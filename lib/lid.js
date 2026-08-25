import {
    isJidGroup,
    isLidUser,
    isPnUser,
    jidNormalizedUser,
} from '@whiskeysockets/baileys'

// Resolución de identidades LID (@lid) ↔ PN (@s.whatsapp.net) para Baileys 7.
//
// Baileys 7 mantiene su propio store persistente en
// `sock.signalRepository.lidMapping` (respaldado por el key store, o sea la
// carpeta de auth). Lo llena solo al desencriptar cada mensaje y al enviar,
// así que sobrevive reinicios. Este módulo es una capa fina encima:
//
//  1. Normaliza lo que devuelve el store. `getPNForLID()` devuelve el JID CON
//     device (`5959xxxxxxx:0@s.whatsapp.net`), que no sirve como jid de chat.
//  2. Aprende de los campos `remoteJidAlt` / `participantAlt` que vienen en la
//     key del mensaje, y los empuja al store para que queden persistidos.
//  3. Arma los cuatro campos (senderPn/senderLid/participantPn/participantLid)
//     que consume el SAAS para deduplicar conversaciones.
//
// Ojo con las direcciones:
//  - LID → PN (`getPNForLID`) es 100% local: cache + key store. Barato.
//  - PN → LID (`getLIDForPN`) puede disparar una consulta USync a los
//    servidores de WhatsApp si el mapping falta. NO la usamos en el path de
//    mensajes: para el LID caemos solo a los campos `*Alt` del propio mensaje.
//    Perder el LID no rompe nada (el SAAS deduplica por número); una llamada
//    de red por mensaje sí.

function lidStore(sock) {
    return sock?.signalRepository?.lidMapping ?? null
}

/**
 * En ecos `fromMe` (mensajes que mandamos desde otro dispositivo), Baileys
 * arma `remoteJidAlt` desde `sender_pn || peer_recipient_pn` — y el sender
 * somos nosotros. Si el alt es nuestro propio número, NO es la contraparte:
 * usarlo persistiría un mapping falso `<lid del peer> → <nuestro PN>` que
 * después envenena `getPNForLID` para ese peer. Descartamos el alt en ese caso.
 */
function altIsSelf(sock, fromMe, alt) {
    if (!fromMe || !alt) return false
    const me = normalize(sock?.user?.id)
    return Boolean(me) && me === alt
}

/** Normaliza a jid de chat sin device: `5959xxx:0@s.whatsapp.net` → `5959xxx@s.whatsapp.net` */
function normalize(jid) {
    if (typeof jid !== 'string' || !jid.includes('@')) return null
    try {
        const normalized = jidNormalizedUser(jid)
        return normalized || null
    } catch {
        return null
    }
}

/**
 * Persiste un par LID/PN en el store de Baileys. Fire-and-forget: nunca throws.
 * El store valida internamente que uno sea @lid y el otro @s.whatsapp.net.
 */
export async function rememberLidPair(sock, lid, pn) {
    const store = lidStore(sock)
    if (!store) return
    const lidJid = normalize(lid)
    const pnJid = normalize(pn)
    if (!lidJid || !pnJid) return
    if (!isLidUser(lidJid) || !isPnUser(pnJid)) return
    try {
        await store.storeLIDPNMappings([{ lid: lidJid, pn: pnJid }])
    } catch (err) {
        // Un mapping perdido no justifica tumbar el procesamiento del mensaje.
        console.warn(`[lid] storeLIDPNMappings failed: ${err?.message ?? err}`)
    }
}

/**
 * Resuelve un JID @lid a su JID telefónico (@s.whatsapp.net), sin device.
 * Solo lee del store local — no genera tráfico de red.
 * Devuelve null si el mapping todavía no se aprendió.
 */
export async function resolvePn(sock, lidJid) {
    const store = lidStore(sock)
    if (!store || !isLidUser(lidJid)) return null
    try {
        return normalize(await store.getPNForLID(lidJid))
    } catch (err) {
        console.warn(`[lid] getPNForLID(${lidJid}) failed: ${err?.message ?? err}`)
        return null
    }
}

/**
 * A partir de una key de mensaje, aprende los pares LID/PN que trae y devuelve
 * las cuatro identidades que espera el SAAS:
 *
 *   senderPn / senderLid           → contraparte del chat 1:1 (null en grupos)
 *   participantPn / participantLid → autor del mensaje dentro de un grupo
 *
 * En Baileys 7 la key trae `remoteJidAlt` (1:1) y `participantAlt` (grupos):
 * el "otro formato" del mismo usuario. Si `remoteJid` es @lid, `remoteJidAlt`
 * es el @s.whatsapp.net, y viceversa.
 */
export async function resolveAddressing(sock, key) {
    const out = {
        senderPn: null,
        senderLid: null,
        participantPn: null,
        participantLid: null,
    }
    if (!key) return out

    const remoteJid = normalize(key.remoteJid)
    const isGroup = Boolean(isJidGroup(key.remoteJid))

    if (!isGroup) {
        const pair = await resolvePair(sock, remoteJid, key.remoteJidAlt, key.fromMe)
        out.senderPn = pair.pn
        out.senderLid = pair.lid
    }

    // `participant` solo viene en grupos; en 1:1 queda null y no lo tocamos.
    if (key.participant) {
        const pair = await resolvePair(
            sock,
            normalize(key.participant),
            key.participantAlt,
            key.fromMe
        )
        out.participantPn = pair.pn
        out.participantLid = pair.lid
    }

    return out
}

/**
 * Dado el jid primario y su alternativo, decide cuál es el PN y cuál el LID,
 * completando el PN desde el store cuando el alternativo no vino.
 */
async function resolvePair(sock, primary, altRaw, fromMe = false) {
    let alt = normalize(altRaw)
    if (altIsSelf(sock, fromMe, alt)) alt = null
    let pn = null
    let lid = null

    if (primary && isPnUser(primary)) pn = primary
    else if (primary && isLidUser(primary)) lid = primary

    if (alt && isPnUser(alt)) pn = pn ?? alt
    else if (alt && isLidUser(alt)) lid = lid ?? alt

    // Si el mensaje nos dio ambos formatos, lo aprendemos para el futuro
    // (mensajes donde solo llegue el @lid).
    if (pn && lid) {
        await rememberLidPair(sock, lid, pn)
        return { pn, lid }
    }

    // Solo tenemos el @lid: lo resolvemos contra el store local.
    if (lid && !pn) pn = await resolvePn(sock, lid)

    return { pn, lid }
}

/**
 * JID de chat canónico: si `remoteJid` viene como @lid, devuelve el
 * @s.whatsapp.net equivalente. Si no se puede resolver, devuelve null para que
 * el llamador decida (descartar inbound vs dejar pasar outbound).
 */
export async function canonicalChatJid(sock, key) {
    const remoteJid = key?.remoteJid
    if (typeof remoteJid !== 'string') return null
    if (!isLidUser(remoteJid)) return remoteJid

    const alt = normalize(key.remoteJidAlt)
    if (alt && isPnUser(alt) && !altIsSelf(sock, key.fromMe, alt)) {
        await rememberLidPair(sock, remoteJid, alt)
        return alt
    }
    return await resolvePn(sock, remoteJid)
}
