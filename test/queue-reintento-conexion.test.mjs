import { test } from 'node:test'
import assert from 'node:assert/strict'
import { shouldRetryConnectionError } from '../lib/queue.js'

test('reintenta las caídas de conexión hasta el máximo de intentos', () => {
    assert.equal(shouldRetryConnectionError({ kind: 'text', attempts: 1 }, new Error('WhatsApp not connected')), true)
    assert.equal(shouldRetryConnectionError({ kind: 'image', attempts: 3 }, new Error('Connection Closed')), true)
    assert.equal(shouldRetryConnectionError({ kind: 'text', attempts: 4 }, new Error('WhatsApp not connected')), false)
})

test('no reintenta otros errores ni los estados', () => {
    assert.equal(shouldRetryConnectionError({ kind: 'text', attempts: 1 }, new Error('forbidden')), false)
    assert.equal(shouldRetryConnectionError({ kind: 'text', attempts: 1 }, new Error('Phone not registered on WhatsApp')), false)
    assert.equal(shouldRetryConnectionError({ kind: 'status', attempts: 1 }, new Error('WhatsApp not connected')), false)
})
