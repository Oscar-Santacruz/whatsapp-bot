# AGENTS.md

Instrucciones para agentes (Claude Code, Codex, etc) trabajando en este repo.

## Stack
- Node.js 22 (ESM)
- Express + Baileys (WhatsApp)
- better-sqlite3 (cola de envíos, store de mensajes)
- Supabase (storage de media + service-role)
- Dotenv para configuración

## Deploy workflow (manual, NO on-commit)

El auto-deploy on-commit de Render está **desactivado**. El flujo es:

1. `git commit` con conventional commits en español o inglés (sin `Co-Authored-By`).
2. `git push origin main`.
3. **Deploy manual con Render CLI**:
   ```bash
   render deploys create srv-d6fjhbv5r7bs73dh4iag --confirm
   ```
   - Service: `whatsapp-bot-car-sale`
   - Service ID: `srv-d6fjhbv5r7bs73dh4iag`
   - Render CLI binary: `/c/Users/Oscar/go/bin/render` (Windows/Git Bash)

No hay paso de build (`npm start` directo desde `index.js`).

## Reglas de commits
- Conventional commits (`feat:`, `fix:`, `chore:`, etc) con scope cuando aplique (`feat(queue): ...`).
- NO usar `--no-verify`, NO agregar `Co-Authored-By`, NO amend salvo pedido explícito.
- Preferir commits chicos y atómicos sobre uno grande mixto.

## Antes de tocar `lib/org-inbound-webhook.js`
- El panel del SAAS (alquilacar.app) espera `media` como **objeto único** con la forma `{ tipo, storagePath, mimeType, sizeBytes, durationMs }` (ver commit `c3dea05`).
- En Baileys un mensaje tiene a lo sumo un tipo de media (image/video/audio/document/sticker), así que el objeto único es coherente.
- **No revertir** ese contrato a array sin coordinar con el consumidor — el validador del backend descarta arrays y deja `media_*` en NULL aunque el binario ya esté en Storage.

## Configuración por env (`.env`)
Defaults documentados al lado de cada variable:

| Variable | Default | Descripción |
|---|---|---|
| `PORT` | `3001` | HTTP server port |
| `API_TOKEN` | `test-secret-local` | Token de auth para endpoints internos |
| `SEND_DELAY_MIN_MS` | `5000` | Mínimo (ms) del delay random entre mensajes consecutivos por org. **Bajarlo aumenta riesgo de ban.** |
| `SEND_DELAY_MAX_MS` | `10000` | Máximo (ms). Si MIN > MAX, vuelve a defaults con warn. |
| `ORG_INBOUND_WEBHOOK_URL` | — | Endpoint del panel para webhooks omnichannel |
| `ORG_INBOUND_WEBHOOK_SECRET` | — | HMAC secret compartido con el SAAS |
| `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` | — | Para upload de media |

## Anti-ban (lib/queue.js)
- Cada org tiene su propio worker loop (`workers` Map por `orgId`); la regulación es **por sesión/número**, no global.
- Cada mensaje pasa por `humanLikeSend`: `presenceSubscribe` → 400-1200ms → `composing` → 1500-3500ms → `paused` → envío.
- Entre mensajes consecutivos: random entre `SEND_DELAY_MIN_MS` y `SEND_DELAY_MAX_MS` (default 5-10s).
- Ratio actual con defaults: ~20 mensajes / 5 minutos por sesión.

## Convenciones
- Idioma: comentarios y docs en español; identificadores en inglés.
- Comillas simples en JS, sin punto y coma final (ver `lib/*.js`).
- Errores no relanzables se loguean con prefijo `[<modulo> <orgId>]`.

## Reviews
- Para cambios sensibles (envío de mensajes, contrato de webhook, persistencia) correr `/judgment-day` (dual review adversarial) antes de mergear.

## Workflow estándar de cambio (procedimiento canónico)

Este es el flujo COMPLETO que se aplica a cualquier cambio funcional. Para cambios solo a `AGENTS.md` u otros docs, los pasos 7 (deploy) y 8 (memoria sobre código) son opcionales — un commit + push alcanza.

0. **Sincronizar antes de empezar** — `git fetch origin && git log HEAD..origin/main`. Si hay commits upstream → `git pull --rebase` ANTES de implementar. Implementar sobre base stale invalida la review posterior.
1. **Implementar el cambio** — ediciones mínimas y atómicas.
2. **Judgment Day** — `/judgment-day` sobre los archivos modificados. Dos jueces ciegos en paralelo, criterios técnicos.
3. **Fix loop**:
   - Issues CRITICAL o WARNING (real) **confirmados por ambos jueces** → aplicar fix automático y re-juzgar.
   - Issues confirmados por **un solo juez** → revisar manualmente con el usuario, no auto-fixear.
   - Si un juez aprueba y el otro pide cambios por una preocupación **no-defecto** (coordinación, riesgo de despliegue, intent ambiguo) → resolver con aclaración del usuario, no es un loop infinito.
   - Tras 2 iteraciones con issues remanentes, escalar.
4. **Re-sincronizar pre-push** — `git fetch origin` por si algo entró durante la implementación. Si hubo divergencia → `git pull --rebase` y volver a juzgar (el rebase puede invalidar fixes previos).
5. **Commit** — conventional, sin `Co-Authored-By`, en el idioma de la conversación.
6. **Push** — `git push origin main`.
7. **Deploy manual con Render CLI** (auto-deploy on-commit está OFF) — usar el comando documentado en la sección _Deploy workflow_ arriba. Luego verificar con `render deploys list <service-id> --limit 1` hasta status `live`. Rollback si falla: `render deploys create <service-id> --commit <sha-anterior> --confirm`.
8. **Persistir en memoria** — `mem_save` con `topic_key` namespaceado como `whatsapp-bot/<area>/<tópico>` (ej: `whatsapp-bot/queue/anti-ban`, `whatsapp-bot/webhook/media-contract`). Saves para decisiones, gotchas, contratos.
9. **Actualizar `AGENTS.md`** — si el cambio toca contratos, env vars, convenciones, infra o el workflow mismo. Si solo se actualiza `AGENTS.md`, el workflow se simplifica: pasos 0, 1, 5, 6 — sin deploy ni Judgment Day pesado.
10. **Session summary** — `mem_session_summary` con Goal / Discoveries / Accomplished / Next Steps / Relevant Files antes de cerrar.

### Atajos que disparan este flujo

Match por intención, no por string literal. Ejemplos en español + inglés:

| Intención | Frases típicas | Pasos |
|---|---|---|
| Revisar + fix loop | "verifica lo que hicieron mal", "haz un bucle hasta que de aprove", "review and fix loop" | 2-3 |
| Cerrar y desplegar | "commit, build, push, deploy", "usa cli de render", "ship it" | 4-7 |
| Persistir | "guarda esto en memoria", "save to memory and AGENTS.md" | 8-9 |
| Archivar | "archiva", "wrap up", "session summary" | 10 |
