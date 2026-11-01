// Los logs no pueden llevar claves de WhatsApp.
//
// libsignal loguea con console.info la sesión entera al cerrarla ("Closing session: SessionEntry
// { ... privKey: <Buffer ..> }") y esos volcados llegaban a Seq con privKey y rootKey.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import pino from 'pino'
import { redact } from '../lib/log-redact.js'

const require = createRequire(import.meta.url)
const { SessionRecord } = require('libsignal')

const b64 = (len, fill) => Buffer.alloc(len, fill).toString('base64')
const PRIV = Buffer.alloc(32, 0xab)
const ROOT = Buffer.alloc(32, 0xcd)
const BASE_KEY = b64(33, 5)

function sesionDePrueba() {
    const record = SessionRecord.deserialize({
        version: 'v1',
        registrationId: 1,
        _sessions: {
            [BASE_KEY]: {
                registrationId: 4242,
                currentRatchet: {
                    ephemeralKeyPair: { pubKey: b64(33, 1), privKey: PRIV.toString('base64') },
                    lastRemoteEphemeralKey: b64(33, 3),
                    previousCounter: 0,
                    rootKey: ROOT.toString('base64'),
                },
                indexInfo: { baseKey: BASE_KEY, baseKeyType: 1, closed: -1, used: 1, created: 1, remoteIdentityKey: b64(33, 6) },
                _chains: { [b64(33, 7)]: { chainKey: { counter: 0, key: b64(32, 8) }, chainType: 1, messageKeys: {} } },
            },
        },
    })
    return { record, entry: record.getSessions()[0] }
}

// Lo que console.* termina escribiendo en stdout/stderr.
function capturarSalida(fn) {
    const chunks = []
    const out = process.stdout.write
    const err = process.stderr.write
    process.stdout.write = (c) => (chunks.push(String(c)), true)
    process.stderr.write = (c) => (chunks.push(String(c)), true)
    try {
        fn()
    } finally {
        process.stdout.write = out
        process.stderr.write = err
    }
    return chunks.join('')
}

const HEX_PRIV = PRIV.toString('hex').match(/../g).join(' ')
const HEX_ROOT = ROOT.toString('hex').match(/../g).join(' ')

test('"Closing session" de libsignal sale en una línea, sin privKey ni rootKey', () => {
    const { record, entry } = sesionDePrueba()
    const salida = capturarSalida(() => {
        record.closeSession(entry)
        record.closeSession(entry) // "Session already closed"
    })
    assert.match(salida, /Closing session: <SessionEntry \[baseKey=/)
    assert.match(salida, /Session already closed <SessionEntry \[baseKey=/)
    assert.doesNotMatch(salida, /privKey|rootKey|chainKey|<Buffer/)
    assert.ok(!salida.includes(HEX_PRIV) && !salida.includes(HEX_ROOT))
    assert.equal(salida.trim().split('\n').length, 2)
})

test('un objeto cualquiera pierde los campos con claves y conserva el resto', () => {
    const r = redact({
        jid: '595981000000@s.whatsapp.net',
        creds: { noiseKey: { private: PRIV } },
        nested: { keyPair: { pubKey: 'pub', privKey: PRIV }, count: 3 },
    })
    assert.deepEqual(r, {
        jid: '595981000000@s.whatsapp.net',
        creds: '[redacted]',
        nested: { keyPair: { pubKey: 'pub', privKey: '[redacted]' }, count: 3 },
    })
})

test('strings, errores y ciclos pasan sin romperse', () => {
    const err = new Error('boom')
    assert.equal(redact('hola'), 'hola')
    assert.equal(redact(err), err)
    const ciclo = { a: 1 }
    ciclo.self = ciclo
    assert.deepEqual(redact(ciclo), { a: 1, self: '[Circular]' })
})

test('el logger pino de Baileys tampoco escribe claves', () => {
    const lineas = []
    const logger = pino(
        { level: 'trace', formatters: { log: (obj) => redact(obj) } },
        { write: (l) => lineas.push(l) }
    )
    const { entry } = sesionDePrueba()
    logger.warn({ session: entry, keys: { privKey: PRIV }, err: new Error('x') }, 'algo')
    const linea = lineas.join('')
    assert.doesNotMatch(linea, /privKey"\s*:\s*"?[^"\[]/)
    assert.ok(!linea.includes(PRIV.toString('base64')) && !linea.includes(HEX_PRIV))
    assert.match(linea, /<SessionEntry \[baseKey=/)
    assert.match(linea, /"err":\{"type":"Error","message":"x"/)
})
