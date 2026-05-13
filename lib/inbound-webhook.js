import { createHmac } from 'crypto'
import { getEnabledInboundWebhook } from './db.js'

const TIMEOUT_MS = 5000
const RETRY_DELAYS_MS = [1000, 5000, 30000]

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
 *  - Solo extraemos texto plano (conversation, extendedTextMessage). Otros
 *    tipos (imagen, audio, video, doc) no se forwardean por ahora.
 *
 * Payload enviado al webhook:
 *   {
 *     event: "message.received",
 *     orgId, from, fromJid, messageId, timestamp, text,
 *     senderPn, senderLid, participantPn, participantLid,
 *     fromMe: false
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

    const text = extractText(waMessage?.message)
    if (!text) return

    const fromJid = waMessage?.key?.remoteJid ?? ''
    const from = fromJid.split('@')[0] ?? ''

    // Ignorar mensajes de grupos por ahora — Celeste es 1:1 entre operador y bot
    if (fromJid.endsWith('@g.us')) return

    const payload = {
        event: 'message.received',
        orgId,
        from,
        fromJid,
        messageId: waMessage.key.id,
        timestamp:
            Number(waMessage.messageTimestamp ?? 0) ||
            Math.floor(Date.now() / 1000),
        text,
        // Pseudo-IDs WhatsApp LID + número real. El receptor los usa para
        // deduplicar conversaciones cuando `fromJid` viene como `<id>@lid`.
        senderPn: waMessage?.key?.senderPn ?? null,
        senderLid: waMessage?.key?.senderLid ?? null,
        participantPn: waMessage?.key?.participantPn ?? null,
        participantLid: waMessage?.key?.participantLid ?? null,
        fromMe: false,
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
