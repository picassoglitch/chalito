# Chalito beta: plan de QA / QA plan (round 1)

[Español](#español) · [English](#english)

The checklist items have the same ids in both languages (W-1, P-3…), so a tester can work in either one and report results by id. The "Automated" column cites the tests that already cover each item. Paths are as on branch `all` at 3697d8b (2026-10-04).

What testers are told about the beta's limits is in [`docs/BETA_NOTES.md`](BETA_NOTES.md). The environment this plan runs against is set up by [`docs/GO_LIVE.md`](GO_LIVE.md) (Phases 0–8).

---

## Español

### Cómo usar este plan
- Cada punto tiene **pasos**, **resultado esperado** y **cobertura automática** (el archivo de prueba que ya lo comprueba). Marca la casilla cuando el resultado coincide. Si no coincide, anota el id, el dispositivo, el navegador o sistema, la hora y una captura.
- Estado de cada punto:
  - **LISTO**: un tester lo puede hacer solo, desde el producto.
  - **PARCIAL**: necesita al operador (quien corre el entorno) para un paso que no tiene interfaz.
  - **BLOQUEADO**: el producto no tiene interfaz para esto todavía. No lo intentes; se queda en la lista para saber qué falta. Ver [Huecos conocidos](#huecos-conocidos).
- Las rutas en español no llevan prefijo (`/bandeja`). En inglés van bajo `/en` con su propio nombre (`/en/inbox`). Prueba al menos una vez cada pantalla en los dos idiomas.
- El dominio es `chalito.chalyb.com`. Las rutas de abajo son relativas a él.

### Antes de empezar (tester)
1. Una cuenta de Chalyb con acceso a Chalito (la da el dueño, GO_LIVE 8.5).
2. Un teléfono con passkey (huella, rostro o llave de seguridad) y un navegador moderno.
3. Una computadora (macOS, Windows o Linux) para la app de escritorio.
4. Para las pruebas de agente: Claude Code instalado con el instalador oficial (https://code.claude.com/docs/en/setup) y una API key de Anthropic.

### Fuera de alcance en la ronda 1
No los pruebes ni los reportes como fallos:
- **WhatsApp, SMS y llamadas.** En la ronda 1 los avisos son solo push. Deja apagados "Avisos por WhatsApp" y "Llamadas" en Ajustes. Lo que sí revisamos es que esos canales no salgan (N-3).
- **Instaladores de escritorio firmados.** La ronda 1 usa compilaciones sin firmar. Windows mostrará SmartScreen y macOS pedirá confirmar al abrir (GO_LIVE fase 9).
- **La prueba de carga de 1,000 dispositivos** (`docs/LOAD_TEST.md`, GO_LIVE fase 10).
- **Codex con el plan de ChatGPT** ("Sign in with ChatGPT"): solo para el dueño hasta que OpenAI lo apruebe.
- **Avisos de "la Mesa empieza pronto"** (BETA_NOTES).
- Modelos 3D del compañero (son ilustraciones; BETA_NOTES).

### Huecos conocidos
Lo que el código no permite hacer hoy desde el producto. Los puntos marcados PARCIAL o BLOQUEADO apuntan aquí.

| # | Hueco | Dónde |
|---|---|---|
| G-1 | **No hay forma de activar push.** La web no pide permiso de notificaciones ni crea una suscripción. El service worker no hace nada con un push. Solo las pruebas insertan `push_subscriptions`. | `apps/web/public/sw.js`, `apps/web/src/components/ServiceWorker.tsx` |
| G-2 | **Borrar la cuenta no tiene interfaz.** Solo existe la API: `POST/GET/DELETE /v1/account/deletion` y `GET /v1/account/export`. | `apps/api/src/account/routes.ts` |
| G-3 | **`/creditos` y `/m/[id]` son pantallas provisionales** ("Esta pantalla llega pronto."). La recarga se hace en el hub ("Administrar en Chalyb"). | `apps/web/src/app/[locale]/creditos`, `…/m/[id]` |
| G-4 | **Nada en la web ni en el escritorio inicia una sesión de agente.** Las sesiones se pueden ver, interrumpir y recibir instrucciones, pero solo `scripts/e2e-phone.ts start` las inicia (contra el stack local). | `packages/client/src/actions.ts` `startSession` |
| G-5 | **Codex no está conectado al agente.** El daemon solo registra el adaptador `claude-code`. `chalito keys set openai` guarda una llave que nada usa. | `apps/agent/src/daemon.ts` `defaultAdapters` |
| G-6 | **La app de escritorio no deja `chalito` en el PATH.** El agente viaja como sidecar `binaries/chalito-agent-<triple>`, nada lo arranca y no hay instrucciones para el usuario. | `apps/desktop/scripts/release/plan.ts`, `src-tauri/src/lib.rs` |
| G-7 | **La Mesa no tiene interfaz.** Solo existe `POST /v1/mesas` en el orquestador. | `apps/orchestrator/src/app.ts` |
| G-8 | **Salas: crear, invitar, rotar la llave y disolver no tienen interfaz.** Solo existe la API `/v1/rooms`. Unirse, leer, publicar, reportar y salir sí la tienen. | `apps/api/src/routes/rooms.ts` |
| G-9 | **El escritorio con passkey sí puede aprobar ALTO**, aunque BETA_NOTES diga que no. Solo un escritorio sin autenticador de plataforma (p. ej. Linux) muestra "Aprueba esta acción desde tu teléfono". | `apps/desktop/src/panel/Inbox.tsx`, `src/lib/stepup.ts` |
| G-10 | **La mascota no muestra cosméticos.** Solo la escena de la sala los muestra. | `apps/desktop/src/pet/scene.ts` |

### Pruebas automáticas de referencia
- **Ensayo de la beta** (`apps/rehearsal`): los caminos principales de punta a punta entre api, agente, cliente, notifier y salas, sobre el stack local de Supabase con los servicios externos simulados. Se corre con `pnpm --filter @chalito/rehearsal test:rehearsal`, y en CI en el job "Beta rehearsal". Sin `DATABASE_URL`, `SUPABASE_AUTH_URL`, `SUPABASE_SERVICE_ROLE_KEY` y `SUPABASE_ANON_KEY` apuntando a localhost (o a una rama, `scripts/nexo-ai-dryrun.sh`), las suites se saltan.
  - `beta.rehearsal.test.ts` §1–§8: SSO, emparejar, endosar, aprobación ALTA, MCP, Mesa, salas, revocar todo.
  - `failures.rehearsal.test.ts` a–g: hub caído, sin crédito, teléfono revocado, horas de silencio, conector revocado, agente revocado, sala que rota su llave.
- Las e2e de la web en `apps/web/e2e/live/**` corren contra un **backend simulado** (la página muestra "MODO DE PRUEBA: datos simulados, nada es real."). Comprueban la interfaz, no el servidor real.
- Los `*.pg.test.ts` necesitan `DATABASE_URL`. pgTAP está en `supabase/tests/database/`.

### Lista de verificación

#### 1. Web / PWA
- [ ] **W-1 Entrar desde el hub** · LISTO
  - Pasos: en chalyb.com, abre Chalito. Llegas a `/auth/sso`.
  - Esperado: "Entrando a Chalito…", luego `/inicio` con la barra: Inicio, Bandeja, Sesiones, Dispositivos, Salas, Tienda, Ajustes. Si el token falla: "No pudimos abrir tu sesión. Vuelve a entrar desde Chalyb." con "Volver a Chalyb".
  - Automático: `apps/web/e2e/sso.spec.ts`; `apps/web/test/sso*.test.ts`; `apps/api/test/hub-contract.test.ts`; ensayo §1 "the hub provisions the tenant and its SSO launch signs the person into the web, then the phone enrols".
- [ ] **W-2 Bienvenida** · LISTO
  - Pasos: con una cuenta nueva, abre `/bienvenida`. Recorre los pasos con "Continuar", "Atrás" y "Saltar".
  - Esperado: "Paso {n} de 7". El último paso es la passkey ("Protege tus aprobaciones"), y al final "¡Listo!" con "Terminar".
  - Automático: `apps/web/e2e/onboarding.spec.ts`; `apps/web/test/onboarding.test.tsx`; `apps/web/e2e/live/settings.spec.ts` "onboarding on the server…".
- [ ] **W-3 Crear passkey en el teléfono** · LISTO
  - Pasos: en el teléfono, abre `/dispositivos` y toca "Crear passkey".
  - Esperado: aparece el diálogo del sistema (huella o rostro). Luego "Este dispositivo ya tiene passkey." Si lo cancelas: "Cancelaste la passkey; puedes intentarlo de nuevo."
  - Automático: `apps/api/test/webauthn.test.ts`; pgTAP `09_webauthn_binding`; ensayo §1 "the phone enrols a passkey; a step-up assertion is then available for it".
- [ ] **W-4 Cambiar la passkey** · LISTO
  - Pasos: en `/dispositivos`, toca "Cambiar llave de acceso". La primera vez cancela la confirmación con la passkey actual; la segunda vez confírmala.
  - Esperado: sin confirmar, "Para cambiar tu llave de acceso, confirma primero con la actual…" y nada cambia. Al confirmar: "Listo: tu nueva llave de acceso protege tus aprobaciones."
  - Automático: `apps/web/e2e/live/devices.spec.ts` "R-M11: changing the passkey asks for the current one…"; `apps/api/test/webauthn.test.ts` (R-M11, passkey clonada).
- [ ] **W-5 Instalar como app (PWA)** · LISTO
  - Pasos: en el teléfono, usa "Agregar a pantalla de inicio" / "Instalar app".
  - Esperado: el ícono "Chalito" abre `/inicio` en ventana propia, sin barra del navegador.
  - Automático: `apps/web/e2e/pwa.spec.ts` "the manifest makes the app installable", "the page links the manifest and registers the service worker".
- [ ] **W-6 Agregar un segundo navegador** · LISTO
  - Pasos: en un navegador nuevo, entra y abre `/vincular`. Escribe un nombre y toca "Mostrar código". En el teléfono, ve a `/dispositivos` → "Añadir un dispositivo", escribe el código ("Buscar") o usa "Escanear anillo". Compara la huella y toca "Aprobar".
  - Esperado:
    - En el teléfono: "Al aprobar, te pediremos tu passkey.", y luego "Listo: {nombre} ya es de confianza."
    - En el navegador nuevo: "Listo" con "Ir a la bandeja".
    - Con "No es mío" no se firma nada.
    - Si dejas pasar el tiempo: "El código venció. Muestra uno nuevo."
  - Automático: `apps/web/e2e/live/endorse.spec.ts` (7 pruebas); `apps/web/test/endorse.test.ts`; `apps/api/test/endorse.test.ts` (R-L13); ensayo §3 "the phone approves with its passkey; the browser enrols…"; pgTAP `12_endorse_codes`, `16_endorsement_broadcast`.
- [ ] **W-7 Enlace de aviso `/n/<id>`** · PARCIAL (el aviso lo crea el operador o una aprobación)
  - Pasos: abre el enlace de un aviso, primero con sesión iniciada y luego sin sesión.
  - Esperado:
    - Con sesión: "Abriendo…" y te lleva a su pantalla.
    - Sin sesión: pasa por el hub y vuelve.
    - Con un id ajeno: "Ese aviso ya no existe o no es tuyo."
  - Automático: `apps/web/e2e/live/notification.spec.ts`; `apps/web/e2e/sso.spec.ts` "/n/<nid> signed out → hub sign-in…"; `apps/web/test/notification-link.test.ts`.
- [ ] **W-8 Idioma** · LISTO
  - Pasos: cambia a `/en/...` en cada pantalla.
  - Esperado: todo en inglés, sin claves sin traducir. `/en/inbox`, `/en/devices`, `/en/rooms`, `/en/settings`, `/en/usage` y `/en/connections` existen.
  - Automático: `apps/web/e2e/i18n.spec.ts`; `apps/web/test/routing.test.ts`.
- [ ] **W-9 Descargar** · LISTO
  - Pasos: abre `/descargar` en computadora y luego en el teléfono.
  - Esperado:
    - En computadora: "Detectamos {so}." y el archivo para ese sistema, con la nota de compilación sin firmar y SmartScreen.
    - En el teléfono: te dice que uses la app web.
    - Sin publicación: "Las descargas aún no están disponibles."
  - Automático: `apps/web/e2e/download.spec.ts`.

#### 2. Escritorio: mascota, panel y sala
Instala la compilación que te dé el operador. **No uses una marcada "UNWIRED"**: no puede iniciar sesión.
- [ ] **D-1 Instalar y abrir** · LISTO
  - Pasos: instala y abre Chalito.
  - Esperado: se abren las ventanas de la mascota y del panel. Si en Ajustes ves "Esta compilación no tiene configurado el inicio de sesión.", la compilación es UNWIRED: repórtalo.
  - Automático: `apps/desktop/test/release-workflow.test.ts` "a release refuses to build unwired"; `panel.test.tsx` "not configured in this build". La ventana real de Tauri no tiene prueba automática.
- [ ] **D-2 Iniciar sesión en el panel** · LISTO
  - Pasos:
    1. Toca "Iniciar sesión" y termina en el navegador.
    2. En el teléfono, aprueba este equipo (`/dispositivos` → "Añadir un dispositivo", con el código que muestra el panel).
  - Esperado:
    - "Termina de iniciar sesión en tu navegador…"
    - Luego "Abre Chalito en un dispositivo de confianza (tu teléfono) y aprueba este equipo."
    - Al aprobar: "Listo: este equipo ya es de confianza."
    - Sin passkey en el equipo: "Este equipo no tiene llave de acceso: las acciones de riesgo ALTO o CRÍTICO se aprueban desde tu teléfono."
  - Automático: `apps/desktop/test/sign-in.test.ts`; `sso.test.ts`; `endorse-flow.e2e.test.ts`; `apps/web/e2e/desktop.spec.ts`.
- [ ] **D-3 Pestañas del panel** · LISTO
  - Pasos: recorre Bandeja, Salas, Ajustes, Seguridad y Voz. Activa "No molestar".
  - Esperado:
    - Las cinco pestañas cargan.
    - Sin cuenta: "Sin conexión a tu cuenta. Empareja esta computadora con «chalito pair»."
    - Si el agente local no corre, Seguridad dice que no responde.
  - Automático: `apps/desktop/test/panel.test.tsx` "offline until the client connects", "says the agent isn't reachable…", "es and en have the same keys…".
- [ ] **D-4 La mascota reacciona** · PARCIAL (necesita algo pendiente, ver P-1)
  - Pasos: con una aprobación o aviso pendiente, mira la mascota.
  - Esperado: cambia de expresión según el nivel más alto pendiente. En horas de silencio se calma. **No lleva cosméticos** (G-10).
  - Automático: `apps/desktop/test/pet-look.test.ts`; `pet-context.test.ts` "the pet signals the highest pending level only"; `hitbox.test.ts`.
- [ ] **D-5 Aprobar desde el panel** · PARCIAL (G-4: el operador inicia la sesión)
  - Pasos: en Bandeja → Aprobaciones, aprueba una de riesgo bajo o medio con "Aprobar". Rechaza otra con "Rechazar". Luego abre una de riesgo ALTO.
  - Esperado:
    - Bajo y medio se envían.
    - ALTO en un equipo sin passkey: "Aprueba esta acción desde tu teléfono" y solo "Rechazar".
    - ALTO en un equipo con passkey (Windows o macOS): se puede aprobar aquí (G-9). Anota cuál de los dos viste.
    - Con un resumen cortado: "Aprobar" sigue desactivado hasta "Ver el comando completo".
    - Si la computadora no firmó la solicitud: "Sin verificar…" y solo se puede rechazar.
  - Automático: `apps/desktop/test/panel.test.tsx` ("lists pending approvals…", "without a passkey: HIGH says approve from the phone…", "with a passkey: HIGH can be approved here", "a truncated summary…", "an unverified approval…"); `enrollment.test.ts`.
- [ ] **D-6 Voz** · LISTO
  - Pasos: en Voz, mantén "Mantén presionado para hablar", habla y suelta.
  - Esperado:
    - "Conectando…", luego "Te escucho…" y una respuesta en voz. Al soltar, el micrófono se cierra.
    - Al tope del mes: "You've used up this month's voice minutes." (o su versión en español).
  - Automático: `apps/desktop/test/voice.test.ts`; `webrtc-voice.test.ts`; ensayo b "a desktop voice session is refused at the monthly cap…".
- [ ] **D-7 Actualizaciones** · LISTO
  - Pasos: Ajustes → "Buscar actualizaciones".
  - Esperado: "Tienes la versión más reciente.", o "Hay una versión nueva: {versión}." → "Descargar e instalar" → "Reiniciar ahora". En una compilación sin actualizador: "Esta compilación no se actualiza sola."
  - Automático: `apps/desktop/test/updates.test.tsx` (incluye "a bad signature … installs nothing").
- [ ] **D-8 Ventana de sala y escena del portal**: ver R-3.

#### 3. Agente (CLI) con Claude Code y Codex
Cómo conseguir `chalito` en la ronda 1: el operador te da la ruta del binario (G-6). Los comandos que cambian algo **solo corren en una terminal donde tú escribes**: sin entrada por tubería y fuera de una sesión de Chalito.
- [ ] **A-1 Guardar la llave de Anthropic** · PARCIAL (G-6)
  - Pasos: `chalito keys set anthropic` y pega la llave.
  - Esperado:
    - El prompt "API key de anthropic (no se mostrará): " no muestra lo que escribes. Al guardar: "anthropic key saved in the OS keychain. It never leaves this computer."
    - Con una llave vacía: "Not saved: the key is empty." Con una que no empieza por `sk-ant-`: aviso, pero la guarda igual.
  - Automático: `apps/agent/test/cli.test.ts` "saves the key in the keychain, never prints it", "warns on an unexpected shape…".
- [ ] **A-2 Emparejar la computadora** · PARCIAL (G-6)
  - Pasos:
    1. Corre `chalito pair`.
    2. En el teléfono, ve a `/dispositivos` → "Añadir un dispositivo" y escanea el glifo o escribe el código.
    3. Compara las huellas y responde `s`.
  - Esperado:
    - Primero ves "En tu teléfono, abre Chalito → Agregar computadora y escanea el glifo o escribe: <CÓDIGO>" y la huella de esta computadora. El código vence en 5 minutos.
    - Al responder `s`: "Listo: esta computadora confía en tu teléfono…".
    - Con `n`: "Nothing was added…".
    - Si vence el código: "The code expired. Run `chalito pair` again."
    - Si el teléfono no tiene passkey: aviso de que no podrá aprobar ALTO.
  - Automático: `apps/agent/test/pair.test.ts` (6 pruebas); ensayo §2 "the agent's signed glyph is claimed by the phone…", "a glyph can't be published twice…".
- [ ] **A-3 Fijar Claude Code** · PARCIAL (G-6)
  - Pasos: `chalito claude pin`, y luego `chalito status`.
  - Esperado:
    - "Claude Code fijado: <ruta>" con su sha256. `status` muestra "(pinned, sha256 …)".
    - Sin emparejar: "Pair this computer first…".
    - Sin `claude`: "`claude` wasn't found. Install it…".
  - Automático: `apps/agent/test/cli.test.ts` "pins path (symlinks resolved) + sha256…", "needs a paired computer", "status: unpaired computer…".
- [ ] **A-4 Arrancar el agente** · PARCIAL (G-6)
  - Pasos: `chalito run` (o `chalito service install`).
  - Esperado:
    - El log muestra `agent.ready`, y al iniciar una sesión, `adapter.init` con `apiKeySource: "ANTHROPIC_API_KEY"`.
    - Si Claude Code se actualizó solo: "Claude Code updated itself: run `chalito claude pin` again…".
    - Sin llave: aparece `adapter.claude_code_unavailable`, pero el agente sigue corriendo.
  - Automático: `apps/agent/test/daemon.test.ts` ("runs exactly the pinned Claude Code…", "a pinned binary that changed…", "a missing Anthropic key is logged…"); `packages/adapters/test/claude-code.test.ts`.
- [ ] **A-5 Una sesión de Claude Code pide aprobaciones** · PARCIAL (G-4: el operador inicia la sesión; guion en `scripts/e2e-claude.md` §5)
  - Pasos: en la sesión, pide una lectura, una edición en la carpeta, un `git push` y un `sudo`.
  - Esperado:
    - Lectura (BAJO): pasa sola.
    - Edición (MEDIO): espera un toque.
    - `git push` (ALTO): espera una aprobación con passkey desde el teléfono.
    - `sudo` (CRÍTICO): bloqueado.
    - Lo que esté bajo `~/.chalito` se bloquea siempre.
    - Claude ve "Approved by Chalito" o "Chalito: <razón>".
    - Escribir `claude` directo en una terminal **no** pasa por Chalito; eso es lo esperado.
  - Automático: `apps/agent/test/policy.test.ts` (LOW/MED/HIGH/CRITICAL, hard floor); `apps/agent/test/agent.test.ts` ("a MED edit waits for the phone…", "HIGH needs step-up…", "an unanswered approval is denied when it expires (10 min)"); `packages/adapters/test/claude-code.test.ts` "routes every tool call through the gate…".
- [ ] **A-6 Ver la sesión en la web** · PARCIAL (G-4)
  - Pasos: abre `/sesiones` y luego la sesión. Prueba "Interrumpir", "Reanudar", "Enviar" y los modos "Preguntar", "Solo planear" y "Aceptar ediciones".
  - Esperado: el estado ("Trabajando", "Esperando aprobación") se actualiza en vivo y las instrucciones llegan a la sesión.
  - Automático: `apps/web/e2e/live/sessions.spec.ts`; `apps/agent/test/agent.test.ts` "bypassPermissions, dontAsk and auto are rejected…".
- [ ] **A-7 Codex con API key** · BLOQUEADO (G-5)
  - Automático, solo a nivel adaptador: `packages/adapters/test/codex.test.ts` "API key: an env-key provider…".
- [ ] **A-8 Codex con el plan de ChatGPT** · fuera de alcance (solo para el dueño)
  - Automático: `packages/adapters/test/codex.test.ts` "ChatGPT plan stays off unless the flag is on…".

#### 4. Aprobaciones en el teléfono (incluye ALTO con passkey)
Todas necesitan una sesión que pida aprobación (A-5): son PARCIAL por G-4.
- [ ] **P-1 Bandeja** · PARCIAL
  - Pasos: abre `/bandeja`.
  - Esperado: "Por aprobar ({n})", con la insignia de riesgo (Bajo, Medio, Alto, Crítico) y la cuenta regresiva "Vence en". Sin pendientes: "Nada pendiente."
  - Automático: `apps/web/e2e/live/inbox.spec.ts`.
- [ ] **P-2 Aprobar bajo o medio** · PARCIAL
  - Pasos: toca "Aprobar".
  - Esperado: no pide passkey, aparece "Aprobación enviada." y la sesión sigue.
  - Automático: `inbox.spec.ts` "approve from the phone releases the session…"; `apps/agent/test/agent.test.ts` "a MED edit waits for the phone; a signed allow releases it".
- [ ] **P-3 Aprobar ALTO con passkey** · PARCIAL
  - Pasos: en una aprobación de riesgo Alto, toca "Aprobar" y confirma con huella o rostro. Repite con otra y cancela el diálogo.
  - Esperado:
    - Aparece la nota "Aprobar pide tu huella, rostro o llave de seguridad." y luego el diálogo del sistema.
    - Al confirmar, la acción corre en la computadora.
    - Al cancelar: "Cancelado: no se envió nada." y la acción no corre.
    - Sin passkey en el teléfono: "Para aprobar acciones de riesgo alto, protege este dispositivo con tu passkey." con "Crear passkey", y "Aprobar" desactivado.
  - Automático: ensayo §4 "the approval escalates push → WhatsApp; the phone checks detailsHash and allows with its passkey; a forged allow doesn't run the tool"; `inbox.spec.ts` "…HIGH needs step-up and cancelling sends nothing"; `packages/client/test/actions.test.ts` "HIGH/CRITICAL (or step_up_required) asks for step-up first…"; `apps/agent/test/agent.test.ts` "HIGH step-up must be a passkey assertion this agent can verify (D-019)".
- [ ] **P-4 Denegar** · PARCIAL
  - Pasos: toca "Denegar" en una de riesgo Alto.
  - Esperado: no pide passkey, aparece "Rechazo enviado." y la herramienta no corre.
  - Automático: `packages/client/test/actions.test.ts` "denying needs no step-up"; `apps/agent/test/agent.test.ts` "a signed deny refuses the tool".
- [ ] **P-5 Expira** · PARCIAL
  - Pasos: deja una aprobación sin responder 10 minutos.
  - Esperado: "Expiró: denegada", también en inglés ("Expired: denied"), y la herramienta no corre.
  - Automático: `inbox.spec.ts` "the countdown runs…", "expired approvals say 'Expired: denied' in English too"; `apps/agent/test/agent.test.ts` "an unanswered approval is denied when it expires (10 min)".
- [ ] **P-6 Resumen cortado y caracteres ocultos** · PARCIAL
  - Pasos: pide un comando muy largo.
  - Esperado: "…(truncado)" y "El resumen está cortado: abre el contenido completo antes de aprobar." "Aprobar" sigue bloqueado hasta abrir "Ver lo que se va a ejecutar, completo".
  - Automático: `inbox.spec.ts` "R-M10…"; `apps/web/test/approval-text.test.ts`.
- [ ] **P-7 Enlace directo `/a/<id>`** · PARCIAL
  - Pasos: abre `/a/<id>` de una aprobación, y luego uno inventado.
  - Esperado: con el id real muestra esa aprobación. Con el inventado: "No encontramos esa aprobación."
  - Automático: `inbox.spec.ts` "the /a/<id> deep link shows that approval".
- [ ] **P-8 Ya resuelta en otro dispositivo** · PARCIAL
  - Pasos: aprueba en el escritorio y luego intenta en el teléfono.
  - Esperado: "Ya se resolvió."
  - Automático: `apps/agent/test/agent.test.ts` "replayed, untrusted, wrong-request and unsigned decisions are rejected…"; pgTAP `33_decision_attempts`.

#### 5. Avisos (solo push en la ronda 1)
- [ ] **N-1 Activar push** · BLOQUEADO (G-1)
  - Automático, solo del lado del servidor: `apps/notifier/test/notifier.test.ts` "a 410 from the push service deletes the subscription"; pgTAP `07_settings_notifier` "push: up to 5 per device", `34_push_subs_revoked`.
- [ ] **N-2 Llega un push al pedir aprobación** · BLOQUEADO (G-1)
  - Esperado, una vez que exista: llega en segundos y al tocarlo abre `/n/<id>` → `/a/<id>`.
  - Automático: ensayo §4; `apps/notifier/test/notify-outbox.test.ts` "a signed poke delivers that row… (push in seconds)"; pgTAP `19_notify_outbox`.
- [ ] **N-3 No sale nada de paga** · LISTO
  - Pasos: en Ajustes → "Contacto y avisos", deja apagados "Avisos por WhatsApp" y "Llamadas". Deja una aprobación sin responder hasta que expire.
  - Esperado: no llega WhatsApp, SMS ni llamada. El aviso sí aparece en "Avisos" de la Bandeja. El operador confirma que `notification_sends` solo tiene push.
  - Automático: ensayo a "paid comms are suppressed with the reason (push, which is free, still goes)", d "phone channels are held…"; `apps/notifier/test/caps.test.ts`; `apps/notifier/test/billing.test.ts`; pgTAP `07_settings_notifier` "clients never turn opt-ins on…".
- [ ] **N-4 Avisos en la bandeja** · PARCIAL
  - Pasos: en `/bandeja` → "Avisos", toca "Entendido".
  - Esperado: el contador "# pendiente(s)" baja.
  - Automático: `apps/web/e2e/live/inbox.spec.ts`.

#### 6. Mesa
- [ ] **M-1 Crear y usar una Mesa** · BLOQUEADO (G-7; `/m/<id>` muestra "Esta pantalla llega pronto.")
  - Automático: ensayo §6 "the turn is admitted, answered, and its llm.tokens event committed with it; the drain delivers it"; `apps/orchestrator/test/turn.test.ts` (límite de cerebros por plan, tope de presupuesto, `budget_reached`, reintento 409); `core.test.ts`; `part2.test.ts`; `decisions.test.ts`; pgTAP `11_mesa`, `13_mesa_decisions_byo`.
- [ ] **M-2 Mesa desde un conector** (`post_to_mesa`): ver C-3.

#### 7. Salas y escena del portal
Crear la sala e invitar no tiene interfaz (G-8): el operador crea la sala y te da un código de invitación.
- [ ] **R-1 Unirse con código** · PARCIAL
  - Pasos: en `/salas` → "Unirse con código", escribe el "Código de invitación" y toca "Unirse". También desde el panel de escritorio → Salas → "Unirme". Prueba también un código malo.
  - Esperado:
    - La sala aparece en la lista. Mientras llega la llave: "Esperando la llave de la sala…". En escritorio: "Listo. Un integrante te dará acceso a los mensajes en un momento."
    - Con un código malo: "Ese código no es válido o ya se usó."
  - Automático: `apps/web/e2e/live/rooms.spec.ts` "join with a code (and a bad code says so)…"; `apps/desktop/test/salas.test.tsx`; `apps/api/test/rooms.pg.test.ts` "dad creates a room, invites, son joins…"; ensayo §7.
- [ ] **R-2 Publicar y leer** · PARCIAL
  - Pasos: en `/r/<id>`, escribe en "Escribe un aviso para la sala" y toca "Enviar". Lee desde otro miembro.
  - Esperado: el otro miembro lo ve como texto en menos de 2 s, con la marca "Nuevo" y el punto de no leído en el panel.
  - Automático: ensayo §7 "the members' RoomControllers see a post as plain text…"; `rooms.pg.test.ts` "…in under 2 s"; `rooms.spec.ts`.
- [ ] **R-3 Escena del portal** · PARCIAL
  - Pasos: abre la sala en el escritorio ("Abrir") y en la web. Haz que otro miembro entre y salga. Cambia la calidad (bajo, medio, alto).
  - Esperado:
    - Al entrar, el portal se abre y el compañero sale de él. Al salir, la animación inversa.
    - Los cosméticos puestos se ven, incluido `portal_swirl` si alguien lo tiene.
    - En calidad bajo no hay sombra de contacto.
  - Automático: `packages/scene/test/choreography.test.ts`; `room-scene.test.ts`; `apps/desktop/test/room-stage.test.tsx`; `packages/roster/test/cosmetics.test.ts`. El render real no tiene prueba automática.
- [ ] **R-4 Reportar** · PARCIAL
  - Pasos: en un mensaje, toca "Reportar", elige un motivo y toca "Enviar reporte". Repite sobre el mismo mensaje.
  - Esperado: "Reporte enviado. Gracias.", y la segunda vez "Ya habías reportado esto." El texto solo se adjunta si marcas la casilla.
  - Automático: `rooms.spec.ts` "report: …"; `apps/api/test/rooms-reports.test.ts`; pgTAP `31_room_kicks_reports`.
- [ ] **R-5 Salir** · PARCIAL
  - Pasos: toca "Salir de la sala" → "Sí, salir".
  - Esperado: "Saliste de esta sala." Lo que se publique después no se puede leer con tu llave.
  - Automático: ensayo §7 "leave → kicked…"; `rooms.pg.test.ts` "son leaves; dad's client rotates…"; `packages/rooms/test/rooms.test.ts`.
- [ ] **R-6 Disuelta o expulsado** · PARCIAL (el operador disuelve la sala)
  - Esperado: "Esta sala ya no existe." o "Ya no eres miembro de esta sala.", y el feed se detiene.
  - Automático: `rooms.spec.ts` "kicked, dissolved, left…"; ensayo §7; pgTAP `08_rooms`.
- [ ] **R-7 Teléfono revocado en una sala** · PARCIAL
  - Pasos: retira tu teléfono (V-1) y abre la sala en él.
  - Esperado: "Este dispositivo fue retirado de tu cuenta." Los demás no pueden publicar hasta que se rote la llave.
  - Automático: ensayo g "the next post is refused until a rotation…"; `apps/desktop/test/room-window.test.tsx`; `rooms.spec.ts` "revoked device…".

#### 8. Tienda
- [ ] **S-1 Ver la tienda** · LISTO
  - Pasos: abre `/tienda`.
  - Esperado: el texto "Ropa y efectos para tu compañero. Solo cambian cómo se ve, nunca lo que puede hacer." Las ranuras: Cabeza, Cara, Cuerpo, Espalda, Aura, Portal. Precios en tokens o "Gratis".
  - Automático: `apps/web/test/store.test.ts`; `apps/web/e2e/live/store.spec.ts`.
- [ ] **S-2 Ponerse y quitarse algo gratis** · LISTO
  - Pasos: toca "Ponérselo" y luego "Quitárselo".
  - Esperado: el estado cambia y se ve en la escena de la sala (no en la mascota, G-10).
  - Automático: `store.spec.ts`; pgTAP `18_directory_cosmetics`.
- [ ] **S-3 Comprar algo de paga** · LISTO (gasta tokens del hub)
  - Pasos: toca "Comprar". Si falla la red, reintenta.
  - Esperado: el saldo baja **una sola vez** exactamente por el precio, y aparece "Ya es tuyo". Al fallar: "No se pudo completar la compra. Reintentar no te cobra dos veces."
  - Automático: `store.spec.ts` "buying spends tokens once, a retry reuses the purchase id…", "a network drop mid-purchase is retried with the same id and charged once"; `apps/api/test/store.test.ts`; `store.pg.test.ts`.
- [ ] **S-4 Sin tokens** · PARCIAL (cuenta con saldo cero)
  - Esperado: "No te alcanzan los tokens." con el chip "¿Por qué?".
  - Automático: `store.spec.ts`; `apps/api/test/pay-to-win.test.ts` (los cosméticos no dan ventajas).

#### 9. Conectores MCP en Claude y ChatGPT
- [ ] **C-1 Conectar Claude** · LISTO
  - Pasos:
    1. En claude.ai, ve a Settings → Connectors → Add custom connector. Nombre `Chalito`, URL `https://mcp.chalito.chalyb.com/mcp`, sin client ID ni secret. Toca Connect.
    2. En la página "{cliente} quiere conectarse a Chalito", revisa "Permisos que pide" y toca "Permitir".
  - Esperado:
    - "Permitirlo pide tu passkey." y luego el diálogo del sistema.
    - "Enviar instrucciones a tus sesiones de agentes…" (`session:prompt`) nunca viene marcado.
    - Si la abres en un dispositivo no emparejado: "…abre esta página en un dispositivo emparejado".
  - Automático: ensayo §5 "CIMD + PKCE + passkey consent → a token…"; `apps/web/e2e/live/mcp.spec.ts` "consent: …session:prompt is never pre-checked; allow needs the passkey"; `apps/api/test/oauth.test.ts`; `oauth-hardening.test.ts`.
- [ ] **C-2 Conectar ChatGPT** · LISTO
  - Pasos: en ChatGPT, ve a Settings → Apps & Connectors → Advanced settings → Developer mode. Create, con Nombre `Chalito`, la misma URL y autenticación OAuth. Luego activa el conector desde el menú de herramientas.
  - Esperado: la misma página de consentimiento que en C-1. ChatGPT pregunta antes de cada herramienta de escritura. "No permitir" cancela sin dar acceso.
  - Automático: `mcp.spec.ts` "'No permitir' sends access_denied"; `apps/api/test/oauth-hardening.test.ts` (origen CIMD).
- [ ] **C-3 Usar las herramientas** · PARCIAL (`prompt_session` necesita una sesión, G-4)
  - Pasos: pide en el chat `list_pending` y `get_session_card`. Con el permiso, usa `prompt_session` para que la sesión haga un `git push`.
  - Esperado:
    - Las lecturas responden.
    - La acción ALTA espera tu aprobación con passkey en el teléfono (P-3), aun con Modo desarrollador `autoApproveHigh`.
    - Ninguna herramienta puede decidir, cambiar política, dispositivos, salas ni facturación.
  - Automático: ensayo §5; `apps/mcp-gateway/test/prompt-e2e.test.ts`; `gateway.test.ts` "no tool can decide, change policy…"; pgTAP `10_mcp_gateway`, `17_review_beta_mcp`.
- [ ] **C-4 Desconectar** · LISTO
  - Pasos: en `/conexiones` ("Apps conectadas"), toca "Desconectar" → "Sí, desconectar". Vuelve a usar el conector.
  - Esperado: la siguiente llamada falla de inmediato.
  - Automático: ensayo e "the very next MCP call fails"; `mcp.spec.ts` "Apps conectadas: list and revoke…"; `gateway.test.ts` "a revoked grant fails on the very next call".
- [ ] **C-5 Compartir la tarjeta** · LISTO
  - Pasos: activa "Compartir tarjeta con apps conectadas", marca "Entiendo que se guarda sin cifrar." y toca "Compartir". Luego apágalo.
  - Esperado: `get_session_card` la ve solo mientras está activa.
  - Automático: `mcp.spec.ts` (tarjeta, incluido "per computer on /dispositivos"); `gateway.test.ts`.

#### 10. Facturación y créditos
- [ ] **B-1 Plan** · LISTO
  - Pasos: en Ajustes → "Plan y créditos", toca "Administrar en Chalyb".
  - Esperado: "Nivel: {nivel}" coincide con tu nivel del hub (Gratis, Pro o VIP). "Administrar en Chalyb" abre el hub, que es donde se recarga.
  - Automático: `apps/web/test/settings-store.test.ts`; `apps/web/test/landing-plans.test.ts`; `packages/billing/test/entitlements.test.ts`.
- [ ] **B-2 Uso** · LISTO
  - Pasos: abre `/uso` ("Ver tu uso"). Cambia el periodo y toca "Ver por día".
  - Esperado: solo tokens, nunca dinero, en "Tokens de Chalito", "Trabajo", "Comunicación" y "Tus claves". Después de usar la voz o una Mesa, el número sube.
  - Automático: `apps/web/e2e/live/usage.spec.ts`; `apps/web/test/usage.test.ts`; ensayo §6.
- [ ] **B-3 Sin crédito** · PARCIAL (cuenta con saldo cero)
  - Pasos: habla con el compañero o usa la voz sin tokens.
  - Esperado: el compañero responde en modo mínimo, con la línea de recarga y el chip "¿Por qué?", y no se cobra nada. La voz se niega al tope.
  - Automático: ensayo b "the companion's recharge line and chip, on free_min; nothing billed"; ensayo a "a companion turn finishes on free_min…"; `packages/billing/test/energy-billable.test.ts`; `apps/orchestrator/test/turn.test.ts`.
- [ ] **B-4 `/creditos`** · BLOQUEADO (G-3: pantalla provisional)

#### 11. Retirar un dispositivo y retirar todos
- [ ] **V-1 Retirar un dispositivo** · LISTO
  - Pasos: en `/dispositivos`, toca "Retirar" en un navegador → "Sí, retirar".
  - Esperado:
    - "{nombre} fue retirado: ya no puede entrar a tu cuenta ni enviar nada a tus computadoras." Por cada computadora: si está en línea, "lo quitó de su lista"; si está apagada, "sin conexión…" (el servidor ya cerró su acceso).
    - En el dispositivo retirado: "Este dispositivo fue retirado de tu cuenta…" con "Emparejar de nuevo".
  - Automático: `apps/web/e2e/live/devices.spec.ts` "devices: presence, and revoking another client goes to the agent", "revoking while a computer is asleep…"; `device-session.spec.ts`; `apps/api/test/device-revoke.test.ts`; pgTAP `34_push_subs_revoked`, `35_revoke_sweep`.
- [ ] **V-2 Retirar a mitad de una aprobación** · PARCIAL (G-4)
  - Pasos: con una aprobación pendiente, retira uno de dos teléfonos.
  - Esperado: sus decisiones se rechazan y los avisos siguen solo al otro.
  - Automático: ensayo c "its later decisions are refused, and the ladder goes on to the remaining device only"; `apps/agent/test/agent.test.ts` "a revoked phone's decision is rejected…".
- [ ] **V-3 Cerrar sesión en todos los demás** · LISTO
  - Pasos: en `/dispositivos` → "Cerrar sesión en todos los demás dispositivos", toca "Cerrar sesión en todos los demás" → "Sí, cerrar sesión" y confirma con la passkey. Repite cancelando la passkey.
  - Esperado:
    - "Se cerró la sesión en # dispositivo(s)." Las computadoras **siguen emparejadas**.
    - Al cancelar: "Se canceló: no se cambió nada."
    - Sin passkey en este dispositivo: "Para usarlo, primero crea una llave de acceso en este dispositivo."
  - Automático: ensayo §8 "the phone, with a fresh step-up, revokes every other client…"; `devices.spec.ts` "sign out everywhere else…"; `apps/api/test/revoke-all.test.ts`; `revoke-all.pg.test.ts`; `packages/client/test/actions.test.ts` "revokeAll…".
- [ ] **V-4 Retirar la computadora** · PARCIAL (G-6)
  - Pasos: retira la computadora desde `/dispositivos`.
  - Esperado: el agente se detiene con un mensaje claro. Las aprobaciones que tenía se niegan (`agent_revoked`) y lo que compartía deja de estar compartido.
  - Automático: ensayo f "its approval is denied (agent_revoked)…"; `apps/agent/test/daemon.test.ts` "a revoked device found on a refresh tick stops the daemon…".

#### 12. Borrar la cuenta
- [ ] **X-1 Pedir el borrado** · BLOQUEADO (G-2)
  - Comportamiento de la API, para cuando haya interfaz:
    - Pide passkey.
    - Primero escribe la exportación.
    - Programa el borrado a 7 días.
    - Manda un aviso crítico a todos tus dispositivos.
    - No se puede programar dos veces.
  - Automático: `apps/api/test/account.test.ts`; `account.pg.test.ts`.
- [ ] **X-2 Cancelar el borrado en el periodo de gracia** · BLOQUEADO (G-2)
  - Automático: `account.test.ts` "the owner can cancel during the grace period, and nothing is deleted".
- [ ] **X-3 Borrado vencido** · BLOQUEADO (G-2; lo corre `/tasks/account-deletions` cada hora)
  - Esperado: se borran los usuarios de dispositivo, tus archivos y tus datos de Chalito. Tu cuenta y tu saldo del hub **no** se tocan.
  - Automático: `account.test.ts` "when due: …"; pgTAP `34_push_subs_revoked` "deleting the account drops every subscription".

---

## English

### How to use this plan
- Each item has **steps**, an **expected result** and **automated coverage** (the test file that already checks it). Tick the box when the result matches. When it doesn't, write down the id, the device, the browser or OS, the time, and a screenshot.
- Item status:
  - **READY**: a tester can do it alone, in the product.
  - **PARTIAL**: needs the operator (whoever runs the environment) for a step with no UI.
  - **BLOCKED**: the product has no UI for this yet. Don't try it; it stays on the list so we know what's missing. See [Known gaps](#known-gaps).
- Spanish routes have no prefix (`/bandeja`). English ones live under `/en` with their own slug (`/en/inbox`). Check every screen at least once in both languages.
- The domain is `chalito.chalyb.com`. Routes below are relative to it.

### Before you start (tester)
1. A Chalyb account with Chalito access (the owner grants it, GO_LIVE 8.5).
2. A phone with a passkey (fingerprint, face or security key) and a modern browser.
3. A computer (macOS, Windows or Linux) for the desktop app.
4. For the agent items: Claude Code installed with the official installer (https://code.claude.com/docs/en/setup) and an Anthropic API key.

### Out of scope for round 1
Don't test these or report them as failures:
- **WhatsApp, SMS and calls.** Round-1 alerts are push only. Leave "WhatsApp alerts" and "Calls" off in Settings. What we do check is that they don't go out (N-3).
- **Signed desktop installers.** Round 1 uses unsigned builds. Windows shows SmartScreen and macOS asks you to confirm on first open (GO_LIVE phase 9).
- **The 1,000-device load test** (`docs/LOAD_TEST.md`, GO_LIVE phase 10).
- **Codex with a ChatGPT plan** ("Sign in with ChatGPT"): owner only until OpenAI approves it.
- **"Your Mesa starts soon" alerts** (BETA_NOTES).
- Rigged 3D companions (they're illustrations; BETA_NOTES).

### Known gaps
What the code doesn't let a tester do from the product today. PARTIAL and BLOCKED items point here.

| # | Gap | Where |
|---|---|---|
| G-1 | **Push can't be turned on.** The web never asks for notification permission or creates a subscription. The service worker's push handler does nothing. Only tests insert `push_subscriptions`. | `apps/web/public/sw.js`, `apps/web/src/components/ServiceWorker.tsx` |
| G-2 | **Account deletion has no UI.** Only the API exists: `POST/GET/DELETE /v1/account/deletion` and `GET /v1/account/export`. | `apps/api/src/account/routes.ts` |
| G-3 | **`/creditos` and `/m/[id]` are placeholders** ("This screen is coming soon."). Recharge happens on the hub ("Manage on Chalyb"). | `apps/web/src/app/[locale]/creditos`, `…/m/[id]` |
| G-4 | **Nothing in the web or desktop starts an agent session.** Sessions can be watched, interrupted and prompted, but only `scripts/e2e-phone.ts start` starts one (against the local stack). | `packages/client/src/actions.ts` `startSession` |
| G-5 | **Codex isn't wired into the agent.** The daemon registers only the `claude-code` adapter. `chalito keys set openai` stores a key nothing uses. | `apps/agent/src/daemon.ts` `defaultAdapters` |
| G-6 | **The desktop install doesn't put `chalito` on PATH.** The agent ships as the sidecar `binaries/chalito-agent-<triple>`, nothing starts it, and there are no user instructions. | `apps/desktop/scripts/release/plan.ts`, `src-tauri/src/lib.rs` |
| G-7 | **Mesa has no UI.** Only `POST /v1/mesas` on the orchestrator. | `apps/orchestrator/src/app.ts` |
| G-8 | **Rooms: create, invite, key rotation and dissolve have no UI.** Only the `/v1/rooms` API. Join, read, post, report and leave do have UI. | `apps/api/src/routes/rooms.ts` |
| G-9 | **A desktop with a passkey can approve HIGH**, although BETA_NOTES says it can't. Only a desktop without a platform authenticator (e.g. Linux) shows "Approve this action from your phone". | `apps/desktop/src/panel/Inbox.tsx`, `src/lib/stepup.ts` |
| G-10 | **The pet doesn't show cosmetics.** Only the room scene does. | `apps/desktop/src/pet/scene.ts` |

### Automated tests to know
- **Beta rehearsal** (`apps/rehearsal`): the main paths end to end across api, agent, client, notifier and rooms, on the local Supabase stack with outside services mocked. Run it with `pnpm --filter @chalito/rehearsal test:rehearsal`; CI runs it in the "Beta rehearsal" step. The suites skip unless `DATABASE_URL`, `SUPABASE_AUTH_URL`, `SUPABASE_SERVICE_ROLE_KEY` and `SUPABASE_ANON_KEY` point at localhost (or at a branch, `scripts/nexo-ai-dryrun.sh`).
  - `beta.rehearsal.test.ts` §1–§8: SSO, pairing, endorsement, HIGH approval, MCP, Mesa, rooms, revoke-all.
  - `failures.rehearsal.test.ts` a–g: hub down, out of credit, phone revoked, quiet hours, connector revoked, agent revoked, a room that rotates its key.
- The web e2e specs under `apps/web/e2e/live/**` run against a **simulated backend** (the page shows "TEST MODE: simulated data, nothing is real."). They check the UI, not the real server.
- `*.pg.test.ts` files need `DATABASE_URL`. pgTAP lives in `supabase/tests/database/`.

### Checklist

#### 1. Web / PWA
- [ ] **W-1 Sign in from the hub** · READY
  - Steps: on chalyb.com, launch Chalito. You land on `/auth/sso`.
  - Expected: "Entrando a Chalito…", then `/inicio` with the nav: Home, Inbox, Sessions, Devices, Rooms, Store, Settings. On a bad token: "No pudimos abrir tu sesión. Vuelve a entrar desde Chalyb." with "Volver a Chalyb".
  - Automated: `apps/web/e2e/sso.spec.ts`; `apps/web/test/sso*.test.ts`; `apps/api/test/hub-contract.test.ts`; rehearsal §1 "the hub provisions the tenant and its SSO launch signs the person into the web, then the phone enrols".
- [ ] **W-2 Welcome** · READY
  - Steps: with a new account, open `/en/welcome`. Go through the steps with "Continue", "Back" and "Skip".
  - Expected: "Step {n} of 7". The last step is the passkey ("Protect your approvals"), then "All set!".
  - Automated: `apps/web/e2e/onboarding.spec.ts`; `apps/web/test/onboarding.test.tsx`; `apps/web/e2e/live/settings.spec.ts` "onboarding on the server…".
- [ ] **W-3 Create a passkey on the phone** · READY
  - Steps: on the phone, open `/en/devices` and tap "Create passkey".
  - Expected: the system prompt (fingerprint or face) appears, then "This device has a passkey." If you cancel: "You cancelled the passkey; you can try again."
  - Automated: `apps/api/test/webauthn.test.ts`; pgTAP `09_webauthn_binding`; rehearsal §1 "the phone enrols a passkey; a step-up assertion is then available for it".
- [ ] **W-4 Change the passkey** · READY
  - Steps: on `/en/devices`, tap "Change passkey". The first time, cancel the check with the current passkey; the second time, confirm it.
  - Expected: without the current passkey, nothing changes. With it, the new passkey replaces the old one.
  - Automated: `apps/web/e2e/live/devices.spec.ts` "R-M11: changing the passkey asks for the current one…"; `apps/api/test/webauthn.test.ts` (R-M11, cloned passkey).
- [ ] **W-5 Install as an app (PWA)** · READY
  - Steps: on the phone, use "Add to Home Screen" / "Install app".
  - Expected: the "Chalito" icon opens `/inicio` in its own window, with no browser bar.
  - Automated: `apps/web/e2e/pwa.spec.ts` "the manifest makes the app installable", "the page links the manifest and registers the service worker".
- [ ] **W-6 Add a second browser** · READY
  - Steps: in a new browser, sign in and open `/en/link`. Enter a name and tap "Show code". On the phone, go to `/en/devices/new` ("Add a device"), type the code or use "Scan ring". Compare the fingerprint and tap "Approve".
  - Expected:
    - On the phone, it asks for your passkey, then the new browser is trusted.
    - In the new browser: "Go to the inbox".
    - "Not mine" signs nothing.
    - If the code expires, the browser asks you to show a new one.
  - Automated: `apps/web/e2e/live/endorse.spec.ts` (7 tests, incl. "EN paths: /en/devices/new…"); `apps/web/test/endorse.test.ts`; `apps/api/test/endorse.test.ts` (R-L13); rehearsal §3; pgTAP `12_endorse_codes`, `16_endorsement_broadcast`.
- [ ] **W-7 Alert link `/n/<id>`** · PARTIAL (the operator or an approval creates the alert)
  - Steps: open an alert's link, first signed in and then signed out.
  - Expected:
    - Signed in: "Opening…", then its screen.
    - Signed out: through the hub and back.
    - Someone else's id: "That alert no longer exists or isn't yours."
  - Automated: `apps/web/e2e/live/notification.spec.ts`; `apps/web/e2e/sso.spec.ts` "/n/<nid> signed out → hub sign-in…"; `apps/web/test/notification-link.test.ts`.
- [ ] **W-8 Language** · READY
  - Steps: switch every screen between the ES route and its `/en/...` one.
  - Expected: everything is in the chosen language, with no raw keys.
  - Automated: `apps/web/e2e/i18n.spec.ts`; `apps/web/test/routing.test.ts`.
- [ ] **W-9 Download** · READY
  - Steps: open `/en/download` on a computer, then on the phone.
  - Expected:
    - On the computer: the detected OS and its file, with the unsigned-build and SmartScreen notes.
    - On the phone: it tells you to use the web app.
    - With nothing published: downloads aren't available yet.
  - Automated: `apps/web/e2e/download.spec.ts`.

#### 2. Desktop: pet, panel and room
Install the build the operator gives you. **Don't use one marked "UNWIRED"**: it can't sign in.
- [ ] **D-1 Install and open** · READY
  - Steps: install and open Chalito.
  - Expected: the pet and panel windows open. If Settings shows "Sign-in isn't configured in this build.", the build is UNWIRED: report it.
  - Automated: `apps/desktop/test/release-workflow.test.ts` "a release refuses to build unwired"; `panel.test.tsx` "not configured in this build". The real Tauri windows have no automated test.
- [ ] **D-2 Sign in on the panel** · READY
  - Steps:
    1. Tap "Sign in" and finish in the browser.
    2. On the phone, approve this computer (`/en/devices/new`, with the code the panel shows).
  - Expected:
    - "Finish signing in in your browser. You'll come back here automatically."
    - Then "Open Chalito on a trusted device (your phone) and approve this computer."
    - Once approved: "Done: this computer is now trusted."
    - With no passkey on the computer: "This computer has no passkey: HIGH or CRITICAL actions are approved from your phone."
  - Automated: `apps/desktop/test/sign-in.test.ts`; `sso.test.ts`; `endorse-flow.e2e.test.ts`; `apps/web/e2e/desktop.spec.ts`.
- [ ] **D-3 Panel tabs** · READY
  - Steps: go through Inbox, Rooms, Settings, Security and Voice. Turn on "Do not disturb".
  - Expected:
    - All five tabs load.
    - Without an account: "Not connected to your account. Pair this computer with “chalito pair”."
    - If the local agent isn't running, Security says it isn't answering.
  - Automated: `apps/desktop/test/panel.test.tsx` "offline until the client connects", "says the agent isn't reachable…", "es and en have the same keys…".
- [ ] **D-4 The pet reacts** · PARTIAL (needs something pending, see P-1)
  - Steps: with an approval or alert pending, watch the pet.
  - Expected: its expression follows the highest pending level, and it calms down in quiet hours. **No cosmetics on it** (G-10).
  - Automated: `apps/desktop/test/pet-look.test.ts`; `pet-context.test.ts` "the pet signals the highest pending level only"; `hitbox.test.ts`.
- [ ] **D-5 Approve on the panel** · PARTIAL (G-4: the operator starts the session)
  - Steps: in Inbox → Approvals, approve a low or medium one with "Approve". Deny another with "Deny". Then open a HIGH one.
  - Expected:
    - Low and medium go through.
    - HIGH on a computer without a passkey: "Approve this action from your phone", with only "Deny".
    - HIGH on a computer with a passkey (Windows or macOS): it can be approved here (G-9). Note which one you saw.
    - With a cut summary: "Approve" stays disabled until "Show the full command".
    - If the computer didn't sign the request: "Unverified…", and it can only be denied.
  - Automated: `apps/desktop/test/panel.test.tsx` ("lists pending approvals…", "without a passkey: HIGH says approve from the phone…", "with a passkey: HIGH can be approved here", "a truncated summary…", "an unverified approval…"); `enrollment.test.ts`.
- [ ] **D-6 Voice** · READY
  - Steps: in Voice, hold "Hold to talk", speak, then release.
  - Expected:
    - "Connecting…", then "Listening…" and a spoken answer. Releasing closes the mic.
    - At the monthly cap: "You've used up this month's voice minutes."
  - Automated: `apps/desktop/test/voice.test.ts`; `webrtc-voice.test.ts`; rehearsal b "a desktop voice session is refused at the monthly cap…".
- [ ] **D-7 Updates** · READY
  - Steps: Settings → "Check for updates".
  - Expected: "You have the latest version.", or "A new version is available: {version}." → "Download and install" → "Restart now". On a build without the updater: "This build doesn't update itself."
  - Automated: `apps/desktop/test/updates.test.tsx` (incl. "a bad signature … installs nothing").
- [ ] **D-8 Room window and portal scene**: see R-3.

#### 3. Agent CLI with Claude Code and Codex
How to get `chalito` in round 1: the operator gives you the binary's path (G-6). Commands that change anything **only run in a terminal you're typing in**: no piped input, and not from inside a Chalito session.
- [ ] **A-1 Save the Anthropic key** · PARTIAL (G-6)
  - Steps: run `chalito keys set anthropic` and paste the key.
  - Expected:
    - The prompt "anthropic API key (input hidden): " doesn't echo what you type. Once saved: "anthropic key saved in the OS keychain. It never leaves this computer."
    - With an empty key: "Not saved: the key is empty." With one that doesn't start with `sk-ant-`: a warning, but it's saved anyway.
  - Automated: `apps/agent/test/cli.test.ts` "saves the key in the keychain, never prints it", "warns on an unexpected shape…".
- [ ] **A-2 Pair the computer** · PARTIAL (G-6)
  - Steps:
    1. Run `chalito pair`.
    2. On the phone, go to `/en/devices/new` and scan the glyph or type the code.
    3. Compare the fingerprints and answer `y`.
  - Expected:
    - First you see "On your phone, open Chalito → Add computer and scan the glyph or type: <CODE>" and this computer's fingerprint. The code expires in 5 minutes.
    - After `y`: "Done: this computer trusts your phone. Install the service with `chalito service install`."
    - After `n`: "Nothing was added…".
    - If the code expires: "The code expired. Run `chalito pair` again."
    - If the phone has no passkey: a warning that it can't approve HIGH.
  - Automated: `apps/agent/test/pair.test.ts` (6 tests); rehearsal §2 "the agent's signed glyph is claimed by the phone…", "a glyph can't be published twice…".
- [ ] **A-3 Pin Claude Code** · PARTIAL (G-6)
  - Steps: run `chalito claude pin`, then `chalito status`.
  - Expected:
    - "Claude Code pinned: <path>" with its sha256. `status` shows "(pinned, sha256 …)".
    - Unpaired: "Pair this computer first (`chalito pair`), then run `chalito claude pin`."
    - No `claude`: "`claude` wasn't found. Install it…".
  - Automated: `apps/agent/test/cli.test.ts` "pins path (symlinks resolved) + sha256…", "needs a paired computer", "status: unpaired computer…".
- [ ] **A-4 Start the agent** · PARTIAL (G-6)
  - Steps: run `chalito run` (or `chalito service install`).
  - Expected:
    - The log shows `agent.ready`, and when a session starts, `adapter.init` with `apiKeySource: "ANTHROPIC_API_KEY"`.
    - If Claude Code updated itself: "Claude Code updated itself: run `chalito claude pin` again…".
    - With no key: `adapter.claude_code_unavailable` is logged, but the agent keeps running.
  - Automated: `apps/agent/test/daemon.test.ts` ("runs exactly the pinned Claude Code…", "a pinned binary that changed…", "a missing Anthropic key is logged…"); `packages/adapters/test/claude-code.test.ts`.
- [ ] **A-5 A Claude Code session asks for approvals** · PARTIAL (G-4: the operator starts the session; script in `scripts/e2e-claude.md` §5)
  - Steps: in the session, ask for a read, an edit in the folder, a `git push` and a `sudo`.
  - Expected:
    - Read (LOW): goes through by itself.
    - Edit (MED): waits for one tap.
    - `git push` (HIGH): waits for a passkey approval on the phone.
    - `sudo` (CRITICAL): blocked.
    - Anything under `~/.chalito` is always blocked.
    - Claude sees "Approved by Chalito" or "Chalito: <reason>".
    - Typing `claude` in a terminal yourself does **not** go through Chalito; that's expected.
  - Automated: `apps/agent/test/policy.test.ts` (LOW/MED/HIGH/CRITICAL, hard floor); `apps/agent/test/agent.test.ts` ("a MED edit waits for the phone…", "HIGH needs step-up…", "an unanswered approval is denied when it expires (10 min)"); `packages/adapters/test/claude-code.test.ts` "routes every tool call through the gate…".
- [ ] **A-6 Watch the session on the web** · PARTIAL (G-4)
  - Steps: open `/en/sessions`, then the session. Try "Interrupt", "Resume", "Send" and the modes "Ask", "Plan only" and "Accept edits".
  - Expected: the state ("Working", waiting for approval) updates live, and prompts reach the session.
  - Automated: `apps/web/e2e/live/sessions.spec.ts`; `apps/agent/test/agent.test.ts` "bypassPermissions, dontAsk and auto are rejected…".
- [ ] **A-7 Codex with an API key** · BLOCKED (G-5)
  - Automated, adapter level only: `packages/adapters/test/codex.test.ts` "API key: an env-key provider…".
- [ ] **A-8 Codex with a ChatGPT plan** · out of scope (owner only)
  - Automated: `packages/adapters/test/codex.test.ts` "ChatGPT plan stays off unless the flag is on…".

#### 4. Approvals on the phone (incl. HIGH with a passkey)
They all need a session that asks for approval (A-5), so they're PARTIAL because of G-4.
- [ ] **P-1 Inbox** · PARTIAL
  - Steps: open `/en/inbox`.
  - Expected: "To approve ({n})", with the risk badge (Low, Medium, High, Critical) and the "Expires in" countdown. With nothing pending: "Nothing pending."
  - Automated: `apps/web/e2e/live/inbox.spec.ts`.
- [ ] **P-2 Approve low or medium** · PARTIAL
  - Steps: tap "Approve".
  - Expected: no passkey prompt, then "Approval sent." and the session continues.
  - Automated: `inbox.spec.ts` "approve from the phone releases the session…"; `apps/agent/test/agent.test.ts` "a MED edit waits for the phone; a signed allow releases it".
- [ ] **P-3 Approve HIGH with a passkey** · PARTIAL
  - Steps: on a High-risk approval, tap "Approve" and confirm with fingerprint or face. Repeat on another one and cancel the prompt.
  - Expected:
    - You see the note "Approving asks for your fingerprint, face or security key.", then the system prompt.
    - When you confirm, the action runs on the computer.
    - When you cancel: "Cancelled: nothing was sent." and the action doesn't run.
    - With no passkey on the phone: "To approve high-risk actions, protect this device with your passkey." with "Create passkey", and "Approve" disabled.
  - Automated: rehearsal §4 "the approval escalates push → WhatsApp; the phone checks detailsHash and allows with its passkey; a forged allow doesn't run the tool"; `inbox.spec.ts` "…HIGH needs step-up and cancelling sends nothing"; `packages/client/test/actions.test.ts` "HIGH/CRITICAL (or step_up_required) asks for step-up first…"; `apps/agent/test/agent.test.ts` "HIGH step-up must be a passkey assertion this agent can verify (D-019)".
- [ ] **P-4 Deny** · PARTIAL
  - Steps: tap "Deny" on a High-risk one.
  - Expected: no passkey prompt, then "Denial sent." and the tool doesn't run.
  - Automated: `packages/client/test/actions.test.ts` "denying needs no step-up"; `apps/agent/test/agent.test.ts` "a signed deny refuses the tool".
- [ ] **P-5 Expiry** · PARTIAL
  - Steps: leave an approval unanswered for 10 minutes.
  - Expected: "Expired: denied", and the tool doesn't run.
  - Automated: `inbox.spec.ts` "the countdown runs…", "expired approvals say 'Expired: denied' in English too"; `apps/agent/test/agent.test.ts` "an unanswered approval is denied when it expires (10 min)".
- [ ] **P-6 Cut summary and hidden characters** · PARTIAL
  - Steps: ask for a very long command.
  - Expected: "…(truncated)" and "The summary is cut: open the full content before approving." "Approve" stays blocked until "See exactly what will run" is opened.
  - Automated: `inbox.spec.ts` "R-M10…"; `apps/web/test/approval-text.test.ts`.
- [ ] **P-7 Deep link `/a/<id>`** · PARTIAL
  - Steps: open `/en/a/<id>` for an approval, then a made-up id.
  - Expected: the real id shows that approval. The made-up one: "We couldn't find that approval."
  - Automated: `inbox.spec.ts` "the /a/<id> deep link shows that approval".
- [ ] **P-8 Already resolved elsewhere** · PARTIAL
  - Steps: approve on the desktop, then try on the phone.
  - Expected: "Already resolved."
  - Automated: `apps/agent/test/agent.test.ts` "replayed, untrusted, wrong-request and unsigned decisions are rejected…"; pgTAP `33_decision_attempts`.

#### 5. Alerts (push only in round 1)
- [ ] **N-1 Turn on push** · BLOCKED (G-1)
  - Automated, server side only: `apps/notifier/test/notifier.test.ts` "a 410 from the push service deletes the subscription"; pgTAP `07_settings_notifier` "push: up to 5 per device", `34_push_subs_revoked`.
- [ ] **N-2 A push arrives for an approval** · BLOCKED (G-1)
  - Expected, once it exists: it arrives within seconds, and tapping it opens `/n/<id>` → `/a/<id>`.
  - Automated: rehearsal §4; `apps/notifier/test/notify-outbox.test.ts` "a signed poke delivers that row… (push in seconds)"; pgTAP `19_notify_outbox`.
- [ ] **N-3 Nothing paid goes out** · READY
  - Steps: in Settings → "Contact and alerts", leave "WhatsApp alerts" and "Calls" off. Let an approval expire unanswered.
  - Expected: no WhatsApp, SMS or call. The alert still shows in the Inbox's "Alerts". The operator confirms `notification_sends` has push only.
  - Automated: rehearsal a "paid comms are suppressed with the reason (push, which is free, still goes)", d "phone channels are held…"; `apps/notifier/test/caps.test.ts`; `apps/notifier/test/billing.test.ts`; pgTAP `07_settings_notifier` "clients never turn opt-ins on…".
- [ ] **N-4 Alerts in the inbox** · PARTIAL
  - Steps: in `/en/inbox` → "Alerts", tap "Got it".
  - Expected: the "# pending" count drops.
  - Automated: `apps/web/e2e/live/inbox.spec.ts`.

#### 6. Mesa
- [ ] **M-1 Create and use a Mesa** · BLOCKED (G-7; `/m/<id>` says "This screen is coming soon.")
  - Automated: rehearsal §6 "the turn is admitted, answered, and its llm.tokens event committed with it; the drain delivers it"; `apps/orchestrator/test/turn.test.ts` (brain limit per plan, budget cap, `budget_reached`, retry 409); `core.test.ts`; `part2.test.ts`; `decisions.test.ts`; pgTAP `11_mesa`, `13_mesa_decisions_byo`.
- [ ] **M-2 Mesa from a connector** (`post_to_mesa`): see C-3.

#### 7. Rooms and the portal scene
Creating a room and inviting have no UI (G-8): the operator creates the room and gives you an invite code.
- [ ] **R-1 Join with a code** · PARTIAL
  - Steps: on `/en/rooms` → "Join with a code", enter the "Invite code" and tap "Join". Also from the desktop panel → Rooms → "Join". Try a bad code too.
  - Expected:
    - The room shows in the list. While the key arrives: "Waiting for the room key…". On desktop: "Done. A member will give you access to the messages shortly."
    - With a bad code: "That code isn't valid or was already used."
  - Automated: `apps/web/e2e/live/rooms.spec.ts` "join with a code (and a bad code says so); EN path /en/rooms"; `apps/desktop/test/salas.test.tsx`; `apps/api/test/rooms.pg.test.ts` "dad creates a room, invites, son joins…"; rehearsal §7.
- [ ] **R-2 Post and read** · PARTIAL
  - Steps: on `/en/r/<id>`, type in "Write a notice for the room" and tap "Send". Read it from another member.
  - Expected: the other member sees it as text in under 2 s, with the "New" marker and the unread dot on the panel.
  - Automated: rehearsal §7 "the members' RoomControllers see a post as plain text…"; `rooms.pg.test.ts` "…in under 2 s"; `rooms.spec.ts`.
- [ ] **R-3 Portal scene** · PARTIAL
  - Steps: open the room on the desktop ("Open") and on the web. Have another member enter and leave. Change the quality (bajo, medio, alto).
  - Expected:
    - On enter, the portal opens and the companion steps out of it. On leave, the reverse.
    - Equipped cosmetics show, including `portal_swirl` if someone owns it.
    - Quality "bajo" has no contact shadow.
  - Automated: `packages/scene/test/choreography.test.ts`; `room-scene.test.ts`; `apps/desktop/test/room-stage.test.tsx`; `packages/roster/test/cosmetics.test.ts`. Real rendering has no automated test.
- [ ] **R-4 Report** · PARTIAL
  - Steps: on a message, tap "Report", pick a reason and tap "Send report". Repeat on the same message.
  - Expected: "Report sent. Thank you.", and the second time "You'd already reported this." The text is attached only if you tick the box.
  - Automated: `rooms.spec.ts` "report: …"; `apps/api/test/rooms-reports.test.ts`; pgTAP `31_room_kicks_reports`.
- [ ] **R-5 Leave** · PARTIAL
  - Steps: tap "Leave the room" → "Yes, leave".
  - Expected: "You left this room." Posts after that can't be read with your key.
  - Automated: rehearsal §7 "leave → kicked…"; `rooms.pg.test.ts` "son leaves; dad's client rotates…"; `packages/rooms/test/rooms.test.ts`.
- [ ] **R-6 Dissolved or kicked** · PARTIAL (the operator dissolves the room)
  - Expected: "This room no longer exists." or "You're no longer a member of this room.", and the feed stops.
  - Automated: `rooms.spec.ts` "kicked, dissolved, left…"; rehearsal §7; pgTAP `08_rooms`.
- [ ] **R-7 A phone revoked in a room** · PARTIAL
  - Steps: remove your phone (V-1), then open the room on it.
  - Expected: "This device was removed from your account." The others can't post until the key rotates.
  - Automated: rehearsal g "the next post is refused until a rotation…"; `apps/desktop/test/room-window.test.tsx`; `rooms.spec.ts` "revoked device…".

#### 8. Store
- [ ] **S-1 Browse the store** · READY
  - Steps: open `/tienda` (or `/en/tienda`).
  - Expected: the intro says cosmetics only change looks. The slots: Head, Face, Body, Back, Aura, Portal. Prices are in tokens, or "Free".
  - Automated: `apps/web/test/store.test.ts`; `apps/web/e2e/live/store.spec.ts`.
- [ ] **S-2 Wear and take off a free item** · READY
  - Steps: tap "Wear", then "Take off".
  - Expected: the state changes, and it shows in the room scene (not on the pet, G-10).
  - Automated: `store.spec.ts`; pgTAP `18_directory_cosmetics`.
- [ ] **S-3 Buy a paid item** · READY (spends hub tokens)
  - Steps: tap "Buy". If the network drops, retry.
  - Expected: the balance drops **once**, by exactly the price, and it shows "Yours". On failure: "…Retrying never charges twice."
  - Automated: `store.spec.ts` "buying spends tokens once, a retry reuses the purchase id…", "a network drop mid-purchase is retried with the same id and charged once"; `apps/api/test/store.test.ts`; `store.pg.test.ts`.
- [ ] **S-4 Out of tokens** · PARTIAL (an account with zero balance)
  - Expected: "You don't have enough tokens." with the "Why?" chip.
  - Automated: `store.spec.ts`; `apps/api/test/pay-to-win.test.ts` (cosmetics give no advantage).

#### 9. MCP connectors in Claude and ChatGPT
- [ ] **C-1 Connect Claude** · READY
  - Steps:
    1. On claude.ai, go to Settings → Connectors → Add custom connector. Name `Chalito`, URL `https://mcp.chalito.chalyb.com/mcp`, with no client ID or secret. Tap Connect.
    2. On "{client} wants to connect to Chalito", review "Permissions requested" and tap "Allow".
  - Expected:
    - "Allowing it asks for your passkey.", then the system prompt.
    - "Send prompts to your agent sessions…" (`session:prompt`) is never pre-checked.
    - On an unpaired device it asks you to open the page on a paired device.
  - Automated: rehearsal §5 "CIMD + PKCE + passkey consent → a token…"; `apps/web/e2e/live/mcp.spec.ts` "consent: …session:prompt is never pre-checked; allow needs the passkey"; `apps/api/test/oauth.test.ts`; `oauth-hardening.test.ts`.
- [ ] **C-2 Connect ChatGPT** · READY
  - Steps: in ChatGPT, go to Settings → Apps & Connectors → Advanced settings → Developer mode. Create one with Name `Chalito`, the same URL and OAuth authentication. Then enable it from the tool menu.
  - Expected: the same consent page as C-1. ChatGPT asks before each write tool. "Don't allow" gives no access.
  - Automated: `mcp.spec.ts` "'No permitir' sends access_denied"; `apps/api/test/oauth-hardening.test.ts` (CIMD origin).
- [ ] **C-3 Use the tools** · PARTIAL (`prompt_session` needs a session, G-4)
  - Steps: in the chat, ask for `list_pending` and `get_session_card`. With the permission, use `prompt_session` to have the session `git push`.
  - Expected:
    - The reads answer.
    - The HIGH action waits for your passkey approval on the phone (P-3), even with Developer mode `autoApproveHigh`.
    - No tool can decide, change policy, devices, rooms or billing.
  - Automated: rehearsal §5; `apps/mcp-gateway/test/prompt-e2e.test.ts`; `gateway.test.ts` "no tool can decide, change policy…"; pgTAP `10_mcp_gateway`, `17_review_beta_mcp`.
- [ ] **C-4 Disconnect** · READY
  - Steps: on `/en/connections` ("Connected apps"), tap "Disconnect" → "Yes, disconnect". Then use the connector again.
  - Expected: the next call fails right away.
  - Automated: rehearsal e "the very next MCP call fails"; `mcp.spec.ts` "Apps conectadas: list and revoke…"; `gateway.test.ts` "a revoked grant fails on the very next call".
- [ ] **C-5 Share the card** · READY
  - Steps: turn on "Share card with connected apps", tick "I understand it's stored unencrypted." and tap "Share". Then turn it off.
  - Expected: `get_session_card` sees the card only while sharing is on.
  - Automated: `mcp.spec.ts` (card sharing, incl. "per computer on /dispositivos"); `gateway.test.ts`.

#### 10. Billing and credits
- [ ] **B-1 Plan** · READY
  - Steps: in Settings → "Plan and credits", tap "Manage on Chalyb".
  - Expected: "Tier: {tier}" matches your hub tier (Gratis, Pro or VIP). "Manage on Chalyb" opens the hub, which is where you recharge.
  - Automated: `apps/web/test/settings-store.test.ts`; `apps/web/test/landing-plans.test.ts`; `packages/billing/test/entitlements.test.ts`.
- [ ] **B-2 Usage** · READY
  - Steps: open `/en/usage` ("See your usage"). Change the period and tap "See by day".
  - Expected: tokens only, never money, under "Work", "Communication" and "Your keys". After using voice or a Mesa, the number goes up.
  - Automated: `apps/web/e2e/live/usage.spec.ts`; `apps/web/test/usage.test.ts`; rehearsal §6.
- [ ] **B-3 Out of credit** · PARTIAL (an account with zero balance)
  - Steps: talk to the companion or use voice with no tokens.
  - Expected: the companion answers in minimal mode, with the recharge line and the "Why?" chip, and nothing is billed. Voice is refused at the cap.
  - Automated: rehearsal b "the companion's recharge line and chip, on free_min; nothing billed"; rehearsal a "a companion turn finishes on free_min…"; `packages/billing/test/energy-billable.test.ts`; `apps/orchestrator/test/turn.test.ts`.
- [ ] **B-4 `/creditos`** · BLOCKED (G-3: placeholder screen)

#### 11. Revoke one device and revoke all
- [ ] **V-1 Remove one device** · READY
  - Steps: on `/en/devices`, tap "Remove" on a browser → "Yes, remove".
  - Expected:
    - It's removed and can't sign in or send anything to your computers. For each computer: if it's online, it dropped the device from its list; if it's asleep, the server ban already holds.
    - On the removed device: "This device was removed from your account. Pair it again from a trusted device." with "Pair again".
  - Automated: `apps/web/e2e/live/devices.spec.ts` "devices: presence, and revoking another client goes to the agent", "revoking while a computer is asleep…"; `device-session.spec.ts`; `apps/api/test/device-revoke.test.ts`; pgTAP `34_push_subs_revoked`, `35_revoke_sweep`.
- [ ] **V-2 Remove mid-approval** · PARTIAL (G-4)
  - Steps: with an approval pending, remove one of two phones.
  - Expected: its decisions are refused, and alerts go on to the other phone only.
  - Automated: rehearsal c "its later decisions are refused, and the ladder goes on to the remaining device only"; `apps/agent/test/agent.test.ts` "a revoked phone's decision is rejected…".
- [ ] **V-3 Sign out everywhere else** · READY
  - Steps: on `/en/devices` → "Sign out of every other device", tap "Sign out everywhere else" → "Yes, sign out" and confirm with your passkey. Repeat, cancelling the passkey.
  - Expected:
    - "Signed out # device(s)." Computers **stay paired**.
    - When cancelled, nothing changes.
    - With no passkey on this device, it asks you to create one first.
  - Automated: rehearsal §8 "the phone, with a fresh step-up, revokes every other client…"; `devices.spec.ts` "sign out everywhere else…"; `apps/api/test/revoke-all.test.ts`; `revoke-all.pg.test.ts`; `packages/client/test/actions.test.ts` "revokeAll…".
- [ ] **V-4 Remove the computer** · PARTIAL (G-6)
  - Steps: remove the computer from `/en/devices`.
  - Expected: the agent stops with a clear message. Its pending approvals are denied (`agent_revoked`), and what it shared stops being shared.
  - Automated: rehearsal f "its approval is denied (agent_revoked)…"; `apps/agent/test/daemon.test.ts` "a revoked device found on a refresh tick stops the daemon…".

#### 12. Account deletion
- [ ] **X-1 Request deletion** · BLOCKED (G-2)
  - API behaviour, for when there is a UI:
    - It asks for a passkey.
    - It writes the export first.
    - It schedules deletion 7 days out.
    - It sends a critical alert to every device.
    - It can't be scheduled twice.
  - Automated: `apps/api/test/account.test.ts`; `account.pg.test.ts`.
- [ ] **X-2 Cancel during the grace period** · BLOCKED (G-2)
  - Automated: `account.test.ts` "the owner can cancel during the grace period, and nothing is deleted".
- [ ] **X-3 Deletion when due** · BLOCKED (G-2; run hourly by `/tasks/account-deletions`)
  - Expected: device users, your files and your Chalito data are deleted. Your hub account and balance are **not** touched.
  - Automated: `account.test.ts` "when due: …"; pgTAP `34_push_subs_revoked` "deleting the account drops every subscription".
