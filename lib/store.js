import { db, now } from './db.js'

const TTL_MS = 7 * 24 * 60 * 60 * 1000

const insertStmt = db.prepare(`
    INSERT OR REPLACE INTO message_store
        (org_id, remote_jid, message_id, from_me, message_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
`)

const selectStmt = db.prepare(`
    SELECT message_json FROM message_store
    WHERE org_id = ? AND remote_jid = ? AND message_id = ? AND from_me = ?
`)

const cleanupStmt = db.prepare(`DELETE FROM message_store WHERE created_at < ?`)

export function saveMessage(orgId, waMessage) {
    if (!waMessage?.key?.id || !waMessage?.message) return
    const { key, message } = waMessage
    try {
        insertStmt.run(
            orgId,
            key.remoteJid || '',
            key.id,
            key.fromMe ? 1 : 0,
            JSON.stringify(message),
            now()
        )
    } catch (e) {
        console.error('[store] saveMessage error:', e.message)
    }
}

export function getStoredMessage(orgId, remoteJid, messageId, fromMe) {
    try {
        const row = selectStmt.get(orgId, remoteJid || '', messageId, fromMe ? 1 : 0)
        if (!row) return undefined
        return JSON.parse(row.message_json)
    } catch (e) {
        console.error('[store] getStoredMessage error:', e.message)
        return undefined
    }
}

export function cleanupOldMessages() {
    try {
        const cutoff = now() - TTL_MS
        const result = cleanupStmt.run(cutoff)
        if (result.changes > 0) {
            console.log(`[store] Cleaned ${result.changes} old messages`)
        }
    } catch (e) {
        console.error('[store] cleanup error:', e.message)
    }
}

setInterval(cleanupOldMessages, 60 * 60 * 1000)
