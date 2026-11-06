// Las filas de bot.db que una sesión necesita en el otro bot cuando se muda (GET /api/session/export y
// POST /api/session/import): la ruta registrada del webhook omnichannel, org_settings, la cola que el
// release dejó en `released` y los batches de esa cola. La carpeta de Baileys va aparte (tar por `render ssh`).
//
// El export lleva el secret de la ruta: sale solo en la respuesta autenticada y nunca se loguea.

import { db, now, getOrgInboundRoute, upsertOrgInboundRoute, setOrgSettings } from './db.js'
import { validarRutaInbound } from './inbound-route.js'

// Las columnas que hacen falta para volver a mandar el envío.
const COLUMNAS_COLA = [
    'batch_id', 'kind', 'phone', 'message', 'document_base64', 'document_filename', 'document_mimetype',
    'metadata_json', 'quoted_message_id', 'quoted_job_id', 'status_options', 'created_at',
]
const COLUMNAS_BATCH = ['id', 'total', 'sent', 'failed', 'status', 'callback_url', 'created_at']

/** Cuántos envíos por página del export: cada uno puede traer un archivo entero en `document_base64`. */
export const EXPORT_PAGE_MAX = 50
/**
 * Tope de archivos por página (largo del base64). El import entra por `express.json` con límite de 50 MB y el
 * contenedor tiene 512 MB: una página arma en memoria las filas y el JSON. Siempre va al menos un envío.
 */
export const EXPORT_PAGE_BYTES = 15 * 1024 * 1024

db.exec(`
-- Qué envíos ya se importaron de otro bot, por su id y su created_at en el origen: un import repetido
-- (reintento, export pedido de nuevo, ida y vuelta de la sesión) no vuelve a mandar lo que ya entró.
CREATE TABLE IF NOT EXISTS imported_jobs (
    org_id      TEXT    NOT NULL,
    source_id   INTEGER NOT NULL,
    created_at  INTEGER NOT NULL,
    job_id      INTEGER NOT NULL,
    imported_at INTEGER NOT NULL,
    PRIMARY KEY (org_id, source_id, created_at)
);
`)

const selectSettingsStmt = db.prepare(`SELECT reenviar_rechazos FROM org_settings WHERE org_id = ?`)
// Primero ids y tamaños, sin traer los archivos: la página se corta por bytes antes de leerlos.
const selectReleasedSizesStmt = db.prepare(`
    SELECT id, COALESCE(LENGTH(document_base64), 0) AS bytes FROM outgoing_queue
    WHERE org_id = ? AND status = 'released' AND id > ? ORDER BY id ASC LIMIT ?
`)
const selectJobStmt = db.prepare(`SELECT id, ${COLUMNAS_COLA.join(', ')} FROM outgoing_queue WHERE id = ?`)
// Un envío citado que ya salió por este bot: el otro lo cita por el id de WhatsApp.
const sentMessageIdStmt = db.prepare(`SELECT sent_message_id FROM outgoing_queue WHERE id = ? AND org_id = ? AND status = 'sent'`)
const selectBatchStmt = db.prepare(`SELECT ${COLUMNAS_BATCH.join(', ')} FROM batches WHERE id = ? AND org_id = ?`)
const selectImportedStmt = db.prepare(`SELECT job_id FROM imported_jobs WHERE org_id = ? AND source_id = ? AND created_at = ?`)
// El citado puede venir en una página anterior: se busca por su id de origen, el último que se importó.
const selectImportedBySourceStmt = db.prepare(`
    SELECT job_id FROM imported_jobs WHERE org_id = ? AND source_id = ? ORDER BY imported_at DESC, job_id DESC LIMIT 1
`)
const insertImportedStmt = db.prepare(`
    INSERT INTO imported_jobs (org_id, source_id, created_at, job_id, imported_at) VALUES (?, ?, ?, ?, ?)
`)
const insertJobStmt = db.prepare(`
    INSERT INTO outgoing_queue (org_id, ${COLUMNAS_COLA.join(', ')}, status, attempts)
    VALUES (@orgId, ${COLUMNAS_COLA.map((c) => `@${c}`).join(', ')}, 'pending', 0)
`)
// En una ida y vuelta el batch ya existe acá con contadores viejos: se quedan los más altos, si no el
// batch no llega nunca a `total` y el callback a flota no sale.
const insertBatchStmt = db.prepare(`
    INSERT INTO batches (org_id, ${COLUMNAS_BATCH.join(', ')})
    VALUES (@orgId, ${COLUMNAS_BATCH.map((c) => `@${c}`).join(', ')})
    ON CONFLICT(id) DO UPDATE SET sent = MAX(sent, excluded.sent), failed = MAX(failed, excluded.failed)
    WHERE batches.status = 'processing' AND batches.org_id = excluded.org_id
`)

/**
 * Lo de la sesión que el otro bot necesita, de a una página de cola (`after` = último `sourceId` recibido).
 * La cola son los envíos que el release frenó (`released`): una sesión que no se soltó no tiene cola para
 * exportar, así no sale nada que este bot todavía manda. `nextAfter` es null en la última página.
 *
 * Los batches van con sus contadores: el callback a flota lo dispara el bot que manda el último envío.
 */
export function exportSessionData(orgId, { after = 0, limit = EXPORT_PAGE_MAX } = {}) {
    const ruta = getOrgInboundRoute(orgId)
    const settings = selectSettingsStmt.get(orgId)
    const tope = Math.min(Math.max(1, limit), EXPORT_PAGE_MAX)
    const candidatos = selectReleasedSizesStmt.all(orgId, after, tope + 1)
    const ids = []
    let bytes = 0
    for (const c of candidatos.slice(0, tope)) {
        if (ids.length > 0 && bytes + c.bytes > EXPORT_PAGE_BYTES) break
        ids.push(c.id)
        bytes += c.bytes
    }
    const pagina = ids.map((id) => selectJobStmt.get(id))
    const hayMas = candidatos.length > ids.length

    const batches = new Map()
    for (const f of pagina) {
        if (f.batch_id && !batches.has(f.batch_id)) {
            const b = selectBatchStmt.get(f.batch_id, orgId)
            if (b) batches.set(f.batch_id, b)
        }
    }
    return {
        orgId,
        inboundRoute: ruta ? { url: ruta.url, secret: ruta.secret } : null,
        settings: settings ? { reenviarRechazos: settings.reenviar_rechazos === 1 } : null,
        batches: [...batches.values()],
        queue: pagina.map(({ id, ...fila }) => {
            if (fila.quoted_job_id != null && fila.quoted_message_id == null) {
                const enviado = sentMessageIdStmt.get(fila.quoted_job_id, orgId)?.sent_message_id
                if (enviado) return { sourceId: id, ...fila, quoted_message_id: enviado, quoted_job_id: null }
            }
            return { sourceId: id, ...fila }
        }),
        nextAfter: hayMas ? ids.at(-1) : null,
    }
}

const KINDS = new Set(['text', 'document', 'compound', 'image', 'video', 'gif', 'audio', 'sticker', 'location', 'status', 'delete'])
const esJsonONulo = (v) => {
    if (v == null) return true
    if (typeof v !== 'string') return false
    try { JSON.parse(v); return true } catch { return false }
}

/** `{ ok: true, value }` o `{ ok: false, error }`. Valida todo antes de escribir nada. */
function validarImport(orgId, data) {
    if (!data || typeof data !== 'object') return { ok: false, error: 'Missing data' }
    if (data.orgId !== orgId) return { ok: false, error: 'data.orgId no coincide con orgId' }

    let ruta = null
    if (data.inboundRoute != null) {
        const r = validarRutaInbound(data.inboundRoute)
        if (!r.ok) return { ok: false, error: `inboundRoute: ${r.error}` }
        ruta = { url: r.url, secret: r.secret }
    }

    let settings = null
    if (data.settings != null) {
        if (typeof data.settings.reenviarRechazos !== 'boolean') {
            return { ok: false, error: 'settings.reenviarRechazos tiene que ser boolean' }
        }
        settings = { reenviarRechazos: data.settings.reenviarRechazos }
    }

    const batches = data.batches ?? []
    if (!Array.isArray(batches)) return { ok: false, error: 'batches tiene que ser un array' }
    for (const [i, b] of batches.entries()) {
        if (typeof b?.id !== 'string' || !Number.isInteger(b.total) || !Number.isInteger(b.created_at)) {
            return { ok: false, error: `batches[${i}] inválido` }
        }
    }

    const cola = data.queue ?? []
    if (!Array.isArray(cola)) return { ok: false, error: 'queue tiene que ser un array' }
    for (const [i, fila] of cola.entries()) {
        if (!fila || typeof fila !== 'object') return { ok: false, error: `queue[${i}] inválida` }
        if (!KINDS.has(fila.kind) || typeof fila.phone !== 'string') {
            return { ok: false, error: `queue[${i}]: kind o phone inválidos` }
        }
        if (!Number.isInteger(fila.sourceId) || !Number.isInteger(fila.created_at)) {
            return { ok: false, error: `queue[${i}]: sourceId o created_at inválidos` }
        }
        for (const c of ['message', 'document_base64', 'document_filename', 'document_mimetype', 'quoted_message_id', 'batch_id']) {
            if (fila[c] != null && typeof fila[c] !== 'string') return { ok: false, error: `queue[${i}]: ${c} tiene que ser texto` }
        }
        if (fila.quoted_job_id != null && !Number.isInteger(fila.quoted_job_id)) {
            return { ok: false, error: `queue[${i}]: quoted_job_id inválido` }
        }
        if (!esJsonONulo(fila.metadata_json) || !esJsonONulo(fila.status_options)) {
            return { ok: false, error: `queue[${i}]: metadata_json o status_options no son JSON` }
        }
    }
    return { ok: true, value: { ruta, settings, batches, cola } }
}

/**
 * Inserta una página exportada por el otro bot, todo o nada, siempre con el `orgId` del parámetro: las filas
 * de otras orgs no se tocan. Los envíos entran como `pending` con ids nuevos. Un `quoted_job_id` se traduce
 * al id nuevo si el citado ya se importó (en esta página o en una anterior); si apunta afuera, se anula.
 *
 * Un envío que ya se importó se saltea: repetir el import (o importar dos veces el mismo export) no manda
 * nada dos veces. Un batch que ya existe acá suma los contadores más altos.
 */
export function importSessionData(orgId, data) {
    const v = validarImport(orgId, data)
    if (!v.ok) return { ok: false, status: 400, error: v.error }
    const { ruta, settings, batches, cola } = v.value

    return db.transaction(() => {
        if (ruta) upsertOrgInboundRoute({ orgId, url: ruta.url, secret: ruta.secret })
        if (settings) setOrgSettings(orgId, settings)
        for (const b of batches) {
            const valores = Object.fromEntries(COLUMNAS_BATCH.map((c) => [c, b[c] ?? null]))
            insertBatchStmt.run({ orgId, ...valores, sent: b.sent ?? 0, failed: b.failed ?? 0, status: b.status ?? 'processing' })
        }
        // Un envío cuenta solo para un batch de esta org: `recordSent` actualiza por id, sin mirar la org.
        const batchDeLaOrg = (id) => (id != null && selectBatchStmt.get(id, orgId) ? id : null)

        let queued = 0
        let skipped = 0
        const ids = new Map()
        // El citado sale antes que el que cita (misma sesión, en orden), así que ya se importó.
        const idImportado = (sourceId) => ids.get(sourceId) ?? selectImportedBySourceStmt.get(orgId, sourceId)?.job_id ?? null
        for (const fila of cola) {
            if (selectImportedStmt.get(orgId, fila.sourceId, fila.created_at)) {
                skipped++
                continue
            }
            const valores = Object.fromEntries(COLUMNAS_COLA.map((c) => [c, fila[c] ?? null]))
            valores.quoted_job_id = Number.isInteger(fila.quoted_job_id) ? idImportado(fila.quoted_job_id) : null
            valores.batch_id = batchDeLaOrg(fila.batch_id)
            const jobId = Number(insertJobStmt.run({ orgId, ...valores }).lastInsertRowid)
            insertImportedStmt.run(orgId, fila.sourceId, fila.created_at, jobId, now())
            ids.set(fila.sourceId, jobId)
            queued++
        }
        return { ok: true, route: Boolean(ruta), settings: Boolean(settings), queued, skipped }
    })()
}
