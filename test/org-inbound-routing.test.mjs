// Ruteo del webhook omnichannel por org.
//
// Esto existe porque el bot le da conversaciones a DOS productos a la vez. Un
// mapa mal armado no rompe nada visible: las entregas siguen devolviendo 200,
// pero caen en el SAAS equivocado, que ignora los orgId que no conoce. Los
// mensajes se pierden sin un solo error en los logs — que fue exactamente lo
// que pasó durante meses con las sesiones de KuSystem.
//
// Corre con `npm test` (runner nativo de Node, sin dependencias).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createHmac } from 'node:crypto'

const SUPABASE_ENV = {
    SUPABASE_URL: 'https://fake.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'fake-service-role',
}

/** Servidor local que hace de SAAS receptor y guarda lo que le llega. */
async function saasFalso() {
    const entregas = []
    const srv = createServer((req, res) => {
        let body = ''
        req.on('data', (c) => (body += c))
        req.on('end', () => {
            entregas.push({
                firma: req.headers['x-hub-signature-256'],
                body,
                orgId: JSON.parse(body).orgId,
            })
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end('{"ok":true}')
        })
    })
    await new Promise((r) => srv.listen(0, '127.0.0.1', r))
    return {
        entregas,
        url: `http://127.0.0.1:${srv.address().port}/inbound`,
        cerrar: () => srv.close(),
    }
}

function mensajeDeTexto(id, texto) {
    return {
        key: { remoteJid: '595981111111@s.whatsapp.net', id, fromMe: false },
        message: { conversation: texto },
        messageTimestamp: 1756700000,
    }
}

function firmaEsperada(secret, body) {
    return `sha256=${createHmac('sha256', secret).update(body, 'utf8').digest('hex')}`
}

/**
 * El módulo cachea el mapa de rutas en el primer uso, así que cada caso lo
 * importa de nuevo con un query distinto para forzar una instancia limpia.
 */
let importN = 0
async function importarLimpio(env) {
    Object.assign(process.env, SUPABASE_ENV, env)
    return import(`../lib/org-inbound-webhook.js?caso=${importN++}`)
}

test('cada org aterriza en su propio SAAS, firmada con su propio secret', async () => {
    const kusystem = await saasFalso()
    const porDefecto = await saasFalso()
    const ORG_KU = 'cb99ca2e-0c7e-4349-9f46-bb042b345c78'
    const ORG_OTRA = '49e194db-b914-4bf4-a3ad-6164d62032b8'

    const mod = await importarLimpio({
        ORG_INBOUND_WEBHOOK_URL: porDefecto.url,
        ORG_INBOUND_WEBHOOK_SECRET: 'secreto-por-defecto',
        ORG_INBOUND_ROUTES: JSON.stringify({
            [ORG_KU]: { url: kusystem.url, secret: 'secreto-kusystem' },
        }),
    })

    await mod.maybeEmitOrgInboundWebhook(ORG_KU, mensajeDeTexto('M-KU', 'hola taller'))
    await mod.maybeEmitOrgInboundWebhook(ORG_OTRA, mensajeDeTexto('M-OTRA', 'hola flota'))

    assert.equal(kusystem.entregas.length, 1, 'la org ruteada entrega una sola vez')
    assert.equal(kusystem.entregas[0].orgId, ORG_KU)
    assert.equal(
        kusystem.entregas[0].firma,
        firmaEsperada('secreto-kusystem', kusystem.entregas[0].body),
        'firma con el secret de su ruta, no con el del default'
    )

    assert.equal(porDefecto.entregas.length, 1, 'la org sin ruta propia no se desvía')
    assert.equal(porDefecto.entregas[0].orgId, ORG_OTRA)
    assert.equal(
        porDefecto.entregas[0].firma,
        firmaEsperada('secreto-por-defecto', porDefecto.entregas[0].body)
    )

    kusystem.cerrar()
    porDefecto.cerrar()
})

test('un ORG_INBOUND_ROUTES roto no deja mudo al destino por defecto', async () => {
    const porDefecto = await saasFalso()

    const mod = await importarLimpio({
        ORG_INBOUND_WEBHOOK_URL: porDefecto.url,
        ORG_INBOUND_WEBHOOK_SECRET: 'secreto-por-defecto',
        ORG_INBOUND_ROUTES: '{esto no es json',
    })

    await mod.maybeEmitOrgInboundWebhook('cualquier-org', mensajeDeTexto('M1', 'hola'))

    assert.equal(porDefecto.entregas.length, 1, 'un typo en la env var no puede tragarse los mensajes')
    porDefecto.cerrar()
})

test('una entrada sin secret se descarta sola, sin arrastrar al resto del mapa', async () => {
    const bueno = await saasFalso()
    const porDefecto = await saasFalso()

    const mod = await importarLimpio({
        ORG_INBOUND_WEBHOOK_URL: porDefecto.url,
        ORG_INBOUND_WEBHOOK_SECRET: 'secreto-por-defecto',
        ORG_INBOUND_ROUTES: JSON.stringify({
            'org-completa': { url: bueno.url, secret: 'secreto-propio' },
            'org-a-medias': { url: 'https://ejemplo.test/inbound' },
        }),
    })

    await mod.maybeEmitOrgInboundWebhook('org-completa', mensajeDeTexto('M-OK', 'va a la suya'))
    await mod.maybeEmitOrgInboundWebhook('org-a-medias', mensajeDeTexto('M-MAL', 'cae al default'))

    assert.equal(bueno.entregas.length, 1, 'la entrada válida sigue ruteando')
    assert.equal(porDefecto.entregas.length, 1, 'la entrada inválida cae al default en vez de perderse')
    assert.equal(porDefecto.entregas[0].orgId, 'org-a-medias')

    bueno.cerrar()
    porDefecto.cerrar()
})
