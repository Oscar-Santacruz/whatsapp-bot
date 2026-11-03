// Un envío que WhatsApp rechaza después de salir (messages.update con status ERROR) no queda como enviado.
//
// `sendMessage` vuelve apenas el mensaje sale del socket y el panel ve el eco, pero si el servidor lo
// rechaza no le llega a nadie del chat. En un grupo se reenvía una vez con las sender keys olvidadas.
//
// Corre con `npm test`.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'bot-queue-rechazo-'))
process.env.SEND_DELAY_MIN_MS = '0'
process.env.SEND_DELAY_MAX_MS = '0'

const { db } = await import('../lib/db.js')
const { enqueueText, setSocketProvider, handleServerRejection, REJECTION_RESEND_WINDOW_MS } = await import('../lib/queue.js')

const enviados = []
const keysOlvidadas = []
const sock = {
    presenceSubscribe: async () => {},
    sendPresenceUpdate: async () => {},
    sendMessage: async (jid, content) => {
        enviados.push(content.text)
        return { key: { remoteJid: jid, id: `MSG${enviados.length}`, fromMe: true }, message: { conversation: content.text } }
    },
    authState: { keys: { set: async (data) => { keysOlvidadas.push(data) } } },
}
setSocketProvider(() => ({ isConnected: true, sock }))

const fila = (id) => db.prepare(`SELECT status, error, sent_message_id, rejected_resends FROM outgoing_queue WHERE id = ?`).get(id)
const esperar = async (cond) => {
    for (let i = 0; i < 400 && !cond(); i++) await new Promise((r) => setTimeout(r, 50))
}

test('en un grupo, un rechazo reenvía una vez con las sender keys olvidadas', async () => {
    const grupo = '120363000000000001@g.us'
    const id = enqueueText({ orgId: 'org', phone: grupo, message: 'CI 1.234.567\nSin reportes.' })
    await esperar(() => fila(id).status === 'sent')
    const primero = fila(id).sent_message_id

    const r = await handleServerRejection('org', sock, { remoteJid: grupo, id: primero, code: '479' })
    assert.equal(r.action, 'resent')
    assert.deepEqual(keysOlvidadas, [{ 'sender-key-memory': { [grupo]: null } }])

    await esperar(() => fila(id).status === 'sent')
    const segundo = fila(id).sent_message_id
    assert.notEqual(segundo, primero)
    assert.equal(enviados.length, 2)

    // El segundo rechazo ya no se reenvía: queda fallido con el código.
    const r2 = await handleServerRejection('org', sock, { remoteJid: grupo, id: segundo, code: '479' })
    assert.equal(r2.action, 'failed')
    assert.equal(fila(id).status, 'failed')
    assert.equal(fila(id).error, 'rechazado por WhatsApp (479)')
    assert.equal(enviados.length, 2)
})

test('en un privado, un rechazo deja el envío fallido sin reenviar', async () => {
    const id = enqueueText({ orgId: 'org2', phone: '595981000001@s.whatsapp.net', message: 'hola' })
    await esperar(() => fila(id).status === 'sent')
    const antes = enviados.length

    const r = await handleServerRejection('org2', sock, { remoteJid: '595981000001@s.whatsapp.net', id: fila(id).sent_message_id, code: '463' })
    assert.equal(r.action, 'failed')
    assert.equal(fila(id).status, 'failed')
    assert.equal(fila(id).error, 'rechazado por WhatsApp (463)')
    await new Promise((r) => setTimeout(r, 100))
    assert.equal(enviados.length, antes)
})

test('un rechazo de un mensaje que no salió por la cola sólo se loguea', async () => {
    const r = await handleServerRejection('org', sock, { remoteJid: 'x@g.us', id: 'NO-EXISTE', code: '479' })
    assert.equal(r.action, 'ignored')
})

test('un rechazo que llega días después del envío no reenvía el mensaje viejo', async () => {
    // ROWILL, 03/11/2026: al reconectar llegaron ERROR de mensajes del 27/10 y salieron otra vez a 49 grupos.
    const grupo = '120363000000000002@g.us'
    const id = enqueueText({ orgId: 'org3', phone: grupo, message: 'recibimos tu pago' })
    await esperar(() => fila(id).status === 'sent')
    const salio = fila(id).sent_message_id
    db.prepare(`UPDATE outgoing_queue SET sent_at = ? WHERE id = ?`).run(Date.now() - 7 * 86_400_000, id)
    const antes = enviados.length

    const r = await handleServerRejection('org3', sock, { remoteJid: grupo, id: salio, code: '479' })
    assert.equal(r.action, 'ignored')
    assert.equal(fila(id).status, 'sent')
    assert.equal(fila(id).rejected_resends, 0)
    await new Promise((r) => setTimeout(r, 100))
    assert.equal(enviados.length, antes)
})

test('justo pasada la ventana tampoco se reenvía', async () => {
    const grupo = '120363000000000003@g.us'
    const id = enqueueText({ orgId: 'org4', phone: grupo, message: 'aviso' })
    await esperar(() => fila(id).status === 'sent')
    db.prepare(`UPDATE outgoing_queue SET sent_at = ? WHERE id = ?`).run(Date.now() - REJECTION_RESEND_WINDOW_MS - 1000, id)

    const r = await handleServerRejection('org4', sock, { remoteJid: grupo, id: fila(id).sent_message_id, code: '479' })
    assert.equal(r.action, 'ignored')
    assert.equal(fila(id).status, 'sent')
})

test('un rechazo de un envío que ya está fallido no lo reencola', async () => {
    const grupo = '120363000000000004@g.us'
    const id = enqueueText({ orgId: 'org5', phone: grupo, message: 'x' })
    await esperar(() => fila(id).status === 'sent')
    const salio = fila(id).sent_message_id
    db.prepare(`UPDATE outgoing_queue SET status = 'failed' WHERE id = ?`).run(id)

    const r = await handleServerRejection('org5', sock, { remoteJid: grupo, id: salio, code: '479' })
    assert.equal(r.action, 'ignored')
    assert.equal(fila(id).status, 'failed')
})
