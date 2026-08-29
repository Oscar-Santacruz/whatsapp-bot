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
import { maybeEmitOrgInboundWebhook } from './org-inbound-webhook.js'
import {
    invalidateProfilePicture,
    clearOrgProfilePictureCache
} from './profile-picture-cache.js'
import { setGroupMeta, invalidateGroup, clearOrgGroupCache } from './group-cache.js'
import { saveContacts } from './contacts.js'
import { canonicalChatJid } from './lid.js'

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
const getAuthPath = (orgId) => path.join(dataDir, `auth_info_baileys_${orgId}`)

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

export async function connectToWhatsApp(orgId) {
    if (!orgId) return

    if (!sessions.has(orgId)) {
        sessions.set(orgId, { sock: null, isConnected: false, qr: null })
    }
    const session = sessions.get(orgId)

    const authFolder = getAuthPath(orgId)
    const { state, saveCreds } = await useMultiFileAuthState(authFolder)
    const { version } = await fetchLatestBaileysVersion()

    const sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'silent' }),
        browser: Browsers.macOS('Desktop'),
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

    sock.ev.on('messages.upsert', ({ messages }) => {
        for (const msg of messages) {
            if (!msg?.key?.id || !msg.message) continue

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
            console.log(`[WA - ${orgId}] QR available`)
            session.qr = qr
        }

        if (connection === 'close') {
            session.isConnected = false
            const statusCode = lastDisconnect?.error?.output?.statusCode
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut

            console.log(`[WA - ${orgId}] Connection closed (code: ${statusCode}). Reconnecting: ${shouldReconnect}`)

            if (shouldReconnect) {
                const wait = backoffMs(orgId)
                console.log(`[WA - ${orgId}] Reconnect in ${Math.round(wait)}ms`)
                setTimeout(() => connectToWhatsApp(orgId), wait)
            } else {
                console.log(`[WA - ${orgId}] Logged out. Clearing auth folder.`)
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
            resetBackoff(orgId)
            console.log(`[WA - ${orgId}] ✅ Connected!`)
        }
    })

    return sock
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
    if (session && session.sock) {
        await session.sock.logout()
    } else {
        const authPath = getAuthPath(orgId)
        if (fs.existsSync(authPath)) {
            fs.rmSync(authPath, { recursive: true, force: true })
        }
        sessions.delete(orgId)
    }
}
