// Registro de rutas del webhook omnichannel (PUT /api/org-inbound-routes/:orgId).
//
// La validación es lo único que impide que un cliente de la API mande los
// mensajes de una sesión a cualquier lado, y la tabla es lo que hace que la ruta
// sobreviva a un deploy: si se pierde, las orgs registradas vuelven a caer al
// destino por defecto sin que nada falle.
//
// Corre con `npm test` (runner nativo de Node, sin dependencias).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { esOrgIdRegistrable, hostDe, validarRutaInbound } from '../lib/inbound-route.js'

const SECRET = 'un-secret-cualquiera'

/** Corre `fn` con ORG_INBOUND_ALLOW_LOCAL en el valor dado y lo deja como estaba. */
function conPermisoLocal(valor, fn) {
    const antes = process.env.ORG_INBOUND_ALLOW_LOCAL
    if (valor === undefined) delete process.env.ORG_INBOUND_ALLOW_LOCAL
    else process.env.ORG_INBOUND_ALLOW_LOCAL = valor
    try {
        return fn()
    } finally {
        if (antes === undefined) delete process.env.ORG_INBOUND_ALLOW_LOCAL
        else process.env.ORG_INBOUND_ALLOW_LOCAL = antes
    }
}

test('acepta una URL https con su secret y la deja normalizada', () => {
    const r = validarRutaInbound({ url: ' https://www.kusystem.com/api/whatsapp/inbound ', secret: SECRET })
    assert.deepEqual(r, { ok: true, url: 'https://www.kusystem.com/api/whatsapp/inbound', secret: SECRET })
})

test('http solo con un host público no pasa: los mensajes viajarían en claro', () => {
    assert.equal(validarRutaInbound({ url: 'http://www.kusystem.com/inbound', secret: SECRET }).ok, false)
})

test('un host local no se registra en producción: la org quedaría sin destino y diciendo que tiene ruta', () => {
    conPermisoLocal(undefined, () => {
        for (const url of [
            'http://localhost:3000/api/whatsapp/inbound',
            'https://localhost/inbound',
            'http://127.0.0.1:3000/inbound',
            'https://127.1.2.3/inbound',
            'https://[::1]/inbound',
            'http://0.0.0.0:3000/inbound',
            'https://app.localhost/inbound',
        ]) {
            const r = validarRutaInbound({ url, secret: SECRET })
            assert.equal(r.ok, false, url)
            assert.match(r.error, /local host/, url)
        }
    })
})

test('con ORG_INBOUND_ALLOW_LOCAL=1 se acepta contra la propia máquina (tests y desarrollo)', () => {
    conPermisoLocal('1', () => {
        assert.equal(validarRutaInbound({ url: 'http://127.0.0.1:3000/inbound', secret: SECRET }).ok, true)
        assert.equal(validarRutaInbound({ url: 'http://localhost:3000/inbound', secret: SECRET }).ok, true)
        assert.equal(
            validarRutaInbound({ url: 'http://www.kusystem.com/inbound', secret: SECRET }).ok,
            false,
            'el permiso es para la propia máquina, no para http en general'
        )
    })
})

test('rechaza lo que no es una URL de entrega', () => {
    for (const url of ['no es una url', 'javascript:alert(1)', 'file:///etc/passwd', 'ftp://x.test/y', '']) {
        assert.equal(validarRutaInbound({ url, secret: SECRET }).ok, false, url)
    }
    assert.equal(
        validarRutaInbound({ url: 'https://user:clave@www.kusystem.com/inbound', secret: SECRET }).ok,
        false,
        'credenciales embebidas'
    )
    assert.equal(
        validarRutaInbound({ url: `https://www.kusystem.com/${'a'.repeat(3000)}`, secret: SECRET }).ok,
        false,
        'URL desmesurada'
    )
})

test('sin secret o sin url no hay ruta, y el motivo nunca trae el secret', () => {
    assert.equal(validarRutaInbound({ url: 'https://www.kusystem.com/x' }).ok, false)
    assert.equal(validarRutaInbound({ url: 'https://www.kusystem.com/x', secret: '' }).ok, false)
    assert.equal(validarRutaInbound({ secret: SECRET }).ok, false)
    assert.equal(validarRutaInbound(undefined).ok, false)

    const r = validarRutaInbound({ url: 'http://malo.test/x', secret: SECRET })
    assert.equal(r.ok, false)
    assert.ok(!JSON.stringify(r).includes(SECRET))
})

test('el secret tiene tope de largo', () => {
    const url = 'https://www.kusystem.com/x'
    assert.equal(validarRutaInbound({ url, secret: 's'.repeat(512) }).ok, true)
    assert.equal(validarRutaInbound({ url, secret: 's'.repeat(513) }).ok, false)
})

test('orgId: acepta los que existen y rechaza los reservados, los raros y los que el bot no puede conectar', () => {
    for (const ok of ['2ed13699-0edc-4af7-9078-7b841a02aac5', 'asemara', 'test1', 'a'.repeat(64)]) {
        assert.equal(esOrgIdRegistrable(ok), true, ok)
    }
    for (const mal of [
        '_celeste',
        '',
        'con espacio',
        'a/b',
        '../x',
        'a'.repeat(65), // /api/connect rechaza más de 64 (ORG_ID_SEGURO de lib/whatsapp.js)
        'abc\n',
        null,
        undefined,
        42,
    ]) {
        assert.equal(esOrgIdRegistrable(mal), false, String(mal))
    }
})

test('hostDe deja solo el host', () => {
    assert.equal(hostDe('https://www.kusystem.com/api/whatsapp/inbound?x=1'), 'www.kusystem.com')
    assert.equal(hostDe('esto no es una url'), 'url inválida')
})

test('la ruta registrada se guarda, se pisa y se lee de la base', async () => {
    // db.js abre bot.db al importarse: DATA_DIR va apuntando a una carpeta propia
    // antes, para que el test no toque la base de nadie.
    process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'bot-rutas-'))
    const { upsertOrgInboundRoute, getOrgInboundRoute } = await import('../lib/db.js')

    assert.equal(getOrgInboundRoute('org-nueva'), undefined, 'sin registro no hay fila')

    upsertOrgInboundRoute({ orgId: 'org-nueva', url: 'https://a.test/inbound', secret: 'uno' })
    const primera = getOrgInboundRoute('org-nueva')
    assert.equal(primera.url, 'https://a.test/inbound')
    assert.equal(primera.secret, 'uno')

    upsertOrgInboundRoute({ orgId: 'org-nueva', url: 'https://b.test/inbound', secret: 'dos' })
    const segunda = getOrgInboundRoute('org-nueva')
    assert.equal(segunda.url, 'https://b.test/inbound', 'registrar de nuevo pisa la anterior')
    assert.equal(segunda.secret, 'dos')

    assert.equal(getOrgInboundRoute('otra'), undefined, 'una org no ve la ruta de otra')
})
