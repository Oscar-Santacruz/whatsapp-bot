import { createHmac, timingSafeEqual } from 'crypto'

// POST /media/firmar — URLs firmadas de la media que el bot guardó en su bucket.
//
// Por qué existe: el bucket `conversaciones` es privado y vive en el Supabase de
// este bot. Para abrir una foto o un audio, la app dueña de la sesión (KuSystem)
// necesitaba la service_role de ESE proyecto, una llave que bypasea el RLS de
// todo lo que hay ahí (incluida la media de flota). En vez de replicarla en cada
// app, el bot firma por ellas: la llave no sale de este proceso.
//
// Autenticación: HMAC-SHA256 con el MISMO secret de la ruta de entrada de la
// org (el que la app registró en PUT /api/org-inbound-routes/:orgId y con el
// que el bot firma sus webhooks), en sentido inverso. Es lo que prueba que quien
// llama es la app dueña de esa sesión: el API_TOKEN es global y no distingue a
// KuSystem de flota. El secret firma `${ts}\n${paths.join('\n')}` (no el body
// crudo: express ya lo parseó) y `ts` (segundos) tiene que estar a ±5 min.
//
// Autorización: el orgId sale del prefijo de cada path ('<orgId>/<archivo>').
// Cada org que aparece tiene que tener ruta PROPIA (env o registrada) y su
// secret tiene que verificar la firma. Las orgs de flota caen al destino por
// defecto, que no cuenta como propio: KuSystem no puede pedir sus archivos.

export const MAX_PATHS = 100
export const TTL_SEGUNDOS = 60 * 60
export const VENTANA_TS_SEGUNDOS = 5 * 60

/** `<orgId>/<archivo>`: un solo nivel, sin `..` ni caracteres raros. */
const PATH_RE = /^([A-Za-z0-9_-]{1,64})\/[A-Za-z0-9_-]{1,128}\.[A-Za-z0-9]{1,8}$/

export function canonicoMediaFirmar(ts, paths) {
    return `${ts}\n${paths.join('\n')}`
}

export function firmaMediaFirmar(secret, ts, paths) {
    return `sha256=${createHmac('sha256', secret).update(canonicoMediaFirmar(ts, paths), 'utf8').digest('hex')}`
}

function firmaValida(esperada, recibida) {
    if (typeof recibida !== 'string') return false
    const a = Buffer.from(esperada)
    const b = Buffer.from(recibida)
    return a.length === b.length && timingSafeEqual(a, b)
}

/**
 * @param {object} p
 * @param {unknown} p.body                 `{ ts, paths }`
 * @param {string|undefined} p.signature   header X-Hub-Signature-256
 * @param {(orgId: string) => string|null} p.secretPropio  secret de la ruta propia de la org, o null
 * @param {(paths: string[]) => Promise<Array<{path: string|null, signedUrl?: string}>>} p.firmar
 * @param {number} [p.ahora]               epoch en segundos (inyectable para tests)
 * @returns {Promise<{status: number, body: object}>}
 */
export async function firmarMedia({ body, signature, secretPropio, firmar, ahora = Math.floor(Date.now() / 1000) }) {
    const { ts, paths } = body ?? {}
    if (!Array.isArray(paths) || paths.length === 0 || !Number.isInteger(ts)) {
        return { status: 400, body: { error: 'Invalid body (ts, paths)' } }
    }
    if (paths.length > MAX_PATHS) {
        return { status: 400, body: { error: `Too many paths (max ${MAX_PATHS})` } }
    }

    const orgIds = new Set()
    for (const p of paths) {
        const m = typeof p === 'string' ? PATH_RE.exec(p) : null
        if (!m) return { status: 400, body: { error: 'Invalid path' } }
        orgIds.add(m[1])
    }

    if (Math.abs(ahora - ts) > VENTANA_TS_SEGUNDOS) {
        return { status: 401, body: { error: 'Stale timestamp' } }
    }

    // Todas las orgs del pedido tienen que ser de quien firma. Mismo 401 para
    // "sin ruta propia" y "firma mala": no revela qué orgs existen.
    for (const orgId of orgIds) {
        const secret = secretPropio(orgId)
        if (!secret || !firmaValida(firmaMediaFirmar(secret, ts, paths), signature)) {
            return { status: 401, body: { error: 'Invalid signature' } }
        }
    }

    const unicos = [...new Set(paths)]
    const filas = await firmar(unicos)
    const urls = {}
    for (const f of filas ?? []) {
        // `path` viene null cuando ese archivo puntual no existe.
        if (f?.path && f.signedUrl) urls[f.path] = f.signedUrl
    }
    return { status: 200, body: { urls } }
}
