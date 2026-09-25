import Database from 'better-sqlite3'
import path from 'path'
import fs from 'fs'

const dataDir = process.env.DATA_DIR || path.join(process.cwd(), 'data')
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true })

const dbPath = path.join(dataDir, 'bot.db')
export const db = new Database(dbPath)

db.pragma('journal_mode = WAL')
db.pragma('foreign_keys = ON')

// ── Schema ────────────────────────────────────────────────────────────────────

db.exec(`
CREATE TABLE IF NOT EXISTS outgoing_queue (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    org_id              TEXT    NOT NULL,
    batch_id            TEXT,
    phone               TEXT    NOT NULL,
    kind                TEXT    NOT NULL,           -- text | document | compound | image | video | gif | audio | sticker | location | status
    message             TEXT,
    document_base64     TEXT,
    document_filename   TEXT,
    document_mimetype   TEXT,
    metadata_json       TEXT,                       -- opaque JSON passthrough
    status              TEXT    NOT NULL DEFAULT 'pending',
    error               TEXT,
    attempts            INTEGER NOT NULL DEFAULT 0,
    created_at          INTEGER NOT NULL,
    sent_at             INTEGER
);
CREATE INDEX IF NOT EXISTS idx_queue_status ON outgoing_queue(org_id, status);
CREATE INDEX IF NOT EXISTS idx_queue_batch  ON outgoing_queue(batch_id);

CREATE TABLE IF NOT EXISTS batches (
    id           TEXT    PRIMARY KEY,
    org_id       TEXT    NOT NULL,
    total        INTEGER NOT NULL,
    sent         INTEGER NOT NULL DEFAULT 0,
    failed       INTEGER NOT NULL DEFAULT 0,
    status       TEXT    NOT NULL DEFAULT 'processing',
    callback_url TEXT,
    created_at   INTEGER NOT NULL,
    completed_at INTEGER,
    notified_at  INTEGER
);

CREATE TABLE IF NOT EXISTS message_store (
    org_id       TEXT    NOT NULL,
    remote_jid   TEXT    NOT NULL,
    message_id   TEXT    NOT NULL,
    from_me      INTEGER NOT NULL,
    message_json TEXT    NOT NULL,
    created_at   INTEGER NOT NULL,
    PRIMARY KEY (org_id, remote_jid, message_id, from_me)
);
CREATE INDEX IF NOT EXISTS idx_msg_store_created ON message_store(created_at);

-- Inbound webhooks: por orgId, a dónde mandar notificaciones cuando llega un msg.
-- Si una org no tiene fila acá → comportamiento idéntico al pre-feature
-- (el handler de mensajes solo guarda en message_store, no notifica afuera).
CREATE TABLE IF NOT EXISTS inbound_webhooks (
    org_id     TEXT    PRIMARY KEY,
    url        TEXT    NOT NULL,
    secret     TEXT    NOT NULL,
    enabled    INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

-- Address book sincronizado por sesión. Alimenta la audiencia "todos mis
-- contactos" al publicar un estado. Se llena desde los eventos de Baileys
-- (messaging-history.set / contacts.upsert / contacts.set).
CREATE TABLE IF NOT EXISTS contacts (
    org_id     TEXT    NOT NULL,
    jid        TEXT    NOT NULL,            -- @s.whatsapp.net (número real)
    name       TEXT,                        -- nombre agendado por el usuario
    notify     TEXT,                        -- push name del contacto
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (org_id, jid)
);
CREATE INDEX IF NOT EXISTS idx_contacts_org ON contacts(org_id);
`)

// ── Migrations (columns added after initial schema) ───────────────────────────
// Safely add columns that may not exist on older DBs — errors are ignored.

const migrations = [
    `ALTER TABLE outgoing_queue ADD COLUMN metadata_json TEXT`,
    `ALTER TABLE batches ADD COLUMN callback_url TEXT`,
    `ALTER TABLE outgoing_queue ADD COLUMN quoted_message_id TEXT`,
    `ALTER TABLE outgoing_queue ADD COLUMN status_options TEXT`,
    // Quién escribió el mensaje en un grupo: sin esto no se puede responder citándolo.
    `ALTER TABLE message_store ADD COLUMN participant TEXT`,
]
for (const sql of migrations) {
    try { db.exec(sql) } catch { /* column already exists */ }
}

export function now() {
    return Date.now()
}

// ── Inbound webhooks API ──────────────────────────────────────────────────────

const upsertInboundWebhookStmt = db.prepare(`
    INSERT INTO inbound_webhooks (org_id, url, secret, enabled, created_at, updated_at)
    VALUES (@orgId, @url, @secret, @enabled, @now, @now)
    ON CONFLICT(org_id) DO UPDATE SET
        url        = excluded.url,
        secret     = excluded.secret,
        enabled    = excluded.enabled,
        updated_at = excluded.updated_at
`)

const selectEnabledInboundWebhookStmt = db.prepare(`
    SELECT org_id, url, secret, enabled
    FROM inbound_webhooks
    WHERE org_id = ? AND enabled = 1
`)

const selectInboundWebhookStmt = db.prepare(`
    SELECT org_id, url, secret, enabled
    FROM inbound_webhooks
    WHERE org_id = ?
`)

const deleteInboundWebhookStmt = db.prepare(`DELETE FROM inbound_webhooks WHERE org_id = ?`)

export function upsertInboundWebhook({ orgId, url, secret, enabled = 1 }) {
    upsertInboundWebhookStmt.run({
        orgId,
        url,
        secret,
        enabled: enabled ? 1 : 0,
        now: now(),
    })
}

/**
 * Devuelve el webhook SOLO si está habilitado. El handler de mensajes usa esto
 * para decidir si emitir o no — early return cuando no hay configuración.
 */
export function getEnabledInboundWebhook(orgId) {
    return selectEnabledInboundWebhookStmt.get(orgId)
}

/**
 * Devuelve la fila completa (incluso si está disabled). Para la API de gestión.
 */
export function getInboundWebhook(orgId) {
    return selectInboundWebhookStmt.get(orgId)
}

export function deleteInboundWebhook(orgId) {
    deleteInboundWebhookStmt.run(orgId)
}
