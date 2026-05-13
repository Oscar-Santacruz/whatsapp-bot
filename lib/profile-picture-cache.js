/**
 * Caché en memoria de URLs de foto de perfil (contactos 1:1 y grupos).
 *
 * Las URLs que devuelve `sock.profilePictureUrl(jid, 'image')` caducan en el
 * CDN de WhatsApp y, si el bot llama el método por cada mensaje recibido, un
 * grupo activo dispara cientos de calls/min que terminan en rate-limit/baneo.
 *
 * Por eso cacheamos:
 *  - 6 horas para URLs válidas (no nulas)
 *  - 30 minutos para "sin foto" (null), para detectar relativamente rápido
 *    cuando el usuario sube una foto nueva.
 *
 * La caché se invalida explícitamente desde `whatsapp.js` cuando llegan
 * eventos `contacts.update` (con `imgUrl` cambiado), `groups.update` (con
 * `pictureUrl`/`subject` cambiado) o `group-participants.update`.
 *
 * Multi-tenant: la clave externa es `orgId`, ya que cada org tiene su propio
 * `sock` y dos orgs pueden ver fotos distintas para el mismo `jid` según
 * privacidad/contactos.
 */

const URL_TTL_MS = 6 * 60 * 60 * 1000
const NULL_TTL_MS = 30 * 60 * 1000

// orgId → Map<jid, { url: string | null, fetchedAt: number, setAt: string | null }>
const caches = new Map()

function getOrgCache(orgId) {
    let c = caches.get(orgId)
    if (!c) {
        c = new Map()
        caches.set(orgId, c)
    }
    return c
}

export function invalidateProfilePicture(orgId, jid) {
    if (!orgId || !jid) return
    const c = caches.get(orgId)
    if (c) c.delete(jid)
}

export function clearOrgProfilePictureCache(orgId) {
    if (!orgId) return
    caches.delete(orgId)
}

/**
 * Devuelve `{ url, fetchedAt, setAt }` para `jid` en `orgId`.
 *
 *  - Si el caché tiene una entrada fresca, la devuelve sin tocar a Baileys.
 *  - Si `force=true`, ignora el TTL y consulta a Baileys igual.
 *  - Si Baileys devuelve 404 / not-authorized → cachea `url = null`
 *    (foto privada o sin foto).
 *  - Si falla por timeout/red/rate-limit → NO cachea, devuelve la entrada
 *    previa si existe (o `{ url: null, setAt: null }` como fallback).
 *
 * NUNCA throws: los errores se loguean.
 */
export async function getProfilePictureCached(orgId, sock, jid, opts = {}) {
    const force = opts.force === true
    const now = Date.now()

    if (!orgId || !jid) {
        return { url: null, fetchedAt: now, setAt: null }
    }

    const c = getOrgCache(orgId)
    const hit = c.get(jid)

    if (!force && hit) {
        const ttl = hit.url ? URL_TTL_MS : NULL_TTL_MS
        if (now - hit.fetchedAt < ttl) return hit
    }

    if (!sock || typeof sock.profilePictureUrl !== 'function') {
        return hit ?? { url: null, fetchedAt: now, setAt: null }
    }

    let url = null
    try {
        url = await sock.profilePictureUrl(jid, 'image')
        if (typeof url !== 'string' || !url) url = null
    } catch (err) {
        const statusCode =
            err?.output?.statusCode ??
            err?.data ??
            err?.status ??
            null
        const msg = String(err?.message ?? '')

        const isNoPic =
            statusCode === 401 ||
            statusCode === 404 ||
            msg.includes('not authorized') ||
            msg.includes('item-not-found') ||
            msg.includes('no profile picture')

        if (!isNoPic) {
            // 408 / 429 / network / decrypt → no cachear; preservar entrada anterior.
            console.warn(
                `[profile-pic ${orgId}] fetch failed for ${jid}: ${msg} (status=${statusCode})`
            )
            return hit ?? { url: null, fetchedAt: now, setAt: null }
        }
        url = null
    }

    const entry = {
        url,
        fetchedAt: now,
        // setAt informativo: cuándo el bot vio esta URL por última vez. Baileys
        // no expone el timestamp original del cambio en `profilePictureUrl`.
        setAt: new Date(now).toISOString(),
    }
    c.set(jid, entry)
    return entry
}
