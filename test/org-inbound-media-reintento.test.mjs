// Una imagen sin caption vale por su media: si la subida a Storage falla por un
// error transitorio (07/10: un 520 de Cloudflare), el comprobante del chofer se
// perdía porque no había reintento. Descarga y subida reintentan solo lo
// transitorio; lo permanente (tamaño, mime, clave vacía) no.
//
// Corre con `npm test` (runner nativo de Node, sin dependencias).

import { test, beforeEach, after } from 'node:test'
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

const sock = {
    user: { id: '595990000000:1@s.whatsapp.net' },
    profilePictureUrl: async () => 'https://pps.whatsapp.net/foto.jpg',
    groupMetadata: async (jid) => ({ id: jid, subject: 'Taller', participants: [] }),
    signalRepository: { lidMapping: { getPNForLID: async () => null, storeLIDPNMappings: async () => {} } },
}

function imagenSinCaption(id) {
    return {
        key: { remoteJid: PN, id, fromMe: false },
        message: { imageMessage: { mimetype: 'image/jpeg', fileLength: 1234 } },
        messageTimestamp: Math.floor(Date.now() / 1000),
        pushName: 'Chofer',
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
    return import(`../lib/org-inbound-webhook.js?media=${importN++}`)
}

/** Subida falsa que devuelve, intento a intento, los `errores` y luego éxito. */
function deps(errores) {
    const llamadas = { download: 0, upload: 0 }
    let i = 0
    return {
        llamadas,
        download: async () => {
            llamadas.download++
            return Buffer.from('jpg')
        },
        upload: async () => {
            llamadas.upload++
            const message = errores[i++]
            return { error: message === undefined ? null : { message } }
        },
        delays: [1, 3],
    }
}

const silencio = []
const { warn, error: errorOriginal } = console
beforeEach(() => {
    silencio.length = 0
    console.warn = (...a) => silencio.push(a.join(' '))
    console.error = (...a) => silencio.push(a.join(' '))
})
after(() => {
    console.warn = warn
    console.error = errorOriginal
})

test('esErrorMediaTransitorio: vacíos, <none> y red son transitorios; tamaño, mime y clave no', async () => {
    const saas = await saasFalso()
    const { esErrorMediaTransitorio } = await importarLimpio(saas.url)
    saas.cerrar()

    for (const m of ['<none>', 'fetch failed', '']) {
        assert.equal(esErrorMediaTransitorio(new Error(m)), true, m)
    }
    for (const m of [
        'The object exceeded the maximum allowed size',
        'mime type text/csv is not supported',
        'Cannot derive from empty media key',
    ]) {
        assert.equal(esErrorMediaTransitorio(new Error(m)), false, m)
    }
})

test('imagen sin caption: la subida falla dos veces y a la tercera se entrega', async () => {
    const saas = await saasFalso()
    const mod = await importarLimpio(saas.url)
    const d = deps(['<none>', '<none>'])
    mod.__setMediaDepsForTests(d)

    await mod.maybeEmitOrgInboundWebhook('org-reintento', imagenSinCaption('R-1'), sock)

    assert.equal(saas.payloads.length, 1)
    assert.equal(saas.payloads[0].media.tipo, 'image')
    assert.equal(saas.payloads[0].media.storagePath, 'org-reintento/R-1.jpg')
    assert.equal(d.llamadas.download, 1)
    assert.equal(d.llamadas.upload, 3)
    assert.ok(silencio.some((l) => l.includes('image upload retry 1 (R-1): storage upload failed: <none>')))
    assert.ok(silencio.some((l) => l.includes('image upload retry 2 (R-1)')))
    mod.__setMediaDepsForTests()
    saas.cerrar()
})

test('error permanente de la subida: un solo intento y no se entrega', async () => {
    const saas = await saasFalso()
    const mod = await importarLimpio(saas.url)
    const d = deps(['The object exceeded the maximum allowed size'])
    mod.__setMediaDepsForTests(d)

    await mod.maybeEmitOrgInboundWebhook('org-permanente', imagenSinCaption('P-1'), sock)

    assert.equal(saas.payloads.length, 0)
    assert.equal(d.llamadas.upload, 1)
    assert.ok(silencio.some((l) => l.includes('image upload failed (P-1) tras 1 intentos')))
    mod.__setMediaDepsForTests()
    saas.cerrar()
})

test('agotados los 3 intentos transitorios se descarta como antes', async () => {
    const saas = await saasFalso()
    const mod = await importarLimpio(saas.url)
    const d = deps(['fetch failed', 'fetch failed', 'fetch failed', 'fetch failed'])
    mod.__setMediaDepsForTests(d)

    await mod.maybeEmitOrgInboundWebhook('org-agotado', imagenSinCaption('A-1'), sock)

    assert.equal(saas.payloads.length, 0)
    assert.equal(d.llamadas.upload, 3)
    assert.ok(silencio.some((l) => l.includes('image upload failed (A-1) tras 3 intentos')))
    mod.__setMediaDepsForTests()
    saas.cerrar()
})

test('"already exists" en el reintento cuenta como éxito', async () => {
    const saas = await saasFalso()
    const mod = await importarLimpio(saas.url)
    const d = deps(['<none>', 'The resource already exists'])
    mod.__setMediaDepsForTests(d)

    await mod.maybeEmitOrgInboundWebhook('org-ya-existe', imagenSinCaption('E-1'), sock)

    assert.equal(saas.payloads.length, 1)
    assert.equal(saas.payloads[0].media.storagePath, 'org-ya-existe/E-1.jpg')
    assert.equal(d.llamadas.upload, 2)
    mod.__setMediaDepsForTests()
    saas.cerrar()
})
