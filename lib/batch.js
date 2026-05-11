import { db, now } from './db.js'
import { notifyBatchComplete } from './discord.js'
import crypto from 'crypto'

const insertBatch = db.prepare(`
    INSERT INTO batches (id, org_id, total, callback_url, created_at)
    VALUES (?, ?, ?, ?, ?)
`)

const incrementSentStmt   = db.prepare(`UPDATE batches SET sent   = sent   + 1 WHERE id = ?`)
const incrementFailedStmt = db.prepare(`UPDATE batches SET failed = failed + 1 WHERE id = ?`)
const getBatchStmt        = db.prepare(`SELECT * FROM batches WHERE id = ?`)

const completeBatchStmt = db.prepare(`
    UPDATE batches
    SET status = 'completed', completed_at = ?
    WHERE id = ? AND status = 'processing'
`)

const markNotifiedStmt = db.prepare(`
    UPDATE batches SET notified_at = ?, status = 'notified' WHERE id = ?
`)

const resultsForBatchStmt = db.prepare(`
    SELECT phone, status, error, metadata_json
    FROM outgoing_queue
    WHERE batch_id = ?
    ORDER BY id ASC
`)

// ── Public API ────────────────────────────────────────────────────────────────

export function createBatch(orgId, total, callbackUrl = null) {
    const id = `btc_${crypto.randomBytes(8).toString('hex')}`
    insertBatch.run(id, orgId, total, callbackUrl, now())
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

// ── Internal ──────────────────────────────────────────────────────────────────

async function maybeFinalize(batchId) {
    const batch = getBatchStmt.get(batchId)
    if (!batch || batch.status !== 'processing') return
    if (batch.sent + batch.failed < batch.total) return

    // Atomically mark as completed (only one caller wins)
    const result = completeBatchStmt.run(now(), batchId)
    if (result.changes === 0) return

    const finalBatch = getBatchStmt.get(batchId)

    // Build per-message results
    const rows = resultsForBatchStmt.all(batchId)
    const results = rows.map(row => {
        const base = {
            phone: row.phone,
            status: row.status,
            metadata: row.metadata_json ? JSON.parse(row.metadata_json) : null,
        }
        if (row.error) base.error = row.error
        return base
    })

    const summary = { sent: finalBatch.sent, failed: finalBatch.failed, total: finalBatch.total }

    try {
        if (finalBatch.callback_url) {
            // Structured callback → car-sale (or any consumer)
            await sendCallback(finalBatch, results, summary)
        } else {
            // No callback → notify Discord directly (standalone usage)
            const errors = results.filter(r => r.status === 'failed')
            await notifyBatchComplete({ batch: finalBatch, errors })
        }
        markNotifiedStmt.run(now(), batchId)
    } catch (e) {
        console.error(`[batch] notify error for ${batchId}:`, e.message)
    }
}

async function sendCallback(batch, results, summary) {
    const payload = {
        batchId: batch.id,
        orgId: batch.org_id,
        summary,
        results,
    }
    const callbackToken = process.env.CALLBACK_AUTH_TOKEN || process.env.API_TOKEN
    const headers = { 'Content-Type': 'application/json' }
    if (callbackToken) headers.Authorization = `Bearer ${callbackToken}`

    const res = await fetch(batch.callback_url, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
    })

    if (!res.ok) {
        const txt = await res.text()
        console.error(`[batch] callback failed ${res.status} for ${batch.id}: ${txt}`)
    } else {
        console.log(`[batch] callback delivered for ${batch.id} → ${summary.sent} sent, ${summary.failed} failed`)
    }
}
