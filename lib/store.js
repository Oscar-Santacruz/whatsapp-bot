import { db, now } from './db.js'

const TTL_MS = 7 * 24 * 60 * 60 * 1000

const insertStmt = db.prepare(`
    INSERT OR REPLACE INTO message_store
        (org_id, remote_jid, message_id, from_me, message_json, participant, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
`)

const selectStmt = db.prepare(`
    SELECT message_json FROM message_store
    WHERE org_id = ? AND remote_jid = ? AND message_id = ? AND from_me = ?
`)

const selectQuotedStmt = db.prepare(`
    SELECT from_me, message_json, participant FROM message_store
    WHERE org_id = ? AND remote_jid = ? AND message_id = ?
    ORDER BY from_me
    LIMIT 1
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
            key.participant || null,
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

/**
 * El mensaje guardado tal como lo pide Baileys en `sendMessage(jid, content, { quoted })`: key + message.
 * En un grupo la key necesita al participante; un mensaje guardado antes de que se guardara el participante
 * no se puede citar ahí y devuelve undefined (se manda sin cita en vez de con una cita rota).
 */
export function getStoredQuoted(orgId, remoteJid, messageId) {
    try {
        const row = selectQuotedStmt.get(orgId, remoteJid || '', messageId)
        if (!row) return undefined
        const esGrupo = (remoteJid || '').endsWith('@g.us')
        if (esGrupo && !row.from_me && !row.participant) return undefined
        return {
            key: {
                remoteJid,
                id: messageId,
                fromMe: Boolean(row.from_me),
                ...(row.participant ? { participant: row.participant } : {}),
            },
            message: JSON.parse(row.message_json),
        }
    } catch (e) {
        console.error('[store] getStoredQuoted error:', e.message)
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
