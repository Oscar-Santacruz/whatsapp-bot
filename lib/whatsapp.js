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

const sessions = new Map()
const reconnectAttempts = new Map()
// LID (@lid) → phone JID (@s.whatsapp.net) por org. Se construye escuchando
// contacts.upsert / contacts.set que Baileys dispara al conectar.
const lidMaps = new Map() // orgId → Map<lidJid, phoneJid>

const dataDir = process.env.DATA_DIR || process.cwd()
const getAuthPath = (orgId) => path.join(dataDir, `auth_info_baileys_${orgId}`)

export function getSession(orgId) {
    return sessions.get(orgId)
}

export function getAllSessions() {
    return sessions
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

    sock.ev.on('creds.update', saveCreds)

    sock.ev.on('messages.upsert', ({ messages }) => {
        for (const msg of messages) {
            if (msg?.key?.id && msg.message) {
                saveMessage(orgId, msg)
                // Emitir webhook outbound SOLO si esta org tiene uno configurado
                // y es un mensaje entrante (no eco de algo que envió el bot).
                // Fire-and-forget: el handler de Baileys no espera el HTTP.
                if (!msg.key.fromMe) {
                    let outMsg = msg
                    const remoteJid = msg?.key?.remoteJid ?? ''
                    if (remoteJid.endsWith('@lid')) {
                        // 1) Probar mapa construido desde contacts.upsert/set
                        let phoneJid = lidMap.get(remoteJid)

                        // 2) Fallback: Baileys v7+ incluye senderPn (sender phone
                        //    number) en la key cuando el remoteJid es LID.
                        if (!phoneJid) {
                            const senderPn = msg?.key?.senderPn
                            if (typeof senderPn === 'string' && senderPn) {
                                phoneJid = senderPn.includes('@')
                                    ? senderPn
                                    : `${senderPn}@s.whatsapp.net`
                                lidMap.set(remoteJid, phoneJid)
                            }
                        }

                        // 3) Fallback: algunos builds usan remoteJidAlt
                        if (!phoneJid) {
                            const alt = msg?.key?.remoteJidAlt
                            if (typeof alt === 'string' && alt.endsWith('@s.whatsapp.net')) {
                                phoneJid = alt
                                lidMap.set(remoteJid, phoneJid)
                            }
                        }

                        if (!phoneJid) {
                            // Log compacto pero util de la estructura de la key
                            // para diagnosticar que campos provee este Baileys.
                            console.warn(
                                `[wa - ${orgId}] LID ${remoteJid} sin resolver. key=${JSON.stringify(msg.key)}`
                            )
                            continue
                        }

                        outMsg = { ...msg, key: { ...msg.key, remoteJid: phoneJid } }
                    }
                    maybeEmitInboundWebhook(orgId, outMsg).catch((err) =>
                        console.error(
                            `[wa - ${orgId}] inbound-webhook unexpected error: ${err?.message ?? err}`
                        )
                    )
                }
            }
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

export function loadExistingSessions() {
    if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true })
    }
    const files = fs.readdirSync(dataDir)
    const orgFolders = files.filter(f => f.startsWith('auth_info_baileys_'))

    orgFolders.forEach(folder => {
        const orgId = folder.replace('auth_info_baileys_', '')
        console.log(`[WA] Auto-connecting saved session for Org: ${orgId}`)
        connectToWhatsApp(orgId)
    })
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
