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
// Tras un timeout o error de red: hay contactos nuevos a los que WhatsApp no
// les contesta la consulta de la foto nunca, y reintentarla en cada mensaje
// deja cada uno esperando el tope de org-inbound.
const FAILED_TTL_MS = 10 * 60 * 1000

// orgId → Map<jid, { url: string | null, fetchedAt: number, setAt: string | null }>
const caches = new Map()
// `${orgId}|${jid}` → Promise de la consulta en curso. Los mensajes que llegan
// mientras la primera consulta sigue abierta la comparten en vez de abrir otra.
const inflight = new Map()

function getOrgCache(orgId) {
    let c = caches.get(orgId)
    if (!c) {
        c = new Map()
        caches.set(orgId, c)
    }
    return c
}

/** ¿Hay una consulta de foto abierta para este contacto? */
export function isProfilePictureInflight(orgId, jid) {
    return inflight.has(`${orgId}|${jid}`)
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
 *  - Si falla por timeout/red/rate-limit → conserva la URL previa (o null) y
 *    no vuelve a consultar por FAILED_TTL_MS.
 *
 * NUNCA throws: los errores se loguean.
 */
export function getProfilePictureCached(orgId, sock, jid, opts = {}) {
    if (!orgId || !jid) {
        return Promise.resolve({ url: null, fetchedAt: Date.now(), setAt: null })
    }
    const clave = `${orgId}|${jid}`
    const enCurso = inflight.get(clave)
    if (enCurso && opts.force !== true) return enCurso
    const promesa = fetchProfilePicture(orgId, sock, jid, opts).finally(() => {
        if (inflight.get(clave) === promesa) inflight.delete(clave)
    })
    inflight.set(clave, promesa)
    return promesa
}

async function fetchProfilePicture(orgId, sock, jid, opts) {
    const force = opts.force === true
    const now = Date.now()

    if (!orgId || !jid) {
        return { url: null, fetchedAt: now, setAt: null }
    }

    const c = getOrgCache(orgId)
    const hit = c.get(jid)

    if (!force && hit) {
        const ttl = hit.failed ? FAILED_TTL_MS : hit.url ? URL_TTL_MS : NULL_TTL_MS
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
            // Baileys lo manda con guión y status 500: sin esto una foto
            // privada nunca se cacheaba y se volvía a pedir en cada mensaje.
            msg.includes('not-authorized') ||
            msg.includes('item-not-found') ||
            msg.includes('no profile picture')

        if (!isNoPic) {
            // 408 / 429 / network / decrypt → conservar la foto anterior y no
            // volver a preguntar hasta FAILED_TTL_MS.
            console.warn(
                `[profile-pic ${orgId}] fetch failed for ${jid}: ${msg} (status=${statusCode})`
            )
            const fallido = {
                url: hit?.url ?? null,
                fetchedAt: Date.now(),
                setAt: hit?.setAt ?? null,
                failed: true,
            }
            c.set(jid, fallido)
            return fallido
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
