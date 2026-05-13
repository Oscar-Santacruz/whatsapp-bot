import { createHmac } from 'crypto'
import { downloadMediaMessage } from '@whiskeysockets/baileys'
import { createClient } from '@supabase/supabase-js'
import { getEnabledInboundWebhook } from './db.js'

const TIMEOUT_MS = 5000
const RETRY_DELAYS_MS = [1000, 5000, 30000]

// El backend de Celeste hace OCR sobre comprobantes de transferencia. Solo
// aceptamos fotos y PDFs — el resto se filtra con un texto sintético para que
// el flujo conversacional pueda explicar al usuario qué archivo enviar.
const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'application/pdf'])
const MAX_BYTES = 10 * 1024 * 1024
// 30 min: el backend descarga apenas recibe el webhook (timeout 15s), pero
// dejamos margen por si reintenta o procesa async.
const SIGNED_URL_TTL_SECONDS = 30 * 60
const STORAGE_BUCKET = process.env.CELESTE_INBOUND_BUCKET || 'celeste-inbound'
const TEXT_UNSUPPORTED =
    'Recibí un archivo no soportado. Solo acepto fotos (jpg/png) o PDFs.'
const TEXT_TOO_LARGE =
    'Tu archivo es muy grande, mandalo más chico (máx 10MB).'

let supabaseClient = null

function getSupabase() {
    if (supabaseClient) return supabaseClient
    const url = process.env.SUPABASE_URL
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
    if (!url || !serviceRoleKey) return null
    supabaseClient = createClient(url, serviceRoleKey, {
        auth: { autoRefreshToken: false, persistSession: false },
    })
    return supabaseClient
}

/**
 * Si `orgId` tiene un webhook inbound configurado y habilitado, le hace POST
 * con el mensaje recibido. Fire-and-forget desde el handler de Baileys —
 * NUNCA throws (cualquier error se loguea).
 *
 * Backwards-compat: si no hay fila en `inbound_webhooks` para este orgId,
 * la función hace early return y no hay efecto observable. Las orgs viejas
 * (cobros) NO van a configurar webhook → comportamiento idéntico al previo.
 *
 * Filtros:
 *  - Mensajes con fromMe=true se descartan (eco de mensajes que envió el bot).
 *  - Mensajes de grupos se descartan (Celeste es 1:1 entre operador y bot).
 *  - Texto: conversation, extendedTextMessage.text.
 *  - Media: imageMessage / documentMessage con MIME en {jpeg, png, pdf} y
 *    tamaño ≤ 10MB. Se sube a Supabase Storage y se firma una URL con
 *    TTL de 30 min. El caption va en `media.caption`, NO duplicado en `text`.
 *
 * Payload enviado al webhook:
 *   {
 *     event: "message.received",
 *     orgId, from, fromJid, messageId, timestamp, text,
 *     senderPn, senderLid, participantPn, participantLid,
 *     fromMe: false,
 *     media?: { url, mimeType, caption, fileName, sizeBytes }
 *   }
 *
 * Headers:
 *   Content-Type: application/json
 *   X-Hub-Signature-256: sha256=<hmac_sha256_hex(body, secret)>
 *   X-Wa-Event: message.received
 */
export async function maybeEmitInboundWebhook(orgId, waMessage) {
    let webhook
    try {
        webhook = getEnabledInboundWebhook(orgId)
    } catch (err) {
        console.error(`[inbound-webhook ${orgId}] config read failed: ${err.message}`)
        return
    }
    if (!webhook) return // sin config → silencio (este es el path de cobros)

    if (waMessage?.key?.fromMe === true) return

    const fromJid = waMessage?.key?.remoteJid ?? ''
    if (!fromJid) return
    if (fromJid.endsWith('@g.us')) return

    const from = fromJid.split('@')[0] ?? ''
    const messageId = waMessage?.key?.id
    if (!messageId) return

    const message = waMessage?.message
    const text = extractText(message)
    const mediaInfo = extractMediaInfo(message)

    let payloadText = text ?? ''
    let media = null

    if (mediaInfo) {
        const result = await tryBuildMedia({
            orgId,
            from,
            messageId,
            message,
            mediaInfo,
        })
        if (result.kind === 'ok') {
            media = result.media
            payloadText = ''
        } else if (result.kind === 'unsupported') {
            payloadText = TEXT_UNSUPPORTED
        } else if (result.kind === 'too-large') {
            payloadText = TEXT_TOO_LARGE
        } else if (
            typeof mediaInfo.caption === 'string' &&
            mediaInfo.caption.trim()
        ) {
            // upload-failed o error interno: preservamos el caption como
            // texto plano para no perder la intención del usuario.
            payloadText = mediaInfo.caption.trim()
        }
    }

    // Si no quedó nada útil (stickers, audios, videos, ubicaciones, o media
    // soportada que falló sin caption) → no golpeamos el webhook.
    if (!payloadText && !media) return

    const payload = {
        event: 'message.received',
        orgId,
        from,
        fromJid,
        messageId,
        timestamp:
            Number(waMessage.messageTimestamp ?? 0) ||
            Math.floor(Date.now() / 1000),
        text: payloadText,
        // Pseudo-IDs WhatsApp LID + número real. El receptor los usa para
        // deduplicar conversaciones cuando `fromJid` viene como `<id>@lid`.
        senderPn: waMessage?.key?.senderPn ?? null,
        senderLid: waMessage?.key?.senderLid ?? null,
        participantPn: waMessage?.key?.participantPn ?? null,
        participantLid: waMessage?.key?.participantLid ?? null,
        fromMe: false,
        ...(media ? { media } : {}),
    }

    await deliverWithRetry(webhook.url, webhook.secret, payload, orgId)
}

function extractText(message) {
    if (!message) return null
    if (
        typeof message.conversation === 'string' &&
        message.conversation.trim()
    ) {
        return message.conversation
    }
    if (
        typeof message.extendedTextMessage?.text === 'string' &&
        message.extendedTextMessage.text.trim()
    ) {
        return message.extendedTextMessage.text
    }
    return null
}

function extractMediaInfo(message) {
    if (!message) return null
    const img = message.imageMessage
    if (img && img.mimetype) {
        return {
            mimeType: img.mimetype,
            caption: typeof img.caption === 'string' ? img.caption : null,
            fileName: null,
            declaredSize: Number(img.fileLength ?? 0) || null,
        }
    }
    const doc = message.documentMessage
    if (doc && doc.mimetype) {
        return {
            mimeType: doc.mimetype,
            caption: typeof doc.caption === 'string' ? doc.caption : null,
            fileName: typeof doc.fileName === 'string' ? doc.fileName : null,
            declaredSize: Number(doc.fileLength ?? 0) || null,
        }
    }
    return null
}

async function tryBuildMedia({ orgId, from, messageId, message, mediaInfo }) {
    if (!ALLOWED_MIME.has(mediaInfo.mimeType)) {
        return { kind: 'unsupported' }
    }
    // Chequeo barato con el size declarado por WhatsApp antes de bajar bytes.
    if (mediaInfo.declaredSize && mediaInfo.declaredSize > MAX_BYTES) {
        return { kind: 'too-large' }
    }

    const supabase = getSupabase()
    if (!supabase) {
        console.warn(
            `[inbound-webhook ${orgId}] media skipped — SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY no configurados (${messageId})`
        )
        return { kind: 'failed' }
    }

    let buffer
    try {
        buffer = await downloadMediaMessage({ message }, 'buffer', {})
    } catch (err) {
        console.error(
            `[inbound-webhook ${orgId}] media download failed (${messageId}): ${err.message}`
        )
        return { kind: 'failed' }
    }
    if (!(buffer instanceof Buffer) || buffer.byteLength === 0) {
        return { kind: 'failed' }
    }
    if (buffer.byteLength > MAX_BYTES) {
        return { kind: 'too-large' }
    }

    let signedUrl
    try {
        signedUrl = await uploadAndSign(supabase, {
            orgId,
            from,
            messageId,
            buffer,
            mimeType: mediaInfo.mimeType,
        })
    } catch (err) {
        console.error(
            `[inbound-webhook ${orgId}] media upload failed (${messageId}): ${err.message}`
        )
        return { kind: 'failed' }
    }

    return {
        kind: 'ok',
        media: {
            url: signedUrl,
            mimeType: mediaInfo.mimeType,
            caption: mediaInfo.caption,
            fileName: mediaInfo.fileName,
            sizeBytes: buffer.byteLength,
        },
    }
}

async function uploadAndSign(supabase, { orgId, from, messageId, buffer, mimeType }) {
    const ext = mimeToExt(mimeType)
    const datePart = new Date().toISOString().slice(0, 10)
    const safePhone = String(from).replace(/[^0-9]/g, '') || 'unknown'
    const safeId = String(messageId).replace(/[^A-Za-z0-9_-]/g, '_')
    const path = `${orgId}/inbound/${safePhone}/${datePart}/${safeId}.${ext}`

    const upload = await supabase.storage
        .from(STORAGE_BUCKET)
        .upload(path, buffer, {
            contentType: mimeType.split(';')[0].trim(),
            upsert: false,
        })
    if (upload.error && !isAlreadyExistsError(upload.error)) {
        throw new Error(`storage upload failed: ${upload.error.message}`)
    }

    const signed = await supabase.storage
        .from(STORAGE_BUCKET)
        .createSignedUrl(path, SIGNED_URL_TTL_SECONDS)
    if (signed.error || !signed.data?.signedUrl) {
        throw new Error(
            `signed url failed: ${signed.error?.message ?? 'no url returned'}`
        )
    }
    return signed.data.signedUrl
}

function mimeToExt(mime) {
    if (mime === 'image/jpeg') return 'jpg'
    if (mime === 'image/png') return 'png'
    if (mime === 'application/pdf') return 'pdf'
    return 'bin'
}

function isAlreadyExistsError(err) {
    const msg = String(err?.message ?? '')
    return msg.includes('already exists') || msg.includes('Duplicate')
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

            if (res.ok) return // éxito

            // 4xx no se reintenta — es config del cliente, retry no ayuda
            if (res.status >= 400 && res.status < 500) {
                console.warn(
                    `[inbound-webhook ${orgId}] POST ${res.status} (4xx, no retry)`
                )
                return
            }

            console.warn(
                `[inbound-webhook ${orgId}] POST ${res.status} attempt=${attempt + 1}`
            )
        } catch (err) {
            console.warn(
                `[inbound-webhook ${orgId}] POST failed attempt=${attempt + 1}: ${err.message}`
            )
        }

        if (attempt < RETRY_DELAYS_MS.length) {
            await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]))
        }
    }

    console.error(
        `[inbound-webhook ${orgId}] all ${totalAttempts} attempts exhausted, dropping message`
    )
}
