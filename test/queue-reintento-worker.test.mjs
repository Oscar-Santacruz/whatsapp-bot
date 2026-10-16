// El worker de la cola reintenta cuando la sesión está caída, en vez de dar el mensaje por perdido.
//
// Después de un deploy `resumeAllWorkers()` arranca antes de que las sesiones reconecten: sin reintento,
// todo lo pendiente quedaba `failed` en cadena. Un error que no es de conexión, en cambio, falla en el acto.
//
// Corre con `npm test`.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'bot-queue-retry-'))
process.env.SEND_DELAY_MIN_MS = '0'
process.env.SEND_DELAY_MAX_MS = '0'
process.env.QUEUE_CONNECTION_RETRY_MS = '20'

const { db } = await import('../lib/db.js')
const { enqueueText, setSocketProvider } = await import('../lib/queue.js')

const enviados = []
const sock = {
    presenceSubscribe: async () => {},
    sendPresenceUpdate: async () => {},
    sendMessage: async (jid, content) => {
        if (content.text === 'ROMPER') throw new Error('archivo rechazado')
        enviados.push(content.text)
        return { key: { remoteJid: jid, id: `MSG${enviados.length}`, fromMe: true }, message: { conversation: content.text } }
    },
}

// La sesión está caída hasta que `reconectar()` la levanta.
const sesion = { isConnected: false, sock }
const reconectar = () => { sesion.isConnected = true }
setSocketProvider((orgId) => (orgId === 'sin-sesion' ? undefined : sesion))

const fila = (id) => db.prepare(`SELECT status, attempts, error FROM outgoing_queue WHERE id = ?`).get(id)
const esperar = async (cond) => {
    // Cada envío pasa por la simulación de tipeo del anti-ban (2 a 5 s).
    for (let i = 0; i < 400 && !cond(); i++) await new Promise((r) => setTimeout(r, 50))
}

test('una sesión caída reintenta y el mensaje sale al reconectar, en orden', async () => {
    const primero = enqueueText({ orgId: 'org', phone: '595981000001', message: 'uno' })
    const segundo = enqueueText({ orgId: 'org', phone: '595981000001', message: 'dos' })

    await esperar(() => fila(primero).attempts >= 2)
    assert.notEqual(fila(primero).status, 'failed')
    assert.equal(fila(segundo).attempts, 0, 'el segundo espera su turno')

    reconectar()
    await esperar(() => fila(segundo).status === 'sent')

    assert.equal(fila(primero).status, 'sent')
    assert.equal(fila(segundo).status, 'sent')
    assert.deepEqual(enviados, ['uno', 'dos'])
})

test('sin conexión después de los intentos máximos, el mensaje falla', async () => {
    const id = enqueueText({ orgId: 'sin-sesion', phone: '595981000002', message: 'nadie' })
    await esperar(() => fila(id).status === 'failed')

    assert.equal(fila(id).status, 'failed')
    assert.equal(fila(id).attempts, 4)
    assert.equal(fila(id).error, 'WhatsApp not connected')
})

test('un error que no es de conexión falla al primer intento', async () => {
    const id = enqueueText({ orgId: 'org', phone: '595981000003', message: 'ROMPER' })
    await esperar(() => fila(id).status === 'failed')

    assert.equal(fila(id).status, 'failed')
    assert.equal(fila(id).attempts, 1)
})
