// Un mensaje recuperado de message_store se reenvía al SAAS marcado `replay` (para que lo guarde sin
// contestar), baja el media con reuploadRequest y devuelve lo que contestó el SAAS.
//
// Corre con `npm test` (runner nativo de Node, sin dependencias).

import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'

const PN = '595981123456@s.whatsapp.net'

async function saasFalso(respuesta = { kind: 'inserted' }) {
    const payloads = []
    const srv = createServer((req, res) => {
        let body = ''
        req.on('data', (c) => (body += c))
        req.on('end', () => {
            payloads.push(JSON.parse(body))
            res.writeHead(200, { 'Content-Type': 'application/json', Connection: 'close' })
            res.end(JSON.stringify(respuesta))
        })
    })
    await new Promise((r) => srv.listen(0, '127.0.0.1', r))
    return { payloads, url: `http://127.0.0.1:${srv.address().port}/inbound`, cerrar: () => srv.close() }
}

const reuploadRequest = async () => {}
const sock = {
    user: { id: '595990000000:1@s.whatsapp.net' },
    updateMediaMessage: reuploadRequest,
    profilePictureUrl: async () => null,
    groupMetadata: async (jid) => ({ id: jid, subject: 'Taller', participants: [] }),
    signalRepository: { lidMapping: { getPNForLID: async () => null, storeLIDPNMappings: async () => {} } },
}

const imagen = (id) => ({
    key: { remoteJid: PN, id, fromMe: false },
    message: { imageMessage: { mimetype: 'image/jpeg', fileLength: 1234 } },
    messageTimestamp: 1_760_000_000,
})

let importN = 0
async function importarLimpio(url) {
    delete process.env.ORG_INBOUND_ROUTES
    Object.assign(process.env, {
        SUPABASE_URL: 'https://fake.supabase.co',
        SUPABASE_SERVICE_ROLE_KEY: 'fake-service-role',
        ORG_INBOUND_WEBHOOK_SECRET: 'secreto',
        ORG_INBOUND_WEBHOOK_URL: url,
    })
    return import(`../lib/org-inbound-webhook.js?replay=${importN++}`)
}

function deps() {
    const llamadas = []
    return {
        llamadas,
        download: async (message, replay) => {
            llamadas.push(replay)
            return Buffer.from('jpg')
        },
        upload: async () => ({ error: null }),
        delays: [1, 3],
    }
}

const { warn, error: errorOriginal } = console
beforeEach(() => {
    console.warn = () => {}
    console.error = () => {}
})
after(() => {
    console.warn = warn
    console.error = errorOriginal
})

test('replay: el payload va marcado, el media baja con reuploadRequest y se devuelve la respuesta del SAAS', async () => {
    const saas = await saasFalso({ kind: 'inserted', conversacionId: 'c1' })
    const mod = await importarLimpio(saas.url)
    const d = deps()
    mod.__setMediaDepsForTests(d)

    const r = await mod.maybeEmitOrgInboundWebhook('org-replay', imagen('RP-1'), sock, { replay: true })

    assert.equal(saas.payloads.length, 1)
    assert.equal(saas.payloads[0].replay, true)
    assert.equal(saas.payloads[0].messageId, 'RP-1')
    assert.equal(saas.payloads[0].timestamp, 1_760_000_000)
    assert.equal(d.llamadas[0].reuploadRequest, reuploadRequest)
    assert.equal(d.llamadas[0].key.id, 'RP-1')
    assert.equal(r.ok, true)
    assert.equal(r.body.kind, 'inserted')
    mod.__setMediaDepsForTests()
    saas.cerrar()
})

test('sin replay: el payload no lleva la marca y el media baja como siempre', async () => {
    const saas = await saasFalso()
    const mod = await importarLimpio(saas.url)
    const d = deps()
    mod.__setMediaDepsForTests(d)

    await mod.maybeEmitOrgInboundWebhook('org-replay', imagen('RP-2'), sock)

    assert.equal('replay' in saas.payloads[0], false)
    assert.equal(d.llamadas[0], null)
    mod.__setMediaDepsForTests()
    saas.cerrar()
})
