require('dotenv').config()
const express = require('express')
const cors = require('cors')
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys')
const pino = require('pino')

const app = express()
app.use(cors())
app.use(express.json())

const PORT = process.env.PORT || 3000
const API_TOKEN = process.env.API_TOKEN || 'secure-token-123' // You should set this in Render deployment

let sock = null

async function connectToWhatsApp() {
    // Baileys needs a folder to store connection credentials.
    // In Render, this folder will be deleted on every reboot unless you use a Persistent Disk.
    // Make sure to add 'auth_info_baileys' to your Render persistent disk path if you want it to survive reboots.
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys')

    sock = makeWASocket({
        auth: state,
        printQRInTerminal: true,
        logger: pino({ level: 'silent' }), // Suppress baileys logs unless debugging
        browser: ['Car Sale Bot', 'Chrome', '1.0.0']
    })

    sock.ev.on('creds.update', saveCreds)

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update

        if (qr) {
            console.log('\n==================================================')
            console.log('SCAN THIS QR CODE WITH YOUR WHATSAPP TO CONNECT')
            console.log('==================================================\n')
            // qr terminal prints it automatically because printQRInTerminal is true
        }

        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut
            console.log('Connection closed due to ', lastDisconnect?.error, ', reconnecting ', shouldReconnect)

            // Reconnect if not logged out explicitly
            if (shouldReconnect) {
                connectToWhatsApp()
            } else {
                console.log('Logged out. Please delete the auth_info_baileys folder and scan QR again.')
            }
        } else if (connection === 'open') {
            console.log('opened connection')
        }
    })
}

// Security Middleware
const requireAuth = (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || authHeader !== `Bearer ${API_TOKEN}`) {
        return res.status(401).json({ error: 'Unauthorized. Invalid API Token.' });
    }
    next();
};

// API Endpoint to send messages
app.post('/send', requireAuth, async (req, res) => {
    try {
        const { phone, message } = req.body

        if (!phone || !message) {
            return res.status(400).json({ error: 'Missing phone or message parameter' })
        }

        if (!sock) {
            return res.status(503).json({ error: 'WhatsApp is not connected yet' })
        }

        // Format phone number to JID format used by Baileys. Example: 595981123456@s.whatsapp.net
        // Remove +, spaces, dashes
        const cleanPhone = phone.replace(/[\+\-\s]/g, '')
        const jid = `${cleanPhone}@s.whatsapp.net`

        // Check if number exists on WhatsApp (optional but recommended)
        const [result] = await sock.onWhatsApp(jid)
        if (!result || !result.exists) {
            return res.status(404).json({ error: 'Phone number is not registered on WhatsApp' })
        }

        // Send message
        await sock.sendMessage(result.jid, { text: message })

        console.log(`Message sent to ${cleanPhone}`)
        res.status(200).json({ success: true, message: 'Message sent successfully' })

    } catch (error) {
        console.error('Error sending message:', error)
        res.status(500).json({ error: 'Internal server error while sending message', details: error.message })
    }
})

// Health endpoint for Render
app.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok', connected: sock !== null })
})

// Start Express and WhatsApp
app.listen(PORT, () => {
    console.log(`WhatsApp API Microservice is running on port ${PORT}`)
    connectToWhatsApp()
})
