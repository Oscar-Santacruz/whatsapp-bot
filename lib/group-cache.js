const TTL_MS = 5 * 60 * 1000

// `${orgId}:${jid}` → { subject, participants, cachedAt }
const cache = new Map()

function key(orgId, jid) {
    return `${orgId}:${jid}`
}

function isExpired(entry) {
    return Date.now() - entry.cachedAt > TTL_MS
}

export function setGroupMeta(orgId, jid, { subject, participants }) {
    if (!jid) return
    const existing = cache.get(key(orgId, jid)) ?? {}
    cache.set(key(orgId, jid), {
        subject: subject ?? existing.subject ?? null,
        participants: participants ?? existing.participants ?? null,
        cachedAt: Date.now(),
    })
}

export function getGroupMeta(orgId, jid) {
    const entry = cache.get(key(orgId, jid))
    if (!entry || isExpired(entry)) return null
    return entry
}

export function invalidateGroup(orgId, jid) {
    cache.delete(key(orgId, jid))
}

export function clearOrgGroupCache(orgId) {
    for (const k of cache.keys()) {
        if (k.startsWith(`${orgId}:`)) cache.delete(k)
    }
}
