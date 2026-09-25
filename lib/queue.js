import { db, now } from './db.js'
import { saveMessage, getStoredQuoted } from './store.js'
import { recordSent, recordFailed } from './batch.js'

const enqueueStmt = db.prepare(`
    INSERT INTO outgoing_queue
        (org_id, batch_id, phone, kind, message,
         document_base64, document_filename, document_mimetype,
         metadata_json, quoted_message_id, created_at)
    VALUES
        (@orgId, @batchId, @phone, @kind, @message,
         @documentBase64, @documentFilename, @documentMimetype,
         @metadataJson, @quotedMessageId, @createdAt)
`)

// Statement propio para estados: incluye status_options (jidList + estilo de texto)
// y no usa quoted_message_id. Mantiene intacto el enqueueStmt compartido.
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
const markSentStmt    = db.prepare(`UPDATE outgoing_queue SET status = 'sent',    sent_at = ?       WHERE id = ?`)
const markFailedStmt  = db.prepare(`UPDATE outgoing_queue SET status = 'failed',  error = ?         WHERE id = ?`)

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

export function enqueueText({ orgId, phone, message, batchId = null, metadata = null, quotedMessageId = null }) {
    const result = enqueueStmt.run({
        orgId, batchId, phone, kind: 'text', message,
        documentBase64: null, documentFilename: null, documentMimetype: null,
        metadataJson: metadata ? JSON.stringify(metadata) : null,
        quotedMessageId,
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
        createdAt: now(),
    })
    ensureWorker(orgId)
    return result.lastInsertRowid
}

export function enqueueImage({ orgId, phone, file, mimetype, caption = null, batchId = null, metadata = null }) {
    const result = enqueueStmt.run({
        orgId, batchId, phone, kind: 'image',
        message: caption,
        documentBase64: file,
        documentFilename: null,
        documentMimetype: mimetype || 'image/jpeg',
        metadataJson: metadata ? JSON.stringify(metadata) : null,
        quotedMessageId: null,
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

    if (job.kind === 'text') {
        const content = { text: job.message }

        // Baileys cita con `options.quoted` (key + message), no dentro del contenido: puesto en `content`
        // se ignoraba y la respuesta salía como un mensaje suelto. Si no está en el store, sale sin cita.
        const quoted = job.quoted_message_id ? getStoredQuoted(orgId, target, job.quoted_message_id) : undefined
        if (job.quoted_message_id && !quoted) {
            console.warn(`[queue] ${orgId}: no tengo el mensaje ${job.quoted_message_id} para citarlo, sale sin cita`)
        }

        const sent = await humanLikeSend(sock, target, content, quoted ? { quoted } : {})
        if (sent) saveMessage(orgId, sent)

    } else if (job.kind === 'document') {
        const sent = await humanLikeSend(sock, target, {
            document: Buffer.from(job.document_base64, 'base64'),
            fileName: job.document_filename,
            mimetype: job.document_mimetype,
        })
        if (sent) saveMessage(orgId, sent)

    } else if (job.kind === 'image') {
        const sent = await humanLikeSend(sock, target, {
            image: Buffer.from(job.document_base64, 'base64'),
            caption: job.message || undefined,
            mimetype: job.document_mimetype,
        })
        if (sent) saveMessage(orgId, sent)

    } else if (job.kind === 'video') {
        const sent = await humanLikeSend(sock, target, {
            video: Buffer.from(job.document_base64, 'base64'),
            caption: job.message || undefined,
            mimetype: job.document_mimetype,
        })
        if (sent) saveMessage(orgId, sent)

    } else if (job.kind === 'gif') {
        const sent = await humanLikeSend(sock, target, {
            video: Buffer.from(job.document_base64, 'base64'),
            gifPlayback: true,
            caption: job.message || undefined,
            mimetype: job.document_mimetype,
        })
        if (sent) saveMessage(orgId, sent)

    } else if (job.kind === 'audio') {
        const sent = await humanLikeSend(sock, target, {
            audio: Buffer.from(job.document_base64, 'base64'),
            mimetype: job.document_mimetype,
            ptt: false,
        })
        if (sent) saveMessage(orgId, sent)

    } else if (job.kind === 'sticker') {
        const sent = await humanLikeSend(sock, target, {
            sticker: Buffer.from(job.document_base64, 'base64'),
            mimetype: job.document_mimetype,
        })
        if (sent) saveMessage(orgId, sent)

    } else if (job.kind === 'location') {
        const punto = JSON.parse(job.message)
        const sent = await humanLikeSend(sock, target, {
            location: {
                degreesLatitude: punto.latitude,
                degreesLongitude: punto.longitude,
                name: punto.name || undefined,
                address: punto.address || undefined,
            },
        })
        if (sent) saveMessage(orgId, sent)

    } else if (job.kind === 'compound') {
        // Text first — if it fails the whole job fails (media skipped)
        const sentText = await humanLikeSend(sock, target, { text: job.message })
        if (sentText) saveMessage(orgId, sentText)

        // Media second — failure here is logged but doesn't fail the job
        if (job.document_base64) {
            try {
                await delay(randomBetween(1000, 2500))
                const sentMedia = await humanLikeSend(sock, target, {
                    document: Buffer.from(job.document_base64, 'base64'),
                    fileName: job.document_filename,
                    mimetype: job.document_mimetype,
                })
                if (sentMedia) saveMessage(orgId, sentMedia)
            } catch (mediaErr) {
                console.error(`[queue:${orgId}] compound media failed for ${job.phone}: ${mediaErr.message}`)
            }
        }
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

        const sent = await humanLikeSend(sock, target, content, sendOpts)
        if (sent) saveMessage(orgId, sent)

    } else {
        throw new Error(`Unknown kind: ${job.kind}`)
    }
}

async function workerLoop(orgId) {
    while (true) {
        const job = nextPendingStmt.get(orgId)
        if (!job) {
            workers.delete(orgId)
            return
        }

        markSendingStmt.run(job.id)

        try {
            await processOne(orgId, job)
            markSentStmt.run(now(), job.id)
            console.log(`[queue:${orgId}] ✅ sent #${job.id} → ${job.phone} (${job.kind})`)
            await recordSent(job.batch_id)
        } catch (e) {
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

function ensureWorker(orgId) {
    if (workers.has(orgId)) return
    const promise = workerLoop(orgId).catch(e => {
        console.error(`[queue:${orgId}] worker crashed:`, e.message)
        workers.delete(orgId)
    })
    workers.set(orgId, promise)
}
