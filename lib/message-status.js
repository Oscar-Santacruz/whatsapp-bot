import { proto } from '@whiskeysockets/baileys'

/**
 * Qué pasó con lo que mandamos, según WhatsApp.
 *
 * `sock.sendMessage` resuelve apenas escribe el mensaje en el socket, sin
 * esperar al servidor: el log dice "sent" y el SAAS lo da por enviado aunque
 * WhatsApp lo rechace. El rechazo llega después, como `messages.update` con
 * status ERROR y el código en `messageStubParameters` (479 smax-invalid, 463
 * cuenta restringida, …). En ASEMARA, el 17/10/2026, una respuesta del bot a un
 * grupo quedó "enviada" y no apareció en ningún celular, ni en el del propio
 * número: sin este evento no había forma de enterarse.
 *
 * Las entregas en grupos llegan como `message-receipt.update`, una por
 * participante: de esas se reporta sólo la primera por mensaje.
 */

const { Status } = proto.WebMessageInfo

/** `messages.update` → estados de mensajes propios. Pura. */
export function estadosDeUpdates(updates) {
    if (!Array.isArray(updates)) return []
    const estados = []
    for (const u of updates) {
        const key = u?.key
        const status = u?.update?.status
        if (!key?.fromMe || !key.id || !key.remoteJid || typeof status !== 'number') continue
        if (status === Status.ERROR) {
            const params = u.update.messageStubParameters
            estados.push({
                messageId: key.id,
                jid: key.remoteJid,
                status: 'error',
                errorCode: Array.isArray(params) && params[0] != null ? String(params[0]) : null,
                errorText: Array.isArray(params) && params[1] != null ? String(params[1]) : null,
            })
        } else if (status === Status.DELIVERY_ACK || status === Status.READ || status === Status.PLAYED) {
            estados.push({ messageId: key.id, jid: key.remoteJid, status: 'delivered' })
        }
    }
    return estados
}

/** `message-receipt.update` → entregas de mensajes propios en grupos. Pura. */
export function estadosDeReceipts(receipts) {
    if (!Array.isArray(receipts)) return []
    const estados = []
    for (const r of receipts) {
        const key = r?.key
        if (!key?.fromMe || !key.id || !key.remoteJid) continue
        if (!r.receipt?.receiptTimestamp && !r.receipt?.readTimestamp) continue
        estados.push({ messageId: key.id, jid: key.remoteJid, status: 'delivered' })
    }
    return estados
}

const ENTREGADOS_MAX = 5000

/**
 * Deja pasar cada error y sólo la primera entrega de cada mensaje: un grupo de
 * 200 participantes son 200 receipts por mensaje.
 */
export function crearFiltroEstados(max = ENTREGADOS_MAX) {
    const entregados = new Set()
    return (estado) => {
        if (estado.status !== 'delivered') return true
        const clave = `${estado.jid}|${estado.messageId}`
        if (entregados.has(clave)) return false
        entregados.add(clave)
        if (entregados.size > max) entregados.delete(entregados.values().next().value)
        return true
    }
}

/** Línea de log de un rechazo. Sin el texto del mensaje: sólo id, chat y código. */
export function lineaDeRechazo(orgId, estado) {
    const detalle = estado.errorText ? ` ${estado.errorText}` : ''
    return `[wa - ${orgId}] WhatsApp rechazó el envío ${estado.messageId} → ${estado.jid} (código ${estado.errorCode ?? '?'})${detalle}`
}
