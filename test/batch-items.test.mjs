// /send-batch rechaza de entrada los ítems que no se pueden encolar.
//
// El batch se completa cuando sent + failed alcanza `total`. Un ítem sin contenido no se encolaba y el batch
// quedaba en 'processing' para siempre, sin disparar su callback; uno sin phone rompía el INSERT a mitad del loop.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validarItemsBatch } from '../lib/batch-items.js'

const B64 = Buffer.from('x').toString('base64')

test('acepta cada forma de ítem que /send-batch sabe encolar', () => {
    assert.equal(validarItemsBatch([
        { phone: '595981000001', message: 'hola' },
        { phone: '595981000001', message: 'con pdf', document: { base64: B64, fileName: 'a.pdf', mimetype: 'application/pdf' } },
        { phone: '595981000001', document: { base64: B64, fileName: 'a.pdf' } },
        { phone: '595981000001', image: { base64: B64 }, message: 'pie' },
        { phone: '595981000001', video: { base64: B64, gifPlayback: true } },
        { phone: '595981000001', audio: { base64: B64 } },
        { phone: '595981000001', sticker: { base64: B64 } },
    ]), null)
})

test('rechaza un ítem sin mensaje ni medio, con su índice', () => {
    const error = validarItemsBatch([{ phone: '1', message: 'ok' }, { phone: '595981000001' }, { phone: '595981000001', message: '  ' }])
    assert.match(error, /messages\[1\]: falta message o un medio/)
    assert.match(error, /messages\[2\]/)
    assert.doesNotMatch(error, /messages\[0\]/)
})

test('rechaza un ítem sin phone o que no es un objeto', () => {
    assert.match(validarItemsBatch([{ message: 'hola' }]), /messages\[0\]: falta phone/)
    assert.match(validarItemsBatch([{ phone: 595981000001, message: 'hola' }]), /falta phone/)
    assert.match(validarItemsBatch([null]), /no es un objeto/)
    assert.match(validarItemsBatch(['hola']), /no es un objeto/)
})

test('rechaza un medio sin base64 o un documento sin fileName', () => {
    assert.match(validarItemsBatch([{ phone: '1', image: {} }]), /image\.base64/)
    assert.match(validarItemsBatch([{ phone: '1', document: { base64: B64 } }]), /document\.fileName/)
})

test('con muchos errores informa los primeros y cuántos más hay', () => {
    const error = validarItemsBatch(Array.from({ length: 13 }, () => ({})))
    assert.match(error, /messages\[9\]/)
    assert.doesNotMatch(error, /messages\[10\]/)
    assert.match(error, /y 3 más/)
})
