import { db, now } from './db.js'

// Persistencia del address book por sesión (orgId). Se usa como audiencia
// "todos mis contactos" al publicar un estado. Solo guardamos números reales
// (@s.whatsapp.net); ignoramos grupos, broadcast y JIDs @lid sin número.

const upsertStmt = db.prepare(`
    INSERT INTO contacts (org_id, jid, name, notify, updated_at)
    VALUES (@orgId, @jid, @name, @notify, @updatedAt)
    ON CONFLICT(org_id, jid) DO UPDATE SET
        name       = COALESCE(excluded.name, contacts.name),
        notify     = COALESCE(excluded.notify, contacts.notify),
        updated_at = excluded.updated_at
`)

/**
 * Extrae el JID telefónico (@s.whatsapp.net) de un Contact de Baileys.
 * En Baileys 7 el `id` puede venir como @lid; preferimos `phoneNumber`.
 */
function phoneJidOf(contact) {
    if (!contact) return null
    if (typeof contact.phoneNumber === 'string' && contact.phoneNumber.endsWith('@s.whatsapp.net')) {
        return contact.phoneNumber
    }
    if (typeof contact.id === 'string' && contact.id.endsWith('@s.whatsapp.net')) {
        return contact.id
    }
    return null
}

const upsertMany = db.transaction((orgId, contacts) => {
    let saved = 0
    for (const c of contacts) {
        const jid = phoneJidOf(c)
        if (!jid) continue
        upsertStmt.run({
            orgId,
            jid,
            name: c.name ?? null,
            notify: c.notify ?? null,
            updatedAt: now(),
        })
        saved++
    }
    return saved
})

/**
 * Guarda/actualiza contactos provenientes de eventos de Baileys.
 * Devuelve cuántos contactos con número válido se persistieron.
 */
export function saveContacts(orgId, contacts) {
    if (!orgId || !Array.isArray(contacts) || contacts.length === 0) return 0
    try {
        return upsertMany(orgId, contacts)
    } catch (e) {
        console.error(`[contacts:${orgId}] saveContacts error:`, e.message)
        return 0
    }
}

const listJidsStmt = db.prepare(`SELECT jid FROM contacts WHERE org_id = ?`)

/** Lista de JIDs (@s.whatsapp.net) para usar como statusJidList. */
export function getContactJids(orgId) {
    return listJidsStmt.all(orgId).map((r) => r.jid)
}

const countStmt = db.prepare(`SELECT COUNT(*) AS n FROM contacts WHERE org_id = ?`)

export function countContacts(orgId) {
    return countStmt.get(orgId).n
}

const listStmt = db.prepare(`
    SELECT jid, name, notify FROM contacts WHERE org_id = ? ORDER BY COALESCE(name, notify, jid)
`)

/** Lista completa para exponer por API (selección/preview en el cliente). */
export function listContacts(orgId) {
    return listStmt.all(orgId)
}
