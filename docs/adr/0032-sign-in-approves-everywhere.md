# ADR 0032: Signing in approves every device, and what's left pops up

Status: accepted (owner decision 2026-10-25). Extends [ADR 0029](0029-sign-in-alone.md).

## Context

On 2026-10-25 the owner's computer was stuck on "Abre Chalito en un dispositivo de confianza (tu
teléfono) y aprueba este equipo con este código". The installed app was 0.1.0-beta.2, built before
ADR 0029 shipped, so it went straight to the endorsement code. The owner had no trusted phone, and
the web inbox showed nothing to approve: the endorsement is only approved from "Añadir un
dispositivo", never pushed. The browser also still waited for a trusted device ("Esperando
aprobación"), because ADR 0029 only covered the desktop panel.

The owner's words: no manual approvals; signing in is the approval; anything that still needs the
person pops up on whatever screen they're on.

## Decision

- **Browser.** A signed-in browser with no device keys enrols itself through `POST
/v1/devices/signin` (`apps/web/src/lib/sign-in-enrol.ts`), with a fresh identity every time, and
  trusts the account's computers from the directory. `/vincular` only shows how that went, with a
  retry. On every connect it also trusts computers added since (like the desktop).
- **Desktop.** The endorsement fallback is gone. An api without the route is the error
  `unsupported`, never a code for another device to approve.
- **Computer.** The pairing the desktop app starts (`chalito run` with the panel's IPC secret) no
  longer asks for the OS password (pkexec/osascript). `chalito pair` from a terminal keeps it, and
  so does Developer mode.
- **What still needs the person pops up.** On the web, a pending approval opens a dialog over every
  page except the inbox and `/a/<id>` (`ApprovalPopup`). On the desktop, it shows over every tab
  except the inbox and brings the panel window forward; "No molestar" holds the window back for
  approvals (the card is still there when the person opens the panel). A reverse check for an
  approver that isn't one of the account's devices, or replacing the computer's account, brings it
  forward even under "No molestar": the person just started that pairing.
- "Añadir un dispositivo" stays, so a trusted device can still approve the code an older app
  (beta.2 or earlier) shows.

## Consequences

- The ADR 0029 trade-off now covers browsers too: anyone with the person's Chalyb session can add
  a browser that the account's computers trust. Every device still gets the security alert, and
  revoking still works. A revoked browser comes back only after a new Chalyb sign-in.
- On the computer, the panel's IPC secret plus the reverse check are the local proof. Malware
  already running as the person could drive the panel's pairing without a password prompt; that
  was already true on Windows.
- Old installs don't update themselves (unsigned betas have no updater key). They keep showing the
  endorsement code until the person installs a build with ADR 0029.
