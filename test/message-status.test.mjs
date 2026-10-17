// Rechazos y entregas de lo que manda una sesión (lib/message-status.js) y su
// reenvío al SAAS como `message.status`, sólo a las orgs que lo piden.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { proto } from '@whiskeysockets/baileys'

import {
    crearFiltroEstados,
    estadosDeReceipts,
    estadosDeUpdates,
    lineaDeRechazo,
} from '../lib/message-status.js'

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'bot-estados-'))

const { Status } = proto.WebMessageInfo
const GRUPO = '120363425161105998@g.us'

test('un rechazo del servidor sale como error con su código', () => {
    const estados = estadosDeUpdates([
        { key: { remoteJid: GRUPO, id: 'A1', fromMe: true }, update: { status: Status.ERROR, messageStubParameters: ['479'] } },
    ])
    assert.deepEqual(estados, [
        { messageId: 'A1', jid: GRUPO, status: 'error', errorCode: '479', errorText: null },
    ])
})

test('se ignoran los mensajes ajenos, los sin status y el server ack', () => {
    const estados = estadosDeUpdates([
        { key: { remoteJid: GRUPO, id: 'B1', fromMe: false }, update: { status: Status.ERROR, messageStubParameters: ['479'] } },
        { key: { remoteJid: GRUPO, id: 'B2', fromMe: true }, update: { message: null } },
        { key: { remoteJid: GRUPO, id: 'B3', fromMe: true }, update: { status: Status.SERVER_ACK } },
    ])
    assert.deepEqual(estados, [])
})

test('la entrega 1:1 y los receipts de grupo salen como delivered', () => {
    assert.deepEqual(
        estadosDeUpdates([{ key: { remoteJid: '595981111111@s.whatsapp.net', id: 'C1', fromMe: true }, update: { status: Status.DELIVERY_ACK } }]),
        [{ messageId: 'C1', jid: '595981111111@s.whatsapp.net', status: 'delivered' }]
    )
    assert.deepEqual(
        estadosDeReceipts([
            { key: { remoteJid: GRUPO, id: 'C2', fromMe: true }, receipt: { userJid: '1@s.whatsapp.net', receiptTimestamp: 1 } },
            { key: { remoteJid: GRUPO, id: 'C3', fromMe: false }, receipt: { userJid: '1@s.whatsapp.net', receiptTimestamp: 1 } },
        ]),
        [{ messageId: 'C2', jid: GRUPO, status: 'delivered' }]
    )
})

test('el filtro deja pasar cada error y una sola entrega por mensaje', () => {
    const pasa = crearFiltroEstados(2)
    const entrega = { messageId: 'D1', jid: GRUPO, status: 'delivered' }
    const error = { messageId: 'D1', jid: GRUPO, status: 'error', errorCode: '479' }
    assert.equal(pasa(entrega), true)
    assert.equal(pasa(entrega), false)
    assert.equal(pasa(error), true)
    assert.equal(pasa(error), true)
    pasa({ messageId: 'D2', jid: GRUPO, status: 'delivered' })
    pasa({ messageId: 'D3', jid: GRUPO, status: 'delivered' })
    assert.equal(pasa(entrega), true, 'con el tope lleno se olvida la más vieja')
})

test('la línea de log no lleva el texto, sí id, chat y código', () => {
    assert.equal(
        lineaDeRechazo('asemara', { messageId: 'E1', jid: GRUPO, status: 'error', errorCode: '463', errorText: null }),
        `[wa - asemara] WhatsApp rechazó el envío E1 → ${GRUPO} (código 463)`
    )
})

async function saasFalso() {
    const entregas = []
    const srv = createServer((req, res) => {
        let body = ''
        req.on('data', (c) => (body += c))
        req.on('end', () => {
            entregas.push({ evento: req.headers['x-wa-event'], body: JSON.parse(body) })
            res.writeHead(200).end('{}')
        })
    })
    await new Promise((r) => srv.listen(0, '127.0.0.1', r))
    return { entregas, url: `http://127.0.0.1:${srv.address().port}/inbound`, cerrar: () => srv.close() }
}

test('message.status va sólo a las orgs de ORG_INBOUND_STATUS_EVENTS', async () => {
    const saas = await saasFalso()
    Object.assign(process.env, {
        SUPABASE_URL: 'https://fake.supabase.co',
        SUPABASE_SERVICE_ROLE_KEY: 'fake',
        ORG_INBOUND_WEBHOOK_URL: saas.url,
        ORG_INBOUND_WEBHOOK_SECRET: 'secreto',
        ORG_INBOUND_STATUS_EVENTS: ' asemara ,otra',
    })
    const mod = await import('../lib/org-inbound-webhook.js?caso=estados')
    const estado = { messageId: 'F1', jid: GRUPO, status: 'error', errorCode: '479', errorText: null }

    await mod.maybeEmitOrgStatusWebhook('asemara', estado)
    await mod.maybeEmitOrgStatusWebhook('flota-org', estado)

    assert.equal(saas.entregas.length, 1)
    assert.equal(saas.entregas[0].evento, 'message.status')
    assert.equal(saas.entregas[0].body.event, 'message.status')
    assert.equal(saas.entregas[0].body.orgId, 'asemara')
    assert.equal(saas.entregas[0].body.messageId, 'F1')
    assert.equal(saas.entregas[0].body.status, 'error')
    assert.equal(saas.entregas[0].body.errorCode, '479')
    saas.cerrar()
})
