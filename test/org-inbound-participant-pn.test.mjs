// Número real de los participantes de grupo que WhatsApp manda sólo como LID.
//
// Está apagado por defecto y se prende por sesión con
// ORG_INBOUND_RESOLVE_PARTICIPANT_PN: para las demás sesiones el payload tiene
// que quedar exactamente como antes.
//
// Corre con `npm test` (runner nativo de Node, sin dependencias).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'

const LID = '107009177338054@lid'
const PN = '595981123456@s.whatsapp.net'

/** Servidor local que hace de SAAS receptor y guarda los payloads. */
async function saasFalso() {
    const payloads = []
    const srv = createServer((req, res) => {
        let body = ''
        req.on('data', (c) => (body += c))
        req.on('end', () => {
            payloads.push(JSON.parse(body))
            res.writeHead(200, { 'Content-Type': 'application/json' })
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

/** Socket mínimo: metadata del grupo y store de LIDs que no conoce a nadie. */
function sockFalso(participantes) {
    const pares = []
    return {
        pares,
        user: { id: '595990000000:1@s.whatsapp.net' },
        groupMetadata: async (jid) => ({ id: jid, subject: 'Consultas', participants: participantes }),
        signalRepository: {
            lidMapping: {
                getPNForLID: async () => null,
                storeLIDPNMappings: async (lista) => {
                    pares.push(...lista)
                },
            },
        },
    }
}

function mensajeDeGrupo(grupo, id) {
    return {
        key: { remoteJid: grupo, participant: LID, id, fromMe: false },
        message: { conversation: 'alguien tiene referencias?' },
        messageTimestamp: 1756700000,
    }
}

/**
 * Cada caso importa el módulo de nuevo: la lista de sesiones se lee una sola
 * vez por instancia. Los grupos cambian de caso a caso porque el caché de
 * metadata es compartido.
 */
let importN = 0
async function importarLimpio(env) {
    delete process.env.ORG_INBOUND_ROUTES
    delete process.env.ORG_INBOUND_RESOLVE_PARTICIPANT_PN
    Object.assign(process.env, {
        SUPABASE_URL: 'https://fake.supabase.co',
        SUPABASE_SERVICE_ROLE_KEY: 'fake-service-role',
        ORG_INBOUND_WEBHOOK_SECRET: 'secreto',
        ...env,
    })
    return import(`../lib/org-inbound-webhook.js?caso=${importN++}`)
}

test('la sesión habilitada recibe el número real del participante y el store aprende el par', async () => {
    const saas = await saasFalso()
    const sock = sockFalso([{ id: LID, phoneNumber: PN }])
    const mod = await importarLimpio({
        ORG_INBOUND_WEBHOOK_URL: saas.url,
        ORG_INBOUND_RESOLVE_PARTICIPANT_PN: 'otra-sesion, asemara',
    })

    await mod.maybeEmitOrgInboundWebhook('asemara', mensajeDeGrupo('120363000000000001@g.us', 'M-1'), sock)

    assert.equal(saas.payloads.length, 1)
    assert.equal(saas.payloads[0].participantPn, PN)
    assert.equal(saas.payloads[0].participantLid, LID)
    assert.deepEqual(sock.pares, [{ lid: LID, pn: PN }], 'la próxima vez lo resuelve el store')
    saas.cerrar()
})

test('las demás sesiones reciben el payload de siempre, sin número', async () => {
    const saas = await saasFalso()
    const sock = sockFalso([{ id: LID, phoneNumber: PN }])
    const mod = await importarLimpio({
        ORG_INBOUND_WEBHOOK_URL: saas.url,
        ORG_INBOUND_RESOLVE_PARTICIPANT_PN: 'asemara',
    })

    await mod.maybeEmitOrgInboundWebhook('org-de-flota', mensajeDeGrupo('120363000000000002@g.us', 'M-2'), sock)

    assert.equal(saas.payloads.length, 1)
    assert.equal(saas.payloads[0].participantPn, null)
    assert.equal(sock.pares.length, 0)
    saas.cerrar()
})

test('si el grupo no trae el número del participante, sigue sin número', async () => {
    const saas = await saasFalso()
    const sock = sockFalso([{ id: LID }])
    const mod = await importarLimpio({
        ORG_INBOUND_WEBHOOK_URL: saas.url,
        ORG_INBOUND_RESOLVE_PARTICIPANT_PN: 'asemara',
    })

    await mod.maybeEmitOrgInboundWebhook('asemara', mensajeDeGrupo('120363000000000003@g.us', 'M-3'), sock)

    assert.equal(saas.payloads.length, 1)
    assert.equal(saas.payloads[0].participantPn, null)
    assert.equal(saas.payloads[0].participantLid, LID)
    saas.cerrar()
})
