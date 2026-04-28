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
    setSocketProvider,
    resumeAllWorkers
} from './lib/queue.js'
import { createBatch, getBatch } from './lib/batch.js'

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

app.post('/send-batch', requireAuth, async (req, res) => {
    try {
        const { orgId, messages } = req.body
        if (!orgId || !Array.isArray(messages) || messages.length === 0) {
            return res.status(400).json({ error: 'Missing orgId or messages array' })
        }

        const session = getSession(orgId)
        if (!session) {
            return res.status(503).json({ error: 'No session. Call /api/connect first.' })
        }

        const batchId = createBatch(orgId, messages.length)

        for (const m of messages) {
            if (m.file) {
                enqueueDocument({
                    orgId,
                    phone: m.phone,
                    file: m.file,
                    fileName: m.fileName,
                    mimetype: m.mimetype,
                    batchId
                })
            } else {
                enqueueText({
                    orgId,
                    phone: m.phone,
                    message: m.message,
                    batchId
                })
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
