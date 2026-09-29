// Validación de la ruta que una app registra para el webhook omnichannel de su
// sesión (PUT /api/org-inbound-routes/:orgId).
//
// Es lo único que separa a un cliente de la API de mandar los mensajes de una
// sesión a cualquier lado, así que es estricta con lo que se puede validar sin
// conocer al destino: esquema, host, credenciales embebidas y largo. El secret se
// pide no vacío y nada más: es el mismo que ya viaja en ORG_INBOUND_ROUTES, que
// no tiene mínimo, y rechazar uno corto dejaría a la org sin ruta, que es el
// modo de falla silencioso que este ruteo existe para evitar.

/** El mismo criterio y el mismo tope que `ORG_ID_SEGURO` de lib/whatsapp.js. */
const ORG_ID_RE = /^[A-Za-z0-9_-]{1,64}$/
const URL_MAX = 2048
const SECRET_MAX = 512
/** Celeste tiene su propio webhook: el omnichannel no la atiende. */
const ORG_IDS_RESERVADOS = new Set(['_celeste'])

/** ¿El orgId de la ruta es uno que este servicio acepta registrar? */
export function esOrgIdRegistrable(orgId) {
    return typeof orgId === 'string' && ORG_ID_RE.test(orgId) && !ORG_IDS_RESERVADOS.has(orgId)
}

/**
 * ¿El host es la propia máquina (o "cualquier interfaz")? Dentro del contenedor
 * del bot eso no es KuSystem: una ruta así entrega a la nada, y como la
 * registrada le gana al destino por defecto la org no cae a flota, queda sin
 * destino y el estado sigue diciendo que tiene ruta.
 */
function esHostLocal(hostname) {
    return (
        hostname === 'localhost' ||
        hostname.endsWith('.localhost') ||
        hostname === '0.0.0.0' ||
        hostname === '[::1]' ||
        hostname === '[::]' ||
        /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)
    )
}

/**
 * Valida `{ url, secret }`. Devuelve `{ ok: true, url, secret }` con la URL ya
 * normalizada, o `{ ok: false, error }` con un motivo que se le puede devolver
 * a quien llamó (nunca incluye el secret).
 *
 * Un host local solo se acepta con ORG_INBOUND_ALLOW_LOCAL=1: es para probar
 * contra la propia máquina (tests, desarrollo), no se prende en producción. El
 * caso real es un KuSystem de desarrollo apuntando al bot de producción, que
 * arma su URL con `http://localhost:3000` y pisaría la ruta buena de un tenant.
 */
export function validarRutaInbound(body) {
    const { url, secret } = body ?? {}

    if (typeof url !== 'string' || !url.trim()) return { ok: false, error: 'Missing url' }
    if (typeof secret !== 'string' || !secret) return { ok: false, error: 'Missing secret' }
    if (url.length > URL_MAX) return { ok: false, error: 'Invalid url (too long)' }
    if (secret.length > SECRET_MAX) return { ok: false, error: 'Invalid secret (too long)' }

    let parsed
    try {
        parsed = new URL(url.trim())
    } catch {
        return { ok: false, error: 'Invalid url' }
    }

    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        return { ok: false, error: 'Invalid url (must be https)' }
    }
    if (parsed.username || parsed.password) {
        return { ok: false, error: 'Invalid url (no credentials allowed)' }
    }

    if (esHostLocal(parsed.hostname)) {
        if (process.env.ORG_INBOUND_ALLOW_LOCAL !== '1') {
            return { ok: false, error: 'Invalid url (local host not allowed)' }
        }
    } else if (parsed.protocol !== 'https:') {
        // Sin https los mensajes de los clientes viajan en claro, y el HMAC solo
        // firma: no cifra.
        return { ok: false, error: 'Invalid url (must be https)' }
    }

    return { ok: true, url: parsed.toString(), secret }
}

/** Host de una URL para los logs: alcanza para saber a dónde va sin escribir el path. */
export function hostDe(url) {
    try {
        return new URL(url).host
    } catch {
        return 'url inválida'
    }
}
