import { createHmac } from 'crypto'
import {
    downloadMediaMessage,
    isPnUser,
    jidNormalizedUser,
} from '@whiskeysockets/baileys'
import { getContactName } from './contacts.js'
import { createClient } from '@supabase/supabase-js'
import { getProfilePictureCached } from './profile-picture-cache.js'
import { getGroupMeta, setGroupMeta } from './group-cache.js'
import { phoneByLidOf, rememberLidPair, resolveAddressing } from './lid.js'

/**
 * Webhook omnichannel: emite TODO lo que pasa por las sesiones de orgs
 * (no `_celeste`) al SAAS que corresponda, para su panel de conversaciones.
 *
 * Distinto del `inbound-webhook.js` clásico:
 *  - NO filtra fromMe=true (necesitamos ecos de lo que la ATC manda desde el cel)
 *  - Soporta grupos (incluye `participant`)
 *  - Soporta audio: download + decrypt + upload a Supabase Storage
 *  - No usa la tabla `inbound_webhooks`, sino el ruteo por env var de acá abajo
 *
 * El destino se resuelve POR ORG. Antes era una sola URL global, y eso hacía que
 * las sesiones de los otros productos que viven en este mismo bot (KuSystem)
 * cayeran igual en el SAAS de AlquilaCar, que responde 200 e ignora los orgId
 * que no conoce: sus mensajes se perdían sin dejar un solo error en ningún log.
 * El bot ya era multi-tenant en todo menos en esto.
 *
 * Se habilita por env vars:
 *   ORG_INBOUND_ROUTES               — JSON { "<orgId>": { "url": "…", "secret": "…" } }.
 *                                      Ruteo explícito por sesión. Opcional.
 *   ORG_INBOUND_WEBHOOK_URL          — destino de las orgs sin ruta propia
 *   ORG_INBOUND_WEBHOOK_SECRET       — secret HMAC de ese destino
 *   SUPABASE_URL                     — para subir media
 *   SUPABASE_SERVICE_ROLE_KEY        — bypasea RLS de Storage
 *   ORG_INBOUND_RESOLVE_PARTICIPANT_PN — orgIds (separados por coma) a los que
 *                                      se les completa el número real del
 *                                      participante de un grupo. Opcional.
 *
 * Si a una org no le resuelve destino → silencio total (early return). El bot
 * sigue funcionando igual que antes.
 *
 * El orgId `_celeste` se ignora — Celeste tiene su propio webhook.
 */

const TIMEOUT_MS = 8000
const RETRY_DELAYS_MS = [1000, 5000, 30000]
const STORAGE_BUCKET = 'conversaciones'
const CELESTE_ORG_ID = '_celeste'
/**
 * Tope de espera para lo que sólo decora el payload (foto de perfil, metadata
 * de grupo). Cada una es una consulta a WhatsApp con el timeout por defecto de
 * Baileys, 60 s: con un contacto nuevo la respuesta a veces no llega nunca, y
 * esperarla demoraba un minuto entero la entrega del primer mensaje de cada
 * conversación (El Dorado, sep-2026: 46 de 55 hilos nuevos). El webhook no
 * puede esperar a un adorno.
 */
const ENRICH_BUDGET_MS = 2500
/** Desde cuánto se loguea el desglose de una preparación lenta. */
const SLOW_PREP_MS = 3000

let supabaseClient = null
let routesCache = null
let resolvePnOrgsCache = null
// `${orgId}|${jid}` → consulta de metadata de grupo en curso. Con la consulta
// colgada, cada mensaje del grupo abriría otra: se comparte la primera.
const groupMetaInflight = new Map()

/**
 * Parsea `ORG_INBOUND_ROUTES` una sola vez.
 *
 * Un JSON roto NO puede tumbar el ruteo entero: si el mapa no se entiende se
 * ignora completo y todas las sesiones caen al destino por defecto, que es
 * exactamente el comportamiento que había antes de que esto existiera. Un typo
 * en la env var no puede dejar mudo el panel de nadie.
 */
function getRoutes() {
    if (routesCache) return routesCache
    routesCache = new Map()

    const raw = process.env.ORG_INBOUND_ROUTES?.trim()
    if (!raw) return routesCache

    let parsed
    try {
        parsed = JSON.parse(raw)
    } catch (err) {
        // Se loguea la POSICIÓN del error, no `err.message`: ante basura al
        // principio del valor Node cita un pedazo del input, y este input tiene
        // los secrets adentro. La posición alcanza para encontrar el typo.
        const posicion = /position (\d+)/.exec(err.message)?.[1] ?? '?'
        console.error(
            `[org-inbound] ORG_INBOUND_ROUTES no es JSON válido (posición ${posicion}), se ignora el mapa entero`
        )
        return routesCache
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        console.error('[org-inbound] ORG_INBOUND_ROUTES debe ser un objeto { orgId: { url, secret } }, se ignora')
        return routesCache
    }

    for (const [clave, ruta] of Object.entries(parsed)) {
        // La clave se trimea: un espacio al pegar el JSON no matchea con ningún
        // orgId y la sesión se iría al default sin decir nada.
        const orgId = clave.trim()
        const url = typeof ruta?.url === 'string' ? ruta.url.trim() : null
        const secret = typeof ruta?.secret === 'string' ? ruta.secret : null
        if (!orgId || !url || !secret) {
            console.error(`[org-inbound] ruta inválida para "${clave}" (falta url o secret), se ignora esa entrada`)
            continue
        }
        routesCache.set(orgId, { url, secret })
    }

    // Se loguea el host y no la URL entera: alcanza para saber a dónde va cada
    // sesión sin dejar el path del webhook escrito en los logs.
    for (const [orgId, ruta] of routesCache) {
        let host
        try {
            host = new URL(ruta.url).host
        } catch {
            host = 'url inválida'
        }
        console.log(`[org-inbound] ${orgId} → ${host}`)
    }

    return routesCache
}

function getConfigForOrg(orgId) {
    const supabaseUrl = process.env.SUPABASE_URL
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
    if (!supabaseUrl || !serviceRoleKey) return null

    const ruta = getRoutes().get(orgId)
    const url = ruta ? ruta.url : process.env.ORG_INBOUND_WEBHOOK_URL
    const secret = ruta ? ruta.secret : process.env.ORG_INBOUND_WEBHOOK_SECRET
    if (!url || !secret) return null

    return { url, secret, supabaseUrl, serviceRoleKey }
}

/**
 * ¿A esta sesión se le completa el número real del participante de un grupo?
 *
 * WhatsApp entrega a muchos participantes sólo como LID, sin número. La lista
 * de participantes del grupo sí lo trae, pero sumarlo le cambia el payload al
 * SAAS que recibe: por eso va sólo para las sesiones listadas en
 * ORG_INBOUND_RESOLVE_PARTICIPANT_PN, y el resto recibe lo de siempre.
 */
function resolvesParticipantPn(orgId) {
    if (!resolvePnOrgsCache) {
        resolvePnOrgsCache = new Set(
            (process.env.ORG_INBOUND_RESOLVE_PARTICIPANT_PN ?? '')
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean)
        )
    }
    return resolvePnOrgsCache.has(orgId)
}

/**
 * Espera `promise` como mucho `ms`. Si no llega a tiempo devuelve `{ ok: false }`
 * y la promesa sigue sola (lo que llene en su caché queda para el próximo
 * mensaje). Nunca lanza: un error cuenta como "no llegó".
 */
export async function withinBudget(promise, ms = ENRICH_BUDGET_MS) {
    let timer
    const vencido = new Promise((resolve) => {
        timer = setTimeout(() => resolve({ ok: false }), ms)
    })
    try {
        return await Promise.race([
            promise.then(
                (value) => ({ ok: true, value }),
                () => ({ ok: false })
            ),
            vencido,
        ])
    } finally {
        clearTimeout(timer)
    }
}

/** Pide la metadata del grupo (una sola consulta en curso por grupo) y la cachea. */
function fetchGroupMeta(orgId, sock, jid) {
    const clave = `${orgId}|${jid}`
    const enCurso = groupMetaInflight.get(clave)
    if (enCurso) return enCurso
    const promesa = Promise.resolve()
        .then(() => sock.groupMetadata(jid))
        .then((meta) => {
            const subject = meta?.subject ?? null
            const participants = meta?.participants?.map((p) => p.id) ?? null
            const phoneByLid = phoneByLidOf(meta?.participants)
            setGroupMeta(orgId, jid, { subject, participants, phoneByLid })
            return { subject, participants, phoneByLid }
        })
        .finally(() => groupMetaInflight.delete(clave))
    groupMetaInflight.set(clave, promesa)
    return promesa
}

function getSupabase(cfg) {
    if (!supabaseClient) {
        supabaseClient = createClient(cfg.supabaseUrl, cfg.serviceRoleKey, {
            auth: { autoRefreshToken: false, persistSession: false },
        })
    }
    return supabaseClient
}

function extractText(message) {
    if (!message) return null
    if (typeof message.conversation === 'string' && message.conversation.trim()) {
        return message.conversation
    }
    if (typeof message.extendedTextMessage?.text === 'string' && message.extendedTextMessage.text.trim()) {
        return message.extendedTextMessage.text
    }
    const captionFromMedia =
        message.imageMessage?.caption ||
        message.videoMessage?.caption ||
        message.documentMessage?.caption ||
        message.audioMessage?.caption
    if (typeof captionFromMedia === 'string' && captionFromMedia.trim()) {
        return captionFromMedia
    }
    return null
}

function extractAudio(message) {
    const audio = message?.audioMessage
    if (!audio) return null
    return {
        mimeType: audio.mimetype || 'audio/ogg; codecs=opus',
        sizeBytes: Number(audio.fileLength ?? 0) || null,
        durationMs: typeof audio.seconds === 'number' ? audio.seconds * 1000 : null,
    }
}

function extractImage(message) {
    const img = message?.imageMessage
    if (!img) return null
    return {
        mimeType: img.mimetype || 'image/jpeg',
        sizeBytes: Number(img.fileLength ?? 0) || null,
        caption: typeof img.caption === 'string' ? img.caption.trim() : null,
    }
}

function extractVideo(message) {
    const vid = message?.videoMessage
    if (!vid) return null
    const isGif = vid.gifPlayback === true
    return {
        mimeType: vid.mimetype || 'video/mp4',
        sizeBytes: Number(vid.fileLength ?? 0) || null,
        durationMs: typeof vid.seconds === 'number' ? vid.seconds * 1000 : null,
        caption: typeof vid.caption === 'string' ? vid.caption.trim() : null,
        gifPlayback: isGif,
    }
}

function extractDocument(message) {
    const doc = message?.documentMessage
    if (!doc) return null
    return {
        mimeType: doc.mimetype || 'application/octet-stream',
        sizeBytes: Number(doc.fileLength ?? 0) || null,
        fileName: typeof doc.fileName === 'string' ? doc.fileName : null,
        caption: typeof doc.caption === 'string' ? doc.caption.trim() : null,
    }
}

function extractSticker(message) {
    const sticker = message?.stickerMessage
    if (!sticker) return null
    return {
        mimeType: sticker.mimetype || 'image/webp',
        sizeBytes: Number(sticker.fileLength ?? 0) || null,
        isAnimated: sticker.isAnimated === true,
    }
}

function extractQuotedId(message) {
    if (!message || typeof message !== 'object') return null
    for (const v of Object.values(message)) {
        if (v && typeof v === 'object') {
            const id = v?.contextInfo?.stanzaId
            if (typeof id === 'string' && id) return id
        }
    }
    return null
}

function mimeToExt(mime) {
    if (!mime) return 'bin'
    if (mime.includes('ogg')) return 'ogg'
    if (mime.includes('mpeg') || mime.includes('mp3')) return 'mp3'
    if (mime.includes('mp4')) return 'mp4'
    if (mime.includes('m4a')) return 'm4a'
    if (mime.includes('wav')) return 'wav'
    if (mime.includes('aac')) return 'aac'
    if (mime.includes('webm')) return 'webm'
    if (mime.includes('jpeg') || mime.includes('jpg')) return 'jpg'
    if (mime.includes('png')) return 'png'
    if (mime.includes('gif')) return 'gif'
    if (mime.includes('webp')) return 'webp'
    if (mime.includes('pdf')) return 'pdf'
    return 'bin'
}

function normalizeContentType(mime) {
    if (!mime) return mime
    return mime.split(';')[0].trim()
}

async function uploadMedia(orgId, messageId, message, mimeType, cfg) {
    const buffer = await downloadMediaMessage(
        { message },
        'buffer',
        {}
    )
    const ext = mimeToExt(mimeType)
    const path = `${orgId}/${sanitizeId(messageId)}.${ext}`
    const supabase = getSupabase(cfg)
    const { error } = await supabase.storage
        .from(STORAGE_BUCKET)
        .upload(path, buffer, {
            contentType: normalizeContentType(mimeType),
            upsert: false,
        })
    if (error && !isAlreadyExistsError(error)) {
        throw new Error(`storage upload failed: ${error.message}`)
    }
    return path
}

/** Normaliza a jid de chat sin device (`:NN`). Nunca throws. */
function safeNormalizeJid(jid) {
    if (typeof jid !== 'string' || !jid.includes('@')) return null
    try {
        return jidNormalizedUser(jid) || null
    } catch {
        return null
    }
}

function sanitizeId(id) {
    // Baileys IDs vienen como '3EB0...' o 'BAE5...' — alfanumérico safe en general.
    // Defensivo: reemplazar cualquier char no apto para path.
    return String(id).replace(/[^A-Za-z0-9_-]/g, '_')
}

function isAlreadyExistsError(err) {
    const msg = String(err?.message ?? '')
    return msg.includes('already exists') || msg.includes('Duplicate')
}

/**
 * Punto de entrada. Llamar desde messages.upsert para CADA mensaje (incluyendo
 * fromMe=true). El módulo decide internamente si emite o no.
 *
 * NUNCA throws — los errores se loguean.
 */
export async function maybeEmitOrgInboundWebhook(orgId, waMessage, sock = null) {
    if (!orgId || orgId === CELESTE_ORG_ID) return

    const cfg = getConfigForOrg(orgId)
    if (!cfg) return

    try {
        // Cuánto tarda cada paso antes de la entrega. Una demora acá es una
        // respuesta demorada del lado del SAAS (el bot de captación de
        // KuSystem arranca recién cuando le llega el webhook).
        const inicio = Date.now()
        const tiempos = {}

        const remoteJid = waMessage?.key?.remoteJid ?? ''
        if (!remoteJid) return

        const isGroup = remoteJid.endsWith('@g.us')

        // Defensa: ignorar broadcasts y status — ya están filtrados arriba pero
        // por las dudas.
        if (remoteJid.endsWith('@broadcast') || remoteJid === 'status@broadcast') return

        const message = waMessage?.message
        if (!message) return

        const messageId = waMessage?.key?.id
        if (!messageId) return

        const text = extractText(message)
        const audio = extractAudio(message)
        const image = extractImage(message)
        const video = extractVideo(message)
        const document = extractDocument(message)
        const sticker = extractSticker(message)

        // Si no hay ni texto ni ningún tipo de media, descartamos.
        if (!text && !audio && !image && !video && !document && !sticker) {
            console.warn(`[org-inbound ${orgId}] message discarded — unknown type (${messageId}):`, Object.keys(message))
            return
        }

        const tsRaw = Number(waMessage?.messageTimestamp ?? 0)
        const timestamp = tsRaw > 0 ? tsRaw : Math.floor(Date.now() / 1000)

        const participant = isGroup
            ? waMessage?.key?.participant || waMessage?.participant || null
            : null

        // En Baileys un mensaje tiene a lo sumo UN tipo de media (image/video/
        // audio/document/sticker). El receptor espera `media` como un único
        // objeto con la forma { tipo, storagePath, mimeType, sizeBytes,
        // durationMs }, no un array.
        let mediaCandidate = null
        if (audio) {
            mediaCandidate = {
                tipo: 'audio',
                mimeType: audio.mimeType,
                sizeBytes: audio.sizeBytes,
                durationMs: audio.durationMs,
            }
        } else if (image) {
            mediaCandidate = {
                tipo: 'image',
                mimeType: image.mimeType,
                sizeBytes: image.sizeBytes,
                durationMs: null,
            }
        } else if (video) {
            mediaCandidate = {
                tipo: video.gifPlayback ? 'gif' : 'video',
                mimeType: video.mimeType,
                sizeBytes: video.sizeBytes,
                durationMs: video.durationMs,
            }
        } else if (document) {
            mediaCandidate = {
                tipo: 'document',
                mimeType: document.mimeType,
                sizeBytes: document.sizeBytes,
                durationMs: null,
            }
        } else if (sticker) {
            mediaCandidate = {
                tipo: 'sticker',
                mimeType: sticker.mimeType,
                sizeBytes: sticker.sizeBytes,
                durationMs: null,
            }
        }

        let media = null
        if (mediaCandidate) {
            const tMedia = Date.now()
            try {
                const storagePath = await uploadMedia(
                    orgId,
                    messageId,
                    message,
                    mediaCandidate.mimeType,
                    cfg
                )
                media = { ...mediaCandidate, storagePath }
            } catch (err) {
                console.error(
                    `[org-inbound ${orgId}] ${mediaCandidate.tipo} upload failed (${messageId}): ${err.message}`
                )
            }
            tiempos.media = Date.now() - tMedia
        }

        // Si no hay texto ni se logró subir el media, descartamos.
        if (!text && !media) return

        // Foto de perfil de la conversación. Usamos `remoteJid` (jid de la
        // chat) tanto para grupos (@g.us) como para 1:1 (@s.whatsapp.net),
        // nunca el participant. Si falla o tarda, va `null` sin frenar el envío:
        // la consulta sigue en segundo plano y llena el caché para el próximo.
        let profilePictureUrl = null
        let profilePictureSetAt = null
        let t = Date.now()
        const pic = await withinBudget(getProfilePictureCached(orgId, sock, remoteJid))
        tiempos.foto = Date.now() - t
        if (pic.ok) {
            profilePictureUrl = pic.value.url
            profilePictureSetAt = pic.value.setAt
        }

        let groupName = null
        let groupPhoneByLid = null
        const resolvePn = isGroup && resolvesParticipantPn(orgId)
        if (isGroup) {
            let cached = getGroupMeta(orgId, remoteJid)
            // Un caché armado desde /groups o groups.upsert no trae los números:
            // si esta sesión los necesita, se vuelve a pedir la metadata.
            if (!cached || (resolvePn && !cached.phoneByLid)) {
                t = Date.now()
                // Si la metadata tarda, el mensaje sale sin nombre de grupo y
                // el caché se completa cuando llegue.
                const meta = await withinBudget(fetchGroupMeta(orgId, sock, remoteJid))
                tiempos.grupo = Date.now() - t
                if (meta.ok) cached = meta.value
            }
            groupName = cached?.subject ?? null
            groupPhoneByLid = cached?.phoneByLid ?? null
        }

        // Pseudo-IDs WhatsApp LID + número real. El receptor los usa para
        // deduplicar conversaciones cuando `jid` viene como `<id>@lid`.
        // Se resuelven contra el store persistente de Baileys — ver lib/lid.js.
        t = Date.now()
        const addressing = await resolveAddressing(sock, waMessage?.key)
        tiempos.direcciones = Date.now() - t

        // Participante que llegó sólo como LID: el número sale de la lista de
        // participantes del grupo, y el par queda en el store para que la
        // próxima vez se resuelva sin mirar la metadata.
        if (resolvePn && !addressing.participantPn && addressing.participantLid) {
            const pn = groupPhoneByLid?.[addressing.participantLid] ?? null
            if (pn) {
                addressing.participantPn = pn
                await rememberLidPair(sock, addressing.participantLid, pn)
            }
        }

        // Nombre visible del remitente. Prioridad: nombre de AGENDA del
        // teléfono vinculado (tabla contacts, alimentada por contacts.upsert/
        // contacts.set/contacts.update y el history sync) > pushName del
        // mensaje (nombre de perfil que se puso el propio contacto). Flota
        // solo lo persiste en 1:1 inbound (isGroup=false && fromMe=false);
        // en el resto de los casos mandamos el pushName crudo como antes.
        const rawPushName =
            typeof waMessage?.pushName === 'string' && waMessage.pushName
                ? waMessage.pushName
                : null
        let bestName = rawPushName
        if (!isGroup && !waMessage?.key?.fromMe) {
            // Candidatos en orden: número real resuelto (senderPn) y el jid
            // del chat normalizado (sin sufijo de device `:NN`). La tabla
            // contacts solo guarda @s.whatsapp.net, así que un chat @lid sin
            // resolver no matchea — cae al pushName.
            const candidates = []
            if (addressing.senderPn) candidates.push(addressing.senderPn)
            const chatJid = safeNormalizeJid(remoteJid)
            if (chatJid && isPnUser(chatJid) && !candidates.includes(chatJid)) {
                candidates.push(chatJid)
            }
            bestName = getContactName(orgId, candidates) ?? rawPushName
        } else if (resolvePn && !waMessage?.key?.fromMe && addressing.participantPn) {
            // Sesiones que resuelven el número: en grupos también va primero
            // la agenda, porque WhatsApp no siempre manda el pushName.
            bestName = getContactName(orgId, [addressing.participantPn]) ?? rawPushName
        }

        const payload = {
            event: 'message.received',
            orgId,
            jid: remoteJid,
            isGroup,
            ...(isGroup && { groupName }),
            participant,
            ...addressing,
            fromMe: Boolean(waMessage?.key?.fromMe),
            // Mejor nombre disponible del remitente (agenda > pushName).
            pushName: bestName,
            messageId,
            timestamp,
            text,
            media,
            quotedMessageId: extractQuotedId(message),
            profilePictureUrl,
            profilePictureSetAt,
        }

        const preparacion = Date.now() - inicio
        if (preparacion >= SLOW_PREP_MS) {
            const detalle = Object.entries(tiempos).map(([k, v]) => `${k}=${v}ms`).join(' ')
            console.warn(
                `[org-inbound ${orgId}] preparación lenta ${preparacion}ms (${messageId}): ${detalle}`
            )
        }

        await deliverWithRetry(cfg.url, cfg.secret, payload, orgId)
    } catch (err) {
        console.error(
            `[org-inbound ${orgId}] unexpected error: ${err?.message ?? err}`
        )
    }
}

async function deliverWithRetry(url, secret, payload, orgId) {
    const body = JSON.stringify(payload)
    const signature = `sha256=${createHmac('sha256', secret)
        .update(body, 'utf8')
        .digest('hex')}`

    const totalAttempts = RETRY_DELAYS_MS.length + 1

    for (let attempt = 0; attempt < totalAttempts; attempt++) {
        try {
            const controller = new AbortController()
            const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)

            let res
            try {
                res = await fetch(url, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-Hub-Signature-256': signature,
                        'X-Wa-Event': 'message.received',
                    },
                    body,
                    signal: controller.signal,
                })
            } finally {
                clearTimeout(timer)
            }

            if (res.ok) return

            if (res.status >= 400 && res.status < 500) {
                console.warn(
                    `[org-inbound ${orgId}] POST ${res.status} (4xx, no retry)`
                )
                return
            }

            console.warn(
                `[org-inbound ${orgId}] POST ${res.status} attempt=${attempt + 1}`
            )
        } catch (err) {
            console.warn(
                `[org-inbound ${orgId}] POST failed attempt=${attempt + 1}: ${err.message}`
            )
        }

        if (attempt < RETRY_DELAYS_MS.length) {
            await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]))
        }
    }

    console.error(
        `[org-inbound ${orgId}] all ${totalAttempts} attempts exhausted, dropping message`
    )
}
