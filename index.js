require('dotenv').config()
const express = require('express')
const cors = require('cors')
const qrcode_terminal = require('qrcode-terminal')
const qrcode_web = require('qrcode')
const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys')
const pino = require('pino')
const fs = require('fs')
const path = require('path')

const app = express()
app.use(cors())
app.use(express.json({ limit: '50mb' }))

const PORT = process.env.PORT || 3001
const API_TOKEN = process.env.API_TOKEN || 'test-secret-local'

// Multi-tenant sessions
const sessions = new Map()
// session structure: { sock, isConnected, qr }

const getAuthPath = (orgId) => path.join(__dirname, `auth_info_baileys_${orgId}`)

async function connectToWhatsApp(orgId) {
    if (!orgId) return;

    // Initialize session object immediately to prevent double connection attempts
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
        browser: ['CarSaleBot', 'Chrome', '120.0.0'],
        generateHighQualityLinkPreview: false,
    })

    session.sock = sock

    sock.ev.on('creds.update', saveCreds)

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update

        if (qr) {
            console.log(`\n=== [Org: ${orgId}] SCAN THIS QR CODE ===\n`)
            // qrcode_terminal.generate(qr, { small: true })
            session.qr = qr
        }

        if (connection === 'close') {
            session.isConnected = false
            const statusCode = lastDisconnect?.error?.output?.statusCode
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut

            console.log(`[WA - ${orgId}] Connection closed (code: ${statusCode}). Reconnecting: ${shouldReconnect}`)

            if (shouldReconnect) {
                setTimeout(() => connectToWhatsApp(orgId), 3000)
            } else {
                console.log(`[WA - ${orgId}] Logged out. Automatically clearing auth folder and removing session...`)
                session.qr = null
                session.sock = null // Delete socket reference
                sessions.delete(orgId)
                if (fs.existsSync(authFolder)) {
                    fs.rmSync(authFolder, { recursive: true, force: true })
                }
            }
        } else if (connection === 'open') {
            session.isConnected = true
            session.qr = null
            console.log(`[WA - ${orgId}] ✅ WhatsApp connected! Bot ready.`)
        }
    })
}

// Startup routine: automatically connect existing folders
function loadExistingSessions() {
    const files = fs.readdirSync(__dirname)
    const orgFolders = files.filter(f => f.startsWith('auth_info_baileys_'))

    orgFolders.forEach(folder => {
        const orgId = folder.replace('auth_info_baileys_', '')
        console.log(`[WA] Auto-connecting saved session for Org ID: ${orgId}`)
        connectToWhatsApp(orgId)
    })
}

// Security Middleware
const requireAuth = (req, res, next) => {
    const authHeader = req.headers.authorization
    if (!authHeader || authHeader !== `Bearer ${API_TOKEN}`) {
        return res.status(401).json({ error: 'Unauthorized. Invalid API Token.' })
    }
    next()
}

// POST /api/connect -> Init session for orgId
app.post('/api/connect', requireAuth, async (req, res) => {
    try {
        const { orgId } = req.body
        if (!orgId) return res.status(400).json({ error: 'Missing orgId' })

        if (sessions.has(orgId)) {
            const session = sessions.get(orgId)
            if (session.isConnected) {
                return res.status(200).json({ status: 'connected', message: 'Already connected' })
            } else {
                return res.status(200).json({ status: 'connecting', message: 'Already connecting, QR might be available.' })
            }
        }

        await connectToWhatsApp(orgId)
        res.status(200).json({ status: 'connecting', message: 'Triggered connection.' })
    } catch (e) {
        res.status(500).json({ error: e.message })
    }
})

// GET /api/status/:orgId -> Get connection status and QR base64
app.get('/api/status/:orgId', requireAuth, async (req, res) => {
    const { orgId } = req.params
    if (!orgId) return res.status(400).json({ error: 'Missing orgId' })

    const session = sessions.get(orgId)
    if (!session) {
        return res.status(200).json({ connected: false, qr: null, error: 'No session initialized. Call /api/connect first.' })
    }

    if (session.isConnected) {
        return res.status(200).json({ connected: true, qr: null })
    }

    if (session.qr) {
        try {
            const qrBase64 = await qrcode_web.toDataURL(session.qr)
            return res.status(200).json({ connected: false, qr: qrBase64 })
        } catch (e) {
            return res.status(500).json({ connected: false, error: 'Error generating QR format' })
        }
    }

    return res.status(200).json({ connected: false, qr: null })
})

// POST /send  → send a WhatsApp message
app.post('/send', requireAuth, async (req, res) => {
    try {
        const { phone, message, orgId } = req.body

        if (!phone || !message || !orgId) {
            return res.status(400).json({ error: 'Missing phone, message, or orgId' })
        }

        const session = sessions.get(orgId)

        if (!session || !session.isConnected || !session.sock) {
            return res.status(503).json({ error: 'WhatsApp is not connected.' })
        }

        // Normalize phone: strip +, spaces, dashes → e.g. "595981234567"
        const cleanPhone = phone.replace(/[\+\-\s\(\)]/g, '')
        const jid = `${cleanPhone}@s.whatsapp.net`

        // Verify the number exists on WhatsApp
        const [result] = await session.sock.onWhatsApp(jid)
        if (!result?.exists) {
            return res.status(404).json({ error: `Phone ${cleanPhone} is not registered on WhatsApp` })
        }

        await session.sock.sendMessage(result.jid, { text: message })

        console.log(`[WA - ${orgId}] Message sent to ${cleanPhone}`)
        res.status(200).json({ success: true })

    } catch (error) {
        console.error(`[WA - ${req.body?.orgId}] Error sending message:`, error.message)
        res.status(500).json({ error: error.message })
    }
})

// POST /send-document → send a PDF or other media
app.post('/send-document', requireAuth, async (req, res) => {
    try {
        const { phone, file, fileName, mimetype, orgId } = req.body

        if (!phone || !file || !fileName || !orgId) {
            return res.status(400).json({ error: 'Missing phone, file (base64), fileName, or orgId' })
        }

        const session = sessions.get(orgId)
        if (!session || !session.isConnected || !session.sock) {
            return res.status(503).json({ error: 'WhatsApp is not connected.' })
        }

        const cleanPhone = phone.replace(/[\+\-\s\(\)]/g, '')
        const jid = `${cleanPhone}@s.whatsapp.net`

        const [result] = await session.sock.onWhatsApp(jid)
        if (!result?.exists) {
            return res.status(404).json({ error: `Phone ${cleanPhone} is not registered` })
        }

        // Convert base64 to buffer
        const buffer = Buffer.from(file, 'base64')

        await session.sock.sendMessage(result.jid, {
            document: buffer,
            fileName: fileName,
            mimetype: mimetype || 'application/pdf'
        })

        console.log(`[WA - ${orgId}] Document ${fileName} sent to ${cleanPhone}`)
        res.status(200).json({ success: true })

    } catch (error) {
        console.error(`[WA - ${req.body?.orgId}] Error sending document:`, error.message)
        res.status(500).json({ error: error.message })
    }
})

// GET /health  → for Render health checks
app.get('/health', (_req, res) => {
    res.status(200).json({ status: 'ok', sessions_active: Array.from(sessions.keys()) })
})

// POST /logout → disconnect and delete session
app.post('/logout', requireAuth, async (req, res) => {
    try {
        const { orgId } = req.body;
        if (!orgId) return res.status(400).json({ error: 'Missing orgId' })

        const session = sessions.get(orgId)

        if (session && session.sock) {
            await session.sock.logout() // This will trigger the connection=close event with DisconnectReason.loggedOut
        } else {
            // Force cleanup if sock wasn't fully initialized but folder exists
            const authPath = getAuthPath(orgId)
            if (fs.existsSync(authPath)) {
                fs.rmSync(authPath, { recursive: true, force: true })
            }
            sessions.delete(orgId)
        }

        console.log(`[WA - ${orgId}] Logged out and session cleared via API.`)

        res.status(200).json({ success: true, message: 'Logged out.' })
    } catch (error) {
        console.error(`[WA - ${req.body?.orgId}] Error during logout:`, error.message)
        res.status(500).json({ error: error.message })
    }
})

app.listen(PORT, () => {
    console.log(`[Server] WhatsApp API running on port ${PORT}`)
    loadExistingSessions()
})
