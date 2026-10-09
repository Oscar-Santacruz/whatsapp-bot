import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { pipeline } from 'node:stream/promises'

/** Sin bytes en ninguna dirección durante este tiempo, la subida se corta (y se reintenta). */
const IDLE_TIMEOUT_MS = 60000

/**
 * Sube un archivo del disco a Supabase Storage por la API REST
 * (`POST /storage/v1/object/<bucket>/<path>`), leyéndolo de a pedazos.
 *
 * No usa supabase-js a propósito: su `upload` va por `fetch`, y el `fetch` de
 * Node (undici) junta en memoria el cuerpo entero aunque se le pase un stream
 * (medido con Node 22: 300 MB vivos para un video de 300 MB, con stream de Node,
 * ReadableStream web, `ReadableStream.from` o el de un FileHandle). Con
 * `http.request` y `pipeline` la memoria queda en el tamaño de los buffers.
 *
 * Devuelve `{ error }` con la misma forma que supabase-js: `null` si salió bien,
 * o `{ message, statusCode }` con lo que contestó Storage. Errores de red lanzan.
 */
export async function subirArchivoStorage({ supabaseUrl, serviceRoleKey, bucket, path, filePath, contentType, upsert = false }) {
    const { size } = await stat(filePath)
    const url = new URL(
        `/storage/v1/object/${encodeURIComponent(bucket)}/${path.split('/').map(encodeURIComponent).join('/')}`,
        supabaseUrl
    )
    const request = url.protocol === 'http:' ? httpRequest : httpsRequest

    return new Promise((resolve, reject) => {
        const req = request(
            url,
            {
                method: 'POST',
                headers: {
                    apikey: serviceRoleKey,
                    Authorization: `Bearer ${serviceRoleKey}`,
                    'Content-Type': contentType,
                    'Content-Length': size,
                    'Cache-Control': 'max-age=3600',
                    'x-upsert': String(upsert),
                },
            },
            (res) => {
                let cuerpo = ''
                res.setEncoding('utf8')
                res.on('data', (c) => (cuerpo += c))
                res.on('error', reject)
                res.on('end', () => {
                    if (res.statusCode >= 200 && res.statusCode < 300) return resolve({ error: null })
                    let datos = null
                    try {
                        datos = JSON.parse(cuerpo)
                    } catch {
                        // Una página de Cloudflare (520 y compañía) no es JSON.
                    }
                    resolve({
                        error: {
                            message: datos?.message || datos?.error || `HTTP ${res.statusCode}`,
                            statusCode: String(datos?.statusCode ?? res.statusCode),
                        },
                    })
                })
            }
        )
        req.setTimeout(IDLE_TIMEOUT_MS, () => req.destroy(new Error(`storage upload timeout (${IDLE_TIMEOUT_MS} ms sin actividad)`)))
        req.on('error', reject)
        pipeline(createReadStream(filePath), req).catch(reject)
    })
}
