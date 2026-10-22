import makeWASocket, {
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    Browsers,
    isJidBroadcast,
    isJidStatusBroadcast,
    isLidUser
} from '@whiskeysockets/baileys'
import pino from 'pino'
import fs from 'fs'
import path from 'path'
import { saveMessage, getStoredMessage } from './store.js'
import { maybeEmitInboundWebhook } from './inbound-webhook.js'
import { maybeEmitOrgInboundWebhook, maybeEmitOrgStatusWebhook } from './org-inbound-webhook.js'
import { crearFiltroEstados, estadosDeReceipts, estadosDeUpdates, lineaDeRechazo } from './message-status.js'
import {
    invalidateProfilePicture,
    clearOrgProfilePictureCache
} from './profile-picture-cache.js'
import { setGroupMeta, invalidateGroup, clearOrgGroupCache } from './group-cache.js'
import { saveContacts } from './contacts.js'
import { canonicalChatJid } from './lid.js'
import { handleServerRejection } from './queue.js'

const sessions = new Map()
const reconnectAttempts = new Map()
// La resolución LID (@lid) → phone JID (@s.whatsapp.net) la delegamos en el
// store persistente de Baileys 7 (`sock.signalRepository.lidMapping`), que vive
// en la carpeta de auth y sobrevive reinicios. Ver lib/lid.js.

// Rastrea qué orgId está conectando ahora mismo, para que el handler global
// de uncaughtException pueda identificar y purgar la sesión corrupta cuando
// Baileys lanza un error síncrono de descifrado Noise.
let currentlyConnectingOrgId = null

const dataDir = process.env.DATA_DIR || process.cwd()

/** Desde cuántos segundos de atraso se loguea un mensaje en vivo. */
const LATE_UPSERT_S = 15

// `getAuthPath` alimenta rmSync: un orgId con `../` borraría cualquier cosa del
// disco. Los orgId legítimos son UUIDs o slugs internos como `_celeste`.
const ORG_ID_SEGURO = /^[A-Za-z0-9_-]{1,64}$/
function assertOrgIdSeguro(orgId) {
    if (!ORG_ID_SEGURO.test(String(orgId ?? ''))) {
        throw new Error(`orgId inválido: "${orgId}"`)
    }
}

const getAuthPath = (orgId) => {
    assertOrgIdSeguro(orgId)
    return path.join(dataDir, `auth_info_baileys_${orgId}`)
}

/**
 * Reenvía al SAAS un mensaje guardado en `message_store` que no llegó a persistirse (p. ej. el destino estuvo
 * caído). Va por el mismo webhook omnichannel que un mensaje en vivo, marcado `replay`, y con la misma
 * resolución de LID. A propósito NO pasa por el webhook clásico (Celeste), que contesta a los usuarios.
 */
export async function replayStoredMessage(orgId, waMessage) {
    const session = sessions.get(orgId)
    const sock = session?.sock
    if (!sock) return { ok: false, motivo: 'sin_socket' }

    let outMsg = waMessage
    if (isLidUser(waMessage.key.remoteJid)) {
        const phoneJid = await canonicalChatJid(sock, waMessage.key)
        if (phoneJid && phoneJid !== waMessage.key.remoteJid) {
            outMsg = { ...waMessage, key: { ...waMessage.key, remoteJid: phoneJid, remoteJidAlt: waMessage.key.remoteJid } }
        } else if (!phoneJid && !waMessage.key.fromMe) {
            return { ok: false, motivo: 'lid_sin_resolver' }
        }
    }
    const r = await maybeEmitOrgInboundWebhook(orgId, outMsg, sock, { replay: true })
    return r ? { ...r, motivo: r.ok ? null : 'entrega_fallida' } : { ok: false, motivo: 'descartado' }
}

export function getSession(orgId) {
    return sessions.get(orgId)
}

export function getAllSessions() {
    return sessions
}

export function getCurrentlyConnectingOrgId() {
    return currentlyConnectingOrgId
}

export function purgeCorruptSession(orgId) {
    if (!orgId) return false
    try {
        sessions.delete(orgId)
        reconnectAttempts.delete(orgId)
        clearOrgProfilePictureCache(orgId)
        const authPath = getAuthPath(orgId)
        if (fs.existsSync(authPath)) {
            fs.rmSync(authPath, { recursive: true, force: true })
            console.log(`[WA - ${orgId}] Carpeta auth borrada por sesión corrupta.`)
            return true
        }
    } catch (e) {
        console.error(`[WA - ${orgId}] Error purgando sesión:`, e?.message)
    }
    return false
}

function backoffMs(orgId) {
    const attempts = (reconnectAttempts.get(orgId) || 0) + 1
    reconnectAttempts.set(orgId, attempts)
    const base = Math.min(60_000, 1000 * 2 ** (attempts - 1))
    const jitter = Math.random() * 500
    return base + jitter
}

function resetBackoff(orgId) {
    reconnectAttempts.delete(orgId)
}

export async function connectToWhatsApp(orgId, options = {}) {
    if (!orgId) return

    // `pairingPhone` (solo dígitos, con código de país) activa la vinculación
    // por código de 8 caracteres en vez de QR. Ver requestPairingSession().
    const pairingPhone = options.pairingPhone || null

    if (!sessions.has(orgId)) {
        sessions.set(orgId, { sock: null, isConnected: false, qr: null })
    }
    const session = sessions.get(orgId)

    session.pairingPhone = pairingPhone
    session.pairingCode = null
    session.pairingError = null
    // El QR rota cada ~20s: sin este flag pediríamos un código nuevo en cada
    // rotación y WhatsApp nos frena por rate limit.
    let pairingRequested = false

    const authFolder = getAuthPath(orgId)
    const { state, saveCreds } = await useMultiFileAuthState(authFolder)
    const { version } = await fetchLatestBaileysVersion()

    // Entre los dos await de arriba (disco + HTTP a GitHub) pueden pasar varios
    // segundos. Si en esa ventana abandonaron la sesión, crear el socket ahora
    // dejaría uno huérfano escribiendo en una carpeta de auth que ya no existe.
    if (session.abandoned) {
        console.log(`[WA - ${orgId}] Sesión abandonada durante el arranque; no se crea el socket.`)
        return
    }

    const sock = makeWASocket({
        version,
        auth: state,
        // En `warn` Baileys avisa lo que no frena el envío pero lo pierde: el
        // rechazo del servidor (479 smax-invalid, 463), fallas de descifrado.
        // En `silent` esos avisos no quedaban en ningún lado.
        logger: pino({ level: process.env.BAILEYS_LOG_LEVEL || 'warn', base: { org: orgId } }),
        // WhatsApp rechaza el link_code_companion_reg si el browser se anuncia
        // como escritorio de macOS; para pairing hay que ir como Chrome.
        browser: pairingPhone ? Browsers.ubuntu('Chrome') : Browsers.macOS('Desktop'),
        markOnlineOnConnect: false,
        // Por defecto NO descargamos el historial completo (es pesado). La agenda
        // de contactos igual llega por contacts.set/upsert (app state). Activá
        // WA_SYNC_FULL_HISTORY=true para además capturar contactos de todas las
        // conversaciones del history sync — es seguro: los mensajes históricos NO
        // pasan por messages.upsert, van a messaging-history.set (que solo leemos
        // para contactos).
        syncFullHistory: process.env.WA_SYNC_FULL_HISTORY === 'true',
        generateHighQualityLinkPreview: false,
        shouldIgnoreJid: (jid) => isJidBroadcast(jid) || isJidStatusBroadcast(jid),
        getMessage: async (key) => {
            const msg = getStoredMessage(orgId, key.remoteJid, key.id, key.fromMe)
            return msg || undefined
        }
    })

    session.sock = sock

    // Persiste el address book, que alimenta la audiencia "todos mis
    // contactos" al publicar un estado.
    //
    // A propósito NO empujamos acá los pares lid/phoneNumber del address book
    // al store de Baileys: con `useMultiFileAuthState` cada par son DOS
    // archivos en disco (el directo y el `_reverse`), y una agenda de decenas
    // de miles de contactos multiplicada por sesión agota los inodos del disco.
    // El store se llena solo, on-demand, cuando Baileys desencripta un mensaje
    // real — acotado a las conversaciones que existen de verdad. Ver lib/lid.js.
    const ingestContacts = (contacts) => {
        if (!Array.isArray(contacts) || contacts.length === 0) return
        saveContacts(orgId, contacts)
    }

    sock.ev.on('contacts.upsert', ingestContacts)
    sock.ev.on('contacts.set', ({ contacts }) => ingestContacts(contacts))
    // Contactos del history sync (llega cuando WA_SYNC_FULL_HISTORY=true o en el
    // sync inicial). Los mensajes de este evento se ignoran a propósito.
    sock.ev.on('messaging-history.set', ({ contacts }) => ingestContacts(contacts))

    // Invalidación de caché de fotos de perfil.
    // El campo `imgUrl` en contacts.update suele venir como string vacío,
    // 'changed' o una URL nueva cuando WhatsApp notifica cambio de avatar.
    // Cualquier presencia del campo se trata como señal de invalidación.
    sock.ev.on('contacts.update', (updates) => {
        // Cambios de nombre de agenda/pushName también actualizan el address
        // book (el upsert usa COALESCE: un update parcial no pisa con null).
        // Ojo: si el update viene con id @lid y sin phoneNumber, saveContacts
        // lo descarta — el nombre igual llega por contacts.upsert/app state.
        const withNames = (updates ?? []).filter(
            (u) => u && (u.name != null || u.notify != null)
        )
        if (withNames.length > 0) ingestContacts(withNames)
        for (const u of updates ?? []) {
            if (u?.id && Object.prototype.hasOwnProperty.call(u, 'imgUrl')) {
                invalidateProfilePicture(orgId, u.id)
            }
        }
    })

    sock.ev.on('groups.upsert', (groups) => {
        for (const g of groups ?? []) {
            if (!g?.id) continue
            setGroupMeta(orgId, g.id, {
                subject: g.subject ?? null,
                participants: g.participants?.map((p) => p.id) ?? null,
            })
        }
    })

    sock.ev.on('groups.update', (updates) => {
        for (const u of updates ?? []) {
            if (!u?.id) continue
            const changedPicture = Object.prototype.hasOwnProperty.call(u, 'pictureUrl')
            const changedSubject = Object.prototype.hasOwnProperty.call(u, 'subject')
            if (changedPicture || changedSubject) {
                invalidateProfilePicture(orgId, u.id)
            }
            // Cualquier cambio de metadatos invalida el caché para forzar un
            // refetch completo en el próximo mensaje.
            invalidateGroup(orgId, u.id)
        }
    })

    sock.ev.on('group-participants.update', (update) => {
        if (!update?.id) return
        invalidateProfilePicture(orgId, update.id)
        invalidateGroup(orgId, update.id)
    })

    sock.ev.on('creds.update', saveCreds)

    const nuevoEstado = crearFiltroEstados()
    const reportarEstados = (estados) => {
        for (const estado of estados) {
            if (!nuevoEstado(estado)) continue
            if (estado.status === 'error') {
                console.warn(lineaDeRechazo(orgId, estado))
                // Si salió por la cola, queda fallido y en un grupo se reenvía una vez (lib/queue.js).
                handleServerRejection(orgId, sock, { remoteJid: estado.jid, id: estado.messageId, code: estado.errorCode })
                    .catch((err) => console.error(`[wa - ${orgId}] rechazo de ${estado.messageId}: ${err?.message ?? err}`))
            }
            maybeEmitOrgStatusWebhook(orgId, estado)
        }
    }
    sock.ev.on('messages.update', (updates) => reportarEstados(estadosDeUpdates(updates)))
    sock.ev.on('message-receipt.update', (receipts) => reportarEstados(estadosDeReceipts(receipts)))

    sock.ev.on('messages.upsert', ({ messages, type }) => {
        for (const msg of messages) {
            if (!msg?.key?.id || !msg.message) continue

            // Mensaje en vivo que Baileys nos entrega tarde. Junto con la
            // "preparación lenta" de org-inbound separa las dos mitades de una
            // demora: la de WhatsApp→Baileys y la nuestra antes del webhook.
            const ts = Number(msg.messageTimestamp ?? 0)
            const atrasoS = ts > 0 ? Math.round(Date.now() / 1000 - ts) : 0
            if (type === 'notify' && atrasoS >= LATE_UPSERT_S) {
                console.warn(
                    `[wa - ${orgId}] mensaje recibido ${atrasoS}s después de enviado (${msg.key.id}, fromMe=${Boolean(msg.key.fromMe)})`
                )
            }

            // El guardado es sincrónico y en orden; el fan-out a los webhooks
            // es fire-and-forget porque necesita resolver el LID contra el
            // store de Baileys (async).
            saveMessage(orgId, msg)

            dispatchMessage(orgId, sock, msg).catch((err) =>
                console.error(
                    `[wa - ${orgId}] dispatch error: ${err?.message ?? err}`
                )
            )
        }
    })

    /**
     * Resuelve el JID canónico del chat y dispara los webhooks.
     *
     * Si el chat vive como @lid en `remoteJid`, el SAAS lo vería como una
     * conversación distinta a la versión @s.whatsapp.net y se duplicaría, así
     * que reescribimos `remoteJid` al número real cuando lo podemos resolver.
     */
    async function dispatchMessage(orgId, sock, msg) {
        let outMsg = msg
        let skipDueToUnresolvedLid = false

        if (isLidUser(msg.key.remoteJid)) {
            const phoneJid = await canonicalChatJid(sock, msg.key)
            if (phoneJid && phoneJid !== msg.key.remoteJid) {
                // Conservamos el @lid original en `remoteJidAlt`: los webhooks
                // vuelven a resolver la key y sin esto perderían `senderLid`.
                outMsg = {
                    ...msg,
                    key: { ...msg.key, remoteJid: phoneJid, remoteJidAlt: msg.key.remoteJid },
                }
            } else if (!phoneJid) {
                console.warn(
                    `[wa - ${orgId}] LID ${msg.key.remoteJid} sin resolver (fromMe=${msg.key.fromMe}). key=${JSON.stringify(msg.key)}`
                )
                // Solo bloqueamos inbound — outbound deja pasar para no
                // perder el eco al SAAS aunque siga como @lid.
                if (!msg.key.fromMe) skipDueToUnresolvedLid = true
            }
        }

        // Webhook clásico (Celeste): solo inbound, solo 1:1 (filtra grupos
        // adentro). Soporta texto + media (jpg/png/pdf). Necesita `sock` para
        // responder al user en WhatsApp si la subida del media falla por un
        // problema técnico transitorio. Salta si no pudimos resolver el LID.
        if (!msg.key.fromMe && !skipDueToUnresolvedLid) {
            await maybeEmitInboundWebhook(orgId, outMsg, sock).catch((err) =>
                console.error(
                    `[wa - ${orgId}] inbound-webhook unexpected error: ${err?.message ?? err}`
                )
            )
        }

        // Webhook omnichannel: inbound + outbound, grupos, audio. Para outbound
        // usamos outMsg con LID resuelto si lo logramos; si no, mandamos el
        // @lid igual (el SAAS verá el jid crudo).
        await maybeEmitOrgInboundWebhook(orgId, outMsg, sock).catch((err) =>
            console.error(
                `[wa - ${orgId}] org-inbound-webhook unexpected error: ${err?.message ?? err}`
            )
        )
    }

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update

        if (qr) {
            if (!pairingPhone) {
                console.log(`[WA - ${orgId}] QR available`)
                session.qr = qr
            } else if (!pairingRequested) {
                // El primer QR es la señal de que el handshake Noise terminó y
                // WhatsApp está esperando el emparejamiento: recién ahí el
                // requestPairingCode tiene websocket para hablar.
                pairingRequested = true
                sock.requestPairingCode(pairingPhone)
                    .then((code) => {
                        session.pairingCode = code
                        console.log(`[WA - ${orgId}] Pairing code emitido para +${pairingPhone}`)
                    })
                    .catch((err) => {
                        session.pairingError = err?.message ?? 'pairing-failed'
                        console.error(`[WA - ${orgId}] requestPairingCode falló:`, session.pairingError)
                    })
            }
        }

        if (connection === 'close') {
            // Una sesión abandonada (la reemplazamos por un intento nuevo de
            // vinculación) no debe reconectar: pisaría el socket vigente.
            if (session.abandoned) {
                console.log(`[WA - ${orgId}] Cierre de sesión abandonada, sin reconectar.`)
                return
            }
            session.isConnected = false
            const statusCode = lastDisconnect?.error?.output?.statusCode
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut

            console.log(`[WA - ${orgId}] Connection closed (code: ${statusCode}). Reconnecting: ${shouldReconnect}`)

            if (shouldReconnect) {
                const wait = backoffMs(orgId)
                console.log(`[WA - ${orgId}] Reconnect in ${Math.round(wait)}ms`)
                // Guardamos el handle: si la sesión se abandona antes de que
                // dispare, este timer crearía un segundo socket sobre el orgId
                // y pisaría al vigente.
                session.reconnectTimer = setTimeout(() => {
                    session.reconnectTimer = null
                    if (session.abandoned) return
                    connectToWhatsApp(orgId)
                }, wait)
            } else {
                console.log(`[WA - ${orgId}] Logged out. Clearing auth folder.`)
                if (session.reconnectTimer) {
                    clearTimeout(session.reconnectTimer)
                    session.reconnectTimer = null
                }
                session.qr = null
                session.sock = null
                sessions.delete(orgId)
                resetBackoff(orgId)
                clearOrgProfilePictureCache(orgId)
                if (fs.existsSync(authFolder)) {
                    fs.rmSync(authFolder, { recursive: true, force: true })
                }
            }
        } else if (connection === 'open') {
            session.isConnected = true
            session.qr = null
            session.pairingCode = null
            session.pairingPhone = null
            session.pairingError = null
            resetBackoff(orgId)
            console.log(`[WA - ${orgId}] ✅ Connected!`)
        }
    })

    return sock
}

/**
 * ¿La carpeta de auth de esta org ya tiene un número vinculado?
 *
 * Guarda antes de borrar credenciales: una sesión desconectada pero vinculada
 * suele ser una caída transitoria que reconecta sola, no una org sin vincular.
 *
 * OJO con `creds.registered`: Baileys lo escribe en UN solo lugar de toda la
 * librería (el handler `link_code_companion_reg`), o sea únicamente en el
 * flujo de pairing code. Las sesiones vinculadas por QR quedan con
 * `registered: false` para siempre. El campo que de verdad marca "hay un
 * dispositivo vinculado" es `creds.me`, que es además el que usa Baileys para
 * decidir login vs registro (`socket.js`: `if (!creds.me)`).
 */
export function hasLinkedNumber(orgId) {
    try {
        const credsFile = path.join(getAuthPath(orgId), 'creds.json')
        if (!fs.existsSync(credsFile)) return false
        const creds = JSON.parse(fs.readFileSync(credsFile, 'utf-8'))
        return Boolean(creds?.me?.id)
    } catch {
        return false
    }
}

/**
 * Abre una sesión nueva pidiendo un código de vinculación de 8 caracteres en
 * lugar del QR. El operador lo tipea en WhatsApp → Dispositivos vinculados →
 * Vincular con número de teléfono.
 *
 * Descarta cualquier intento de vinculación a medias (socket + carpeta auth)
 * antes de arrancar, porque WhatsApp ata el código a un handshake concreto.
 *
 * @param {string} orgId
 * @param {string} phone  Solo dígitos, con código de país y sin '+'.
 * @param {number} timeoutMs  Cuánto esperar el código antes de rendirse.
 * @returns {Promise<{ code: string, phone: string }>}
 */
export async function requestPairingSession(orgId, phone, timeoutMs = 25_000) {
    // Chequeo ANTES de tocar nada: si la org tiene un número vinculado, esto
    // sería un borrado destructivo. Desvincular es una decisión explícita
    // (logoutSession), nunca un efecto colateral de pedir un código.
    if (hasLinkedNumber(orgId)) {
        throw new Error(
            'La org ya tiene un número vinculado. Desconectá la sesión antes de vincular por código.'
        )
    }

    const previous = sessions.get(orgId)
    if (previous) {
        previous.abandoned = true
        if (previous.reconnectTimer) {
            clearTimeout(previous.reconnectTimer)
            previous.reconnectTimer = null
        }
        try {
            previous.sock?.end(undefined)
        } catch (e) {
            console.warn(`[WA - ${orgId}] No se pudo cerrar el socket previo:`, e?.message)
        }
        sessions.delete(orgId)
    }
    reconnectAttempts.delete(orgId)

    // Llegado acá la carpeta, si existe, es un intento de vinculación a medias
    // (QR nunca escaneado o pairing abandonado): sin `creds.me`, borrarla no
    // desvincula ningún teléfono.
    const authPath = getAuthPath(orgId)
    if (fs.existsSync(authPath)) {
        fs.rmSync(authPath, { recursive: true, force: true })
    }

    // Si Baileys lanza un error síncrono de Noise durante ESTE handshake, el
    // handler global de uncaughtException tiene que poder atribuirlo a esta
    // org: sin esto purgaría la sesión que estuviera arrancando en el boot, o
    // mataría el proceso entero.
    const previoConectando = currentlyConnectingOrgId
    currentlyConnectingOrgId = orgId
    try {
        await connectToWhatsApp(orgId, { pairingPhone: phone })
    } finally {
        currentlyConnectingOrgId = previoConectando
    }

    const session = sessions.get(orgId)
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
        if (session?.pairingCode) return { code: session.pairingCode, phone }
        if (session?.pairingError) throw new Error(session.pairingError)
        await new Promise((r) => setTimeout(r, 500))
    }
    throw new Error('Timeout esperando el código de vinculación de WhatsApp.')
}

export async function loadExistingSessions() {
    if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true })
    }
    const files = fs.readdirSync(dataDir)
    const orgFolders = files.filter(f => f.startsWith('auth_info_baileys_'))

    for (const folder of orgFolders) {
        const orgId = folder.replace('auth_info_baileys_', '')
        console.log(`[WA] Auto-connecting saved session for Org: ${orgId}`)
        currentlyConnectingOrgId = orgId
        try {
            await connectToWhatsApp(orgId)
        } catch (err) {
            console.error(`[WA - ${orgId}] Falló conexión inicial: ${err?.message ?? err}`)
        }
        // Esperar a que el handshake Noise termine (o explote) antes de pasar
        // a la siguiente sesión, para que el uncaughtException pueda atribuir
        // el fallo al orgId correcto.
        await new Promise(r => setTimeout(r, 2000))
    }
    currentlyConnectingOrgId = null
}

export async function logoutSession(orgId) {
    const session = sessions.get(orgId)

    if (session) {
        session.abandoned = true
        if (session.reconnectTimer) {
            clearTimeout(session.reconnectTimer)
            session.reconnectTimer = null
        }
    }

    // Avisarle a WhatsApp es lo deseable, pero falla con "Connection Closed"
    // si el socket está caído — justo el estado en el que más se necesita
    // desvincular. El logout local no puede depender de eso.
    if (session?.sock) {
        try {
            await session.sock.logout()
        } catch (e) {
            console.warn(`[WA - ${orgId}] logout remoto falló (${e?.message}); sigo con el borrado local.`)
            try {
                session.sock.end(undefined)
            } catch { /* el socket ya estaba muerto */ }
        }
    }

    const authPath = getAuthPath(orgId)
    if (fs.existsSync(authPath)) {
        fs.rmSync(authPath, { recursive: true, force: true })
    }
    sessions.delete(orgId)
    reconnectAttempts.delete(orgId)
    clearOrgProfilePictureCache(orgId)
}
