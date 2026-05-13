import { createHmac } from 'crypto'
import { downloadMediaMessage } from '@whiskeysockets/baileys'
import { createClient } from '@supabase/supabase-js'
import { getProfilePictureCached } from './profile-picture-cache.js'

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
    const captionFromMedia =
        message.imageMessage?.caption ||
        message.videoMessage?.caption ||
        message.documentMessage?.caption ||
        message.audioMessage?.caption
    if (typeof captionFromMedia === 'string' && captionFromMedia.trim()) {
        return captionFromMedia
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

function extractImage(message) {
    const img = message?.imageMessage
    if (!img) return null
    return {
        mimeType: img.mimetype || 'image/jpeg',
        sizeBytes: Number(img.fileLength ?? 0) || null,
        caption: typeof img.caption === 'string' ? img.caption.trim() : null,
    }
}

function extractVideo(message) {
    const vid = message?.videoMessage
    if (!vid) return null
    const isGif = vid.gifPlayback === true
    return {
        mimeType: vid.mimetype || 'video/mp4',
        sizeBytes: Number(vid.fileLength ?? 0) || null,
        durationMs: typeof vid.seconds === 'number' ? vid.seconds * 1000 : null,
        caption: typeof vid.caption === 'string' ? vid.caption.trim() : null,
        gifPlayback: isGif,
    }
}

function extractDocument(message) {
    const doc = message?.documentMessage
    if (!doc) return null
    return {
        mimeType: doc.mimetype || 'application/octet-stream',
        sizeBytes: Number(doc.fileLength ?? 0) || null,
        fileName: typeof doc.fileName === 'string' ? doc.fileName : null,
        caption: typeof doc.caption === 'string' ? doc.caption.trim() : null,
    }
}

function extractSticker(message) {
    const sticker = message?.stickerMessage
    if (!sticker) return null
    return {
        mimeType: sticker.mimetype || 'image/webp',
        sizeBytes: Number(sticker.fileLength ?? 0) || null,
        isAnimated: sticker.isAnimated === true,
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
    if (mime.includes('mp4')) return 'mp4'
    if (mime.includes('m4a')) return 'm4a'
    if (mime.includes('wav')) return 'wav'
    if (mime.includes('aac')) return 'aac'
    if (mime.includes('webm')) return 'webm'
    if (mime.includes('jpeg') || mime.includes('jpg')) return 'jpg'
    if (mime.includes('png')) return 'png'
    if (mime.includes('gif')) return 'gif'
    if (mime.includes('webp')) return 'webp'
    if (mime.includes('pdf')) return 'pdf'
    return 'bin'
}

function normalizeContentType(mime) {
    if (!mime) return mime
    return mime.split(';')[0].trim()
}

async function uploadMedia(orgId, messageId, message, mimeType, cfg) {
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
            contentType: normalizeContentType(mimeType),
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
export async function maybeEmitOrgInboundWebhook(orgId, waMessage, sock = null) {
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
        const image = extractImage(message)
        const video = extractVideo(message)
        const document = extractDocument(message)
        const sticker = extractSticker(message)

        // Si no hay ni texto ni ningún tipo de media, descartamos.
        if (!text && !audio && !image && !video && !document && !sticker) {
            console.warn(`[org-inbound ${orgId}] message discarded — unknown type (${messageId}):`, Object.keys(message))
            return
        }

        const messageId = waMessage?.key?.id
        if (!messageId) return

        const tsRaw = Number(waMessage?.messageTimestamp ?? 0)
        const timestamp = tsRaw > 0 ? tsRaw : Math.floor(Date.now() / 1000)

        const participant = isGroup
            ? waMessage?.key?.participant || waMessage?.participant || null
            : null

        // En Baileys un mensaje tiene a lo sumo UN tipo de media (image/video/
        // audio/document/sticker). El receptor espera `media` como un único
        // objeto con la forma { tipo, storagePath, mimeType, sizeBytes,
        // durationMs }, no un array.
        let mediaCandidate = null
        if (audio) {
            mediaCandidate = {
                tipo: 'audio',
                mimeType: audio.mimeType,
                sizeBytes: audio.sizeBytes,
                durationMs: audio.durationMs,
            }
        } else if (image) {
            mediaCandidate = {
                tipo: 'image',
                mimeType: image.mimeType,
                sizeBytes: image.sizeBytes,
                durationMs: null,
            }
        } else if (video) {
            mediaCandidate = {
                tipo: video.gifPlayback ? 'gif' : 'video',
                mimeType: video.mimeType,
                sizeBytes: video.sizeBytes,
                durationMs: video.durationMs,
            }
        } else if (document) {
            mediaCandidate = {
                tipo: 'document',
                mimeType: document.mimeType,
                sizeBytes: document.sizeBytes,
                durationMs: null,
            }
        } else if (sticker) {
            mediaCandidate = {
                tipo: 'sticker',
                mimeType: sticker.mimeType,
                sizeBytes: sticker.sizeBytes,
                durationMs: null,
            }
        }

        let media = null
        if (mediaCandidate) {
            try {
                const storagePath = await uploadMedia(
                    orgId,
                    messageId,
                    message,
                    mediaCandidate.mimeType,
                    cfg
                )
                media = { ...mediaCandidate, storagePath }
            } catch (err) {
                console.error(
                    `[org-inbound ${orgId}] ${mediaCandidate.tipo} upload failed (${messageId}): ${err.message}`
                )
            }
        }

        // Si no hay texto ni se logró subir el media, descartamos.
        if (!text && !media) return

        // Foto de perfil de la conversación. Usamos `remoteJid` (jid de la
        // chat) tanto para grupos (@g.us) como para 1:1 (@s.whatsapp.net),
        // nunca el participant. Si falla, va `null` sin bloquear el envío.
        let profilePictureUrl = null
        let profilePictureSetAt = null
        try {
            const pic = await getProfilePictureCached(orgId, sock, remoteJid)
            profilePictureUrl = pic.url
            profilePictureSetAt = pic.setAt
        } catch (err) {
            console.warn(
                `[org-inbound ${orgId}] profile-picture fetch failed for ${remoteJid}: ${err?.message ?? err}`
            )
        }

        const payload = {
            event: 'message.received',
            orgId,
            jid: remoteJid,
            isGroup,
            participant,
            // Pseudo-IDs WhatsApp LID + número real. El receptor los usa para
            // deduplicar conversaciones cuando `jid` viene como `<id>@lid`.
            senderPn: waMessage?.key?.senderPn ?? null,
            senderLid: waMessage?.key?.senderLid ?? null,
            participantPn: waMessage?.key?.participantPn ?? null,
            participantLid: waMessage?.key?.participantLid ?? null,
            fromMe: Boolean(waMessage?.key?.fromMe),
            messageId,
            timestamp,
            text,
            media,
            quotedMessageId: extractQuotedId(message),
            profilePictureUrl,
            profilePictureSetAt,
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
