import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import qrcode_web from 'qrcode'
import {
    connectToWhatsApp,
    getSession,
    getAllSessions,
    loadExistingSessions,
    logoutSession
} from './lib/whatsapp.js'
import {
    enqueueText,
    enqueueDocument,
    enqueueCompound,
    enqueueImage,
    enqueueVideo,
    enqueueAudio,
    enqueueSticker,
    setSocketProvider,
    resumeAllWorkers
} from './lib/queue.js'
import { createBatch, getBatch } from './lib/batch.js'
import {
    upsertInboundWebhook,
    getInboundWebhook,
    deleteInboundWebhook
} from './lib/db.js'

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

app.get('/api/status/:orgId', requireAuth, async (req, res) => {
    const { orgId } = req.params
    if (!orgId) return res.status(400).json({ error: 'Missing orgId' })

    const session = getSession(orgId)
    if (!session) {
        return res.status(200).json({ connected: false, qr: null, error: 'No session initialized.' })
    }

    if (session.isConnected) {
        return res.status(200).json({ connected: true, qr: null })
    }

    if (session.qr) {
        try {
            const qrBase64 = await qrcode_web.toDataURL(session.qr)
            return res.status(200).json({ connected: false, qr: qrBase64 })
        } catch {
            return res.status(500).json({ connected: false, error: 'Error generating QR' })
        }
    }

    return res.status(200).json({ connected: false, qr: null })
})

app.post('/send', requireAuth, async (req, res) => {
    try {
        const { phone, message, orgId } = req.body
        if (!phone || !message || !orgId) {
            return res.status(400).json({ error: 'Missing phone, message, or orgId' })
        }

        const session = getSession(orgId)
        if (!session) {
            return res.status(503).json({ error: 'No session. Call /api/connect first.' })
        }

        const jobId = enqueueText({ orgId, phone, message })
        res.status(202).json({ status: 'queued', jobId })
    } catch (error) {
        console.error(`[/send] Error:`, error.message)
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
        const { phone, file, mimetype, caption, orgId } = req.body
        if (!phone || !file || !orgId) {
            return res.status(400).json({ error: 'Missing phone, file, or orgId' })
        }

        const session = getSession(orgId)
        if (!session) {
            return res.status(503).json({ error: 'No session. Call /api/connect first.' })
        }

        const jobId = enqueueImage({ orgId, phone, file, mimetype, caption })
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
                enqueueText({ ...base, message: m.message })
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

app.listen(PORT, () => {
    console.log(`[Server] WhatsApp API running on port ${PORT}`)
    loadExistingSessions()
    resumeAllWorkers()
})
