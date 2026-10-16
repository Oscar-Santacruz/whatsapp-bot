// Validación de los ítems de POST /send-batch.
//
// El batch se crea con `total = messages.length` y se completa cuando sent + failed alcanza ese total.
// Un ítem que no se encola (sin contenido) o que rompe el INSERT (sin phone) dejaba el batch colgado
// para siempre y su callback sin dispararse. Por eso se valida TODO antes de crear el batch.

const MEDIOS = ['document', 'image', 'video', 'audio', 'sticker']

const esTextoNoVacio = (v) => typeof v === 'string' && v.trim() !== ''

/** Motivo por el que un ítem no se puede encolar, o null si está bien. */
function errorDeItem(m) {
    if (!m || typeof m !== 'object' || Array.isArray(m)) return 'no es un objeto'
    // Un phone numérico en el JSON siempre se aceptó (SQLite lo guarda como texto): no se rechaza ahora.
    if (!esTextoNoVacio(m.phone) && !(typeof m.phone === 'number' && Number.isFinite(m.phone))) return 'falta phone'

    const medio = MEDIOS.find((k) => m[k])
    if (medio) {
        if (!esTextoNoVacio(m[medio].base64)) return `${medio}.base64 debe ser un string no vacío`
        if (medio === 'document' && !esTextoNoVacio(m.document.fileName)) return 'document.fileName es obligatorio'
        if (m.message != null && typeof m.message !== 'string') return 'message debe ser un string'
        return null
    }
    if (!esTextoNoVacio(m.message)) return 'falta message o un medio (document, image, video, audio, sticker)'
    return null
}

/** `null` si todos los ítems se pueden encolar; si no, un texto con los índices y motivos. */
export function validarItemsBatch(messages) {
    const errores = []
    messages.forEach((m, i) => {
        const motivo = errorDeItem(m)
        if (motivo) errores.push(`messages[${i}]: ${motivo}`)
    })
    if (errores.length === 0) return null
    const visibles = errores.slice(0, 10).join('; ')
    return errores.length > 10 ? `${visibles}; y ${errores.length - 10} más` : visibles
}
