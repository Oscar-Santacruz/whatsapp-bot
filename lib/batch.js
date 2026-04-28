import { db, now } from './db.js'
import { notifyBatchComplete } from './discord.js'
import crypto from 'crypto'

const insertBatch = db.prepare(`
    INSERT INTO batches (id, org_id, total, created_at)
    VALUES (?, ?, ?, ?)
`)

const incrementSentStmt = db.prepare(`
    UPDATE batches SET sent = sent + 1 WHERE id = ?
`)

const incrementFailedStmt = db.prepare(`
    UPDATE batches SET failed = failed + 1 WHERE id = ?
`)

const getBatchStmt = db.prepare(`SELECT * FROM batches WHERE id = ?`)

const completeBatchStmt = db.prepare(`
    UPDATE batches
    SET status = 'completed', completed_at = ?
    WHERE id = ? AND status = 'processing'
`)

const markNotifiedStmt = db.prepare(`
    UPDATE batches SET notified_at = ?, status = 'notified' WHERE id = ?
`)

const errorsForBatchStmt = db.prepare(`
    SELECT phone, error FROM outgoing_queue
    WHERE batch_id = ? AND status = 'failed'
`)

export function createBatch(orgId, total) {
    const id = `btc_${crypto.randomBytes(8).toString('hex')}`
    insertBatch.run(id, orgId, total, now())
    return id
}

export function getBatch(batchId) {
    return getBatchStmt.get(batchId)
}

export async function recordSent(batchId) {
    if (!batchId) return
    incrementSentStmt.run(batchId)
    await maybeFinalize(batchId)
}

export async function recordFailed(batchId) {
    if (!batchId) return
    incrementFailedStmt.run(batchId)
    await maybeFinalize(batchId)
}

async function maybeFinalize(batchId) {
    const batch = getBatchStmt.get(batchId)
    if (!batch) return
    if (batch.status !== 'processing') return
    if (batch.sent + batch.failed < batch.total) return

    const result = completeBatchStmt.run(now(), batchId)
    if (result.changes === 0) return

    const finalBatch = getBatchStmt.get(batchId)
    const errors = errorsForBatchStmt.all(batchId)

    try {
        await notifyBatchComplete({ batch: finalBatch, errors })
        markNotifiedStmt.run(now(), batchId)
    } catch (e) {
        console.error(`[batch] notify error for ${batchId}:`, e.message)
    }
}
