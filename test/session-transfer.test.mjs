// Mudar una sesión de Baileys a otro bot sin desvincular el número: release, export, import y load.
//
// Baileys va con un socket falso (setBaileysForTest): sin red ni WhatsApp. Corre con `npm test`.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, renameSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dataDir = mkdtempSync(join(tmpdir(), 'bot-session-transfer-'))
process.env.DATA_DIR = dataDir
process.env.SEND_DELAY_MIN_MS = '0'
process.env.SEND_DELAY_MAX_MS = '0'
process.env.RELEASE_FLUSH_MS = '0'
process.env.LOAD_OPEN_TIMEOUT_MS = '300'
process.env.RELEASE_QUEUE_TIMEOUT_MS = '6000'

const { db, upsertOrgInboundRoute, setOrgSettings } = await import('../lib/db.js')
const { setSocketProvider, enqueueText } = await import('../lib/queue.js')
const wa = await import('../lib/whatsapp.js')
const { exportSessionData, importSessionData } = await import('../lib/session-transfer.js')

setSocketProvider(wa.getSession)

const sockets = []
const logouts = []
const enviados = []
let envioLento = null
let enSendMessage = false
wa.setBaileysForTest({
    fetchLatestBaileysVersion: async () => ({ version: [2, 3000, 0] }),
    useMultiFileAuthState: async () => ({ state: {}, saveCreds: async () => {} }),
    makeWASocket: () => {
        const ev = new EventEmitter()
        let abierto = true
        const sock = {
            ev,
            user: { id: '595981000000:1@s.whatsapp.net' },
            // Si algún camino llamara a logout, el teléfono quedaría desvinculado: el test lo anota y falla.
            logout: async () => { logouts.push(sock) },
            onWhatsApp: async (jid) => [{ exists: true, jid }],
            presenceSubscribe: async () => {},
            sendPresenceUpdate: async () => {},
            sendMessage: async (jid, content) => {
                enSendMessage = true
                if (envioLento) await envioLento
                if (!abierto) throw new Error('Connection Closed')
                enviados.push(content.text)
                return { key: { remoteJid: jid, id: `MSG${enviados.length}`, fromMe: true } }
            },
            end: () => {
                abierto = false
                queueMicrotask(() => ev.emit('connection.update', {
                    connection: 'close',
                    lastDisconnect: { error: { output: { statusCode: 428 } } },
                }))
            },
        }
        sockets.push(sock)
        return sock
    },
})

const CREDS = JSON.stringify({ me: { id: '595981000000:1@s.whatsapp.net' }, noiseKey: 'x' })
const authDir = (orgId) => join(dataDir, `auth_info_baileys_${orgId}`)
const crearCarpeta = (orgId, creds = CREDS) => {
    mkdirSync(authDir(orgId), { recursive: true })
    writeFileSync(join(authDir(orgId), 'creds.json'), creds)
}
const conectar = async (orgId) => {
    crearCarpeta(orgId)
    const sock = await wa.connectToWhatsApp(orgId)
    sock.ev.emit('connection.update', { connection: 'open' })
    assert.equal(wa.getSession(orgId).isConnected, true)
    return sock
}
const encolar = (orgId, message, extra = {}) => Number(db.prepare(`
    INSERT INTO outgoing_queue (org_id, phone, kind, message, created_at, quoted_job_id, batch_id)
    VALUES (?, '595981111111', 'text', ?, ?, ?, ?)
`).run(orgId, message, Date.now(), extra.quotedJobId ?? null, extra.batchId ?? null).lastInsertRowid)
const estado = (id) => db.prepare(`SELECT status FROM outgoing_queue WHERE id = ?`).get(id).status
const esperar = (ms) => new Promise((r) => setTimeout(r, ms))

test('release cierra con end(), nunca con logout, y deja las credenciales enteras', async () => {
    const sock = await conectar('orgA')
    const job = encolar('orgA', 'hola')

    const r = await wa.releaseSession('orgA')

    assert.equal(logouts.length, 0)
    assert.equal(sock.ev.listenerCount('creds.update'), 0)
    assert.equal(existsSync(authDir('orgA')), false)
    assert.match(r.releasedFolder, /^released_orgA_\d+$/)
    assert.equal(readFileSync(join(dataDir, r.releasedFolder, 'creds.json'), 'utf-8'), CREDS)
    assert.equal(wa.getSession('orgA'), undefined)
    assert.equal(wa.isReleased('orgA'), true)
    // Lo pendiente no sale ni se quema acá: queda para el otro bot.
    assert.equal(estado(job), 'released')
    assert.equal(r.queued, 1)
})

test('una sesión soltada no reconecta: ni el close de end() ni un connect posterior', async () => {
    const antes = sockets.length
    // El primer backoff es de 1 s más hasta 0,5 s de jitter: si el close reconectara, ya habría otro socket.
    await esperar(1_800)
    assert.equal(sockets.length, antes)

    assert.equal(await wa.connectToWhatsApp('orgA'), undefined)
    assert.equal(sockets.length, antes)
    assert.equal(wa.getSession('orgA'), undefined)
    assert.equal(existsSync(authDir('orgA')), false)
})

test('un reinicio no levanta la carpeta soltada ni una marcada como soltada', async () => {
    crearCarpeta('orgM')
    writeFileSync(join(authDir('orgM'), '.released'), '1')
    const antes = sockets.length
    await wa.loadExistingSessions()
    // Solo existen la released_orgA_… (no empieza con auth_info_baileys_) y la marcada.
    assert.equal(sockets.length, antes)
    assert.equal(wa.getSession('orgA'), undefined)
    assert.equal(wa.getSession('orgM'), undefined)
})

// Frena el próximo sendMessage hasta que se llame a la función que devuelve.
const frenarEnvio = () => {
    let soltar
    enSendMessage = false
    envioLento = new Promise((r) => { soltar = r })
    return () => { envioLento = null; soltar() }
}
const hastaQueEnvie = async () => {
    for (let i = 0; i < 500 && !enSendMessage; i++) await esperar(20)
    assert.equal(enSendMessage, true)
}

test('release espera al envío en curso, que sale por el socket abierto, y frena lo que sigue', async () => {
    await conectar('orgW')
    const soltarEnvio = frenarEnvio()
    const primero = enqueueText({ orgId: 'orgW', phone: '595981222222', message: 'en curso' })
    const segundo = enqueueText({ orgId: 'orgW', phone: '595981222222', message: 'siguiente' })
    await hastaQueEnvie()

    let termino = false
    const release = wa.releaseSession('orgW').then((r) => { termino = true; return r })
    await esperar(100)
    assert.equal(termino, false)
    assert.equal(wa.getSession('orgW').isConnected, true)
    soltarEnvio()
    const r = await release

    assert.equal(estado(primero), 'sent')
    assert.equal(estado(segundo), 'released')
    assert.deepEqual(enviados.filter((t) => t === 'siguiente'), [])
    assert.equal(r.queued, 1)
    assert.equal(logouts.length, 0)
})

test('un /send que entra mientras el release cierra también queda para el otro bot', async () => {
    await conectar('orgS')
    const release = wa.releaseSession('orgS')
    const tarde = enqueueText({ orgId: 'orgS', phone: '595981333333', message: 'tarde' })
    const r = await release
    assert.equal(estado(tarde), 'released')
    assert.equal(r.queued, 1)
})

test('si el envío en curso no termina a tiempo, el release se cancela y la sesión sigue igual', async () => {
    const sock = await conectar('orgT')
    const soltarEnvio = frenarEnvio()
    const enCurso = enqueueText({ orgId: 'orgT', phone: '595981444444', message: 'lento' })
    const otro = enqueueText({ orgId: 'orgT', phone: '595981444444', message: 'otro' })
    await hastaQueEnvie()

    await assert.rejects(wa.releaseSession('orgT'), { code: 'BUSY' })
    assert.equal(wa.getSession('orgT').sock, sock)
    assert.equal(wa.isReleased('orgT'), false)
    assert.equal(existsSync(authDir('orgT')), true)
    assert.equal(estado(otro), 'pending')
    soltarEnvio()
    for (let i = 0; i < 400 && estado(enCurso) !== 'sent'; i++) await esperar(20)
    assert.equal(estado(enCurso), 'sent')
})

test('si la sesión se cae mientras el release espera, la cola vuelve a pending y la sesión se queda', async () => {
    const sock = await conectar('orgQ')
    const soltarEnvio = frenarEnvio()
    enqueueText({ orgId: 'orgQ', phone: '595981555555', message: 'en curso' })
    const despues = enqueueText({ orgId: 'orgQ', phone: '595981555555', message: 'después' })
    await hastaQueEnvie()

    const release = wa.releaseSession('orgQ')
    await esperar(50)
    sock.ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 428 } } } })
    soltarEnvio()
    await assert.rejects(release, { code: 'NOT_CONNECTED' })

    assert.notEqual(estado(despues), 'released')
    assert.equal(wa.isReleased('orgQ'), false)
    assert.equal(existsSync(authDir('orgQ')), true)
})

test('release de una sesión que no existe o no está conectada da un error claro', async () => {
    await assert.rejects(wa.releaseSession('orgNada'), { code: 'NO_SESSION' })

    crearCarpeta('orgD')
    await wa.connectToWhatsApp('orgD') // sin `open`: está conectando
    await assert.rejects(wa.releaseSession('orgD'), { code: 'NOT_CONNECTED' })
    assert.equal(existsSync(authDir('orgD')), true)
    assert.equal(wa.isReleased('orgD'), false)
})

test('release y load rechazan un orgId con path traversal', async () => {
    await assert.rejects(wa.releaseSession('../etc'), /orgId inválido/)
    await assert.rejects(wa.loadSession('../etc'), /orgId inválido/)
})

test('load sin la carpeta copiada no abre socket ni genera QR', async () => {
    const antes = sockets.length
    await assert.rejects(wa.loadSession('orgB'), { code: 'NO_AUTH' })
    assert.equal(sockets.length, antes)
    assert.equal(wa.getSession('orgB'), undefined)
    assert.equal(existsSync(authDir('orgB')), false)

    // Una carpeta sin número vinculado (`creds.me`) también pediría QR.
    crearCarpeta('orgB', JSON.stringify({ noiseKey: 'x' }))
    await assert.rejects(wa.loadSession('orgB'), { code: 'NO_AUTH' })
    assert.equal(sockets.length, antes)
    assert.equal(wa.getSession('orgB'), undefined)
})

test('load conecta la carpeta copiada sin tocar las otras sesiones', async () => {
    const otra = await conectar('orgE')
    const released = readdirSync(dataDir).find((f) => f.startsWith('released_orgA_'))
    renameSync(join(dataDir, released), authDir('orgA'))

    const antes = sockets.length
    const cargando = wa.loadSession('orgA')
    await esperar(50)
    sockets.at(-1).ev.emit('connection.update', { connection: 'open' })
    assert.deepEqual(await cargando, { connected: true })

    assert.equal(sockets.length, antes + 1)
    assert.equal(wa.isReleased('orgA'), false)
    assert.equal(wa.getSession('orgA').isConnected, true)
    assert.equal(wa.getSession('orgE').sock, otra)
    assert.equal(wa.getSession('orgE').isConnected, true)
    await assert.rejects(wa.loadSession('orgA'), { code: 'ALREADY_LOADED' })
})

test('export por páginas lleva ruta, settings, batches y la cola soltada; import no toca otras orgs ni repite', () => {
    upsertOrgInboundRoute({ orgId: 'orgX', url: 'https://kusystem.example/api/wa', secret: 's3cr3t' })
    setOrgSettings('orgX', { reenviarRechazos: true })
    db.prepare(`INSERT INTO batches (id, org_id, total, sent, callback_url, created_at) VALUES ('btc_x', 'orgX', 4, 1, 'https://flota.example/cb', 1)`).run()
    const primero = encolar('orgX', 'uno', { batchId: 'btc_x' })
    encolar('orgX', 'dos', { quotedJobId: primero, batchId: 'btc_x' })
    encolar('orgX', 'tres', { quotedJobId: 999_999 })
    db.prepare(`UPDATE outgoing_queue SET status = 'released' WHERE org_id = 'orgX'`).run()
    const ajeno = encolar('orgOtra', 'de otra org')

    const p1 = exportSessionData('orgX', { limit: 2 })
    assert.deepEqual(p1.inboundRoute, { url: 'https://kusystem.example/api/wa', secret: 's3cr3t' })
    assert.deepEqual(p1.settings, { reenviarRechazos: true })
    assert.deepEqual(p1.queue.map((f) => f.message), ['uno', 'dos'])
    assert.deepEqual(p1.batches.map((b) => [b.id, b.total, b.sent]), [['btc_x', 4, 1]])
    assert.ok(p1.nextAfter)
    const p2 = exportSessionData('orgX', { after: p1.nextAfter, limit: 2 })
    assert.deepEqual(p2.queue.map((f) => f.message), ['tres'])
    assert.equal(p2.nextAfter, null)

    // El "otro bot" es la misma base con otra org: alcanza para ver que todo entra con el orgId del parámetro.
    const comoOrgY = (p) => ({ ...p, orgId: 'orgY', batches: p.batches.map((b) => ({ ...b, id: 'btc_y' })),
        queue: p.queue.map((f) => ({ ...f, batch_id: f.batch_id ? 'btc_y' : null })) })
    assert.equal(importSessionData('orgY', comoOrgY(p1)).queued, 2)
    assert.equal(importSessionData('orgY', comoOrgY(p2)).queued, 1)

    const filas = db.prepare(`SELECT id, message, status, quoted_job_id, batch_id FROM outgoing_queue WHERE org_id = 'orgY' ORDER BY id`).all()
    assert.deepEqual(filas.map((f) => f.status), ['pending', 'pending', 'pending'])
    assert.equal(filas[1].quoted_job_id, filas[0].id)
    assert.equal(filas[2].quoted_job_id, null)
    assert.equal(filas[0].batch_id, 'btc_y')
    assert.equal(db.prepare(`SELECT org_id, total, sent FROM batches WHERE id = 'btc_y'`).get().sent, 1)
    assert.equal(db.prepare(`SELECT secret FROM org_inbound_routes WHERE org_id = 'orgY'`).get().secret, 's3cr3t')
    assert.equal(estado(ajeno), 'pending')
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM outgoing_queue WHERE org_id = 'orgX' AND status = 'released'`).get().n, 3)

    // Repetir el import, aunque la cola ya haya salido, no manda nada dos veces.
    db.prepare(`UPDATE outgoing_queue SET status = 'sent' WHERE org_id = 'orgY'`).run()
    const otraVez = importSessionData('orgY', comoOrgY(p1))
    assert.deepEqual([otraVez.queued, otraVez.skipped], [0, 2])

    assert.equal(importSessionData('orgZ', p1).status, 400)
    assert.equal(importSessionData('orgZ', { orgId: 'orgZ', inboundRoute: { url: 'http://localhost/x', secret: 's' } }).status, 400)
    assert.equal(importSessionData('orgZ', { orgId: 'orgZ', queue: [{ ...p1.queue[0], kind: 'rm -rf' }] }).status, 400)
})

test('una página del export se corta por el tamaño de los archivos, con al menos un envío', () => {
    const grande = 'A'.repeat(10 * 1024 * 1024)
    for (let i = 0; i < 3; i++) {
        db.prepare(`
            INSERT INTO outgoing_queue (org_id, phone, kind, document_base64, created_at, status)
            VALUES ('orgP', '595981666666', 'document', ?, ?, 'released')
        `).run(grande, Date.now() + i)
    }
    const p1 = exportSessionData('orgP')
    assert.equal(p1.queue.length, 1)
    assert.ok(p1.nextAfter)
    const p2 = exportSessionData('orgP', { after: p1.nextAfter })
    assert.equal(p2.queue.length, 1)
    const p3 = exportSessionData('orgP', { after: p2.nextAfter })
    assert.equal(p3.queue.length, 1)
    assert.equal(p3.nextAfter, null)
})

test('un /logout después del release libera la org y su cola vuelve a salir', async () => {
    await conectar('orgL')
    await wa.releaseSession('orgL')
    await wa.logoutSession('orgL')
    assert.equal(wa.isReleased('orgL'), false)

    await conectar('orgL')
    const job = enqueueText({ orgId: 'orgL', phone: '595981777777', message: 'después del logout' })
    for (let i = 0; i < 400 && estado(job) !== 'sent'; i++) await esperar(20)
    assert.equal(estado(job), 'sent')
    assert.equal(logouts.length, 0) // la sesión ya no tenía socket: el logout fue solo local
})

test('un batch que vuelve en una ida y vuelta se queda con los contadores más altos', () => {
    db.prepare(`INSERT INTO batches (id, org_id, total, sent, created_at) VALUES ('btc_rt', 'orgR', 5, 1, 1)`).run()
    const r = importSessionData('orgR', { orgId: 'orgR', batches: [{ id: 'btc_rt', total: 5, sent: 3, failed: 1, status: 'processing', created_at: 1 }] })
    assert.equal(r.ok, true)
    const b = db.prepare(`SELECT sent, failed FROM batches WHERE id = 'btc_rt'`).get()
    assert.deepEqual([b.sent, b.failed], [3, 1])
})
