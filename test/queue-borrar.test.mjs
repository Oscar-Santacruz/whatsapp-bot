// Borrar para todos un mensaje propio (POST /delete) y vaciar la cola de una sesión (POST /api/queue/cancel).
//
// Corre con `npm test`.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'bot-queue-borrar-'))
process.env.SEND_DELAY_MIN_MS = '0'
process.env.SEND_DELAY_MAX_MS = '0'

const { db } = await import('../lib/db.js')
const { enqueueDelete, cancelPending, setSocketProvider } = await import('../lib/queue.js')

const llamadas = []
let conectado = true
const sock = {
    presenceSubscribe: async () => { llamadas.push('presence') },
    sendPresenceUpdate: async () => { llamadas.push('presence') },
    onWhatsApp: async () => { throw new Error('no se resuelve el número para borrar') },
    sendMessage: async (jid, content) => {
        llamadas.push({ jid, content })
        return { key: { remoteJid: jid, id: `REVOKE${llamadas.length}`, fromMe: true } }
    },
}
setSocketProvider(() => (conectado ? { isConnected: true, sock } : { isConnected: false, sock: null }))

const fila = (id) => db.prepare(`SELECT status, error, sent_message_id FROM outgoing_queue WHERE id = ?`).get(id)
const esperar = async (cond) => {
    for (let i = 0; i < 400 && !cond(); i++) await new Promise((r) => setTimeout(r, 50))
}

test('borra para todos en el chat exacto, sin presencia', async () => {
    const grupo = '120363426294984696@g.us'
    const id = enqueueDelete({ orgId: 'org', jid: grupo, messageId: '3EB0AF43184F137529D11A' })
    await esperar(() => fila(id).status === 'sent')

    assert.equal(fila(id).status, 'sent')
    assert.deepEqual(llamadas, [{ jid: grupo, content: { delete: { remoteJid: grupo, fromMe: true, id: '3EB0AF43184F137529D11A' } } }])
})

test('cancelar vacía lo pendiente de esa sesión y no toca otras', async () => {
    conectado = false
    const insertar = db.prepare(`INSERT INTO outgoing_queue (org_id, phone, kind, message, status, created_at) VALUES (?, ?, 'text', 'viejo', 'pending', ?)`)
    const a = Number(insertar.run('rowill', 'g@g.us', Date.now() - 1000).lastInsertRowid)
    const b = Number(insertar.run('rowill', 'g@g.us', Date.now() - 1000).lastInsertRowid)
    const otra = Number(insertar.run('otra', 'g@g.us', Date.now() - 1000).lastInsertRowid)

    assert.equal(cancelPending({ orgId: 'rowill' }), 2)
    assert.equal(fila(a).status, 'failed')
    assert.equal(fila(a).error, 'cancelado a mano')
    assert.equal(fila(b).status, 'failed')
    assert.equal(fila(otra).status, 'pending')
    db.prepare(`DELETE FROM outgoing_queue WHERE id = ?`).run(otra)
})
