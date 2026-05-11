import { createHmac } from 'crypto'
import { downloadMediaMessage } from '@whiskeysockets/baileys'
import { createClient } from '@supabase/supabase-js'

/**
 * Webhook omnichannel para AlquilaCar: emite TODO lo que pasa por las sesiones
 * de orgs (no `_celeste`) al SAAS para el panel de conversaciones.
 *
 * Distinto del `inbound-webhook.js` clásico:
 *  - NO filtra fromMe=true (necesitamos ecos de lo que la ATC manda desde el cel)
 *  - Soporta grupos (incluye `participant`)
 *  - Soporta audio: download + decrypt + upload a Supabase Storage
 *  - No usa la tabla `inbound_webhooks` (no es por-org configurable, es global)
 *
 * Se habilita por env vars:
 *   ORG_INBOUND_WEBHOOK_URL          — endpoint del SAAS (ej. https://alquilacar.app/api/webhooks/baileys/inbound)
 *   ORG_INBOUND_WEBHOOK_SECRET       — secret HMAC (mismo en SAAS y bot)
 *   SUPABASE_URL                     — para subir audio
 *   SUPABASE_SERVICE_ROLE_KEY        — bypasea RLS de Storage
 *
 * Si falta alguna → silencio total (early return). El bot sigue funcionando
 * igual que antes.
 *
 * El orgId `_celeste` se ignora — Celeste tiene su propio webhook.
 */

const TIMEOUT_MS = 8000
const RETRY_DELAYS_MS = [1000, 5000, 30000]
const STORAGE_BUCKET = 'conversaciones'
const CELESTE_ORG_ID = '_celeste'

let supabaseClient = null

function getConfig() {
    const url = process.env.ORG_INBOUND_WEBHOOK_URL
    const secret = process.env.ORG_INBOUND_WEBHOOK_SECRET
    const supabaseUrl = process.env.SUPABASE_URL
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
    if (!url || !secret || !supabaseUrl || !serviceRoleKey) return null
    return { url, secret, supabaseUrl, serviceRoleKey }
}

function getSupabase(cfg) {
    if (!supabaseClient) {
        supabaseClient = createClient(cfg.supabaseUrl, cfg.serviceRoleKey, {
            auth: { autoRefreshToken: false, persistSession: false },
        })
    }
    return supabaseClient
}

function extractText(message) {
    if (!message) return null
    if (typeof message.conversation === 'string' && message.conversation.trim()) {
        return message.conversation
    }
    if (typeof message.extendedTextMessage?.text === 'string' && message.extendedTextMessage.text.trim()) {
        return message.extendedTextMessage.text
    }
    if (typeof message.audioMessage?.caption === 'string' && message.audioMessage.caption.trim()) {
        return message.audioMessage.caption
    }
    return null
}

function extractAudio(message) {
    const audio = message?.audioMessage
    if (!audio) return null
    return {
        mimeType: audio.mimetype || 'audio/ogg; codecs=opus',
        sizeBytes: Number(audio.fileLength ?? 0) || null,
        durationMs: typeof audio.seconds === 'number' ? audio.seconds * 1000 : null,
    }
}

function extractQuotedId(message) {
    if (!message || typeof message !== 'object') return null
    for (const v of Object.values(message)) {
        if (v && typeof v === 'object') {
            const id = v?.contextInfo?.stanzaId
            if (typeof id === 'string' && id) return id
        }
    }
    return null
}

function mimeToExt(mime) {
    if (!mime) return 'bin'
    if (mime.includes('ogg')) return 'ogg'
    if (mime.includes('mpeg') || mime.includes('mp3')) return 'mp3'
    if (mime.includes('mp4') || mime.includes('m4a')) return 'm4a'
    if (mime.includes('wav')) return 'wav'
    if (mime.includes('aac')) return 'aac'
    if (mime.includes('webm')) return 'webm'
    return 'bin'
}

async function uploadAudio(orgId, messageId, message, mimeType, cfg) {
    const buffer = await downloadMediaMessage(
        { message },
        'buffer',
        {}
    )
    const ext = mimeToExt(mimeType)
    const path = `${orgId}/${sanitizeId(messageId)}.${ext}`
    const supabase = getSupabase(cfg)
    const { error } = await supabase.storage
        .from(STORAGE_BUCKET)
        .upload(path, buffer, {
            contentType: mimeType,
            upsert: false,
        })
    if (error && !isAlreadyExistsError(error)) {
        throw new Error(`storage upload failed: ${error.message}`)
    }
    return path
}

function sanitizeId(id) {
    // Baileys IDs vienen como '3EB0...' o 'BAE5...' — alfanumérico safe en general.
    // Defensivo: reemplazar cualquier char no apto para path.
    return String(id).replace(/[^A-Za-z0-9_-]/g, '_')
}

function isAlreadyExistsError(err) {
    const msg = String(err?.message ?? '')
    return msg.includes('already exists') || msg.includes('Duplicate')
}

/**
 * Punto de entrada. Llamar desde messages.upsert para CADA mensaje (incluyendo
 * fromMe=true). El módulo decide internamente si emite o no.
 *
 * NUNCA throws — los errores se loguean.
 */
export async function maybeEmitOrgInboundWebhook(orgId, waMessage) {
    if (!orgId || orgId === CELESTE_ORG_ID) return

    const cfg = getConfig()
    if (!cfg) return

    try {
        const remoteJid = waMessage?.key?.remoteJid ?? ''
        if (!remoteJid) return

        const isGroup = remoteJid.endsWith('@g.us')

        // Defensa: ignorar broadcasts y status — ya están filtrados arriba pero
        // por las dudas.
        if (remoteJid.endsWith('@broadcast') || remoteJid === 'status@broadcast') return

        const message = waMessage?.message
        if (!message) return

        const text = extractText(message)
        const audio = extractAudio(message)

        // Si no hay ni texto ni audio (imagen/video/doc/sticker en esta versión)
        // → no emitimos. El SAAS soporta solo audio + texto por ahora.
        if (!text && !audio) return

        const messageId = waMessage?.key?.id
        if (!messageId) return

        const tsRaw = Number(waMessage?.messageTimestamp ?? 0)
        const timestamp = tsRaw > 0 ? tsRaw : Math.floor(Date.now() / 1000)

        const participant = isGroup
            ? waMessage?.key?.participant || waMessage?.participant || null
            : null

        let media = null
        if (audio) {
            try {
                const storagePath = await uploadAudio(
                    orgId,
                    messageId,
                    message,
                    audio.mimeType,
                    cfg
                )
                media = {
                    tipo: 'audio',
                    storagePath,
                    mimeType: audio.mimeType,
                    sizeBytes: audio.sizeBytes,
                    durationMs: audio.durationMs,
                }
            } catch (err) {
                console.error(
                    `[org-inbound ${orgId}] audio upload failed (${messageId}): ${err.message}`
                )
                // Si el audio no se pudo subir y no hay texto, descartamos.
                if (!text) return
                // Si hay texto, emitimos solo el texto (sin media).
            }
        }

        const payload = {
            event: 'message.received',
            orgId,
            jid: remoteJid,
            isGroup,
            participant,
            fromMe: Boolean(waMessage?.key?.fromMe),
            messageId,
            timestamp,
            text,
            media,
            quotedMessageId: extractQuotedId(message),
        }

        await deliverWithRetry(cfg.url, cfg.secret, payload, orgId)
    } catch (err) {
        console.error(
            `[org-inbound ${orgId}] unexpected error: ${err?.message ?? err}`
        )
    }
}

async function deliverWithRetry(url, secret, payload, orgId) {
    const body = JSON.stringify(payload)
    const signature = `sha256=${createHmac('sha256', secret)
        .update(body, 'utf8')
        .digest('hex')}`

    const totalAttempts = RETRY_DELAYS_MS.length + 1

    for (let attempt = 0; attempt < totalAttempts; attempt++) {
        try {
            const controller = new AbortController()
            const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)

            let res
            try {
                res = await fetch(url, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-Hub-Signature-256': signature,
                        'X-Wa-Event': 'message.received',
                    },
                    body,
                    signal: controller.signal,
                })
            } finally {
                clearTimeout(timer)
            }

            if (res.ok) return

            if (res.status >= 400 && res.status < 500) {
                console.warn(
                    `[org-inbound ${orgId}] POST ${res.status} (4xx, no retry)`
                )
                return
            }

            console.warn(
                `[org-inbound ${orgId}] POST ${res.status} attempt=${attempt + 1}`
            )
        } catch (err) {
            console.warn(
                `[org-inbound ${orgId}] POST failed attempt=${attempt + 1}: ${err.message}`
            )
        }

        if (attempt < RETRY_DELAYS_MS.length) {
            await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]))
        }
    }

    console.error(
        `[org-inbound ${orgId}] all ${totalAttempts} attempts exhausted, dropping message`
    )
}
