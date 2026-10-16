# ADR 0028: First Run (installers, pairing without a terminal, autostart, guided setup)

- Status: Proposed (First Run docs, 2026-10-16). Nothing is built until the owner's "go".
- Builds on: pairing and the local trusted-client list (ADR 0006), desktop distribution (ADR 0014), hosting and domain (ADR 0015, **amended here**: the api gets `api.chalito.chalyb.com` back), Chalito inside the hub (ADR 0015 update, Chalyb migration 0067), endorsement (ADR 0018), the M14 release pipeline (`docs/OPS.md` §10).
- Protocol: `v` stays 1. One new pairing hand-off field and one new api route (§3). No new command shapes; nothing that enables or loosens anything remotely.
- Order: **First Run ships before M17** (owner, 2026-10-16).

## Context
Owner report (2026-10-16): "right now I access as a new user, I don't have any approved devices and don't know how to use it." The owner wants it simple to connect every agent and tool, simple to configure and simple to get working, plus **downloadable apps for macOS, Linux and Windows**, so that a computer left on runs Chalito by itself and talks to the other tools with no browser open.

What a brand-new user meets today (read of chalito `main` 8d7b22e and Chalyb `main` 5dc7e79, 2026-10-16):

1. **The live UI is the hub port, not `apps/web`.** The screens are in the Chalyb repo:
   - pages in `src/app/[locale]/(dashboard)/app/chalito/`
   - components in `src/components/tools/chalito/`
   - strings in `src/lib/chalito/messages/{es,en}.json`

   `chalito/apps/web` is the older original. The hub has moved on from it (Activate, Recover, ConnectProviders, Empty), so UI work for First Run lands **in the hub**.
2. **There is nothing to download.**
   - No GitHub release exists. `/releases/{stable,beta}/latest.json` on the api returns 404, because `releases.tf` isn't applied and the bucket and signer env aren't set.
   - On hub `main`, the `chalito.download` message namespace is missing, so `/descargar` renders raw keys. The fix sits on the unmerged hub branch `origin/claude/audit-hub-chalito` ("add the missing chalito.download messages").
3. **A computer can't be paired from any screen.**
   - `chalito pair` prints a code and says "abre Chalito → Agregar computadora". That screen doesn't exist.
   - `POST /v1/pairing/claim` is called only by `scripts/e2e-phone.ts` and the rehearsal tests.
   - The desktop panel's pairing check is a stub: `apps/agent/src/ipc-handlers.ts:162-171` always answers `no_pending_pairing`.
   - Desktop sign-in (`/auth/desktop`, then `chalito://`) makes the panel a trusted **client**. It doesn't pair the computer's agent.
4. **Setup needs a terminal in about eight places:**
   - install the CLI ("Instalar el comando chalito", with an admin prompt on macOS);
   - `chalito pair`, and the y/N fingerprint confirmation;
   - `chalito service install`;
   - `chalito claude|codex|grok|gemini pin`;
   - `chalito keys set`;
   - `chalito apps sessions enable`;
   - `chalito policy edit`. Workspaces default to `[]` (`apps/agent/src/policy/schema.ts:167`), so "Espacio de trabajo" in New Session is empty until a folder is added.
5. **Even a published build couldn't connect.**
   - `release.yml:37` builds with `CHALITO_API_BASE=https://api.chalito.chalyb.com`, and the desktop CSP (`tauri.conf.json:68`) allows only that host.
   - That name doesn't resolve. ADR 0015's update removed every subdomain, and the services are on run.app. So the updater endpoint is wrong too.
6. **No autostart.** There's no autostart plugin. The app runs the agent only while it's open (`src-tauri/src/agent.rs`), and running in the background needs `chalito service install`.
7. **The wizard can be skipped into a dead end.**
   - `/bienvenida`'s "pair" and "connect" steps can be skipped.
   - "Terminar" marks onboarding done without checking anything.
   - "Ir a Descargar" leads to the broken `/descargar`.
   - `/dispositivos` has no "you don't have a computer yet" state.
8. **Jargon:** glifo, anillo, huella, passkey, Energía, Mesas, "Modo desarrollador", "cliente de confianza".

What already works and is kept:
- The Tauri 2 app (`apps/desktop`, id `com.chalyb.chalito`) has a tray, deep links, single instance and the updater, and it **embeds the agent** as a bun-compiled sidecar run by its supervisor.
- `release.yml` builds AppImage/deb/rpm, NSIS and a universal DMG, labels unsigned builds, and only ever makes drafts.
- "Conecta tus IA" (`ConnectProviders.tsx`) already sends signed install, key and sign-in commands to a paired computer.

## Decision

### 1. Owner picks (2026-10-16)
| # | Pick |
|---|---|
| 48 | First Run is its own milestone and ships **before M17**. |
| 49 | The api gets the stable name **`api.chalito.chalyb.com`** again: a DNS record plus a Cloud Run domain mapping in `us-central1`, run by the owner. Installed apps keep working if the backend moves. |
| 50 | **Autostart on by default** after install, with a switch in the panel and the tray. |
| 24 | Windows signing, previously pending: ship **unsigned for internal and beta use**, then **Azure Artifact Signing** (formerly Trusted Signing) before the public launch, or an OV certificate if the owner's country or entity isn't eligible. |
| — | macOS is **signed and notarized** with the owner's existing Apple Developer account (ADR 0014 unchanged). Linux stays unsigned for beta; AppImage GPG is optional. |

### 2. Phase A: installers you can download
- **One api base everywhere.**
  - `api.chalito.chalyb.com` maps to the `chalito` Cloud Run service.
  - `release.yml`, the desktop CSP and the updater endpoint keep that host, so their current values become correct.
  - The engine row's `admin_api_base` can stay on run.app (server to server). Moving it is optional.
- **First real release** through the existing M14 pipeline (`docs/OPS.md` §10):
  - updater key;
  - `releases.tf` applied, plus `CHALITO_RELEASES_BUCKET`/`SIGNER` on the api;
  - `SUPABASE_URL`/`SUPABASE_PUBLISHABLE_KEY` repository variables;
  - Apple secrets;
  - a `v0.x.0-beta.1` tag, then a draft, then the owner's publish.

  Windows ships labelled unsigned on the beta channel only. The stable channel refuses unsigned Windows until Azure signing is set.
- **`/descargar` in the hub:**
  - merge the missing `chalito.download` strings;
  - detect the visitor's OS and show **one** primary button, with the other OSes below;
  - explain the Windows SmartScreen step in plain words while Windows is unsigned;
  - show checksums.

### 3. Phase B: pairing a computer with no terminal and no typing
The ceremony of ADR 0006 is kept: key-bound code, fingerprint shown on both sides, passkey on the approving device, and a local reverse check on the computer. Only the **transport of the code** and the **place of each confirmation** change.

1. **Desktop: "Conectar esta computadora".**
   - The panel asks the agent (over the existing IPC) to start pairing. The agent calls `POST /v1/pairing/codes` exactly as `chalito pair` does today (same keys, 5-minute TTL, single claim).
   - The panel shows the device name, the computer's fingerprint and the glyph.
   - The IPC pairing stub (`ipc-handlers.ts:162-171`) becomes real: `pairing.start`, `pairing.status`, `pairing.confirm`.
2. **Hand-off to the browser.**
   - The panel opens `https://www.chalyb.com/app/chalito/computadoras/aprobar#c=<code>` in the default browser. The code travels in the **fragment**, so it never reaches server logs or `Referer`.
   - The user is already signed into the hub there, or signs in.
   - No code is typed on the same machine.
3. **Browser: "Aprobar computadora"** (new hub screen). It shows:
   - the computer's name and OS;
   - the computer's fingerprint as both the colour glyph and the short words, labelled "Debe coincidir con lo que ves en tu computadora";
   - the requester's coarse network signal (§4).

   One button, **"Aprobar"**, does the WebAuthn step-up and signs the claim (`POST /v1/pairing/claim`, unchanged).

   If this browser isn't a trusted client yet and the account has **no** devices, the same screen first runs `Activate` (passkey plus recovery code), so the first device and the first computer happen in one flow. If the account already has devices and this browser isn't one of them, the screen sends the user to endorse it first (ADR 0018). It never approves from an untrusted browser.
4. **Reverse check on the computer.** The panel shows the approving browser's fingerprint (or a phone's) next to "¿Lo aprobaste tú desde *Chrome en esta Mac*?" with **"Sí, fui yo"** and "No". This replaces the terminal y/N. The trusted list is written only after "Sí" (ADR 0006 step 5, unchanged).
5. **From another device:** the panel's glyph is scannable by a phone's `/computadoras/aprobar` camera view, with the short code as the fallback. That keeps the "my laptop, approved from my phone" path, also without typing.
6. `chalito pair` stays for headless machines and prints the same `/computadoras/aprobar` link.

### 4. Why the hand-off link is safe enough (THREAT_MODEL §4.2, §4.5)
The new risk is **pairing phishing**, the device-code-phishing pattern: an attacker runs `chalito pair` on their own machine and sends the victim the approval link. If the victim taps "Aprobar", the attacker's computer becomes one of the victim's agents and receives what is sealed to it (prompts the victim sends there, keys pasted for it).

Mitigations:
- **The approval says what it is approving.** The screen names the computer and asks the user to match the fingerprint "on your computer's screen". A victim who isn't sitting at that computer has nothing to match.
- **Network check.**
  - The api records the public IP and coarse location of the `pairing/codes` request.
  - When the claim comes from a different public IP, the screen switches to a **warning state**: "Esta computadora está en otra red (<ciudad aproximada>)". The one-tap button is replaced by typing the short code shown on the computer.
  - Same network, which is the normal case after a hand-off from the same machine, keeps one tap.
- **Rate and TTL unchanged:** a 5-minute single-claim code, and the `/codes` rate limit.
- **Visible afterwards.** Every pairing raises an alert on all the account's devices ("Se conectó la computadora *X*"), with one-tap revoke (existing revoke path).
- **What a phished approval can't do:**
  - It can't add an approver to the victim's *other* computers (G2: their trusted lists are local).
  - It can't approve anything there, and it can't enable anything (G3).

The exposure is limited to content the victim later chooses to send to that computer, and the alert is there to cut that short.
- **The cloud is still not a root of trust.** A compromised api could serve a fake fingerprint on the approval screen. The reverse check on the computer (step 4) still stops it from making the computer trust the wrong browser. This is the same argument as ADR 0006.

`docs/THREAT_MODEL.md` gains a row under §4.5 ("Pairing phishing via hand-off link") with the mitigations above. The pgTAP and api tests in phase B pin the network-mismatch downgrade.

### 5. Phase C: "leave the PC on and Chalito takes over"
- **Autostart, on by default.**
  - Added with `tauri-plugin-autostart` (LaunchAgent on macOS, Registry Run key on Windows, XDG autostart on Linux), started hidden in the tray.
  - The switch lives in the panel (Ajustes) and the tray menu.
  - First-run copy says it's on and how to turn it off.
- **The background agent with no terminal.**
  - After pairing, the app installs the per-user OS service itself, the same definitions as `chalito service install` (D-005), after one in-app confirmation.
  - Until the service runs, the app's supervisor keeps running the agent. The existing exit-75 lock logic prevents two agents.
  - The CLI-on-PATH step becomes optional (Ajustes → Avanzado).
- **Agents found and pinned for you.**
  - The panel's "Conecta tus IA" step asks the agent to **detect** installed CLIs (claude, codex, grok, gemini, aider, copilot-cli, cursor-cli) in the usual install locations.
  - It shows each one with its version and a **"Usar"** button, which pins path plus sha256 through IPC (the same checks as `chalito <x> pin`).
  - After a self-update changes the hash, the panel shows "Claude Code se actualizó: confirmar" instead of a terminal instruction.
  - Missing tools link to their official installers.
  - Key entry and plan sign-in stay as today (sealed to the computer; Claude/ChatGPT plan sign-in still `owner_only`).
  - Pinning stays a **local** action: a remote client can ask the panel to show the prompt, but can't pin by itself (G3).
- **A project folder from a picker.**
  - The panel offers "Elige la carpeta donde Chalito puede trabajar" with the OS folder picker, which adds a workspace to the signed policy (a local change, like `chalito policy edit`).
  - The default suggestion is the user's home `Projects`/`Proyectos`/`code` folder if one exists. Never the whole home folder.
  - Remote clients can request a folder; the computer confirms locally (same rule as today's tightening and loosening split).

### 6. Phase D: a setup that is actually guided
- **A checklist built from real state**, not a "done" flag:
  1. Cuenta
  2. Este navegador activado
  3. Computadora conectada
  4. Una IA lista
  5. Carpeta elegida
  6. Primera tarea

  Each item reads its state from existing data: devices, agent presence, pinned adapters reported by the agent, policy workspaces count, sessions count.
  - It shows on Inicio and in the desktop panel until everything is green, and can't be marked done by hand.
  - `/bienvenida` keeps its steps, but "pair" and "connect" can only be skipped to "later", never to "done".
- **First task.** When the checklist reaches step 6, offer a ready-made, LOW-tier task in the chosen folder ("Resume este proyecto en 5 líneas"). The user sees an agent run end to end, with an approval demo only if they opt in.
- **Plain-language copy (ES and EN):**

  | Today | Becomes |
  |---|---|
  | glifo / anillo | "código de colores" |
  | huella | "código de verificación" |
  | passkey | "llave de acceso (huella o Face ID)" |
  | cliente de confianza | "dispositivo aprobado" |

  Mesas, Energía and Modo desarrollador get a one-line explanation where they first appear. The brand lint keeps running.
- **Empty states:**
  - `/dispositivos` with no computer: "Aún no conectas una computadora" plus Descargar.
  - `/sesiones/nueva` and "Conecta tus IA" link to the checklist step instead of a dead end.

## Alternatives considered
- **Keep run.app as the desktop api base.** No DNS work, but that host becomes permanent in every installed app and its updater, and a backend move would force an update. Rejected by the owner (pick 49).
- **A global external Application Load Balancer instead of Cloud Run domain mapping.** It's GA where mapping is Preview (VERIFIED_APIS, 2026-10-03), but it costs money monthly and adds Terraform. We start with domain mapping and keep the ALB as the fallback if mapping misbehaves.
- **Pair through a local loopback page** (the browser talks to the agent on `127.0.0.1` to prove it's the same machine). It's a stronger same-machine proof, but Chrome's Local Network Access prompts and per-browser differences make it unreliable. The network check (§4) gives most of the benefit.
- **Let the desktop panel approve its own agent** (the panel is already a trusted client after desktop sign-in). That makes one machine both requester and approver. It breaks the "a second, already trusted device approves" property, and it doesn't work for a first-ever device without a passkey on the desktop. Rejected.
- **Bundle Claude Code.** Out of scope, as before (`docs/OPS.md` §10 item 7).
- **Ship Windows only when signed.** It blocks internal and beta testing on the signing account. Rejected by the owner (pick 24).

## Consequences
- A new user's path is: Descargar, then install and open, then "Conectar esta computadora", then "Aprobar" in the browser, then "Sí, fui yo", then "Usar" next to each detected AI, then choose a folder, then the first task. No terminal, and no codes typed on the same machine.
- ADR 0015's "no subdomains" now has one exception: `api.chalito.chalyb.com`. `mcp.` and others stay off.
- Owner-only steps (none of them is done by code):
  - the DNS record and Cloud Run domain mapping, including Search Console verification of `chalyb.com` if it isn't verified yet;
  - Apple secrets in GitHub;
  - the updater key;
  - `releases.tf` apply plus the api env;
  - the repository variables;
  - publishing the first release;
  - later, the Azure Artifact Signing account.
- Work splits across two repos:
  - chalito: agent, desktop, api, CI.
  - Chalyb hub: screens, strings, the `/descargar` fix.

  Hub changes go in Chalyb PRs with the owner's go, as before.
- Migrations: phase B stores the requester's IP and coarse location on the pairing code. That's one Chalito migration plus pgTAP, **numbers from the coordinator**.

## Not doing
- Removing `chalito pair` or any CLI command. They stay for headless and advanced use.
- Approving a computer from an untrusted browser, or by hub session alone.
- Enabling Developer mode, loosening policy or pinning binaries from a remote client.
- Browser automation of chat websites (ground rule).

## Delivery
First Run in `docs/PLAN.md`, one branch and PR per phase: `fr-a-installers`, `fr-b-pairing`, `fr-c-takeover`, `fr-d-guided`. A and B can run in parallel. C needs B's IPC pairing calls. D needs B and C's state signals. We stop for the owner's "go" after each phase.
