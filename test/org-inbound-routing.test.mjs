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
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// El módulo lee las rutas registradas de la base (bot.db en DATA_DIR): se le da
// una carpeta propia ANTES del primer import, para no tocar la base de nadie.
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'bot-ruteo-'))

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

test('un espacio de más al pegar la clave no manda la sesión al destino equivocado', async () => {
    const propio = await saasFalso()
    const porDefecto = await saasFalso()
    const ORG = 'cb99ca2e-0c7e-4349-9f46-bb042b345c78'

    const mod = await importarLimpio({
        ORG_INBOUND_WEBHOOK_URL: porDefecto.url,
        ORG_INBOUND_WEBHOOK_SECRET: 'secreto-por-defecto',
        ORG_INBOUND_ROUTES: JSON.stringify({ [` ${ORG} `]: { url: propio.url, secret: 'propio' } }),
    })

    await mod.maybeEmitOrgInboundWebhook(ORG, mensajeDeTexto('M-TRIM', 'hola'))

    assert.equal(propio.entregas.length, 1, 'la clave se trimea antes de indexar')
    assert.equal(porDefecto.entregas.length, 0)

    propio.cerrar()
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

/** Registra una ruta como lo hace el PUT: directo en la base que lee la entrega. */
async function registrar(orgId, url, secret) {
    const { upsertOrgInboundRoute } = await import('../lib/db.js')
    upsertOrgInboundRoute({ orgId, url, secret })
}

test('una ruta registrada por la app lleva la org a su SAAS, con su propio secret', async () => {
    const kusystem = await saasFalso()
    const porDefecto = await saasFalso()
    const ORG_NUEVA = '2ed13699-0edc-4af7-9078-7b841a02aac5'

    const mod = await importarLimpio({
        ORG_INBOUND_WEBHOOK_URL: porDefecto.url,
        ORG_INBOUND_WEBHOOK_SECRET: 'secreto-por-defecto',
        ORG_INBOUND_ROUTES: '',
    })
    await registrar(ORG_NUEVA, kusystem.url, 'secreto-registrado')

    await mod.maybeEmitOrgInboundWebhook(ORG_NUEVA, mensajeDeTexto('M-REG', 'hola tienda'))
    await mod.maybeEmitOrgInboundWebhook('otra-org', mensajeDeTexto('M-DEF', 'hola flota'))

    assert.equal(kusystem.entregas.length, 1, 'la org registrada entrega en su SAAS, sin tocar el env')
    assert.equal(kusystem.entregas[0].orgId, ORG_NUEVA)
    assert.equal(
        kusystem.entregas[0].firma,
        firmaEsperada('secreto-registrado', kusystem.entregas[0].body),
        'firma con el secret que registró la app'
    )
    assert.equal(porDefecto.entregas.length, 1, 'la org sin ruta sigue cayendo al default')
    assert.equal(porDefecto.entregas[0].orgId, 'otra-org')

    kusystem.cerrar()
    porDefecto.cerrar()
})

test('la ruta del env le gana a la registrada para la misma org', async () => {
    const delOperador = await saasFalso()
    const registrado = await saasFalso()
    const ORG = 'org-en-los-dos'

    const mod = await importarLimpio({
        ORG_INBOUND_WEBHOOK_URL: registrado.url,
        ORG_INBOUND_WEBHOOK_SECRET: 'secreto-por-defecto',
        ORG_INBOUND_ROUTES: JSON.stringify({ [ORG]: { url: delOperador.url, secret: 'secreto-del-operador' } }),
    })
    await registrar(ORG, registrado.url, 'secreto-registrado')

    await mod.maybeEmitOrgInboundWebhook(ORG, mensajeDeTexto('M-ENV', 'hola'))

    assert.equal(delOperador.entregas.length, 1, 'lo que el operador puso en el env manda')
    assert.equal(registrado.entregas.length, 0)
    assert.equal(
        delOperador.entregas[0].firma,
        firmaEsperada('secreto-del-operador', delOperador.entregas[0].body)
    )
    // El diagnóstico sale de la misma decisión que la entrega: no puede decir otra cosa.
    assert.equal(mod.describeInboundRoute(ORG).source, 'env')

    delOperador.cerrar()
    registrado.cerrar()
})

test('describeInboundRoute dice de dónde sale el destino y nunca el secret', async () => {
    const ORG_ENV = 'org-en-el-env'
    const ORG_REG = 'org-registrada'

    const mod = await importarLimpio({
        ORG_INBOUND_WEBHOOK_URL: 'https://flota.ejemplo.test/inbound',
        ORG_INBOUND_WEBHOOK_SECRET: 'secreto-por-defecto',
        ORG_INBOUND_ROUTES: JSON.stringify({ [ORG_ENV]: { url: 'https://env.ejemplo.test/x', secret: 'secreto-env' } }),
    })
    await registrar(ORG_REG, 'https://reg.ejemplo.test/y', 'secreto-reg')

    assert.deepEqual(mod.describeInboundRoute(ORG_ENV), { source: 'env', host: 'env.ejemplo.test' })
    assert.deepEqual(mod.describeInboundRoute(ORG_REG), { source: 'registered', host: 'reg.ejemplo.test' })
    assert.deepEqual(mod.describeInboundRoute('cualquiera'), { source: 'default', host: 'flota.ejemplo.test' })

    assert.equal(mod.hasOwnInboundRoute(ORG_ENV), true)
    assert.equal(mod.hasOwnInboundRoute(ORG_REG), true)
    assert.equal(mod.hasOwnInboundRoute('cualquiera'), false, 'caer al default no es tener ruta propia')

    const todo = JSON.stringify([ORG_ENV, ORG_REG, 'cualquiera'].map((o) => mod.describeInboundRoute(o)))
    assert.ok(!/secreto-|\/x"|\/y"|\/inbound/.test(todo), 'ni el secret ni el path salen de acá')
})

test('un destino por defecto sin secret no cuenta como destino, ni en la entrega ni en el diagnóstico', async () => {
    const mod = await importarLimpio({
        ORG_INBOUND_WEBHOOK_URL: 'https://flota.ejemplo.test/inbound',
        ORG_INBOUND_WEBHOOK_SECRET: '',
        ORG_INBOUND_ROUTES: '',
    })

    assert.deepEqual(mod.describeInboundRoute('huerfana'), { source: 'none', host: null })
    assert.equal(mod.hasOwnInboundRoute('huerfana'), false)
})

test('si falla la lectura de la ruta registrada, el mensaje no cae a flota ni tira', async () => {
    const porDefecto = await saasFalso()
    const mod = await importarLimpio({
        ORG_INBOUND_WEBHOOK_URL: porDefecto.url,
        ORG_INBOUND_WEBHOOK_SECRET: 'secreto-por-defecto',
        ORG_INBOUND_ROUTES: '',
    })
    const { db } = await import('../lib/db.js')

    db.exec('ALTER TABLE org_inbound_routes RENAME TO org_inbound_routes_apagada')
    try {
        await assert.doesNotReject(() =>
            mod.maybeEmitOrgInboundWebhook('org-sin-ruta', mensajeDeTexto('M-DB', 'hola'))
        )
        assert.equal(
            porDefecto.entregas.length,
            0,
            'una base rota no manda los mensajes de una sesión de KuSystem al destino por defecto'
        )
        assert.throws(() => mod.describeInboundRoute('org-sin-ruta'), 'el diagnóstico no inventa una respuesta')
    } finally {
        db.exec('ALTER TABLE org_inbound_routes_apagada RENAME TO org_inbound_routes')
        porDefecto.cerrar()
    }
})
