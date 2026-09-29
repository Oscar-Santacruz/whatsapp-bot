// La API de rutas, con el servidor de verdad (index.js) y una base propia.
//
// Lo que este archivo cuida es lo que los tests de módulo no ven: que los
// endpoints estén cableados, que respondan lo que la app espera, que la ruta
// sobreviva a un reinicio y que ni el secret ni un pedazo de él salgan por un log
// o una respuesta. Una ruta mal registrada no falla: los mensajes se pierden.
//
// Corre con `npm test` (runner nativo de Node, sin dependencias).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { createServer } from 'node:net'
import Database from 'better-sqlite3'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const RAIZ = fileURLToPath(new URL('..', import.meta.url))
const TOKEN = 'token-de-prueba'
const SECRET = 'secreto-de-kusystem-9f8e7d'
const ORG = '2ed13699-0edc-4af7-9078-7b841a02aac5'
const ORG_EN_ENV = 'org-en-el-env'

async function puertoLibre() {
    const srv = createServer()
    await new Promise((r) => srv.listen(0, '127.0.0.1', r))
    const { port } = srv.address()
    await new Promise((r) => srv.close(r))
    return port
}

/** Levanta index.js con su propia base y puerto. Devuelve cómo hablarle y cómo apagarlo. */
async function levantar(dataDir) {
    const port = await puertoLibre()
    const hijo = spawn(process.execPath, ['index.js'], {
        cwd: RAIZ,
        env: {
            ...process.env,
            PORT: String(port),
            API_TOKEN: TOKEN,
            DATA_DIR: dataDir,
            SUPABASE_URL: 'https://fake.supabase.co',
            SUPABASE_SERVICE_ROLE_KEY: 'fake',
            ORG_INBOUND_WEBHOOK_URL: 'https://flota.ejemplo.test/api/inbound',
            ORG_INBOUND_WEBHOOK_SECRET: 'secreto-por-defecto',
            ORG_INBOUND_ROUTES: JSON.stringify({
                [ORG_EN_ENV]: { url: 'https://env.ejemplo.test/x', secret: 'secreto-env' },
            }),
            ORG_INBOUND_ALLOW_LOCAL: '',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    })

    const logs = []
    hijo.stdout.on('data', (d) => logs.push(String(d)))
    hijo.stderr.on('data', (d) => logs.push(String(d)))

    await new Promise((resolve, reject) => {
        const limite = setTimeout(() => reject(new Error(`no levantó: ${logs.join('')}`)), 20000)
        const espera = setInterval(() => {
            if (logs.join('').includes('WhatsApp API running')) {
                clearTimeout(limite)
                clearInterval(espera)
                resolve()
            }
        }, 50)
    })

    async function api(metodo, ruta, { cuerpo, crudo, token = TOKEN } = {}) {
        const r = await fetch(`http://127.0.0.1:${port}${ruta}`, {
            method: metodo,
            headers: {
                'Content-Type': 'application/json',
                ...(token ? { Authorization: `Bearer ${token}` } : {}),
            },
            body: crudo ?? (cuerpo ? JSON.stringify(cuerpo) : undefined),
        })
        return { status: r.status, json: await r.json().catch(() => null) }
    }

    return {
        api,
        logs: () => logs.join(''),
        apagar: async () => {
            hijo.kill()
            await new Promise((r) => hijo.once('exit', r))
        },
    }
}

const RUTA_KUSYSTEM = { url: 'https://www.kusystem.com/api/whatsapp/inbound', secret: SECRET }

test('registrar una ruta por la API: se valida, rige, se puede mirar y sobrevive a un reinicio', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'bot-api-'))
    let bot = await levantar(dataDir)
    try {
        // Sin ruta propia, la org cae al destino por defecto y el status lo dice.
        let r = await bot.api('GET', `/api/status/${ORG}`)
        assert.equal(r.status, 200)
        assert.equal(r.json.inboundRouted, false)
        assert.equal(r.json.connected, false, 'lo que ya devolvía /api/status sigue igual')
        r = await bot.api('GET', `/api/org-inbound-routes/${ORG}`)
        assert.deepEqual(r.json, { orgId: ORG, source: 'default', host: 'flota.ejemplo.test' })

        // La validación se hace ACÁ: lo que no pasa no se guarda.
        const ruta = `/api/org-inbound-routes/${ORG}`
        assert.equal((await bot.api('PUT', ruta, { cuerpo: RUTA_KUSYSTEM, token: null })).status, 401)
        assert.equal((await bot.api('PUT', ruta, { cuerpo: { url: 'http://www.kusystem.com/x', secret: SECRET } })).status, 400)
        assert.equal((await bot.api('PUT', ruta, { cuerpo: { url: 'http://localhost:3000/x', secret: SECRET } })).status, 400)
        assert.equal((await bot.api('PUT', ruta, { cuerpo: { url: RUTA_KUSYSTEM.url } })).status, 400)
        assert.equal((await bot.api('PUT', '/api/org-inbound-routes/_celeste', { cuerpo: RUTA_KUSYSTEM })).status, 400)
        assert.equal((await bot.api('PUT', `/api/org-inbound-routes/${'a'.repeat(65)}`, { cuerpo: RUTA_KUSYSTEM })).status, 400)
        r = await bot.api('GET', `/api/status/${ORG}`)
        assert.equal(r.json.inboundRouted, false, 'ningún intento inválido dejó una ruta')

        // Un body roto no cita el secret ni en la respuesta ni en el log.
        r = await bot.api('PUT', ruta, { crudo: `{"url":"https://a.b/c","secret":${SECRET}}` })
        assert.equal(r.status, 400)
        assert.deepEqual(r.json, { error: 'Invalid JSON body' })
        assert.ok(!bot.logs().includes('secreto-de-kusy'), 'ni un pedazo del secret en el log')

        // El registro: qué había, qué rige ahora.
        r = await bot.api('PUT', ruta, { cuerpo: RUTA_KUSYSTEM })
        assert.equal(r.status, 200)
        assert.deepEqual(r.json, { ok: true, effective: 'registered', previous: 'default' })

        r = await bot.api('GET', `/api/status/${ORG}`)
        assert.equal(r.json.inboundRouted, true)
        r = await bot.api('GET', ruta)
        assert.deepEqual(r.json, { orgId: ORG, source: 'registered', host: 'www.kusystem.com' })
        assert.ok(!JSON.stringify(r.json).includes(SECRET), 'la API nunca devuelve el secret')

        // Lo que el operador puso en el env manda: se guarda pero no rige, y se avisa.
        r = await bot.api('PUT', `/api/org-inbound-routes/${ORG_EN_ENV}`, { cuerpo: RUTA_KUSYSTEM })
        assert.deepEqual(r.json, { ok: true, effective: 'env', previous: 'env' })
        r = await bot.api('GET', `/api/org-inbound-routes/${ORG_EN_ENV}`)
        assert.deepEqual(r.json, { orgId: ORG_EN_ENV, source: 'env', host: 'env.ejemplo.test' })

        assert.ok(!bot.logs().includes(SECRET), 'el secret no sale en ningún log')
        assert.ok(!bot.logs().includes('/api/whatsapp/inbound'), 'ni el path de la URL')

        // Reiniciar el proceso (un deploy) no borra lo registrado.
        await bot.apagar()
        bot = await levantar(dataDir)
        r = await bot.api('GET', `/api/org-inbound-routes/${ORG}`)
        assert.deepEqual(r.json, { orgId: ORG, source: 'registered', host: 'www.kusystem.com' })
        r = await bot.api('GET', `/api/status/${ORG}`)
        assert.equal(r.json.inboundRouted, true)
    } finally {
        await bot.apagar()
    }
})

test('si la base falla, /api/status responde igual y dice que no pudo leer la ruta', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'bot-api-db-'))
    const bot = await levantar(dataDir)
    // Otra conexión a la misma base: le saca la tabla al servidor que está corriendo.
    const otra = new Database(join(dataDir, 'bot.db'))
    try {
        otra.exec('ALTER TABLE org_inbound_routes RENAME TO org_inbound_routes_apagada')

        // Este endpoint lo polea la app para el QR: con la base rota tiene que contestar,
        // no colgarse. `null` = ilegible, y la app solo registra su ruta con `=== false`.
        const r = await Promise.race([
            bot.api('GET', `/api/status/${ORG}`),
            new Promise((resolve) => setTimeout(() => resolve('COLGADO'), 5000)),
        ])
        assert.notEqual(r, 'COLGADO', 'la request no puede quedar sin respuesta')
        assert.equal(r.status, 200)
        assert.equal(r.json.inboundRouted, null)
        assert.equal(r.json.connected, false)
    } finally {
        otra.close()
        await bot.apagar()
    }
})
