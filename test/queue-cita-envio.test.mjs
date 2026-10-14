// Responder a un envío anterior de la cola (`/send-image` con quotedJobId).
//
// Flota manda al grupo la tarjeta de un comprobante rechazado y después la foto del comprobante. Para que la
// foto salga como respuesta a la tarjeta haría falta el id de WhatsApp de la tarjeta, que no existe hasta que
// la cola la manda: lo que sí tiene quien encola es el `jobId`. La cola guarda el id con el que salió cada
// envío y lo resuelve cuando le toca al que lo cita.
//
// Corre con `npm test`. Tarda unos segundos: cada envío pasa por la simulación de tipeo del anti-ban.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'bot-queue-'))
process.env.SEND_DELAY_MIN_MS = '0'
process.env.SEND_DELAY_MAX_MS = '0'

const { db } = await import('../lib/db.js')
const { enqueueImage, setSocketProvider } = await import('../lib/queue.js')

const GRUPO = '120363000000000000@g.us'
const FOTO = Buffer.from('foto').toString('base64')

/** Socket que anota lo que se le pide mandar. Un pie `ROMPER` hace fallar ese envío. */
function sockFalso(orgId) {
    const envios = []
    const sock = {
        presenceSubscribe: async () => {},
        sendPresenceUpdate: async () => {},
        sendMessage: async (jid, content, options) => {
            if (content.caption === 'ROMPER') throw new Error('archivo rechazado')
            const enviado = {
                key: { remoteJid: jid, id: `${orgId}-MSG${envios.length + 1}`, fromMe: true },
                message: { imageMessage: { caption: content.caption ?? '' } },
            }
            envios.push({ id: enviado.key.id, message: enviado.message, options })
            return enviado
        },
    }
    return { envios, sock }
}

const sesiones = { tarjeta: sockFalso('tarjeta'), rota: sockFalso('rota'), ajena: sockFalso('ajena') }
setSocketProvider((orgId) => ({ isConnected: true, sock: sesiones[orgId].sock }))

const pendientes = db.prepare(`SELECT COUNT(*) AS n FROM outgoing_queue WHERE status IN ('pending', 'sending')`)

async function colaVacia() {
    while (pendientes.get().n > 0) await new Promise((r) => setTimeout(r, 100))
}

test('una imagen responde a lo que mandó un envío anterior de la cola', async () => {
    const tarjeta = enqueueImage({ orgId: 'tarjeta', phone: GRUPO, file: FOTO, caption: 'tarjeta' })
    enqueueImage({ orgId: 'tarjeta', phone: GRUPO, file: FOTO, quotedJobId: tarjeta })

    // El envío citado falló: la foto sale igual, suelta.
    const rota = enqueueImage({ orgId: 'rota', phone: GRUPO, file: FOTO, caption: 'ROMPER' })
    enqueueImage({ orgId: 'rota', phone: GRUPO, file: FOTO, quotedJobId: rota })

    // Una sesión no cita los envíos de otra aunque conozca su número.
    enqueueImage({ orgId: 'ajena', phone: GRUPO, file: FOTO, quotedJobId: tarjeta })

    await colaVacia()

    const [primero, segundo] = sesiones.tarjeta.envios
    assert.deepEqual(primero.options, {})
    assert.deepEqual(segundo.options, {
        quoted: { key: { remoteJid: GRUPO, id: primero.id, fromMe: true }, message: primero.message },
    })
    assert.equal(
        db.prepare(`SELECT sent_message_id FROM outgoing_queue WHERE id = ?`).get(tarjeta).sent_message_id,
        primero.id
    )

    assert.deepEqual(sesiones.rota.envios.map((e) => e.options), [{}])
    assert.deepEqual(sesiones.ajena.envios.map((e) => e.options), [{}])
})
