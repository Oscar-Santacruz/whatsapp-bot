// POST /media/firmar: la autorización decide qué archivos de qué org puede abrir
// quien llama. Un hueco acá no falla visible: entrega URLs de otra org.
//
// Corre con `npm test` (runner nativo de Node, sin dependencias).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { firmarMedia, firmaMediaFirmar, MAX_PATHS } from '../lib/media-firmar.js'

const AHORA = 1_800_000_000
const SECRET_KU = 'secreto-kusystem'
const ORG_KU = 'org-ku-1'
const ORG_KU2 = 'org-ku-2'
const ORG_FLOTA = 'org-flota'
const secretPropio = (orgId) => ({ [ORG_KU]: SECRET_KU, [ORG_KU2]: SECRET_KU })[orgId] ?? null

function armar(paths, { ts = AHORA, secret = SECRET_KU } = {}) {
    const firmadas = []
    return {
        firmadas,
        pedir: (override = {}) =>
            firmarMedia({
                body: { ts, paths },
                signature: firmaMediaFirmar(secret, ts, paths),
                secretPropio,
                firmar: async (ps) => {
                    firmadas.push(ps)
                    return ps.map((p) => (p.endsWith('falta.jpg') ? { path: null } : { path: p, signedUrl: `https://s/${p}?t=1` }))
                },
                ahora: AHORA,
                ...override,
            }),
    }
}

test('firma los paths de la org propia, dedup, y omite los que no existen', async () => {
    const paths = [`${ORG_KU}/a.jpg`, `${ORG_KU}/a.jpg`, `${ORG_KU2}/b.ogg`, `${ORG_KU}/falta.jpg`]
    const t = armar(paths)
    const r = await t.pedir()
    assert.equal(r.status, 200)
    assert.deepEqual(r.body.urls, {
        [`${ORG_KU}/a.jpg`]: `https://s/${ORG_KU}/a.jpg?t=1`,
        [`${ORG_KU2}/b.ogg`]: `https://s/${ORG_KU2}/b.ogg?t=1`,
    })
    assert.equal(t.firmadas[0].length, 3, 'una sola llamada, sin repetidos')
})

test('un path de una org sin ruta propia (flota / default) se rechaza aunque la firma sea buena', async () => {
    const r = await armar([`${ORG_FLOTA}/x.jpg`]).pedir()
    assert.equal(r.status, 401)
    const mezcla = await armar([`${ORG_KU}/a.jpg`, `${ORG_FLOTA}/x.jpg`]).pedir()
    assert.equal(mezcla.status, 401, 'una sola org ajena tumba todo el pedido')
})

test('firma con otro secret, o sin firma, o con paths alterados: 401 y no firma nada', async () => {
    const t = armar([`${ORG_KU}/a.jpg`], { secret: 'otro' })
    assert.equal((await t.pedir()).status, 401)
    assert.equal((await armar([`${ORG_KU}/a.jpg`]).pedir({ signature: undefined })).status, 401)
    const alterado = armar([`${ORG_KU}/a.jpg`])
    assert.equal(
        (await alterado.pedir({ body: { ts: AHORA, paths: [`${ORG_KU}/a.jpg`, `${ORG_KU2}/b.jpg`] } })).status,
        401
    )
    assert.equal(t.firmadas.length + alterado.firmadas.length, 0)
})

test('timestamp fuera de ±5 min: 401 (anti-replay)', async () => {
    assert.equal((await armar([`${ORG_KU}/a.jpg`], { ts: AHORA - 301 }).pedir()).status, 401)
    assert.equal((await armar([`${ORG_KU}/a.jpg`], { ts: AHORA + 301 }).pedir()).status, 401)
    assert.equal((await armar([`${ORG_KU}/a.jpg`], { ts: AHORA - 299 }).pedir()).status, 200)
})

test('paths malformados o traversal: 400', async () => {
    for (const p of ['../x.jpg', `${ORG_KU}/../${ORG_FLOTA}/x.jpg`, `${ORG_KU}/sub/a.jpg`, 'sin-barra.jpg', `${ORG_KU}/a`, '', `/${ORG_KU}/a.jpg`]) {
        assert.equal((await armar([p]).pedir()).status, 400, p)
    }
    assert.equal((await armar([`${ORG_KU}/a.jpg`]).pedir({ body: { ts: AHORA, paths: [] } })).status, 400)
    assert.equal((await armar([`${ORG_KU}/a.jpg`]).pedir({ body: { ts: 'x', paths: [`${ORG_KU}/a.jpg`] } })).status, 400)
    assert.equal((await armar([`${ORG_KU}/a.jpg`]).pedir({ body: null })).status, 400)
})

test(`más de ${MAX_PATHS} paths: 400`, async () => {
    const paths = Array.from({ length: MAX_PATHS + 1 }, (_, i) => `${ORG_KU}/m${i}.jpg`)
    assert.equal((await armar(paths).pedir()).status, 400)
    assert.equal((await armar(paths.slice(0, MAX_PATHS)).pedir()).status, 200)
})
