// Responder citando un mensaje (`/send` con quotedMessageId).
//
// Baileys cita con `sendMessage(jid, content, { quoted })` y en un grupo la key tiene que traer al
// participante. Antes el store guardaba sólo el contenido y la cita iba dentro de `content`, donde
// Baileys la ignora: las respuestas salían como mensajes sueltos.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'bot-store-'))
const { saveMessage, getStoredQuoted } = await import('../lib/store.js')
const { resolveQuoted } = await import('../lib/quoted.js')

const GRUPO = '120363000000000000@g.us'

test('un mensaje de grupo se cita con su participante', () => {
    saveMessage('org', {
        key: { remoteJid: GRUPO, id: 'MSG1', fromMe: false, participant: '107009177338054@lid' },
        message: { conversation: 'Informes de 4.436.424' },
    })
    assert.deepEqual(getStoredQuoted('org', GRUPO, 'MSG1'), {
        key: { remoteJid: GRUPO, id: 'MSG1', fromMe: false, participant: '107009177338054@lid' },
        message: { conversation: 'Informes de 4.436.424' },
    })
})

test('un mensaje de grupo guardado sin participante no se cita', () => {
    saveMessage('org', { key: { remoteJid: GRUPO, id: 'MSG2', fromMe: false }, message: { conversation: 'viejo' } })
    assert.equal(getStoredQuoted('org', GRUPO, 'MSG2'), undefined)
})

test('en un chat privado no hace falta participante', () => {
    const jid = '595981123456@s.whatsapp.net'
    saveMessage('org', { key: { remoteJid: jid, id: 'MSG3', fromMe: false }, message: { conversation: 'hola' } })
    assert.deepEqual(getStoredQuoted('org', jid, 'MSG3')?.key, { remoteJid: jid, id: 'MSG3', fromMe: false })
})

test('un mensaje que no está en el store devuelve undefined', () => {
    assert.equal(getStoredQuoted('org', GRUPO, 'NO-EXISTE'), undefined)
})

// Chats privados: WhatsApp entrega el mensaje con el jid @lid y la respuesta sale por el número.

const NUMERO = '595981123456@s.whatsapp.net'
const LID = '107009177338054@lid'

/** Socket con el store de Baileys que conoce (o no) el número de un LID. */
function sockConLid(pares) {
    return { signalRepository: { lidMapping: { getPNForLID: async (lid) => pares[lid] ?? null } } }
}

test('un privado que llegó como @lid se cita al responder por el número del mismo contacto', async () => {
    saveMessage('org', { key: { remoteJid: LID, id: 'FOTO1', fromMe: false }, message: { conversation: 'comprobante' } })
    // getPNForLID devuelve el jid con device: tiene que comparar contra el jid de chat.
    const sock = sockConLid({ [LID]: '595981123456:0@s.whatsapp.net' })

    assert.deepEqual(await resolveQuoted(sock, 'org', NUMERO, 'FOTO1'), {
        key: { remoteJid: NUMERO, id: 'FOTO1', fromMe: false, participant: LID },
        message: { conversation: 'comprobante' },
    })
})

test('si el LID es de otro contacto, o no se sabe de quién es, no se cita', async () => {
    saveMessage('org', { key: { remoteJid: LID, id: 'FOTO2', fromMe: false }, message: { conversation: 'comprobante' } })

    assert.equal(await resolveQuoted(sockConLid({ [LID]: '595991000000@s.whatsapp.net' }), 'org', NUMERO, 'FOTO2'), undefined)
    assert.equal(await resolveQuoted(sockConLid({}), 'org', NUMERO, 'FOTO2'), undefined)
})

test('un mensaje de un grupo no se cita en el privado de quien lo mandó', async () => {
    saveMessage('org', {
        key: { remoteJid: GRUPO, id: 'FOTO3', fromMe: false, participant: LID },
        message: { conversation: 'comprobante al grupo' },
    })

    assert.equal(await resolveQuoted(sockConLid({ [LID]: NUMERO }), 'org', NUMERO, 'FOTO3'), undefined)
})

test('un mensaje de un privado no se cita en un grupo', async () => {
    saveMessage('org', { key: { remoteJid: LID, id: 'FOTO4', fromMe: false }, message: { conversation: 'comprobante' } })

    assert.equal(await resolveQuoted(sockConLid({ [LID]: NUMERO }), 'org', GRUPO, 'FOTO4'), undefined)
})

test('el mensaje guardado con el jid de destino se cita tal cual, en grupo y en privado', async () => {
    saveMessage('org', {
        key: { remoteJid: GRUPO, id: 'FOTO5', fromMe: false, participant: LID },
        message: { conversation: 'comprobante al grupo' },
    })
    saveMessage('org', { key: { remoteJid: NUMERO, id: 'FOTO6', fromMe: false }, message: { conversation: 'comprobante' } })

    assert.deepEqual((await resolveQuoted(sockConLid({}), 'org', GRUPO, 'FOTO5'))?.key, {
        remoteJid: GRUPO, id: 'FOTO5', fromMe: false, participant: LID,
    })
    assert.deepEqual((await resolveQuoted(sockConLid({}), 'org', NUMERO, 'FOTO6'))?.key, {
        remoteJid: NUMERO, id: 'FOTO6', fromMe: false,
    })
})

test('otra sesión no cita un mensaje que no es suyo', async () => {
    saveMessage('org', { key: { remoteJid: LID, id: 'FOTO7', fromMe: false }, message: { conversation: 'comprobante' } })

    assert.equal(await resolveQuoted(sockConLid({ [LID]: NUMERO }), 'otra-org', NUMERO, 'FOTO7'), undefined)
})
