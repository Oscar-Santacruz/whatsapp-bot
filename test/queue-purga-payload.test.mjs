// La purga del payload de la cola: un envío terminado suelta su archivo (`document_base64`), que pesaba GBs.
//
// Se purga un `sent` enviado hace más de 24 h y un `failed` de más de 7 días. Un `sent` reciente (medido desde
// `sent_at`, no desde el encolado), un `failed` reciente y cualquier `pending`/`sending` conservan el archivo:
// el worker todavía lo necesita. La fila sobrevive entera, solo se anula el archivo. Si WhatsApp rechaza un
// envío ya purgado (o la purga corre mientras se procesa el rechazo), no se reencola.
//
// Corre con `npm test`.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'bot-queue-purga-'))
process.env.SEND_DELAY_MIN_MS = '0'
process.env.SEND_DELAY_MAX_MS = '0'

const { db, setOrgSettings } = await import('../lib/db.js')
for (const org of ['org-carrera', 'org-compound', 'org-compound-txt']) setOrgSettings(org, { reenviarRechazos: true })
const { purgeFinishedPayloads, handleServerRejection, setSocketProvider, PURGE_BATCH_SIZE } = await import('../lib/queue.js')

// Un socket que acepta todo, para los reenvíos que sí prosperan.
const enviados = []
const sockOk = {
    presenceSubscribe: async () => {},
    sendPresenceUpdate: async () => {},
    sendMessage: async (jid, content) => {
        enviados.push(content)
        return { key: { remoteJid: jid, id: `OK${enviados.length}`, fromMe: true }, message: { conversation: 'x' } }
    },
    authState: { keys: { set: async () => {} } },
}
setSocketProvider(() => ({ isConnected: true, sock: sockOk }))

const MINUTO = 60_000
const HORA = 3_600_000
const DIA = 24 * HORA
const AHORA = Date.now()

const insertar = db.prepare(`
    INSERT INTO outgoing_queue (org_id, phone, kind, status, document_base64, document_filename, error, sent_message_id, created_at, sent_at)
    VALUES (@orgId, @phone, @kind, @status, @doc, @filename, @error, @sentMessageId, @createdAt, @sentAt)
`)
// `hace`: cuánto hace que se encoló. `enviadoHace`: cuánto hace que salió (sin valor = no tiene sent_at).
const crear = ({ status, hace, enviadoHace = null, orgId = 'org', phone = '595981000001@s.whatsapp.net', kind = 'document', doc = 'QUJD', filename = 'f.pdf', error = null, sentMessageId = null }) =>
    Number(insertar.run({
        orgId, phone, kind, status, doc, filename, error, sentMessageId,
        createdAt: AHORA - hace,
        sentAt: enviadoHace === null ? null : AHORA - enviadoHace,
    }).lastInsertRowid)
const fila = (id) => db.prepare(`SELECT * FROM outgoing_queue WHERE id = ?`).get(id)

test('purga el archivo de un sent de más de 24 h y deja el resto de la fila', async () => {
    const id = crear({ status: 'sent', hace: 25 * HORA, sentMessageId: 'WA1' })
    const n = await purgeFinishedPayloads(AHORA)

    assert.ok(n >= 1)
    const f = fila(id)
    assert.equal(f.document_base64, null)
    assert.equal(f.status, 'sent')
    assert.equal(f.sent_message_id, 'WA1')
    assert.equal(f.document_filename, 'f.pdf')
})

test('no purga un sent reciente', async () => {
    const id = crear({ status: 'sent', hace: 23 * HORA })
    await purgeFinishedPayloads(AHORA)
    assert.equal(fila(id).document_base64, 'QUJD')
})

test('la ventana cuenta desde el envío: un sent encolado hace 25 h pero enviado hace 2 s conserva el archivo', async () => {
    const id = crear({ status: 'sent', hace: 25 * HORA, enviadoHace: 2_000 })
    await purgeFinishedPayloads(AHORA)
    assert.equal(fila(id).document_base64, 'QUJD')

    // Pasadas las 24 h desde el envío, sí se purga.
    await purgeFinishedPayloads(AHORA + 25 * HORA)
    assert.equal(fila(id).document_base64, null)
})

test('no purga un pending ni un sending por viejos que sean', async () => {
    const pendiente = crear({ status: 'pending', hace: 30 * DIA })
    const enviando = crear({ status: 'sending', hace: 30 * DIA })
    await purgeFinishedPayloads(AHORA)
    assert.equal(fila(pendiente).document_base64, 'QUJD')
    assert.equal(fila(enviando).document_base64, 'QUJD')
})

test('un failed se purga a los 7 días, no antes', async () => {
    const reciente = crear({ status: 'failed', hace: 6 * DIA, error: 'boom' })
    const viejo = crear({ status: 'failed', hace: 8 * DIA, error: 'boom' })
    await purgeFinishedPayloads(AHORA)

    assert.equal(fila(reciente).document_base64, 'QUJD')
    assert.equal(fila(viejo).document_base64, null)
    assert.equal(fila(viejo).error, 'boom')
})

test('anda con más filas que el tamaño de tanda y devuelve cuántas limpió', async () => {
    const total = PURGE_BATCH_SIZE * 3 + 7
    const ids = Array.from({ length: total }, () => crear({ status: 'sent', hace: 2 * DIA, orgId: 'org-tandas' }))
    const guardado = crear({ status: 'sent', hace: HORA, orgId: 'org-tandas' })

    assert.equal(await purgeFinishedPayloads(AHORA), total)
    assert.ok(ids.every((id) => fila(id).document_base64 === null))
    assert.equal(fila(guardado).document_base64, 'QUJD')
    // Ya no queda nada que limpiar.
    assert.equal(await purgeFinishedPayloads(AHORA), 0)
})

test('con el reloj adelantado, el sent reciente también se purga', async () => {
    const id = crear({ status: 'sent', hace: HORA, orgId: 'org-reloj' })
    await purgeFinishedPayloads(AHORA + 2 * DIA)
    assert.equal(fila(id).document_base64, null)
})

test('si la purga corre mientras se procesa el rechazo, queda fallido y no reencolado sin archivo', async () => {
    const grupo = '120363000000000003@g.us'
    // Recién salido (el rechazo entra en la ventana de reenvío); la purga corre con el reloj adelantado.
    const id = crear({ status: 'sent', hace: MINUTO, enviadoHace: MINUTO, orgId: 'org-carrera', phone: grupo, sentMessageId: 'WA-CARRERA' })
    // El archivo está al empezar (el chequeo previo pasa), pero la purga corre durante el await de las sender keys.
    const sock = { authState: { keys: { set: async () => { await purgeFinishedPayloads(AHORA + 2 * DIA) } } } }

    const r = await handleServerRejection('org-carrera', sock, { remoteJid: grupo, id: 'WA-CARRERA', code: '479' })
    assert.equal(r.action, 'failed')
    const f = fila(id)
    assert.equal(f.document_base64, null)
    assert.equal(f.status, 'failed')
    assert.match(f.error, /rechazado por WhatsApp \(479\).*purg/)
    assert.equal(f.rejected_resends, 0)
})

test('un compound con documento purgado no se reencola; uno sin documento sí', async () => {
    const grupo = '120363000000000004@g.us'
    const conPdf = crear({ status: 'sent', hace: MINUTO, enviadoHace: MINUTO, kind: 'compound', orgId: 'org-compound', phone: grupo, sentMessageId: 'WA-C1' })
    await purgeFinishedPayloads(AHORA + 2 * DIA)
    const r = await handleServerRejection('org-compound', sockOk, { remoteJid: grupo, id: 'WA-C1', code: '479' })
    assert.equal(r.action, 'failed')
    assert.equal(fila(conPdf).status, 'failed')

    // Sin documento (document_filename NULL) el compound es solo texto: no necesita archivo y se reenvía.
    const soloTexto = crear({ status: 'sent', hace: MINUTO, enviadoHace: MINUTO, kind: 'compound', doc: null, filename: null, orgId: 'org-compound-txt', phone: grupo, sentMessageId: 'WA-C2' })
    const r2 = await handleServerRejection('org-compound-txt', sockOk, { remoteJid: grupo, id: 'WA-C2', code: '479' })
    assert.equal(r2.action, 'resent')
    for (let i = 0; i < 400 && fila(soloTexto).status !== 'sent'; i++) await new Promise((r) => setTimeout(r, 50))
    assert.equal(fila(soloTexto).status, 'sent')
    assert.equal(fila(soloTexto).rejected_resends, 1)
})

test('un rechazo tardío de un envío ya purgado no lo toca ni lo reencola', async () => {
    const grupo = '120363000000000002@g.us'
    const id = crear({ status: 'sent', hace: 2 * DIA, enviadoHace: 2 * DIA, orgId: 'org-rechazo', phone: grupo, sentMessageId: 'WA-TARDE' })
    await purgeFinishedPayloads(AHORA)

    const r = await handleServerRejection('org-rechazo', null, { remoteJid: grupo, id: 'WA-TARDE', code: '479' })
    assert.equal(r.action, 'ignored')
    const f = fila(id)
    assert.equal(f.status, 'sent')
    assert.equal(f.rejected_resends, 0)
})
