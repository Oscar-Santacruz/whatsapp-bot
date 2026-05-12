import { db, now } from './db.js'
import { saveMessage } from './store.js'
import { recordSent, recordFailed } from './batch.js'

const enqueueStmt = db.prepare(`
    INSERT INTO outgoing_queue
        (org_id, batch_id, phone, kind, message,
         document_base64, document_filename, document_mimetype,
         metadata_json, created_at)
    VALUES
        (@orgId, @batchId, @phone, @kind, @message,
         @documentBase64, @documentFilename, @documentMimetype,
         @metadataJson, @createdAt)
`)

const nextPendingStmt = db.prepare(`
    SELECT * FROM outgoing_queue
    WHERE org_id = ? AND status = 'pending'
    ORDER BY id ASC LIMIT 1
`)

const markSendingStmt = db.prepare(`UPDATE outgoing_queue SET status = 'sending', attempts = attempts + 1 WHERE id = ?`)
const markSentStmt    = db.prepare(`UPDATE outgoing_queue SET status = 'sent',    sent_at = ?       WHERE id = ?`)
const markFailedStmt  = db.prepare(`UPDATE outgoing_queue SET status = 'failed',  error = ?         WHERE id = ?`)

// On startup: reset any jobs stuck in 'sending' (process crashed mid-flight)
db.prepare(`UPDATE outgoing_queue SET status = 'pending' WHERE status = 'sending'`).run()

const workers = new Map()
let socketProvider = null

// ── Public API ────────────────────────────────────────────────────────────────

export function setSocketProvider(fn) {
    socketProvider = fn
}

export function enqueueText({ orgId, phone, message, batchId = null, metadata = null }) {
    const result = enqueueStmt.run({
        orgId, batchId, phone, kind: 'text', message,
        documentBase64: null, documentFilename: null, documentMimetype: null,
        metadataJson: metadata ? JSON.stringify(metadata) : null,
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

// ── Worker ────────────────────────────────────────────────────────────────────

function randomBetween(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms))
}

function cleanPhoneToJid(phone) {
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

async function humanLikeSend(sock, jid, content) {
    try { await sock.presenceSubscribe(jid) } catch {}
    await delay(randomBetween(400, 1200))
    try { await sock.sendPresenceUpdate('composing', jid) } catch {}
    await delay(randomBetween(1500, 3500))
    try { await sock.sendPresenceUpdate('paused', jid) } catch {}
    return await sock.sendMessage(jid, content)
}

async function processOne(orgId, job) {
    if (!socketProvider) throw new Error('socketProvider not configured')
    const session = socketProvider(orgId)
    if (!session?.isConnected || !session?.sock) throw new Error('WhatsApp not connected')

    const sock = session.sock
    const jid = cleanPhoneToJid(job.phone)
    const target = await resolveTarget(sock, jid)

    if (job.kind === 'text') {
        const sent = await humanLikeSend(sock, target, { text: job.message })
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
        await delay(randomBetween(5000, 15000))
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
