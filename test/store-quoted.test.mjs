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
