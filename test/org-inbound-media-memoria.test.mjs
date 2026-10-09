// El 09/10 un video que entró a Vamos tumbó el bot por falta de memoria (512 MB):
// la descarga juntaba el archivo entero en RAM. Ahora el media pasa por un
// archivo temporal y la subida real (`subirArchivoStorage`) lo lee del disco de
// a pedazos. Este test manda un video de 300 MB por el camino real de subida
// (contra un Storage falso local) y exige que la memoria viva no crezca con el
// archivo.
//
// Corre con `npm test` (runner nativo de Node con --expose-gc, sin dependencias).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { Readable } from 'node:stream'

const MB = 1024 * 1024
const TAMANO = 300 * MB
const PN = '595981123456@s.whatsapp.net'

const sock = {
    user: { id: '595990000000:1@s.whatsapp.net' },
    profilePictureUrl: async () => 'https://pps.whatsapp.net/foto.jpg',
    groupMetadata: async (jid) => ({ id: jid, subject: 'Taller', participants: [] }),
    signalRepository: { lidMapping: { getPNForLID: async () => null, storeLIDPNMappings: async () => {} } },
}

/** Storage y SAAS falsos en un mismo server: cuenta los bytes subidos sin guardarlos. */
async function servidorFalso() {
    const estado = { bytesSubidos: 0, rutaSubida: null, payloads: [] }
    const srv = createServer((req, res) => {
        if (req.url.startsWith('/storage/v1/object/')) {
            estado.rutaSubida = req.url
            estado.headers = req.headers
            req.on('data', (c) => (estado.bytesSubidos += c.length))
            req.on('end', () => {
                res.writeHead(200, { 'Content-Type': 'application/json' })
                res.end('{"Key":"conversaciones/x","Id":"1"}')
            })
            return
        }
        let body = ''
        req.on('data', (c) => (body += c))
        req.on('end', () => {
            estado.payloads.push(JSON.parse(body))
            res.writeHead(200, { 'Content-Type': 'application/json', Connection: 'close' })
            res.end('{"ok":true}')
        })
    })
    await new Promise((r) => srv.listen(0, '127.0.0.1', r))
    const base = `http://127.0.0.1:${srv.address().port}`
    return { estado, base, cerrar: () => srv.close() }
}

/** Un video de `total` bytes generado en trozos de 1 MB, como el stream de Baileys. */
function videoEnStream(total) {
    const trozo = Buffer.alloc(MB, 7)
    let enviados = 0
    return Readable.from(
        (function* () {
            while (enviados < total) {
                enviados += trozo.length
                yield trozo
            }
        })()
    )
}

test('un video de 300 MB se sube sin cargarlo entero en memoria y sin dejar temporales', async () => {
    const srv = await servidorFalso()
    delete process.env.ORG_INBOUND_ROUTES
    Object.assign(process.env, {
        SUPABASE_URL: srv.base,
        SUPABASE_SERVICE_ROLE_KEY: 'fake-service-role',
        ORG_INBOUND_WEBHOOK_SECRET: 'secreto',
        ORG_INBOUND_WEBHOOK_URL: `${srv.base}/inbound`,
    })
    const mod = await import('../lib/org-inbound-webhook.js?memoria')
    // Sólo se reemplaza la descarga (que necesitaría WhatsApp): la subida es la real.
    mod.__setMediaDepsForTests({ download: async () => videoEnStream(TAMANO), delays: [1, 1] })

    const temporalesAntes = readdirSync(tmpdir()).filter((n) => n.startsWith('org-inbound-')).length
    // Memoria VIVA (con GC antes de cada muestra): la basura que el GC todavía
    // no juntó no cuenta, lo retenido sí.
    const vivo = () => {
        global.gc()
        return process.memoryUsage().arrayBuffers
    }
    const base = vivo()
    let pico = base
    const muestreo = setInterval(() => (pico = Math.max(pico, vivo())), 50)

    await mod.maybeEmitOrgInboundWebhook(
        'org-video',
        {
            key: { remoteJid: PN, id: 'VID-1', fromMe: false },
            message: { videoMessage: { mimetype: 'video/mp4', fileLength: TAMANO, seconds: 90 } },
            messageTimestamp: Math.floor(Date.now() / 1000),
            pushName: 'Chofer',
        },
        sock
    )
    clearInterval(muestreo)

    assert.equal(srv.estado.rutaSubida, '/storage/v1/object/conversaciones/org-video/VID-1.mp4')
    assert.equal(srv.estado.bytesSubidos, TAMANO)
    assert.equal(srv.estado.headers['content-type'], 'video/mp4')
    assert.equal(srv.estado.payloads.length, 1)
    assert.equal(srv.estado.payloads[0].media.storagePath, 'org-video/VID-1.mp4')

    const crecimiento = (pico - base) / MB
    assert.ok(crecimiento < 64, `la memoria creció ${crecimiento.toFixed(0)} MB con un video de 300 MB`)

    const temporalesDespues = readdirSync(tmpdir()).filter((n) => n.startsWith('org-inbound-')).length
    assert.equal(temporalesDespues, temporalesAntes)

    mod.__setMediaDepsForTests()
    srv.cerrar()
})
