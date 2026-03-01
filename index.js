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
app.use(express.json())

const PORT = process.env.PORT || 3001
const API_TOKEN = process.env.API_TOKEN || 'test-secret-local'

let sock = null
let isConnected = false
let currentQrCode = null

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
            qrcode_terminal.generate(qr, { small: true })
            currentQrCode = qr
        }

        if (connection === 'close') {
            isConnected = false
            const statusCode = lastDisconnect?.error?.output?.statusCode
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut

            console.log(`[WA] Connection closed (code: ${statusCode}). Reconnecting: ${shouldReconnect}`)

            if (shouldReconnect) {
                setTimeout(connectToWhatsApp, 3000)
            } else {
                console.log('[WA] Logged out. Automatically clearing auth_info_baileys folder and restarting...')
                currentQrCode = null
                const authPath = path.join(__dirname, 'auth_info_baileys')
                if (fs.existsSync(authPath)) {
                    fs.rmSync(authPath, { recursive: true, force: true })
                }
                setTimeout(connectToWhatsApp, 1000) // Immediate retry after clearing
            }
        } else if (connection === 'open') {
            isConnected = true
            currentQrCode = null
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

// POST /send-document → send a PDF or other media
app.post('/send-document', requireAuth, async (req, res) => {
    try {
        const { phone, file, fileName, mimetype } = req.body

        if (!phone || !file || !fileName) {
            return res.status(400).json({ error: 'Missing phone, file (base64) or fileName' })
        }

        if (!sock || !isConnected) {
            return res.status(503).json({ error: 'WhatsApp is not connected.' })
        }

        const cleanPhone = phone.replace(/[\+\-\s\(\)]/g, '')
        const jid = `${cleanPhone}@s.whatsapp.net`

        const [result] = await sock.onWhatsApp(jid)
        if (!result?.exists) {
            return res.status(404).json({ error: `Phone ${cleanPhone} is not registered` })
        }

        // Convert base64 to buffer
        const buffer = Buffer.from(file, 'base64')

        await sock.sendMessage(result.jid, {
            document: buffer,
            fileName: fileName,
            mimetype: mimetype || 'application/pdf'
        })

        console.log(`[WA] Document ${fileName} sent to ${cleanPhone}`)
        res.status(200).json({ success: true })

    } catch (error) {
        console.error('[WA] Error sending document:', error.message)
        res.status(500).json({ error: error.message })
    }
})

// GET /health  → for Render health checks
app.get('/health', (_req, res) => {
    res.status(200).json({ status: 'ok', whatsapp_connected: isConnected })
})

// POST /logout → disconnect and delete session
app.post('/logout', async (_req, res) => {
    try {
        if (sock) {
            await sock.logout()
        }

        const authPath = path.join(__dirname, 'auth_info_baileys')
        if (fs.existsSync(authPath)) {
            fs.rmSync(authPath, { recursive: true, force: true })
        }

        isConnected = false
        currentQrCode = null

        console.log('[WA] Logged out and session cleared via web.')

        // Restart connection after a short delay
        setTimeout(() => {
            connectToWhatsApp()
        }, 3000)

        res.status(200).json({ success: true, message: 'Logged out. Reconnecting...' })
    } catch (error) {
        console.error('[WA] Error during logout:', error.message)
        res.status(500).json({ error: error.message })
    }
})

// GET /qr → renders an HTML page with the QR code
app.get('/qr', async (_req, res) => {
    if (isConnected) {
        return res.send(`
            <html><body style="font-family: sans-serif; text-align: center; margin-top: 50px;">
                <h2>WhatsApp Bot is already connected! ✅</h2>
                <p>No QR code needed.</p>
                <button onclick="handleLogout()" style="margin-top: 20px; padding: 10px 20px; background: #dc3545; color: white; border: none; border-radius: 5px; cursor: pointer;">
                    Disconnect & Logout
                </button>
                <script>
                    function handleLogout() {
                        if (confirm('Are you sure you want to logout and clear session?')) {
                            fetch('/logout', { method: 'POST' })
                                .then(r => r.json())
                                .then(data => {
                                    alert(data.message || 'Logging out...');
                                    location.reload();
                                })
                                .catch(err => alert('Error logging out'));
                        }
                    }
                </script>
            </body></html>
        `)
    }

    if (!currentQrCode) {
        return res.send(`
            <html><body style="font-family: sans-serif; text-align: center; margin-top: 50px;">
                <h2>QR Code not available yet.</h2>
                <p>Please wait a moment and refresh this page.</p>
                <hr style="margin-top: 20px; border: none; border-top: 1px solid #eee; width: 300px; margin-left: auto; margin-right: auto;">
                <button onclick="handleLogout()" style="margin-top: 10px; padding: 10px 20px; background: #dc3545; color: white; border: none; border-radius: 5px; cursor: pointer; font-size: 13px;">
                    Force Reset Session
                </button>
                <script>
                    function handleLogout() {
                        if (confirm('This will clear the current session. Proceed?')) {
                            fetch('/logout', { method: 'POST' })
                                .then(r => r.json())
                                .then(data => {
                                    alert(data.message || 'Resetting...');
                                    location.reload();
                                })
                                .catch(err => alert('Error resetting'));
                        }
                    }
                </script>
            </body></html>
        `)
    }

    try {
        const qrImageBase64 = await qrcode_web.toDataURL(currentQrCode)
        res.send(`
            <html><body style="font-family: sans-serif; text-align: center; margin-top: 50px; background: #f0f2f5;">
                <div style="background: white; padding: 40px; border-radius: 10px; display: inline-block; box-shadow: 0 4px 10px rgba(0,0,0,0.1);">
                    <h2>Scan to connect WhatsApp Bot</h2>
                    <img src="${qrImageBase64}" alt="WhatsApp QR Code" style="width: 300px; height: 300px;" />
                    <p style="color: #666; font-size: 14px; margin-top: 20px;">Refresh the page if the QR expires.</p>
                    <hr style="margin-top: 20px; border: none; border-top: 1px solid #eee;">
                    <button onclick="handleLogout()" style="margin-top: 10px; padding: 10px 20px; background: #dc3545; color: white; border: none; border-radius: 5px; cursor: pointer; font-size: 13px;">
                        Reset Session & Try Again
                    </button>
                    <script>
                        function handleLogout() {
                            if (confirm('This will clear the current session. Proceed?')) {
                                fetch('/logout', { method: 'POST' })
                                    .then(r => r.json())
                                    .then(data => {
                                        alert(data.message || 'Resetting...');
                                        location.reload();
                                    })
                                    .catch(err => alert('Error resetting'));
                            }
                        }
                    </script>
                </div>
            </body></html>
        `)
    } catch (err) {
        res.status(500).send('Error generating QR code image')
    }
})

app.listen(PORT, () => {
    console.log(`[Server] WhatsApp API running on port ${PORT}`)
    connectToWhatsApp()
})
