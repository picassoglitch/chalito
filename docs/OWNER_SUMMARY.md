# Chalito: resumen para el dueño / Owner summary

[Español](#español) · [English](#english)

---

## Español

**En una frase:** Chalito está construido y probado. Para abrir la beta privada faltan cosas que solo tú puedes hacer: decidir precios, abrir cuentas, aprobar gastos y encender el motor en el hub. El orden exacto, paso a paso, está en [`GO_LIVE.md`](GO_LIVE.md).

### Lo que ya está hecho
- **El compañero completo:**
  - el agente de computadora que dirige a Claude Code y Codex, con aprobaciones firmadas desde tu teléfono;
  - la app web/PWA;
  - la app de escritorio con el compañero animado;
  - las Mesas;
  - las salas con otros compañeros, en web y escritorio, con la escena del portal (cada compañero con su avatar y sus cosméticos) y un control de calidad gráfica para la sala y la mascota;
  - el conector MCP para ChatGPT y Claude.
- **Avisos que suben de nivel:** push, WhatsApp, llamada y SMS, con límites y horas de silencio. La base de datos avisa sola al motor de avisos cuando hay una aprobación, una pregunta de un agente o un mensaje en una sala.
- **Cobro a través del hub de Chalyb:** cada gasto se admite antes, se reporta y se liquida. La tienda de cosméticos es solo de apariencia, nunca da ventajas.
- **Seis personajes y seis cosméticos,** generados con AI Studio y con su origen registrado.
- **Seguridad:**
  - una revisión completa, con los hallazgos corregidos;
  - límites de uso en todas las rutas;
  - historial de auditoría que cada dueño puede ver;
  - borrado de cuenta con exportación previa y 7 días para arrepentirse;
  - "revocar todos los dispositivos".
- **Página de inicio Solo** con renders reales.
- **Documentación:**
  - [runbook](RUNBOOK.md) para operar;
  - [lista legal](LEGAL_CHECKLIST.md) para tu abogado;
  - [tareas del dueño](OPS.md);
  - [prueba de carga](LOAD_TEST.md);
  - README para levantar todo desde cero.

### Dónde vamos (15 de octubre de 2026)
- **Listo:** el PR del hub, la base de datos en nexo-ai, la nube (Terraform) y el despliegue de los cuatro servicios. El motor ya está activo en el hub.
- **A medias:** faltan las llaves reales de OpenAI, Twilio, Meta y xAI; los trabajos programados se están agregando; tu computadora ya está emparejada (8 de octubre), pero falta probar una aprobación de ida y vuelta.
- **Decidido:** Chalito vive dentro del hub, en `www.chalyb.com/app/chalito`. Las migraciones de Chalito se copian al repositorio del hub, y el hub lleva el registro de la base de datos de aquí en adelante (15 de octubre).
- El detalle, paso por paso, está en la columna "Status" de [`GO_LIVE.md`](GO_LIVE.md).

### Lo que necesita de ti (en este orden)
1. **Decidir** ([Fase 0](GO_LIVE.md#phase-0-decisions-owner-no-cost)):
   - los precios de los 3 cosméticos de pago;
   - los montos en MXN de los planes Solo;
   - el número de Twilio (EE. UU. o MX);
   - quién es el responsable de los datos, y si se permiten usuarios de la UE.
2. **El PR en Chalyb** ([Fase 1](GO_LIVE.md#phase-1-the-chalyb-hub-pr-hub-owners-go-visible)): registrar el motor, y que las rutas de consumo (`admit` y `settle`) lleguen a `main` del hub. **Sin esto, la IA administrada no se enciende.**
3. **Base de datos en nexo-ai** ([Fase 2](GO_LIVE.md#phase-2-supabase-on-nexo-ai-owner--hub-sign-off-visible)): tu visto bueno, luego una prueba en una rama de Supabase, y después aplicar. Ahí también se activa `pg_net` y se guardan dos secretos en Vault, para que las aprobaciones avisen a tu teléfono en segundos.
4. **Nube** ([Fases 3–4](GO_LIVE.md#phase-3-gcp-with-terraform-ops-owners-go-cost)): aprobar `terraform apply` y los despliegues. 💲
5. **Cuentas** ([Fase 5](GO_LIVE.md#phase-5-provider-accounts-owner-cost-visible)): OpenAI, Anthropic, Twilio y Meta/WhatsApp (verificación y aprobación de plantilla). 💲
6. ~~**Web en Vercel**~~: ya no hace falta ([Fase 6](GO_LIVE.md#phase-6-web-on-vercel-not-applicable)). Desde el 5 de octubre de 2026, Chalito vive dentro del hub, en `www.chalyb.com/app/chalito`: no tiene dominio propio ni proyecto aparte en Vercel. El hub está en el plan gratuito (Hobby) de Vercel, que es para uso no comercial; seguir ahí fue tu decisión, y conviene revisarla antes de cobrar.
7. **Encender** ([Fase 8](GO_LIVE.md#phase-8-turn-it-on-for-the-beta-owner-visible)):
   - activar el motor en el hub;
   - tu primera prueba;
   - **una llamada real y un WhatsApp real**;
   - una compra en la tienda;
   - invitar a los testers. 💲
8. **Apps de escritorio firmadas** ([Fase 9](GO_LIVE.md#phase-9-desktop-apps-owner-after-82-cost-visible)): la llave de actualizaciones (respáldala), Apple, Azure, y dos variables del repositorio para que la app se conecte a tu cuenta (`SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`). 💲

💲 = cuesta dinero o es visible para terceros. Nada de eso se ha hecho sin tu permiso.

Las limitaciones que verán los testers están en [`BETA_NOTES.md`](BETA_NOTES.md).

### Antes de abrir más allá de la beta
- Aviso de privacidad y términos publicados, revisados por tu abogado.
- La prueba de carga con 1,000 dispositivos (cuesta dinero).
- La aprobación de OpenAI para "Sign in with ChatGPT".

---

## English

**In one sentence:** Chalito is built and tested. Opening the private beta needs things only you can do: decide prices, open accounts, approve spending, and switch the engine on at the hub. The exact order, step by step, is in [`GO_LIVE.md`](GO_LIVE.md).

### Done
- **The whole companion:**
  - the computer agent that drives Claude Code and Codex, with approvals signed on your phone;
  - the web/PWA app;
  - the desktop app with the animated companion;
  - Mesas;
  - rooms with other companions, on web and desktop, with the portal scene (each companion with its avatar and cosmetics) and a graphics-quality control for the room and the pet;
  - the MCP connector for ChatGPT and Claude.
- **Escalating alerts:** push, WhatsApp, call and SMS, with caps and quiet hours. The database itself tells the alert engine when there's an approval, an agent's question or a room message.
- **Billing through the Chalyb hub:** every spend is admitted first, reported and settled. The cosmetics store is looks only, never an advantage.
- **Six characters and six cosmetics,** generated with AI Studio, provenance logged.
- **Security:**
  - a full review, with the findings fixed;
  - rate limits on every route;
  - an audit history each owner can read;
  - account deletion with an export first and 7 days to cancel;
  - "revoke every other device".
- **The Solo landing page** with real renders.
- **Docs:**
  - the [runbook](RUNBOOK.md) for operations;
  - the [legal checklist](LEGAL_CHECKLIST.md) for your lawyer;
  - [owner tasks](OPS.md);
  - the [load test](LOAD_TEST.md);
  - a README to set everything up from zero.

### Where things stand (15 October 2026)
- **Done:** the hub PR, the database on nexo-ai, the cloud setup (Terraform) and the deploy of all four services. The engine is active on the hub.
- **Partly done:** the real OpenAI, Twilio, Meta and xAI keys are still missing; the scheduled jobs are being added; your computer is paired (8 October), but an approval round trip hasn't been tested yet.
- **Decided:** Chalito lives inside the hub at `www.chalyb.com/app/chalito`. Chalito's migrations are copied into the hub's repo, and the hub keeps the database's record of them from now on (15 October).
- The step-by-step detail is in the "Status" column of [`GO_LIVE.md`](GO_LIVE.md).

### What needs you (in this order)
1. **Decide** ([Phase 0](GO_LIVE.md#phase-0-decisions-owner-no-cost)):
   - the 3 paid cosmetic prices;
   - the Solo MXN amounts;
   - the Twilio number (US or MX);
   - who the data controller is, and whether EU users are allowed.
2. **The Chalyb PR** ([Phase 1](GO_LIVE.md#phase-1-the-chalyb-hub-pr-hub-owners-go-visible)): register the engine, and get the consumption routes (`admit` and `settle`) onto the hub's `main`. **Without this, managed AI stays off.**
3. **Database on nexo-ai** ([Phase 2](GO_LIVE.md#phase-2-supabase-on-nexo-ai-owner--hub-sign-off-visible)): your sign-off, then a dry run on a Supabase branch, then apply. That's also where `pg_net` is turned on and two Vault secrets are stored, so approvals reach your phone in seconds.
4. **Cloud** ([Phases 3–4](GO_LIVE.md#phase-3-gcp-with-terraform-ops-owners-go-cost)): approve `terraform apply` and the deploys. 💲
5. **Accounts** ([Phase 5](GO_LIVE.md#phase-5-provider-accounts-owner-cost-visible)): OpenAI, Anthropic, Twilio and Meta/WhatsApp (verification and template approval). 💲
6. ~~**Web on Vercel**~~: no longer needed ([Phase 6](GO_LIVE.md#phase-6-web-on-vercel-not-applicable)). Since 5 October 2026, Chalito lives inside the hub at `www.chalyb.com/app/chalito`: no domain of its own and no separate Vercel project. The hub is on Vercel's free Hobby plan, which is for non-commercial use; staying on it was your decision, worth revisiting before you charge for anything.
7. **Turn it on** ([Phase 8](GO_LIVE.md#phase-8-turn-it-on-for-the-beta-owner-visible)):
   - activate the engine on the hub;
   - your own first run;
   - **one real call and one real WhatsApp**;
   - one store purchase;
   - invite the testers. 💲
8. **Signed desktop apps** ([Phase 9](GO_LIVE.md#phase-9-desktop-apps-owner-after-82-cost-visible)): the updater key (back it up), Apple, Azure, and two repository variables so the app connects to accounts (`SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`). 💲

💲 = costs money or is visible to others. None of it has been done without your go.

What testers should know is in [`BETA_NOTES.md`](BETA_NOTES.md).

### Before opening beyond the beta
- A privacy notice and terms published, reviewed by your lawyer.
- The 1,000-device load test (costs money).
- OpenAI's approval for "Sign in with ChatGPT".
