// Ningún log puede llevar material criptográfico de WhatsApp.
//
// libsignal (la usa Baileys) loguea con console.info/warn la sesión entera al
// cerrarla o abrirla: "Closing session: SessionEntry { ... privKey: <Buffer ..> }".
// Su `inspect()` propio ya no lo llama Node (sólo mira util.inspect.custom), así
// que el objeto sale completo, con privKey y rootKey, y termina en Seq.
//
// Este módulo envuelve console.* apenas se importa (va primero en index.js) y
// expone `redact` para el logger pino de Baileys. Una sesión de libsignal se
// loguea como `<SessionEntry [baseKey=...]>` (la baseKey es pública y sirve
// para correlacionar); cualquier otro objeto pierde los campos con claves.

const REDACTED = '[redacted]'
const MAX_DEPTH = 8

// Nombres de campo que guardan claves o estado de sesión (libsignal + creds de Baileys).
const SENSITIVE_KEYS = new Set([
    'privkey',
    'privatekey',
    'private',
    'rootkey',
    'chainkey',
    'ephemeralkeypair',
    'pairingephemeralkeypair',
    'currentratchet',
    'messagekeys',
    'cipherkey',
    'mackey',
    'noisekey',
    'signedprekey',
    'signedidentitykey',
    'advsecretkey',
    'creds',
    '_sessions',
    '_chains',
    'pendingprekey'
])

export function isSensitiveKey(key) {
    return typeof key === 'string' && SENSITIVE_KEYS.has(key.toLowerCase())
}

// Una SessionEntry de libsignal (o su forma serializada).
function isSignalSession(value) {
    return value.indexInfo != null && typeof value.indexInfo === 'object' &&
        ('currentRatchet' in value || '_chains' in value)
}

function describeSession(value) {
    const baseKey = value.indexInfo.baseKey
    let id = null
    if (Buffer.isBuffer(baseKey)) id = baseKey.toString('base64')
    else if (typeof baseKey === 'string') id = baseKey
    return `<SessionEntry [baseKey=${id}]>`
}

export function redact(value, depth = 0, seen = new WeakSet()) {
    if (value === null || typeof value !== 'object') return value
    // Los Buffer sueltos y los Error pasan tal cual: una clave se reconoce por el
    // nombre del campo, y el stack de un error hace falta entero.
    if (Buffer.isBuffer(value) || ArrayBuffer.isView(value) || value instanceof Error) return value
    if (seen.has(value)) return '[Circular]'
    if (depth >= MAX_DEPTH) return '[Object]'
    if (isSignalSession(value)) return describeSession(value)
    seen.add(value)

    if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1, seen))
    if (value instanceof Map) {
        const out = new Map()
        for (const [k, v] of value) out.set(k, isSensitiveKey(k) ? REDACTED : redact(v, depth + 1, seen))
        return out
    }

    // Los objetos ajenos (Date, Set, sockets…) no se copian: perderían su forma
    // al loguearlos y no traen claves por nombre de campo.
    const proto = Object.getPrototypeOf(value)
    if (proto !== Object.prototype && proto !== null && !hasSensitiveField(value)) return value

    const out = {}
    for (const key of Object.keys(value)) {
        out[key] = isSensitiveKey(key) ? REDACTED : redact(value[key], depth + 1, seen)
    }
    return out
}

function hasSensitiveField(value) {
    for (const key of Object.keys(value)) if (isSensitiveKey(key)) return true
    return false
}

const CONSOLE_METHODS = ['log', 'info', 'warn', 'error', 'debug', 'trace']
const INSTALLED = Symbol.for('whatsapp-bot.console-redaction')

export function installConsoleRedaction(target = console) {
    if (target[INSTALLED]) return
    for (const method of CONSOLE_METHODS) {
        const original = target[method]
        if (typeof original !== 'function') continue
        target[method] = function (...args) {
            return original.apply(this, args.map((a) => redact(a)))
        }
    }
    Object.defineProperty(target, INSTALLED, { value: true })
}

installConsoleRedaction()
