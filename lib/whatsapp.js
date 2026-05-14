import makeWASocket, {
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    Browsers,
    isJidBroadcast,
    isJidStatusBroadcast
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

const sessions = new Map()
const reconnectAttempts = new Map()
// LID (@lid) → phone JID (@s.whatsapp.net) por org. Se construye escuchando
// contacts.upsert / contacts.set que Baileys dispara al conectar.
const lidMaps = new Map() // orgId → Map<lidJid, phoneJid>

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
        lidMaps.delete(orgId)
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
        syncFullHistory: false,
        generateHighQualityLinkPreview: false,
        shouldIgnoreJid: (jid) => isJidBroadcast(jid) || isJidStatusBroadcast(jid),
        getMessage: async (key) => {
            const msg = getStoredMessage(orgId, key.remoteJid, key.id, key.fromMe)
            return msg || undefined
        }
    })

    session.sock = sock

    // Construir mapa LID → phone JID para resolver JIDs multi-device (@lid).
    // Baileys dispara contacts.upsert/contacts.set al conectar y al recibir
    // actualizaciones de contactos.
    if (!lidMaps.has(orgId)) lidMaps.set(orgId, new Map())
    const lidMap = lidMaps.get(orgId)

    const indexContacts = (contacts) => {
        for (const c of contacts) {
            if (c.lid && c.id && c.id.endsWith('@s.whatsapp.net')) {
                lidMap.set(c.lid, c.id)
            }
        }
    }

    sock.ev.on('contacts.upsert', indexContacts)
    sock.ev.on('contacts.set', ({ contacts }) => indexContacts(contacts))

    // Invalidación de caché de fotos de perfil.
    // El campo `imgUrl` en contacts.update suele venir como string vacío,
    // 'changed' o una URL nueva cuando WhatsApp notifica cambio de avatar.
    // Cualquier presencia del campo se trata como señal de invalidación.
    sock.ev.on('contacts.update', (updates) => {
        for (const u of updates ?? []) {
            if (u?.id && Object.prototype.hasOwnProperty.call(u, 'imgUrl')) {
                invalidateProfilePicture(orgId, u.id)
            }
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
        }
    })

    sock.ev.on('group-participants.update', (update) => {
        if (update?.id) invalidateProfilePicture(orgId, update.id)
    })

    sock.ev.on('creds.update', saveCreds)

    sock.ev.on('messages.upsert', ({ messages }) => {
        for (const msg of messages) {
            if (!msg?.key?.id || !msg.message) continue

            saveMessage(orgId, msg)

            // Resolución de LID → phone JID. Aplica a inbound y outbound:
            // si el chat existe como @lid en remoteJid, el SAAS lo vería como
            // una conversación distinta a la versión @s.whatsapp.net y se
            // duplicaría. Para inbound podemos caer a senderPn; para outbound
            // no (senderPn es uno mismo), así que dependemos de lidMap o
            // remoteJidAlt.
            let outMsg = msg
            let skipDueToUnresolvedLid = false
            const remoteJid = msg?.key?.remoteJid ?? ''
            if (remoteJid.endsWith('@lid')) {
                let phoneJid = lidMap.get(remoteJid)
                if (!phoneJid && !msg.key.fromMe) {
                    const senderPn = msg?.key?.senderPn
                    if (typeof senderPn === 'string' && senderPn) {
                        phoneJid = senderPn.includes('@')
                            ? senderPn
                            : `${senderPn}@s.whatsapp.net`
                        lidMap.set(remoteJid, phoneJid)
                    }
                }
                if (!phoneJid) {
                    const alt = msg?.key?.remoteJidAlt
                    if (typeof alt === 'string' && alt.endsWith('@s.whatsapp.net')) {
                        phoneJid = alt
                        lidMap.set(remoteJid, phoneJid)
                    }
                }
                if (!phoneJid) {
                    console.warn(
                        `[wa - ${orgId}] LID ${remoteJid} sin resolver (fromMe=${msg.key.fromMe}). key=${JSON.stringify(msg.key)}`
                    )
                    // Solo bloqueamos inbound — outbound deja pasar para no
                    // perder el eco al SAAS aunque siga como @lid.
                    if (!msg.key.fromMe) skipDueToUnresolvedLid = true
                } else {
                    outMsg = { ...msg, key: { ...msg.key, remoteJid: phoneJid } }
                }
            }

            // Webhook clásico (Celeste): solo inbound, solo 1:1 (filtra grupos
            // adentro). Soporta texto + media (jpg/png/pdf). Necesita `sock`
            // para responder al user en WhatsApp si la subida del media
            // falla por un problema técnico transitorio. Salta si no pudimos
            // resolver el LID.
            if (!msg.key.fromMe && !skipDueToUnresolvedLid) {
                maybeEmitInboundWebhook(orgId, outMsg, sock).catch((err) =>
                    console.error(
                        `[wa - ${orgId}] inbound-webhook unexpected error: ${err?.message ?? err}`
                    )
                )
            }

            // Webhook omnichannel: inbound + outbound, grupos, audio. Para
            // outbound usamos outMsg con LID resuelto si lo logramos; si no,
            // mandamos el @lid igual (el SAAS verá el jid crudo).
            maybeEmitOrgInboundWebhook(orgId, outMsg, sock).catch((err) =>
                console.error(
                    `[wa - ${orgId}] org-inbound-webhook unexpected error: ${err?.message ?? err}`
                )
            )
        }
    })

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
