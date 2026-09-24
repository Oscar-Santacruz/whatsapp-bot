// La foto de perfil y la metadata de grupo son adornos del payload: si
// WhatsApp tarda en contestarlas, el webhook sale igual y sin ellas.
//
// Con un contacto nuevo la consulta de la foto a veces no vuelve nunca y
// Baileys la corta recién a los 60 s. Esperarla demoraba un minuto la entrega
// del primer mensaje de cada conversación.
//
// Corre con `npm test` (runner nativo de Node, sin dependencias).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'

const PN = '595981123456@s.whatsapp.net'

async function saasFalso() {
    const payloads = []
    const srv = createServer((req, res) => {
        let body = ''
        req.on('data', (c) => (body += c))
        req.on('end', () => {
            payloads.push(JSON.parse(body))
            res.writeHead(200, { 'Content-Type': 'application/json', Connection: 'close' })
            res.end('{"ok":true}')
        })
    })
    await new Promise((r) => srv.listen(0, '127.0.0.1', r))
    return {
        payloads,
        url: `http://127.0.0.1:${srv.address().port}/inbound`,
        cerrar: () => srv.close(),
    }
}

/** Socket cuyas consultas a WhatsApp tardan lo que diga `demoraMs` (Infinity = nunca). */
function sockLento({ demoraFotoMs = Infinity, demoraGrupoMs = Infinity, fotoError = null } = {}) {
    const esperar = (ms, valor, error) =>
        new Promise((resolve, reject) => {
            if (ms === Infinity) return
            setTimeout(() => (error ? reject(error) : resolve(valor)), ms).unref()
        })
    const llamadas = { foto: 0, grupo: 0 }
    return {
        llamadas,
        user: { id: '595990000000:1@s.whatsapp.net' },
        profilePictureUrl: () => {
            llamadas.foto++
            return esperar(demoraFotoMs, 'https://pps.whatsapp.net/foto.jpg', fotoError)
        },
        groupMetadata: (jid) => {
            llamadas.grupo++
            return esperar(demoraGrupoMs, { id: jid, subject: 'Taller', participants: [] })
        },
        signalRepository: { lidMapping: { getPNForLID: async () => null, storeLIDPNMappings: async () => {} } },
    }
}

function mensaje(remoteJid, id, extra = {}) {
    return {
        key: { remoteJid, id, fromMe: false, ...extra },
        message: { conversation: 'hola, quiero un presupuesto' },
        messageTimestamp: Math.floor(Date.now() / 1000),
        pushName: 'Cliente',
    }
}

let importN = 0
async function importarLimpio(url) {
    delete process.env.ORG_INBOUND_ROUTES
    Object.assign(process.env, {
        SUPABASE_URL: 'https://fake.supabase.co',
        SUPABASE_SERVICE_ROLE_KEY: 'fake-service-role',
        ORG_INBOUND_WEBHOOK_SECRET: 'secreto',
        ORG_INBOUND_WEBHOOK_URL: url,
    })
    return import(`../lib/org-inbound-webhook.js?foto=${importN++}`)
}

test('una foto que no vuelve nunca no demora la entrega', async () => {
    const saas = await saasFalso()
    const mod = await importarLimpio(saas.url)
    const sock = sockLento()

    const t0 = Date.now()
    await mod.maybeEmitOrgInboundWebhook('org-foto-colgada', mensaje(PN, 'F-1'), sock)
    const demora = Date.now() - t0

    assert.equal(saas.payloads.length, 1)
    assert.equal(saas.payloads[0].text, 'hola, quiero un presupuesto')
    assert.equal(saas.payloads[0].profilePictureUrl, null)
    assert.ok(demora < 4000, `tardó ${demora}ms`)
    saas.cerrar()
})

test('dos mensajes seguidos comparten la consulta de la foto en curso', async () => {
    const saas = await saasFalso()
    const mod = await importarLimpio(saas.url)
    const sock = sockLento()

    await Promise.all([
        mod.maybeEmitOrgInboundWebhook('org-dos-mensajes', mensaje(PN, 'D-1'), sock),
        mod.maybeEmitOrgInboundWebhook('org-dos-mensajes', mensaje(PN, 'D-2'), sock),
    ])

    assert.equal(saas.payloads.length, 2)
    assert.equal(sock.llamadas.foto, 1)
    saas.cerrar()
})

test('la foto que llega tarde queda en caché para el mensaje siguiente', async () => {
    const saas = await saasFalso()
    const mod = await importarLimpio(saas.url)
    const sock = sockLento({ demoraFotoMs: 3000 })

    await mod.maybeEmitOrgInboundWebhook('org-foto-tarde', mensaje(PN, 'T-1'), sock)
    assert.equal(saas.payloads[0].profilePictureUrl, null)

    await new Promise((r) => setTimeout(r, 1000))
    await mod.maybeEmitOrgInboundWebhook('org-foto-tarde', mensaje(PN, 'T-2'), sock)
    assert.equal(saas.payloads[1].profilePictureUrl, 'https://pps.whatsapp.net/foto.jpg')
    assert.equal(sock.llamadas.foto, 1)
    saas.cerrar()
})

test('una foto privada (not-authorized) se cachea y no se vuelve a pedir', async () => {
    const saas = await saasFalso()
    const mod = await importarLimpio(saas.url)
    const error = Object.assign(new Error('not-authorized'), { output: { statusCode: 500 } })
    const sock = sockLento({ demoraFotoMs: 10, fotoError: error })

    await mod.maybeEmitOrgInboundWebhook('org-foto-privada', mensaje(PN, 'P-1'), sock)
    await mod.maybeEmitOrgInboundWebhook('org-foto-privada', mensaje(PN, 'P-2'), sock)

    assert.equal(saas.payloads.length, 2)
    assert.equal(sock.llamadas.foto, 1)
    saas.cerrar()
})

test('la metadata de un grupo que no contesta no demora la entrega', async () => {
    const saas = await saasFalso()
    const mod = await importarLimpio(saas.url)
    const sock = sockLento({ demoraFotoMs: 10 })

    const t0 = Date.now()
    await mod.maybeEmitOrgInboundWebhook(
        'org-grupo-colgado',
        mensaje('120363000000000099@g.us', 'G-1', { participant: PN }),
        sock
    )

    assert.equal(saas.payloads.length, 1)
    assert.equal(saas.payloads[0].groupName, null)
    assert.ok(Date.now() - t0 < 4000)
    saas.cerrar()
})
