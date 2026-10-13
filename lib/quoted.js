import { isPnUser } from '@whiskeysockets/baileys'
import { getStoredQuoted, getStoredLidMessage } from './store.js'
import { resolvePn } from './lid.js'

/**
 * El mensaje a citar tal como lo pide Baileys en `sendMessage(jid, content, { quoted })`, o undefined si ese
 * mensaje no es del chat `target` (o ya no está en el store): ahí la respuesta sale sin cita.
 *
 * WhatsApp entrega muchos chats privados con el jid `@lid` y las respuestas salen por el número, así que en
 * un privado el mensaje puede estar guardado con otro jid. Se busca por id entre los `@lid` de la sesión y
 * se cita sólo si ese LID es el mismo contacto (store local de Baileys, sin tráfico de red). La key lleva el
 * chat de destino y, como participante, el LID con el que llegó el mensaje.
 */
export async function resolveQuoted(sock, orgId, target, messageId) {
    const quoted = getStoredQuoted(orgId, target, messageId)
    if (quoted || !isPnUser(target)) return quoted

    const stored = getStoredLidMessage(orgId, messageId)
    if (!stored) return undefined
    if ((await resolvePn(sock, stored.remoteJid)) !== target) return undefined

    return {
        key: {
            remoteJid: target,
            id: messageId,
            fromMe: stored.fromMe,
            ...(stored.fromMe ? {} : { participant: stored.remoteJid }),
        },
        message: stored.message,
    }
}
