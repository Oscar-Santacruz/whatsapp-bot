import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import qrcode_web from 'qrcode'
import {
    connectToWhatsApp,
    getSession,
    getAllSessions,
    loadExistingSessions,
    logoutSession,
    getCurrentlyConnectingOrgId,
    purgeCorruptSession,
    requestPairingSession,
    hasLinkedNumber
} from './lib/whatsapp.js'
import {
    enqueueText,
    enqueueDocument,
    enqueueCompound,
    enqueueImage,
    enqueueVideo,
    enqueueAudio,
    enqueueSticker,
    enqueueLocation,
    enqueueStatus,
    checkStatusRateLimit,
    setSocketProvider,
    resumeAllWorkers
} from './lib/queue.js'
import { createBatch, getBatch } from './lib/batch.js'
import {
    upsertInboundWebhook,
    getInboundWebhook,
    deleteInboundWebhook,
    upsertOrgInboundRoute
} from './lib/db.js'
import { describeInboundRoute, hasOwnInboundRoute } from './lib/org-inbound-webhook.js'
import { esOrgIdRegistrable, validarRutaInbound } from './lib/inbound-route.js'
import { countContacts, getContactJids } from './lib/contacts.js'
import { getProfilePictureCached } from './lib/profile-picture-cache.js'
import { getGroupMeta, setGroupMeta } from './lib/group-cache.js'

// Baileys lanza errores síncronos de descifrado Noise dentro de listeners del
// WebSocket cuando las credenciales guardadas ya no son válidas. Esos errores
// no llegan al connection.update, así que los atajamos a nivel proceso para
// borrar la sesión corrupta y seguir vivos.
process.on('uncaughtException', (err) => {
    const msg = err?.message ?? ''
    const isNoiseDecryptFail =
        msg.includes('Unsupported state') ||
        msg.includes('unable to authenticate data')

    if (isNoiseDecryptFail) {
        const orgId = getCurrentlyConnectingOrgId()
        console.error(
            `[WA] Sesión corrupta detectada (Noise decrypt fail)` +
            (orgId ? ` para Org: ${orgId}` : ' (orgId desconocido)')
        )
        if (orgId) purgeCorruptSession(orgId)
        return
    }
    console.error('[fatal] uncaughtException:', err)
    process.exit(1)
})

process.on('unhandledRejection', (err) => {
    console.error('[unhandledRejection]', err)
})

const app = express()
app.use(cors())
app.use(express.json({ limit: '50mb' }))

const PORT = process.env.PORT || 3001
const API_TOKEN = process.env.API_TOKEN || 'test-secret-local'

setSocketProvider(getSession)

const requireAuth = (req, res, next) => {
    const authHeader = req.headers.authorization
    if (!authHeader || authHeader !== `Bearer ${API_TOKEN}`) {
        return res.status(401).json({ error: 'Unauthorized. Invalid API Token.' })
    }
    next()
}

app.post('/api/connect', requireAuth, async (req, res) => {
    try {
        const { orgId } = req.body
        if (!orgId) return res.status(400).json({ error: 'Missing orgId' })

        const existing = getSession(orgId)
        if (existing) {
            if (existing.isConnected) {
                return res.status(200).json({ status: 'connected', message: 'Already connected' })
            }
            return res.status(200).json({ status: 'connecting', message: 'Already connecting, QR may be available.' })
        }

        await connectToWhatsApp(orgId)
        res.status(200).json({ status: 'connecting', message: 'Triggered connection.' })
    } catch (e) {
        res.status(500).json({ error: e.message })
    }
})

/**
 * Vinculación por código en vez de QR.
 *
 * Body: { orgId, phone } — `phone` con código de país, sin '+' ni separadores.
 * Devuelve el código de 8 caracteres que el operador tipea en WhatsApp →
 * Dispositivos vinculados → Vincular con número de teléfono.
 *
 * Rechaza la operación si la org ya tiene credenciales (conectada o
 * reconectando): pedir un código borra la sesión guardada, así que primero
 * hay que hacer /logout de forma explícita.
 */
app.post('/api/pair', requireAuth, async (req, res) => {
    try {
        const { orgId, phone } = req.body
        if (!orgId) return res.status(400).json({ error: 'Missing orgId' })

        const digits = String(phone ?? '').replace(/\D/g, '')
        if (digits.length < 8 || digits.length > 15) {
            return res.status(400).json({
                error: 'Invalid phone. Usá solo dígitos, con código de país y sin "+".'
            })
        }

        const existing = getSession(orgId)
        if (existing?.isConnected) {
            return res.status(409).json({
                code: 'ALREADY_LINKED',
                error: 'Ya hay una sesión conectada. Desconectá antes de vincular otro número.'
            })
        }
        if (hasLinkedNumber(orgId)) {
            return res.status(409).json({
                code: 'ALREADY_LINKED',
                error: 'La org ya tiene un número vinculado. Desconectá la sesión antes de vincular por código.'
            })
        }

        const { code } = await requestPairingSession(orgId, digits)
        console.log(`[WA - ${orgId}] Pairing code entregado vía API.`)
        res.status(200).json({ code, phone: digits })
    } catch (e) {
        console.error('[/api/pair] Error:', e.message)
        res.status(500).json({ error: e.message })
    }
})

// `inboundRouted`: si el webhook omnichannel de la org tiene ruta propia (env o
// registrada) o cae al destino por defecto. La app lo mira para saber si tiene
// que registrar la suya (PUT /api/org-inbound-routes/:orgId).
app.get('/api/status/:orgId', requireAuth, async (req, res) => {
    const { orgId } = req.params
    if (!orgId) return res.status(400).json({ error: 'Missing orgId' })

    // null = no se pudo leer la ruta (falló la base): la app solo registra la suya
    // con `=== false`, y este endpoint es el que polea el QR: no puede colgarse.
    let inboundRouted = null
    try {
        inboundRouted = hasOwnInboundRoute(orgId)
    } catch (e) {
        console.error(`[/api/status ${orgId}] no se pudo leer la ruta inbound: ${e.message}`)
    }
    const responder = (status, body) => res.status(status).json({ ...body, inboundRouted })

    const session = getSession(orgId)
    if (!session) {
        return responder(200, { connected: false, qr: null, pairingCode: null, error: 'No session initialized.' })
    }

    if (session.isConnected) {
        return responder(200, { connected: true, qr: null, pairingCode: null, phone: session.sock?.user?.id ?? null })
    }

    if (session.pairingCode) {
        return responder(200, {
            connected: false,
            qr: null,
            pairingCode: session.pairingCode,
            phone: session.pairingPhone ?? null
        })
    }

    if (session.pairingError) {
        return responder(200, {
            connected: false,
            qr: null,
            pairingCode: null,
            error: session.pairingError
        })
    }

    if (session.qr) {
        try {
            const qrBase64 = await qrcode_web.toDataURL(session.qr)
            return responder(200, { connected: false, qr: qrBase64, pairingCode: null })
        } catch {
            return responder(500, { connected: false, error: 'Error generating QR' })
        }
    }

    return responder(200, { connected: false, qr: null, pairingCode: null })
})

// TEST ONLY — envío sync sin queue ni delay anti-ban
app.post('/send-sync', requireAuth, async (req, res) => {
    try {
        const { phone, message, orgId } = req.body
        if (!phone || !message || !orgId) {
            return res.status(400).json({ error: 'Missing phone, message, or orgId' })
        }

        const session = getSession(orgId)
        if (!session?.isConnected || !session?.sock) {
            return res.status(503).json({ error: 'No session. Call /api/connect first.' })
        }

        const rawJid = phone.includes('@') ? phone : `${phone.replace(/[\+\-\s\(\)]/g, '')}@s.whatsapp.net`
        const onWa = await session.sock.onWhatsApp(rawJid)
        const resolved = Array.isArray(onWa) ? onWa[0] : null
        if (!resolved?.exists) {
            return res.status(422).json({ error: 'Phone not registered on WhatsApp', jid: rawJid })
        }
        const jid = resolved.jid || rawJid
        const result = await session.sock.sendMessage(jid, { text: message })
        res.status(200).json({ status: 'sent', messageId: result?.key?.id ?? null, jid, result })
    } catch (error) {
        console.error(`[/send-sync] Error:`, error.message)
        res.status(500).json({ error: error.message })
    }
})

// Responder a un mensaje: `quotedMessageId` es su id de WhatsApp; `quotedJobId`, el `jobId` que devolvió
// el envío anterior al que se responde (quien encola no conoce el id del mensaje hasta que sale). Un
// `quotedJobId` que no es un número de envío se ignora: el mensaje sale igual, sin cita.
const envioCitado = (valor) => (Number.isInteger(valor) && valor > 0 ? valor : null)

app.post('/send', requireAuth, async (req, res) => {
    try {
        const { phone, message, orgId, quotedMessageId, quotedJobId } = req.body
        if (!phone || !message || !orgId) {
            return res.status(400).json({ error: 'Missing phone, message, or orgId' })
        }

        const session = getSession(orgId)
        if (!session) {
            return res.status(503).json({ error: 'No session. Call /api/connect first.' })
        }

        const jobId = enqueueText({ orgId, phone, message, quotedMessageId, quotedJobId: envioCitado(quotedJobId) })
        res.status(202).json({ status: 'queued', jobId })
    } catch (error) {
        console.error(`[/send] Error:`, error.message)
        res.status(500).json({ error: error.message })
    }
})

// "Escribiendo..." en el chat, sin mandar nada. Lo usa el asistente de
// KuSystem mientras junta los mensajes que el cliente manda en ráfaga: el
// cliente ve que alguien le está por contestar. No pasa por la cola porque no
// es un envío: es instantáneo y no cuenta para el anti-ban. WhatsApp apaga el
// indicador solo a los ~25 s, o antes con `paused` o con el mensaje real.
const PRESENCE_STATES = new Set(['composing', 'recording', 'paused', 'available'])

app.post('/presence', requireAuth, async (req, res) => {
    try {
        const { phone, orgId } = req.body
        const state = req.body.state ?? 'composing'
        if (!phone || !orgId) {
            return res.status(400).json({ error: 'Missing phone or orgId' })
        }
        if (!PRESENCE_STATES.has(state)) {
            return res.status(400).json({ error: `Invalid state: ${state}` })
        }

        const session = getSession(orgId)
        if (!session?.isConnected || !session?.sock) {
            return res.status(503).json({ error: 'No session. Call /api/connect first.' })
        }

        const jid = phone.includes('@') ? phone : `${phone.replace(/[\+\-\s\(\)]/g, '')}@s.whatsapp.net`
        try { await session.sock.presenceSubscribe(jid) } catch {}
        await session.sock.sendPresenceUpdate(state, jid)
        res.status(200).json({ status: 'ok', state })
    } catch (error) {
        console.error(`[/presence] Error:`, error.message)
        res.status(500).json({ error: error.message })
    }
})

app.post('/send-document', requireAuth, async (req, res) => {
    try {
        const { phone, file, fileName, mimetype, orgId } = req.body
        if (!phone || !file || !fileName || !orgId) {
            return res.status(400).json({ error: 'Missing phone, file, fileName, or orgId' })
        }

        const session = getSession(orgId)
        if (!session) {
            return res.status(503).json({ error: 'No session. Call /api/connect first.' })
        }

        const jobId = enqueueDocument({ orgId, phone, file, fileName, mimetype })
        res.status(202).json({ status: 'queued', jobId })
    } catch (error) {
        console.error(`[/send-document] Error:`, error.message)
        res.status(500).json({ error: error.message })
    }
})

app.post('/send-image', requireAuth, async (req, res) => {
    try {
        const { phone, file, mimetype, caption, orgId, quotedMessageId, quotedJobId } = req.body
        if (!phone || !file || !orgId) {
            return res.status(400).json({ error: 'Missing phone, file, or orgId' })
        }

        const session = getSession(orgId)
        if (!session) {
            return res.status(503).json({ error: 'No session. Call /api/connect first.' })
        }

        const jobId = enqueueImage({
            orgId, phone, file, mimetype, caption,
            quotedMessageId,
            quotedJobId: envioCitado(quotedJobId),
        })
        res.status(202).json({ status: 'queued', jobId })
    } catch (error) {
        console.error(`[/send-image] Error:`, error.message)
        res.status(500).json({ error: error.message })
    }
})

app.post('/send-video', requireAuth, async (req, res) => {
    try {
        const { phone, file, mimetype, caption, gifPlayback, orgId } = req.body
        if (!phone || !file || !orgId) {
            return res.status(400).json({ error: 'Missing phone, file, or orgId' })
        }

        const session = getSession(orgId)
        if (!session) {
            return res.status(503).json({ error: 'No session. Call /api/connect first.' })
        }

        const jobId = enqueueVideo({ orgId, phone, file, mimetype, caption, gifPlayback: gifPlayback === true })
        res.status(202).json({ status: 'queued', jobId })
    } catch (error) {
        console.error(`[/send-video] Error:`, error.message)
        res.status(500).json({ error: error.message })
    }
})

app.post('/send-audio', requireAuth, async (req, res) => {
    try {
        const { phone, file, mimetype, orgId } = req.body
        if (!phone || !file || !orgId) {
            return res.status(400).json({ error: 'Missing phone, file, or orgId' })
        }

        const session = getSession(orgId)
        if (!session) {
            return res.status(503).json({ error: 'No session. Call /api/connect first.' })
        }

        const jobId = enqueueAudio({ orgId, phone, file, mimetype })
        res.status(202).json({ status: 'queued', jobId })
    } catch (error) {
        console.error(`[/send-audio] Error:`, error.message)
        res.status(500).json({ error: error.message })
    }
})

app.post('/send-sticker', requireAuth, async (req, res) => {
    try {
        const { phone, file, mimetype, orgId } = req.body
        if (!phone || !file || !orgId) {
            return res.status(400).json({ error: 'Missing phone, file, or orgId' })
        }

        const session = getSession(orgId)
        if (!session) {
            return res.status(503).json({ error: 'No session. Call /api/connect first.' })
        }

        const jobId = enqueueSticker({ orgId, phone, file, mimetype })
        res.status(202).json({ status: 'queued', jobId })
    } catch (error) {
        console.error(`[/send-sticker] Error:`, error.message)
        res.status(500).json({ error: error.message })
    }
})

const esCoordenada = (valor, limite) =>
    typeof valor === 'number' && Number.isFinite(valor) && Math.abs(valor) <= limite

const textoOpcional = (valor) =>
    typeof valor === 'string' && valor.trim() ? valor.trim().slice(0, 200) : null

/**
 * POST /send-location
 *
 * Manda una ubicación con pin: el cliente la ve como tarjeta de mapa y la abre
 * con un toque en Google Maps o Waze.
 * Body:
 *   orgId      string
 *   phone      string
 *   latitude   number  — grados decimales, -90 a 90
 *   longitude  number  — grados decimales, -180 a 180
 *   name       string? — título de la tarjeta (el nombre del local)
 *   address    string? — renglón de abajo (la dirección)
 */
app.post('/send-location', requireAuth, async (req, res) => {
    try {
        const { phone, latitude, longitude, name, address, orgId } = req.body
        if (!phone || !orgId) {
            return res.status(400).json({ error: 'Missing phone or orgId' })
        }
        if (!esCoordenada(latitude, 90) || !esCoordenada(longitude, 180)) {
            return res.status(400).json({ error: 'latitude/longitude must be numbers in range' })
        }

        const session = getSession(orgId)
        if (!session) {
            return res.status(503).json({ error: 'No session. Call /api/connect first.' })
        }

        const jobId = enqueueLocation({
            orgId,
            phone,
            latitude,
            longitude,
            name: textoOpcional(name),
            address: textoOpcional(address),
        })
        res.status(202).json({ status: 'queued', jobId })
    } catch (error) {
        console.error(`[/send-location] Error:`, error.message)
        res.status(500).json({ error: error.message })
    }
})

/**
 * POST /publish-status
 *
 * Publica un estado de WhatsApp (status@broadcast).
 * Body:
 *   orgId           string   — organization id
 *   recipients      string[] — teléfonos/JIDs que verán el estado (requerido, no vacío)
 *   message         string?  — texto del estado, o caption si hay file
 *   file            string?  — media en base64 (imagen o video)
 *   mimetype        string?  — image/* o video/* (default image/jpeg si hay file)
 *   backgroundColor string?  — color de fondo, solo estado de texto
 *   font            number?  — fuente, solo estado de texto
 */
app.post('/publish-status', requireAuth, async (req, res) => {
    try {
        const { orgId, recipients, toAllContacts, message, file, mimetype, backgroundColor, font } = req.body
        if (!orgId) {
            return res.status(400).json({ error: 'Missing orgId' })
        }
        if (!file && !message) {
            return res.status(400).json({ error: 'Provide message (text) or file (media)' })
        }

        // Audiencia: toda la libreta sincronizada de la sesión, o una lista explícita.
        let audience
        if (toAllContacts) {
            audience = getContactJids(orgId)
            if (audience.length === 0) {
                return res.status(400).json({ error: 'No contacts synced yet for this session' })
            }
        } else {
            if (!Array.isArray(recipients) || recipients.length === 0) {
                return res.status(400).json({ error: 'Provide recipients (non-empty array) or set toAllContacts: true' })
            }
            if (!recipients.every(r => typeof r === 'string' && r.trim())) {
                return res.status(400).json({ error: 'recipients must be non-empty strings' })
            }
            audience = recipients
        }

        const session = getSession(orgId)
        if (!session) {
            return res.status(503).json({ error: 'No session. Call /api/connect first.' })
        }

        // Anti-ban: limita cuántos estados se publican por ventana de tiempo.
        const rl = checkStatusRateLimit(orgId)
        if (!rl.ok) {
            return res.status(429).json({ error: `Status rate limit reached (${rl.count}/${rl.limit} per ${rl.scope})` })
        }

        const jobId = enqueueStatus({ orgId, recipients: audience, message, file, mimetype, backgroundColor, font })
        res.status(202).json({ status: 'queued', jobId, audience: audience.length })
    } catch (error) {
        console.error(`[/publish-status] Error:`, error.message)
        res.status(500).json({ error: error.message })
    }
})

/**
 * GET /api/contacts/:orgId
 * Cantidad de contactos sincronizados para esa sesión. Lo usa el cliente para
 * mostrar "publicar a N contactos" antes de disparar el estado a toda la libreta.
 */
app.get('/api/contacts/:orgId', requireAuth, (req, res) => {
    try {
        const { orgId } = req.params
        res.json({ orgId, count: countContacts(orgId) })
    } catch (error) {
        console.error(`[/api/contacts] Error:`, error.message)
        res.status(500).json({ error: error.message })
    }
})

/**
 * POST /send-batch
 *
 * Body:
 *   orgId       string   — organization id
 *   callbackUrl string?  — called when all messages finish (receives results[])
 *   messages    array    — each item:
 *     phone     string   — recipient
 *     message   string?  — text body
 *     document  object?  — { base64, fileName, mimetype } → compound if message also present
 *     image     object?  — { base64, mimetype }
 *     video     object?  — { base64, mimetype, gifPlayback? }
 *     audio     object?  — { base64, mimetype }
 *     sticker   object?  — { base64, mimetype }
 *     metadata  object?  — opaque JSON returned as-is in the callback per message
 */
app.post('/send-batch', requireAuth, async (req, res) => {
    try {
        const { orgId, messages, callbackUrl = null } = req.body
        if (!orgId || !Array.isArray(messages) || messages.length === 0) {
            return res.status(400).json({ error: 'Missing orgId or messages array' })
        }

        const session = getSession(orgId)
        if (!session) {
            return res.status(503).json({ error: 'No session. Call /api/connect first.' })
        }

        const batchId = createBatch(orgId, messages.length, callbackUrl)

        for (const m of messages) {
            const base = { orgId, phone: m.phone, batchId, metadata: m.metadata ?? null }

            if (m.message && m.document) {
                // compound: text + document as one atomic unit
                enqueueCompound({
                    ...base,
                    message: m.message,
                    file: m.document.base64,
                    fileName: m.document.fileName,
                    mimetype: m.document.mimetype,
                })
            } else if (m.document) {
                enqueueDocument({
                    ...base,
                    file: m.document.base64,
                    fileName: m.document.fileName,
                    mimetype: m.document.mimetype,
                })
            } else if (m.image) {
                enqueueImage({
                    ...base,
                    file: m.image.base64,
                    mimetype: m.image.mimetype,
                    caption: m.message,
                })
            } else if (m.video) {
                enqueueVideo({
                    ...base,
                    file: m.video.base64,
                    mimetype: m.video.mimetype,
                    caption: m.message,
                    gifPlayback: m.video.gifPlayback === true,
                })
            } else if (m.audio) {
                enqueueAudio({
                    ...base,
                    file: m.audio.base64,
                    mimetype: m.audio.mimetype,
                })
            } else if (m.sticker) {
                enqueueSticker({
                    ...base,
                    file: m.sticker.base64,
                    mimetype: m.sticker.mimetype,
                })
            } else if (m.message) {
                enqueueText({ ...base, message: m.message, quotedMessageId: m.quotedMessageId ?? null })
            }
        }

        res.status(202).json({ status: 'queued', batchId, queued: messages.length })
    } catch (error) {
        console.error(`[/send-batch] Error:`, error.message)
        res.status(500).json({ error: error.message })
    }
})

app.get('/api/batch/:batchId', requireAuth, (req, res) => {
    const batch = getBatch(req.params.batchId)
    if (!batch) return res.status(404).json({ error: 'Batch not found' })
    res.json(batch)
})

// GET /profile-picture?orgId=<...>&jid=<urlencoded_jid>[&force=1]
//
// Devuelve `{ url, setAt }`. La app la llama para refrescar la foto on-demand
// cuando el usuario aprieta "Actualizar foto" (con `force=1`) o cuando todavía
// no tiene la URL en cache local. Sirve siempre desde el caché del bot salvo
// que `force=1` o que el TTL haya expirado.
app.get('/profile-picture', requireAuth, async (req, res) => {
    try {
        const { orgId, jid } = req.query
        const force = req.query.force === '1' || req.query.force === 'true'

        if (!orgId || typeof orgId !== 'string') {
            return res.status(400).json({ error: 'Missing orgId' })
        }
        if (!jid || typeof jid !== 'string') {
            return res.status(400).json({ error: 'Missing jid' })
        }
        if (!/@(g\.us|s\.whatsapp\.net|lid)$/.test(jid)) {
            return res.status(400).json({ error: 'Invalid jid format' })
        }

        const session = getSession(orgId)
        if (!session || !session.sock || !session.isConnected) {
            return res.status(502).json({ error: 'Baileys not connected for this orgId' })
        }

        const pic = await getProfilePictureCached(orgId, session.sock, jid, { force })
        return res.status(200).json({ url: pic.url, setAt: pic.setAt })
    } catch (err) {
        const statusCode = err?.output?.statusCode ?? err?.status ?? null
        if (statusCode === 429) {
            return res.status(429).json({ error: 'WhatsApp rate limit' })
        }
        console.error(`[/profile-picture] Error:`, err?.message ?? err)
        return res.status(500).json({ error: err?.message ?? 'Internal error' })
    }
})

// GET /group-participants?orgId=<uuid>&jid=<jid>
//
// Devuelve la lista de JIDs de los participantes del grupo.
// Usa el caché de groupMetadata (TTL 5 min); solo llama a Baileys si expiró.
app.get('/group-participants', requireAuth, async (req, res) => {
    try {
        const { orgId, jid } = req.query
        if (!orgId || !jid) {
            return res.status(400).json({ error: 'Missing orgId or jid' })
        }
        if (!jid.endsWith('@g.us')) {
            return res.status(400).json({ error: 'jid must end with @g.us' })
        }

        const session = getSession(orgId)
        if (!session || !session.sock || !session.isConnected) {
            return res.status(503).json({ error: 'Baileys not connected for this orgId' })
        }

        let cached = getGroupMeta(orgId, jid)
        if (!cached) {
            const meta = await session.sock.groupMetadata(jid)
            const subject = meta?.subject ?? null
            const participants = meta?.participants?.map((p) => p.id) ?? null
            setGroupMeta(orgId, jid, { subject, participants })
            cached = { subject, participants }
        }

        return res.status(200).json({ jid, participants: cached.participants ?? [] })
    } catch (err) {
        console.error(`[/group-participants] Error:`, err?.message ?? err)
        return res.status(500).json({ error: err?.message ?? 'Internal error' })
    }
})

// GET /groups?orgId=<uuid>
//
// Devuelve TODOS los grupos en los que está la sesión, con su nombre.
//
// Es lo que necesita un panel para que el usuario ELIJA un grupo de una lista.
// El JID ('120363…@g.us') no se puede tipear ni copiar: WhatsApp no lo muestra
// en ninguna pantalla de la app. Sin esto, la única forma de descubrir un grupo
// era esperar a que alguien escribiera en él y verlo llegar por el webhook de
// entrada — que además hay que tener configurado por orgId, así que para una
// org sin webhook la lista quedaba vacía para siempre.
//
// Distinto de /group-participants, que responde por UN grupo que ya conocés.
app.get('/groups', requireAuth, async (req, res) => {
    try {
        const { orgId } = req.query
        if (!orgId) {
            return res.status(400).json({ error: 'Missing orgId' })
        }

        const session = getSession(orgId)
        if (!session || !session.sock || !session.isConnected) {
            return res.status(503).json({ error: 'Baileys not connected for this orgId' })
        }

        const metas = await session.sock.groupFetchAllParticipating()

        const groups = Object.values(metas ?? {})
            .filter((meta) => meta?.id)
            .map((meta) => {
                // De paso alimenta el caché de /group-participants: esta llamada
                // ya trajo la metadata completa, y volver a pedírsela a WhatsApp
                // grupo por grupo sería pagar dos veces lo mismo.
                setGroupMeta(orgId, meta.id, {
                    subject: meta.subject ?? null,
                    participants: meta.participants?.map((p) => p.id) ?? null
                })
                return {
                    jid: meta.id,
                    subject: meta.subject ?? null,
                    participants: meta.participants?.length ?? 0
                }
            })
            // Por nombre: el panel la muestra tal cual, y sin orden hay que
            // leerla entera para encontrar uno.
            .sort((a, b) => (a.subject ?? '').localeCompare(b.subject ?? '', 'es'))

        return res.status(200).json({ groups })
    } catch (err) {
        console.error(`[/groups] Error:`, err?.message ?? err)
        return res.status(500).json({ error: err?.message ?? 'Internal error' })
    }
})

app.get('/health', (_req, res) => {
    const sessions = Array.from(getAllSessions().entries()).map(([orgId, s]) => ({
        orgId,
        connected: s.isConnected
    }))
    res.status(200).json({ status: 'ok', sessions })
})

// ── Inbound webhooks: gestión de configuración por orgId ──────────────────────
//
// POST   /api/inbound-webhooks            → crear o actualizar
// GET    /api/inbound-webhooks/:orgId     → leer (sin exponer secret completo)
// DELETE /api/inbound-webhooks/:orgId     → eliminar
//
// Una org sin fila acá tiene el comportamiento previo: los mensajes entrantes
// solo se guardan en message_store y nadie los consume.

app.post('/api/inbound-webhooks', requireAuth, (req, res) => {
    try {
        const { orgId, url, secret, enabled = true } = req.body
        if (!orgId || !url || !secret) {
            return res.status(400).json({ error: 'Missing orgId, url, or secret' })
        }
        if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
            return res.status(400).json({ error: 'Invalid url (must start with http:// or https://)' })
        }
        if (typeof secret !== 'string' || secret.length < 16) {
            return res.status(400).json({ error: 'Invalid secret (min 16 chars)' })
        }
        upsertInboundWebhook({ orgId, url, secret, enabled: enabled ? 1 : 0 })
        res.status(200).json({ ok: true })
    } catch (e) {
        console.error('[/api/inbound-webhooks POST] Error:', e.message)
        res.status(500).json({ error: e.message })
    }
})

app.get('/api/inbound-webhooks/:orgId', requireAuth, (req, res) => {
    try {
        const wh = getInboundWebhook(req.params.orgId)
        if (!wh) return res.status(404).json({ error: 'Not found' })
        res.status(200).json({
            orgId: wh.org_id,
            url: wh.url,
            enabled: wh.enabled === 1,
            // No devolvemos el secret completo: solo confirmamos formato/longitud.
            secretMasked: wh.secret ? `***${wh.secret.slice(-4)}` : null,
        })
    } catch (e) {
        console.error('[/api/inbound-webhooks GET] Error:', e.message)
        res.status(500).json({ error: e.message })
    }
})

app.delete('/api/inbound-webhooks/:orgId', requireAuth, (req, res) => {
    try {
        deleteInboundWebhook(req.params.orgId)
        res.status(200).json({ ok: true })
    } catch (e) {
        console.error('[/api/inbound-webhooks DELETE] Error:', e.message)
        res.status(500).json({ error: e.message })
    }
})

// ── Rutas del webhook omnichannel: registro por la app dueña de la sesión ─────
//
// PUT /api/org-inbound-routes/:orgId  body { url, secret } → registra a dónde
//     van los mensajes entrantes de esa sesión. Lo llama KuSystem al vincular la
//     línea de un tenant: sin esto hay que sumar la org a ORG_INBOUND_ROUTES a
//     mano, y una org que nadie sumó no falla, pierde mensajes en silencio.
// GET /api/org-inbound-routes/:orgId  → a dónde va hoy y por qué (nunca el secret).
//
// ORG_INBOUND_ROUTES sigue mandando: si la org está ahí, la registrada no rige.

app.put('/api/org-inbound-routes/:orgId', requireAuth, (req, res) => {
    try {
        const { orgId } = req.params
        if (!esOrgIdRegistrable(orgId)) return res.status(400).json({ error: 'Invalid orgId' })

        const ruta = validarRutaInbound(req.body)
        if (!ruta.ok) return res.status(400).json({ error: ruta.error })

        const antes = describeInboundRoute(orgId)
        upsertOrgInboundRoute({ orgId, url: ruta.url, secret: ruta.secret })
        // Lo que rige ahora, leído de la misma decisión que usa la entrega: si la
        // org está en ORG_INBOUND_ROUTES, la registrada se guarda pero no rige.
        const despues = describeInboundRoute(orgId)

        // Qué destino había y cuál hay ahora: una org que cambia de destino por un
        // orgId equivocado del cliente tiene que quedar a la vista.
        console.log(
            `[org-inbound] ruta registrada ${orgId}: ${antes.source} (${antes.host ?? '-'}) → ${despues.source} (${despues.host})`
        )
        if (despues.source === 'env') {
            console.warn(`[org-inbound] ${orgId} también está en ORG_INBOUND_ROUTES: la registrada no rige`)
        }
        res.status(200).json({ ok: true, effective: despues.source, previous: antes.source })
    } catch (e) {
        console.error('[/api/org-inbound-routes PUT] Error:', e.message)
        res.status(500).json({ error: e.message })
    }
})

app.get('/api/org-inbound-routes/:orgId', requireAuth, (req, res) => {
    try {
        const { orgId } = req.params
        if (!esOrgIdRegistrable(orgId)) return res.status(400).json({ error: 'Invalid orgId' })
        res.status(200).json({ orgId, ...describeInboundRoute(orgId) })
    } catch (e) {
        console.error('[/api/org-inbound-routes GET] Error:', e.message)
        res.status(500).json({ error: e.message })
    }
})

app.post('/logout', requireAuth, async (req, res) => {
    try {
        const { orgId } = req.body
        if (!orgId) return res.status(400).json({ error: 'Missing orgId' })

        await logoutSession(orgId)
        console.log(`[WA - ${orgId}] Logged out via API.`)
        res.status(200).json({ success: true, message: 'Logged out.' })
    } catch (error) {
        console.error(`[/logout] Error:`, error.message)
        res.status(500).json({ error: error.message })
    }
})

// Un body JSON roto no se cita ni en el log ni en la respuesta: body-parser copia
// un pedazo del texto en el mensaje de error, y en PUT /api/org-inbound-routes
// ese texto trae un secret (un curl con $SECRET sin comillas alcanza).
app.use((err, req, res, next) => {
    if (err?.type === 'entity.parse.failed') {
        console.warn(`[http] ${req.method} ${req.path}: body JSON inválido`)
        return res.status(400).json({ error: 'Invalid JSON body' })
    }
    next(err)
})

app.listen(PORT, () => {
    console.log(`[Server] WhatsApp API running on port ${PORT}`)
    loadExistingSessions()
    resumeAllWorkers()
})
