import v8 from 'node:v8'

// Telemetría de memoria: una línea por minuto, para ver qué venía pasando antes de un
// "JavaScript heap out of memory". Sin esto la caída llega sin un solo log que la explique.
const INTERVAL_MS = 60_000
const WARN_RATIO = 0.75
// El OOM del contenedor (2 GB) es por RSS y no deja ningún log de V8: se avisa antes de llegar.
const RSS_WARN_MB = 1800

const mb = (bytes) => Math.round(bytes / 1_048_576)

function logMemory() {
    const m = process.memoryUsage()
    const limit = v8.getHeapStatistics().heap_size_limit
    const linea =
        `[mem] rss=${mb(m.rss)}MB heap=${mb(m.heapUsed)}/${mb(m.heapTotal)}MB ` +
        `límite=${mb(limit)}MB external=${mb(m.external)}MB buffers=${mb(m.arrayBuffers)}MB`

    if (m.heapUsed > limit * WARN_RATIO || mb(m.rss) > RSS_WARN_MB) console.warn(`${linea} cerca del límite`)
    else console.log(linea)
}

/** Loguea una línea ya y otra cada minuto. Se llama desde el callback de `app.listen`. */
export function startMemoryMonitor() {
    logMemory()
    setInterval(logMemory, INTERVAL_MS).unref()
}
