const WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || ''

function formatDuration(ms) {
    const totalSec = Math.floor(ms / 1000)
    const min = Math.floor(totalSec / 60)
    const sec = totalSec % 60
    if (min === 0) return `${sec}s`
    return `${min}m ${sec}s`
}

export async function notifyBatchComplete({ batch, errors }) {
    if (!WEBHOOK_URL) {
        console.warn('[discord] DISCORD_WEBHOOK_URL not set, skipping notification')
        return
    }

    const duration = batch.completed_at - batch.created_at
    const allOk = batch.failed === 0
    const color = allOk ? 0x22c55e : (batch.sent > 0 ? 0xf59e0b : 0xef4444)
    const emoji = allOk ? '✅' : (batch.sent > 0 ? '⚠️' : '❌')

    const fields = [
        { name: 'Org', value: `\`${batch.org_id}\``, inline: true },
        { name: 'Enviados', value: `${batch.sent} / ${batch.total}`, inline: true },
        { name: 'Fallidos', value: `${batch.failed}`, inline: true },
        { name: 'Duración', value: formatDuration(duration), inline: true },
        { name: 'Batch ID', value: `\`${batch.id}\``, inline: false }
    ]

    if (errors && errors.length > 0) {
        const errList = errors.slice(0, 10).map(e => `• \`${e.phone}\` — ${e.error}`).join('\n')
        const more = errors.length > 10 ? `\n_...y ${errors.length - 10} más_` : ''
        fields.push({ name: 'Errores', value: errList + more, inline: false })
    }

    const payload = {
        embeds: [{
            title: `${emoji} Batch de WhatsApp completado`,
            color,
            fields,
            timestamp: new Date(batch.completed_at).toISOString()
        }]
    }

    try {
        const res = await fetch(WEBHOOK_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        })
        if (!res.ok) {
            const txt = await res.text()
            console.error(`[discord] webhook failed ${res.status}: ${txt}`)
        }
    } catch (e) {
        console.error('[discord] webhook error:', e.message)
    }
}
