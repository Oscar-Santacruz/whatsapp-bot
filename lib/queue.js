import { db, now } from './db.js'
import { saveMessage } from './store.js'
import { resolveQuoted } from './quoted.js'
import { recordSent, recordFailed } from './batch.js'

const enqueueStmt = db.prepare(`
    INSERT INTO outgoing_queue
        (org_id, batch_id, phone, kind, message,
         document_base64, document_filename, document_mimetype,
         metadata_json, quoted_message_id, quoted_job_id, created_at)
    VALUES
        (@orgId, @batchId, @phone, @kind, @message,
         @documentBase64, @documentFilename, @documentMimetype,
         @metadataJson, @quotedMessageId, @quotedJobId, @createdAt)
`)

// Statement propio para estados: incluye status_options (jidList + estilo de texto)
// y no cita ningún mensaje. Mantiene intacto el enqueueStmt compartido.
const enqueueStatusStmt = db.prepare(`
    INSERT INTO outgoing_queue
        (org_id, batch_id, phone, kind, message,
         document_base64, document_filename, document_mimetype,
         status_options, metadata_json, created_at)
    VALUES
        (@orgId, @batchId, @phone, @kind, @message,
         @documentBase64, @documentFilename, @documentMimetype,
         @statusOptions, @metadataJson, @createdAt)
`)

const nextPendingStmt = db.prepare(`
    SELECT * FROM outgoing_queue
    WHERE org_id = ? AND status = 'pending'
    ORDER BY id ASC LIMIT 1
`)

const markSendingStmt = db.prepare(`UPDATE outgoing_queue SET status = 'sending', attempts = attempts + 1 WHERE id = ?`)
const markPendingStmt = db.prepare(`UPDATE outgoing_queue SET status = 'pending' WHERE id = ?`)
const markSentStmt    =db.prepare(`UPDATE outgoing_queue SET status = 'sent',    sent_at = ?, sent_message_id = ? WHERE id = ?`)
const markFailedStmt  = db.prepare(`UPDATE outgoing_queue SET status = 'failed',  error = ?         WHERE id = ?`)

// El id de WhatsApp con el que salió un envío de la misma sesión (null si falló o todavía no salió).
const sentMessageIdStmt = db.prepare(`SELECT sent_message_id FROM outgoing_queue WHERE id = ? AND org_id = ?`)

// On startup: reset any jobs stuck in 'sending' (process crashed mid-flight).
// Status jobs are NOT re-queued: a duplicated story is visible spam, so we fail
// them instead of risking a re-publish (we can't know if it went out or not).
db.prepare(`UPDATE outgoing_queue SET status = 'failed', error = 'interrupted: status not retried to avoid duplicate' WHERE status = 'sending' AND kind = 'status'`).run()
db.prepare(`UPDATE outgoing_queue SET status = 'pending' WHERE status = 'sending'`).run()

const workers = new Map()
let socketProvider = null

// ── Anti-ban delay config (ms) ────────────────────────────────────────────────
// Delay aleatorio entre mensajes consecutivos de una misma org/sesión.
// Bajar estos valores aumenta el riesgo de ban por parte de WhatsApp.
const DEFAULT_SEND_DELAY_MIN_MS = 5000
const DEFAULT_SEND_DELAY_MAX_MS = 10000

function parseDelayMs(raw, fallback) {
    if (raw === undefined || raw === null || raw === '') return fallback
    if (!/^-?\d+$/.test(String(raw).trim())) return fallback
    const n = Number(raw)
    if (!Number.isFinite(n) || n < 0) return fallback
    return n
}

let SEND_DELAY_MIN_MS = parseDelayMs(process.env.SEND_DELAY_MIN_MS, DEFAULT_SEND_DELAY_MIN_MS)
let SEND_DELAY_MAX_MS = parseDelayMs(process.env.SEND_DELAY_MAX_MS, DEFAULT_SEND_DELAY_MAX_MS)

if (SEND_DELAY_MIN_MS > SEND_DELAY_MAX_MS) {
    console.warn(
        `[queue] SEND_DELAY_MIN_MS (${SEND_DELAY_MIN_MS}) > SEND_DELAY_MAX_MS (${SEND_DELAY_MAX_MS}); ` +
        `falling back to defaults ${DEFAULT_SEND_DELAY_MIN_MS}-${DEFAULT_SEND_DELAY_MAX_MS}ms`
    )
    SEND_DELAY_MIN_MS = DEFAULT_SEND_DELAY_MIN_MS
    SEND_DELAY_MAX_MS = DEFAULT_SEND_DELAY_MAX_MS
}

console.log(`[queue] send delay range: ${SEND_DELAY_MIN_MS}-${SEND_DELAY_MAX_MS}ms`)

// ── Public API ────────────────────────────────────────────────────────────────

export function setSocketProvider(fn) {
    socketProvider = fn
}

export function enqueueText({ orgId, phone, message, batchId = null, metadata = null, quotedMessageId = null, quotedJobId = null }) {
    const result = enqueueStmt.run({
        orgId, batchId, phone, kind: 'text', message,
        documentBase64: null, documentFilename: null, documentMimetype: null,
        metadataJson: metadata ? JSON.stringify(metadata) : null,
        quotedMessageId,
        quotedJobId,
        createdAt: now(),
    })
    ensureWorker(orgId)
    return result.lastInsertRowid
}

export function enqueueDocument({ orgId, phone, file, fileName, mimetype, batchId = null, metadata = null }) {
    const result = enqueueStmt.run({
        orgId, batchId, phone, kind: 'document',
        message: null,
        documentBase64: file,
        documentFilename: fileName,
        documentMimetype: mimetype || 'application/pdf',
        metadataJson: metadata ? JSON.stringify(metadata) : null,
        quotedMessageId: null,
        quotedJobId: null,
        createdAt: now(),
    })
    ensureWorker(orgId)
    return result.lastInsertRowid
}

/**
 * Compound message: text + document sent as one atomic unit.
 * If text send fails → document is skipped.
 * Both count as a single slot in the batch.
 */
export function enqueueCompound({ orgId, phone, message, file, fileName, mimetype, batchId = null, metadata = null }) {
    const result = enqueueStmt.run({
        orgId, batchId, phone, kind: 'compound',
        message,
        documentBase64: file,
        documentFilename: fileName,
        documentMimetype: mimetype || 'application/pdf',
        metadataJson: metadata ? JSON.stringify(metadata) : null,
        quotedMessageId: null,
        quotedJobId: null,
        createdAt: now(),
    })
    ensureWorker(orgId)
    return result.lastInsertRowid
}

export function enqueueImage({ orgId, phone, file, mimetype, caption = null, batchId = null, metadata = null, quotedMessageId = null, quotedJobId = null }) {
    const result = enqueueStmt.run({
        orgId, batchId, phone, kind: 'image',
        message: caption,
        documentBase64: file,
        documentFilename: null,
        documentMimetype: mimetype || 'image/jpeg',
        metadataJson: metadata ? JSON.stringify(metadata) : null,
        quotedMessageId,
        quotedJobId,
        createdAt: now(),
    })
    ensureWorker(orgId)
    return result.lastInsertRowid
}

export function enqueueVideo({ orgId, phone, file, mimetype, caption = null, gifPlayback = false, batchId = null, metadata = null }) {
    const result = enqueueStmt.run({
        orgId, batchId, phone, kind: gifPlayback ? 'gif' : 'video',
        message: caption,
        documentBase64: file,
        documentFilename: null,
        documentMimetype: mimetype || 'video/mp4',
        metadataJson: metadata ? JSON.stringify(metadata) : null,
        quotedMessageId: null,
        quotedJobId: null,
        createdAt: now(),
    })
    ensureWorker(orgId)
    return result.lastInsertRowid
}

export function enqueueAudio({ orgId, phone, file, mimetype, batchId = null, metadata = null }) {
    const result = enqueueStmt.run({
        orgId, batchId, phone, kind: 'audio',
        message: null,
        documentBase64: file,
        documentFilename: null,
        documentMimetype: mimetype || 'audio/ogg; codecs=opus',
        metadataJson: metadata ? JSON.stringify(metadata) : null,
        quotedMessageId: null,
        quotedJobId: null,
        createdAt: now(),
    })
    ensureWorker(orgId)
    return result.lastInsertRowid
}

export function enqueueSticker({ orgId, phone, file, mimetype, batchId = null, metadata = null }) {
    const result = enqueueStmt.run({
        orgId, batchId, phone, kind: 'sticker',
        message: null,
        documentBase64: file,
        documentFilename: null,
        documentMimetype: mimetype || 'image/webp',
        metadataJson: metadata ? JSON.stringify(metadata) : null,
        quotedMessageId: null,
        quotedJobId: null,
        createdAt: now(),
    })
    ensureWorker(orgId)
    return result.lastInsertRowid
}

/**
 * Ubicación con pin (la tarjeta de mapa de WhatsApp, no un link). La cola no
 * tiene columnas de coordenadas: el punto viaja como JSON en `message`, que en
 * este kind no tiene otro uso.
 */
export function enqueueLocation({ orgId, phone, latitude, longitude, name = null, address = null, batchId = null, metadata = null }) {
    const result = enqueueStmt.run({
        orgId, batchId, phone, kind: 'location',
        message: JSON.stringify({ latitude, longitude, name, address }),
        documentBase64: null,
        documentFilename: null,
        documentMimetype: null,
        metadataJson: metadata ? JSON.stringify(metadata) : null,
        quotedMessageId: null,
        quotedJobId: null,
        createdAt: now(),
    })
    ensureWorker(orgId)
    return result.lastInsertRowid
}

/**
 * Publica un estado (status@broadcast). A diferencia de un mensaje, requiere
 * `recipients`: los JIDs que verán el estado. Sin esa lista, el estado se
 * publica pero no lo ve nadie. `backgroundColor`/`font` solo aplican a estados
 * de texto; el tipo de media se deriva del mimetype en processOne.
 */
export function enqueueStatus({ orgId, recipients, message = null, file = null, mimetype = null, backgroundColor = null, font = null, metadata = null }) {
    const statusOptions = JSON.stringify({
        jidList: recipients,
        ...(backgroundColor ? { backgroundColor } : {}),
        ...(font !== null && font !== undefined ? { font } : {}),
    })
    const result = enqueueStatusStmt.run({
        orgId,
        batchId: null,
        phone: 'status@broadcast',
        kind: 'status',
        message,
        documentBase64: file,
        documentFilename: null,
        documentMimetype: file ? (mimetype || 'image/jpeg') : null,
        statusOptions,
        metadataJson: metadata ? JSON.stringify(metadata) : null,
        createdAt: now(),
    })
    ensureWorker(orgId)
    return result.lastInsertRowid
}

export function resumeAllWorkers() {
    const orgs = db.prepare(`SELECT DISTINCT org_id FROM outgoing_queue WHERE status = 'pending'`).all()
    for (const { org_id } of orgs) {
        ensureWorker(org_id)
    }
}

// ── Rate-limit de estados (anti-ban) ──────────────────────────────────────────
// Publicar estados automatizados es sensible para WhatsApp. El uso humano es
// esporádico, así que limitamos cuántos estados se encolan por ventana de tiempo.
const STATUS_MAX_PER_HOUR = parseInt(process.env.WA_STATUS_MAX_PER_HOUR || '5', 10)
const STATUS_MAX_PER_DAY  = parseInt(process.env.WA_STATUS_MAX_PER_DAY  || '20', 10)

const countStatusSinceStmt = db.prepare(`
    SELECT COUNT(*) AS n FROM outgoing_queue
    WHERE org_id = ? AND kind = 'status' AND created_at > ?
`)

/**
 * Devuelve { ok: true } o { ok: false, scope, limit, count } si la org superó
 * el cupo de estados por hora o por día. Se mide por created_at (intentos).
 */
export function checkStatusRateLimit(orgId) {
    const nowMs = now()
    const lastHour = countStatusSinceStmt.get(orgId, nowMs - 3_600_000).n
    if (lastHour >= STATUS_MAX_PER_HOUR) {
        return { ok: false, scope: 'hour', limit: STATUS_MAX_PER_HOUR, count: lastHour }
    }
    const lastDay = countStatusSinceStmt.get(orgId, nowMs - 86_400_000).n
    if (lastDay >= STATUS_MAX_PER_DAY) {
        return { ok: false, scope: 'day', limit: STATUS_MAX_PER_DAY, count: lastDay }
    }
    return { ok: true }
}

// ── Worker ────────────────────────────────────────────────────────────────────

function randomBetween(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms))
}

function cleanPhoneToJid(phone) {
    if (phone.includes('@')) return phone
    return `${phone.replace(/[\+\-\s\(\)]/g, '')}@s.whatsapp.net`
}

async function resolveTarget(sock, jid) {
    try {
        const onWa = await sock.onWhatsApp(jid)
        const result = Array.isArray(onWa) ? onWa[0] : null
        if (!result?.exists) throw new Error('Phone not registered on WhatsApp')
        return result.jid || jid
    } catch (e) {
        if (e.message.includes('not registered')) throw e
        return jid // fallback on network errors
    }
}

async function humanLikeSend(sock, jid, content, options = {}) {
    // status@broadcast no es un chat: no hay presencia que simular. Conservamos
    // solo el delay anti-ban antes de publicar.
    if (jid === 'status@broadcast') {
        await delay(randomBetween(1500, 3500))
        return await sock.sendMessage(jid, content, options)
    }
    try { await sock.presenceSubscribe(jid) } catch {}
    await delay(randomBetween(400, 1200))
    try { await sock.sendPresenceUpdate('composing', jid) } catch {}
    await delay(randomBetween(1500, 3500))
    try { await sock.sendPresenceUpdate('paused', jid) } catch {}
    return await sock.sendMessage(jid, content, options)
}

/**
 * La cita de un envío, como la pide Baileys: `options.quoted` (key + message). Puesta dentro del contenido
 * se ignora y la respuesta sale como un mensaje suelto.
 *
 * Se responde a un mensaje por su id de WhatsApp (`quoted_message_id`) o a lo que mandó un envío anterior
 * de la cola (`quoted_job_id`): quien encola dos mensajes seguidos no conoce el id del primero, que recién
 * existe cuando sale, pero sí su número de envío. La cola de una sesión sale en orden, así que el envío
 * citado ya se procesó. Si falló, si el mensaje no es de este chat o si ya se limpió del store, sale sin cita.
 */
async function quoteOptions(sock, orgId, target, job) {
    const messageId = job.quoted_message_id
        ?? (job.quoted_job_id ? sentMessageIdStmt.get(job.quoted_job_id, orgId)?.sent_message_id : null)

    if (!messageId) {
        if (job.quoted_job_id) console.warn(`[queue] ${orgId}: el envío #${job.quoted_job_id} no salió por esta sesión, #${job.id} va sin cita`)
        return {}
    }

    const quoted = await resolveQuoted(sock, orgId, target, messageId)
    if (quoted) return { quoted }

    console.warn(`[queue] ${orgId}: no tengo el mensaje ${messageId} para citarlo, sale sin cita`)
    return {}
}

/** Manda el envío y devuelve el id de WhatsApp con el que salió (null si Baileys no lo informó). */
async function processOne(orgId, job) {
    if (!socketProvider) throw new Error('socketProvider not configured')
    const session = socketProvider(orgId)
    if (!session?.isConnected || !session?.sock) throw new Error('WhatsApp not connected')

    const sock = session.sock
    const isGroup = job.phone.endsWith('@g.us')
    const isStatus = job.phone === 'status@broadcast'
    const target = (isGroup || isStatus)
        ? job.phone
        : await resolveTarget(sock, cleanPhoneToJid(job.phone))

    const send = async (content, options = {}) => {
        const sent = await humanLikeSend(sock, target, content, options)
        if (sent) saveMessage(orgId, sent)
        return sent?.key?.id ?? null
    }

    if (job.kind === 'text') {
        return send({ text: job.message }, await quoteOptions(sock, orgId, target, job))

    } else if (job.kind === 'document') {
        return send({
            document: Buffer.from(job.document_base64, 'base64'),
            fileName: job.document_filename,
            mimetype: job.document_mimetype,
        })

    } else if (job.kind === 'image') {
        return send({
            image: Buffer.from(job.document_base64, 'base64'),
            caption: job.message || undefined,
            mimetype: job.document_mimetype,
        }, await quoteOptions(sock, orgId, target, job))

    } else if (job.kind === 'video') {
        return send({
            video: Buffer.from(job.document_base64, 'base64'),
            caption: job.message || undefined,
            mimetype: job.document_mimetype,
        })

    } else if (job.kind === 'gif') {
        return send({
            video: Buffer.from(job.document_base64, 'base64'),
            gifPlayback: true,
            caption: job.message || undefined,
            mimetype: job.document_mimetype,
        })

    } else if (job.kind === 'audio') {
        return send({
            audio: Buffer.from(job.document_base64, 'base64'),
            mimetype: job.document_mimetype,
            ptt: false,
        })

    } else if (job.kind === 'sticker') {
        return send({
            sticker: Buffer.from(job.document_base64, 'base64'),
            mimetype: job.document_mimetype,
        })

    } else if (job.kind === 'location') {
        const punto = JSON.parse(job.message)
        return send({
            location: {
                degreesLatitude: punto.latitude,
                degreesLongitude: punto.longitude,
                name: punto.name || undefined,
                address: punto.address || undefined,
            },
        })

    } else if (job.kind === 'compound') {
        // Text first — if it fails the whole job fails (media skipped)
        const textId = await send({ text: job.message })

        // Media second — failure here is logged but doesn't fail the job
        if (job.document_base64) {
            try {
                await delay(randomBetween(1000, 2500))
                await send({
                    document: Buffer.from(job.document_base64, 'base64'),
                    fileName: job.document_filename,
                    mimetype: job.document_mimetype,
                })
            } catch (mediaErr) {
                console.error(`[queue:${orgId}] compound media failed for ${job.phone}: ${mediaErr.message}`)
            }
        }
        return textId

    } else if (job.kind === 'status') {
        const opts = job.status_options ? JSON.parse(job.status_options) : {}
        const statusJidList = (opts.jidList || []).map(cleanPhoneToJid)

        const sendOpts = { statusJidList }
        let content
        if (job.document_base64) {
            const buf = Buffer.from(job.document_base64, 'base64')
            const isVideo = (job.document_mimetype || '').startsWith('video/')
            content = isVideo
                ? { video: buf, caption: job.message || undefined }
                : { image: buf, caption: job.message || undefined }
        } else {
            content = { text: job.message }
            // backgroundColor/font solo aplican a estados de texto
            if (opts.backgroundColor) sendOpts.backgroundColor = opts.backgroundColor
            if (opts.font !== undefined && opts.font !== null) sendOpts.font = opts.font
        }

        return send(content, sendOpts)

    } else {
        throw new Error(`Unknown kind: ${job.kind}`)
    }
}

// Una caída de conexión suele durar segundos (Baileys reconecta solo): el mensaje se reintenta
// en vez de darlo por perdido. Los estados quedan afuera: un estado duplicado es spam visible.
const MAX_CONNECTION_ATTEMPTS = 4
const CONNECTION_RETRY_DELAY_MS = parseDelayMs(process.env.QUEUE_CONNECTION_RETRY_MS, 20_000)

export function shouldRetryConnectionError(job, error) {
    if (job.kind === 'status') return false
    if (job.attempts >= MAX_CONNECTION_ATTEMPTS) return false
    return error?.message === 'WhatsApp not connected' || error?.message === 'Connection Closed'
}

async function workerLoop(orgId) {
    while (true) {
        const job = nextPendingStmt.get(orgId)
        if (!job) {
            workers.delete(orgId)
            return
        }

        markSendingStmt.run(job.id)
        // `job` se leyó antes de contar este intento.
        job.attempts += 1

        try {
            const sentMessageId = await processOne(orgId, job)
            markSentStmt.run(now(), sentMessageId, job.id)
            console.log(`[queue:${orgId}] ✅ sent #${job.id} → ${job.phone} (${job.kind})`)
            await recordSent(job.batch_id)
        } catch (e) {
            if (shouldRetryConnectionError(job, e)) {
                // Vuelve a pendiente y espera acá mismo: la cola de la sesión sale en orden, así que
                // no se pasa a los que siguen mientras la conexión está caída.
                console.warn(`[queue:${orgId}] ⏳ #${job.id} → ${job.phone}: ${e.message}, reintento ${job.attempts}/${MAX_CONNECTION_ATTEMPTS} en ${CONNECTION_RETRY_DELAY_MS}ms`)
                markPendingStmt.run(job.id)
                await delay(CONNECTION_RETRY_DELAY_MS)
                continue
            }
            console.error(`[queue:${orgId}] ❌ failed #${job.id} → ${job.phone}: ${e.message}`)
            markFailedStmt.run(e.message, job.id)
            await recordFailed(job.batch_id)
        }

        // Delay before next message only if there's more work
        const next = nextPendingStmt.get(orgId)
        if (!next) {
            workers.delete(orgId)
            return
        }
        await delay(randomBetween(SEND_DELAY_MIN_MS, SEND_DELAY_MAX_MS))
    }
}

// ── Rechazo del servidor ──────────────────────────────────────────────────────
//
// `sendMessage` vuelve en cuanto el mensaje sale del socket, no cuando WhatsApp lo acepta: el envío queda
// `sent` y Baileys lo emite como propio (el eco que ve el panel). Si el servidor lo rechaza, el aviso llega
// después, como un `messages.update` con status ERROR y el código en `messageStubParameters` (479 es el más
// común en grupos: sesión o sender key vieja de algún dispositivo). Nadie del chat lo recibe, ni siquiera
// como "Esperando este mensaje".
//
// En un grupo se reenvía una vez, después de olvidar a qué dispositivos ya se les dio la sender key: así
// Baileys la vuelve a repartir a todos. Como el original no le llegó a nadie, el reenvío no duplica.
const MAX_REJECTED_RESENDS = 1

const jobBySentIdStmt = db.prepare(`
    SELECT * FROM outgoing_queue WHERE org_id = ? AND sent_message_id = ? ORDER BY id DESC LIMIT 1
`)
const requeueRejectedStmt = db.prepare(`
    UPDATE outgoing_queue
    SET status = 'pending', error = ?, sent_message_id = NULL, rejected_resends = rejected_resends + 1
    WHERE id = ?
`)

export async function handleServerRejection(orgId, sock, { remoteJid, id, code }) {
    const job = id ? jobBySentIdStmt.get(orgId, id) : null
    const motivo = `rechazado por WhatsApp (${code ?? 'sin código'})`
    if (!job) {
        console.error(`[queue:${orgId}] ❌ ${remoteJid} rechazó el mensaje ${id}: ${motivo} (no salió por la cola)`)
        return { action: 'ignored' }
    }

    const isGroup = job.phone.endsWith('@g.us')
    if (isGroup && job.kind !== 'status' && (job.rejected_resends ?? 0) < MAX_REJECTED_RESENDS) {
        try {
            await sock?.authState?.keys?.set({ 'sender-key-memory': { [job.phone]: null } })
        } catch (e) {
            console.warn(`[queue:${orgId}] no pude olvidar las sender keys de ${job.phone}: ${e.message}`)
        }
        requeueRejectedStmt.run(`${motivo}; reenviado`, job.id)
        console.error(`[queue:${orgId}] ❌ #${job.id} → ${job.phone}: ${motivo}, se reenvía con sender keys nuevas`)
        ensureWorker(orgId)
        return { action: 'resent' }
    }

    markFailedStmt.run(motivo, job.id)
    console.error(`[queue:${orgId}] ❌ #${job.id} → ${job.phone}: ${motivo}`)
    return { action: 'failed' }
}

function ensureWorker(orgId) {
    if (workers.has(orgId)) return
    const promise = workerLoop(orgId).catch(e => {
        console.error(`[queue:${orgId}] worker crashed:`, e.message)
        workers.delete(orgId)
    })
    workers.set(orgId, promise)
}
