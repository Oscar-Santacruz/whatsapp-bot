# AGENTS.md

Instrucciones para agentes (Claude Code, Codex, etc) trabajando en este repo.

## Stack
- Node.js 22 (ESM)
- Express + Baileys (WhatsApp)
- better-sqlite3 (cola de envíos, store de mensajes)
- Supabase (storage de media + service-role)
- Dotenv para configuración

## Deploy workflow (auto-deploy on-commit ACTIVADO)

El servicio de Render tiene **auto-deploy activado**: mergear/pushear a `main` ya
dispara el deploy solo. Para saltarlo en un commit (docs, etc), incluir
`[skip render]` en el mensaje.

1. `git commit` con conventional commits en español o inglés (sin `Co-Authored-By`).
2. `git push origin main` → Render deploya automáticamente.
3. Redeploy forzado o rollback, si hace falta:
   ```bash
   render deploys create srv-d91iqr8js32c739g3ipg --confirm
   ```
   - Service: `whatsapp-bot-iptest` (es el PRODUCTIVO pese al sufijo "iptest":
     tiene el disco de sesiones Baileys en `/app/auth_info_baileys` y flota lo
     consume vía `WHATSAPP_BOT_URL=https://whatsapp-bot-iptest.onrender.com`)
   - Service ID: `srv-d91iqr8js32c739g3ipg`
   - URL: https://whatsapp-bot-iptest.onrender.com
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
- **Este bot le da conversaciones a DOS productos**: flota (AlquilaCar) y KuSystem. El destino se resuelve por org, con tres fuentes de más a menos fuerte: (1) `ORG_INBOUND_ROUTES` (env; manda el operador), (2) la ruta **registrada** por la app dueña de la sesión, (3) `ORG_INBOUND_WEBHOOK_URL` (lo que no está mapeado; hoy flota). Antes era una sola URL global y las sesiones de KuSystem caían igual en flota, que responde 200 e ignora los orgId que no conoce: sus mensajes se perdieron durante meses sin un solo error en los logs.
- **Ruta registrada por la app** (`lib/inbound-route.js`, tabla `org_inbound_routes` de `bot.db`): `PUT /api/org-inbound-routes/:orgId` con `{ url, secret }`. KuSystem la llama sola al vincular la línea de un tenant (el POST de conectar, o el status mientras hay un QR a la vista), y así una org nueva no exige tocar `ORG_INBOUND_ROUTES` en Render: sin eso, una org que nadie sumó no falla, pierde mensajes en silencio. La URL tiene que ser https y no puede ser un host local (salvo `ORG_INBOUND_ALLOW_LOCAL=1`, para tests y desarrollo): un KuSystem de desarrollo apuntando a este bot registraría `http://localhost` y dejaría a la org sin destino. Vive en `DATA_DIR`, o sea en el disco: sobrevive a los deploys.
- **Mirar el ruteo antes de adivinar**: `GET /api/org-inbound-routes/:orgId` devuelve `{ source: 'env' | 'registered' | 'default' | 'none', host }` (nunca el secret ni el path), y `GET /api/status/:orgId` suma `inboundRouted` (`true` = ruta propia, `false` = cae al default, `null` = no se pudo leer la base). La entrega y el diagnóstico salen de la misma función (`resolveRoute`): no pueden discrepar. Si leer la ruta registrada falla, la entrega **no** cae al default (mandaría los mensajes de KuSystem a flota): el mensaje se pierde con un error a la vista en el log. Una entrega rechazada se loguea con el host de destino.
- **Rotar el secret de KuSystem** deja con el viejo a las rutas registradas: hay que volver a registrarlas (la app lo hace al vincular la línea) o ponerlas en `ORG_INBOUND_ROUTES`, que manda.
- El modo de falla de este archivo es **silencioso**: una entrega mal ruteada devuelve 200 igual. Por eso el ruteo tiene test (`npm test`) y por eso un `ORG_INBOUND_ROUTES` roto se ignora entero y cae al default en vez de tirar. Correr `npm test` antes de pushear cambios acá.
- **Nada opcional puede frenar la entrega.** La foto de perfil y la metadata de grupo son consultas a WhatsApp con el timeout de Baileys (60 s), y con contactos nuevos a veces no vuelven: esperarlas demoraba un minuto el primer mensaje de cada conversación (y con él la respuesta del bot de captación de KuSystem). Van con `withinBudget` (2,5 s); si no llegan, el payload sale con `null` y la consulta termina en segundo plano llenando el caché. Sólo el primer mensaje espera el tope: los que llegan con la consulta de la foto todavía abierta salen sin esperar, y un timeout se recuerda 10 min (`FAILED_TTL_MS`) para no repreguntar en cada mensaje. La foto se pide en paralelo con la subida del media. Una demora de preparación ≥ 3 s se loguea con el desglose por paso (`preparación lenta`), y un mensaje en vivo que Baileys entrega ≥ 15 s tarde, como `mensaje recibido Ns después de enviado`.
- No loguear `ORG_INBOUND_ROUTES` ni `err.message` de su `JSON.parse`: el valor tiene secrets adentro y Node cita un pedazo del input cuando la basura está al principio. Lo mismo vale para el body del `PUT /api/org-inbound-routes`: un JSON roto responde 400 sin citarlo (`entity.parse.failed`), porque body-parser copia un pedazo del texto y ahí viaja un secret.

## Media firmada para las apps (`POST /media/firmar`)
- El bucket privado `conversaciones` vive en el Supabase de ESTE bot. Las apps (KuSystem) no tienen su service_role: piden URLs firmadas acá (`lib/media-firmar.js`). No agregues endpoints que devuelvan la llave ni descarguen bytes por ellas.
- Body `{ ts, paths }` + header `X-Hub-Signature-256` = HMAC-SHA256 de `${ts}
${paths.join('
')}` con el secret de la ruta de entrada de la org (el mismo con el que el bot firma sus webhooks). `ts` en segundos, ±5 min. Máx. 100 paths, TTL 1 h.
- El orgId sale del prefijo de cada path; toda org del pedido necesita ruta PROPIA (env o registrada) cuyo secret verifique la firma. Las orgs que caen al destino por defecto (flota) no se pueden pedir. Sin `requireAuth` a propósito: el API_TOKEN es global y no distingue apps.
- No loguear paths enteros ni firmas.

## Configuración por env (`.env`)
Defaults documentados al lado de cada variable:

| Variable | Default | Descripción |
|---|---|---|
| `PORT` | `3001` | HTTP server port |
| `API_TOKEN` | `test-secret-local` | Token de auth para endpoints internos |
| `SEND_DELAY_MIN_MS` | `5000` | Mínimo (ms) del delay random entre mensajes consecutivos por org. **Bajarlo aumenta riesgo de ban.** |
| `SEND_DELAY_MAX_MS` | `10000` | Máximo (ms). Si MIN > MAX, vuelve a defaults con warn. |
| `ORG_INBOUND_ROUTES` | — | JSON `{ "<orgId>": { "url", "secret" } }`. Ruteo del webhook omnichannel por sesión, para que cada producto reciba lo suyo. **Gana** sobre la ruta registrada por la app. Roto o ausente → se ignora el mapa entero: cada org cae a su ruta registrada o, si no tiene, al default. |
| `ORG_INBOUND_ALLOW_LOCAL` | — | `1` deja registrar rutas a hosts locales (`localhost`, `127.x`, `0.0.0.0`, `[::1]`). Solo para tests y desarrollo: en producción no se define. |
| `DATA_DIR` | cwd (sesiones) / `./data` (base) | Dónde viven las sesiones de Baileys (`auth_info_baileys_<orgId>/`) y `bot.db` (cola de envíos, store de mensajes y rutas registradas). En producción tiene que apuntar al disco persistente (el que Render monta en `/app/auth_info_baileys`): fuera de ahí, sesiones y rutas se pierden en cada deploy. |
| `ORG_INBOUND_WEBHOOK_URL` | — | Endpoint del panel para las orgs **sin** ruta propia (hoy: flota) |
| `ORG_INBOUND_WEBHOOK_SECRET` | — | HMAC secret de ese destino por defecto |
| `ORG_INBOUND_RESOLVE_PARTICIPANT_PN` | — | orgIds separados por coma a los que el webhook omnichannel les completa `participantPn` en grupos cuando WhatsApp manda al participante sólo como LID (sale de la metadata del grupo) y busca el nombre en la agenda. Para las demás sesiones el payload no cambia. Hoy: `asemara`. |
| `ORG_QUOTED_REPLY` | — | orgIds separados por coma que responden citando de verdad cuando `/send` trae `quotedMessageId` (`sendMessage(jid, content, { quoted })` con la key guardada, incluido el `participant` en grupos). Las demás sesiones siguen como antes, con la cita dentro del contenido, que Baileys ignora. Hoy: `asemara`. |
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
7. **Verificar el deploy** (auto-deploy on-commit está ON — el push del paso 6 ya lo disparó) — chequear con `render deploys list <service-id> -o json` (cortar en el cliente; `--limit` no existe en este comando) hasta status `live`. Rollback si falla: `render deploys create <service-id> --commit <sha-anterior> --confirm`.
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
