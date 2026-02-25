require('dotenv').config()
const express = require('express')
const cors = require('cors')
const qrcode = require('qrcode-terminal')
const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys')
const pino = require('pino')

const app = express()
app.use(cors())
app.use(express.json())

const PORT = process.env.PORT || 3001
const API_TOKEN = process.env.API_TOKEN || 'test-secret-local'

let sock = null
let isConnected = false

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys')
    const { version } = await fetchLatestBaileysVersion()

    sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'silent' }),
        browser: ['CarSaleBot', 'Chrome', '120.0.0'],
        generateHighQualityLinkPreview: false,
    })

    sock.ev.on('creds.update', saveCreds)

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update

        if (qr) {
            console.log('\n============================================================')
            console.log('  SCAN THIS QR CODE WITH YOUR WHATSAPP TO CONNECT THE BOT')
            console.log('============================================================\n')
            qrcode.generate(qr, { small: true })
        }

        if (connection === 'close') {
            isConnected = false
            const statusCode = lastDisconnect?.error?.output?.statusCode
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut

            console.log(`[WA] Connection closed (code: ${statusCode}). Reconnecting: ${shouldReconnect}`)

            if (shouldReconnect) {
                setTimeout(connectToWhatsApp, 3000)
            } else {
                console.log('[WA] Logged out. Delete auth_info_baileys folder and restart.')
            }
        } else if (connection === 'open') {
            isConnected = true
            console.log('[WA] ✅ WhatsApp connected! Bot ready to send messages.')
        }
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

// POST /send  → send a WhatsApp message
app.post('/send', requireAuth, async (req, res) => {
    try {
        const { phone, message } = req.body

        if (!phone || !message) {
            return res.status(400).json({ error: 'Missing phone or message' })
        }

        if (!sock || !isConnected) {
            return res.status(503).json({ error: 'WhatsApp is not connected. Scan the QR code first.' })
        }

        // Normalize phone: strip +, spaces, dashes → e.g. "595981234567"
        const cleanPhone = phone.replace(/[\+\-\s\(\)]/g, '')
        const jid = `${cleanPhone}@s.whatsapp.net`

        // Verify the number exists on WhatsApp
        const [result] = await sock.onWhatsApp(jid)
        if (!result?.exists) {
            return res.status(404).json({ error: `Phone ${cleanPhone} is not registered on WhatsApp` })
        }

        await sock.sendMessage(result.jid, { text: message })

        console.log(`[WA] Message sent to ${cleanPhone}`)
        res.status(200).json({ success: true })

    } catch (error) {
        console.error('[WA] Error sending message:', error.message)
        res.status(500).json({ error: error.message })
    }
})

// GET /health  → for Render health checks
app.get('/health', (_req, res) => {
    res.status(200).json({ status: 'ok', whatsapp_connected: isConnected })
})

app.listen(PORT, () => {
    console.log(`[Server] WhatsApp API running on port ${PORT}`)
    connectToWhatsApp()
})
