import Database from 'better-sqlite3'
import path from 'path'
import fs from 'fs'

const dataDir = process.env.DATA_DIR || path.join(process.cwd(), 'data')
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true })

const dbPath = path.join(dataDir, 'bot.db')
export const db = new Database(dbPath)

db.pragma('journal_mode = WAL')
db.pragma('foreign_keys = ON')

db.exec(`
CREATE TABLE IF NOT EXISTS outgoing_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    org_id TEXT NOT NULL,
    batch_id TEXT,
    phone TEXT NOT NULL,
    kind TEXT NOT NULL,
    message TEXT,
    document_base64 TEXT,
    document_filename TEXT,
    document_mimetype TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    error TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    sent_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_queue_status ON outgoing_queue(org_id, status);
CREATE INDEX IF NOT EXISTS idx_queue_batch ON outgoing_queue(batch_id);

CREATE TABLE IF NOT EXISTS batches (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL,
    total INTEGER NOT NULL,
    sent INTEGER NOT NULL DEFAULT 0,
    failed INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'processing',
    created_at INTEGER NOT NULL,
    completed_at INTEGER,
    notified_at INTEGER
);

CREATE TABLE IF NOT EXISTS message_store (
    org_id TEXT NOT NULL,
    remote_jid TEXT NOT NULL,
    message_id TEXT NOT NULL,
    from_me INTEGER NOT NULL,
    message_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (org_id, remote_jid, message_id, from_me)
);
CREATE INDEX IF NOT EXISTS idx_msg_store_created ON message_store(created_at);
`)

export function now() {
    return Date.now()
}
