import { db, now } from './db.js'
import { saveMessage } from './store.js'
import { recordSent, recordFailed } from './batch.js'

const enqueueStmt = db.prepare(`
    INSERT INTO outgoing_queue
        (org_id, batch_id, phone, kind, message, document_base64, document_filename, document_mimetype, created_at)
    VALUES (@orgId, @batchId, @phone, @kind, @message, @documentBase64, @documentFilename, @documentMimetype, @createdAt)
`)

const nextPendingStmt = db.prepare(`
    SELECT * FROM outgoing_queue
    WHERE org_id = ? AND status = 'pending'
    ORDER BY id ASC LIMIT 1
`)

const markSendingStmt = db.prepare(`
    UPDATE outgoing_queue SET status = 'sending', attempts = attempts + 1 WHERE id = ?
`)

const markSentStmt = db.prepare(`
    UPDATE outgoing_queue SET status = 'sent', sent_at = ? WHERE id = ?
`)

const markFailedStmt = db.prepare(`
    UPDATE outgoing_queue SET status = 'failed', error = ? WHERE id = ?
`)

const resetSendingStmt = db.prepare(`
    UPDATE outgoing_queue SET status = 'pending' WHERE status = 'sending'
`)

resetSendingStmt.run()

const workers = new Map()
let socketProvider = null

export function setSocketProvider(fn) {
    socketProvider = fn
}

export function enqueueText({ orgId, phone, message, batchId = null }) {
    const result = enqueueStmt.run({
        orgId, batchId, phone, kind: 'text', message,
        documentBase64: null, documentFilename: null, documentMimetype: null,
        createdAt: now()
    })
    ensureWorker(orgId)
    return result.lastInsertRowid
}

export function enqueueDocument({ orgId, phone, file, fileName, mimetype, batchId = null }) {
    const result = enqueueStmt.run({
        orgId, batchId, phone, kind: 'document',
        message: null,
        documentBase64: file,
        documentFilename: fileName,
        documentMimetype: mimetype || 'application/pdf',
        createdAt: now()
    })
    ensureWorker(orgId)
    return result.lastInsertRowid
}

function randomBetween(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms))
}

function cleanPhoneToJid(phone) {
    const cleaned = phone.replace(/[\+\-\s\(\)]/g, '')
    return `${cleaned}@s.whatsapp.net`
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
    if (!session || !session.isConnected || !session.sock) {
        throw new Error('WhatsApp not connected')
    }

    const sock = session.sock
    const jid = cleanPhoneToJid(job.phone)

    let target = jid
    try {
        const onWa = await sock.onWhatsApp(jid)
        const result = Array.isArray(onWa) ? onWa[0] : null
        if (!result?.exists) {
            throw new Error(`Phone not registered on WhatsApp`)
        }
        target = result.jid || jid
    } catch (e) {
        if (e.message.includes('not registered')) throw e
    }

    let content
    if (job.kind === 'text') {
        content = { text: job.message }
    } else if (job.kind === 'document') {
        content = {
            document: Buffer.from(job.document_base64, 'base64'),
            fileName: job.document_filename,
            mimetype: job.document_mimetype
        }
    } else {
        throw new Error(`Unknown kind: ${job.kind}`)
    }

    const sent = await humanLikeSend(sock, target, content)
    if (sent) saveMessage(orgId, sent)
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
            console.log(`[queue:${orgId}] sent #${job.id} → ${job.phone}`)
            await recordSent(job.batch_id)
        } catch (e) {
            console.error(`[queue:${orgId}] failed #${job.id} → ${job.phone}: ${e.message}`)
            markFailedStmt.run(e.message, job.id)
            await recordFailed(job.batch_id)
        }

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

export function resumeAllWorkers() {
    const orgs = db.prepare(`SELECT DISTINCT org_id FROM outgoing_queue WHERE status = 'pending'`).all()
    for (const { org_id } of orgs) {
        ensureWorker(org_id)
    }
}
