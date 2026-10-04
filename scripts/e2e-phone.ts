/**
 * Test phone for the M3 end-to-end run (scripts/e2e-claude.md). Until the web client
 * exists (M5), this plays the user's phone: enrols as the first client, claims a pairing
 * code, sends signed commands, opens sealed approval details and signs Decisions.
 *
 *   pnpm tsx scripts/e2e-phone.ts <command> [--flags]
 *
 * Talks to the real `api` routes and Firestore. With FIRESTORE_EMULATOR_HOST and
 * FIREBASE_AUTH_EMULATOR_HOST set it uses the emulators. Keys and ids are kept in
 * ~/.chalito-e2e-phone.json (0600): test keys only, never a real phone's.
 *
 * Workspace packages are imported by path and `firebase` is resolved from apps/agent, so
 * this script adds nothing to the root package.json.
 */
import { createHmac, randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";
import {
  deriveDeviceId,
  fingerprint,
  fromB64url,
  generateBoxKeyPair,
  generateSigningKeyPair,
  openJson,
  randomNonce,
  sealJson,
  signEnvelope,
  toB64url,
} from "../packages/crypto/src/index.js";
import { verifyGlyph } from "../packages/glyph/src/index.js";
import type { GlyphPayload, SealedEnvelope } from "../packages/protocol/src/index.js";

// ---- output, args, state --------------------------------------------------------

const out = (s = "") => process.stdout.write(`${s}\n`);
const die = (s: string): never => {
  process.stderr.write(`e2e-phone: ${s}\n`);
  process.exit(1);
};

const [cmd = "help", ...rest] = process.argv.slice(2);
const flags: Record<string, string | true> = {};
for (let i = 0; i < rest.length; i++) {
  const a = rest[i]!;
  if (!a.startsWith("--")) die(`unexpected argument ${a}`);
  const next = rest[i + 1];
  if (next !== undefined && !next.startsWith("--")) {
    flags[a.slice(2)] = next;
    i++;
  } else flags[a.slice(2)] = true;
}
const flag = (name: string): string | undefined =>
  typeof flags[name] === "string" ? (flags[name] as string) : undefined;
const need = (name: string): string => flag(name) ?? die(`--${name} is required`);

const env = process.env;
const API = (env.CHALITO_API_BASE ?? "http://localhost:8787").replace(/\/+$/, "");
const PROJECT = env.CHALITO_FIREBASE_PROJECT_ID ?? "demo-chalito";
const DATABASE = env.CHALITO_FIREBASE_DATABASE_ID ?? "chalito";
const STATE_FILE = env.CHALITO_E2E_PHONE_STATE ?? join(homedir(), ".chalito-e2e-phone.json");

interface State {
  owner: string;
  deviceId: string;
  signPk: string;
  signSk: string;
  boxPk: string;
  boxSk: string;
  /** The paired agent, as learned from the glyph it signed (never from the server). */
  agent?: { deviceId: string; pubBox: string; fingerprint: string };
  lastDecision?: unknown;
}

const loadState = (): State =>
  existsSync(STATE_FILE)
    ? (JSON.parse(readFileSync(STATE_FILE, "utf8")) as State)
    : die(`no phone yet (${STATE_FILE}); run \`enrol\` first`);
const saveState = (s: State) => writeFileSync(STATE_FILE, `${JSON.stringify(s, null, 2)}\n`, { mode: 0o600 });

const keysOf = async (s: State) => ({
  sign: { publicKey: await fromB64url(s.signPk), secretKey: await fromB64url(s.signSk) },
  box: { publicKey: await fromB64url(s.boxPk), secretKey: await fromB64url(s.boxSk) },
});
const agentOf = (s: State) => s.agent ?? die("not paired with an agent yet; run `claim` first");

// ---- HTTP + Firebase ------------------------------------------------------------

const post = async (path: string, body: unknown, bearer?: string): Promise<Record<string, unknown>> => {
  const res = await fetch(`${API}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) die(`${path} → ${res.status} ${String(json.error ?? "")} ${String(json.message ?? "")}`.trim());
  return json;
};

/** The firebase client SDK, resolved from apps/agent (the root has no firebase dependency). */
const requireFromAgent = createRequire(new URL("../apps/agent/package.json", import.meta.url));
const load = async <T>(id: string): Promise<T> => (await import(pathToFileURL(requireFromAgent.resolve(id)).href)) as T;

/* eslint-disable @typescript-eslint/no-explicit-any -- the SDK is loaded dynamically, untyped here */
interface Fb {
  db: any;
  fs: any;
  idToken: string;
}
const signIn = async (customToken: string): Promise<Fb> => {
  const appMod = await load<any>("firebase/app");
  const authMod = await load<any>("firebase/auth");
  const fs = await load<any>("firebase/firestore");
  const app = appMod.initializeApp(
    { projectId: PROJECT, apiKey: env.CHALITO_FIREBASE_API_KEY ?? "demo-key" },
    randomUUID(),
  );
  const auth = authMod.getAuth(app);
  if (env.FIREBASE_AUTH_EMULATOR_HOST)
    authMod.connectAuthEmulator(auth, `http://${env.FIREBASE_AUTH_EMULATOR_HOST}`, { disableWarnings: true });
  const db = fs.getFirestore(app, DATABASE);
  if (env.FIRESTORE_EMULATOR_HOST) {
    const [host, port] = env.FIRESTORE_EMULATOR_HOST.split(":");
    fs.connectFirestoreEmulator(db, host, Number(port));
  }
  const cred = await authMod.signInWithCustomToken(auth, customToken);
  return { db, fs, idToken: await cred.user.getIdToken() };
};
/* eslint-enable @typescript-eslint/no-explicit-any */

/** Device credential: a signed one-time challenge exchanged for a custom token (as the agent does). */
const deviceSession = async (s: State): Promise<Fb> => {
  const k = await keysOf(s);
  const challenge = await signEnvelope(
    "chalito.refresh-challenge.v1",
    { v: 1 as const, owner: s.owner, deviceId: s.deviceId, nonce: await randomNonce(), issuedAt: Date.now() },
    s.deviceId,
    k.sign.secretKey,
  );
  const res = await post("/v1/devices/token", challenge);
  return signIn(String(res.customToken));
};

// ---- commands -------------------------------------------------------------------

const COMMAND_TTL_MS = 5 * 60_000;
const APPROVAL_DECISION_TTL_MS = 5 * 60_000;

/** Signs a command body and writes it to the agent's commands collection. */
const sendCommand = async (s: State, payload: (cid: string) => Promise<Record<string, unknown>>) => {
  const agent = agentOf(s);
  const k = await keysOf(s);
  const cid = randomUUID();
  const now = Date.now();
  const body = {
    v: 1 as const,
    cid,
    uid: s.owner,
    targetDeviceId: agent.deviceId,
    origin: `client:${s.deviceId}`,
    nonce: await randomNonce(),
    issuedAt: now,
    expiresAt: now + COMMAND_TTL_MS,
    payload: await payload(cid),
  };
  const envelope = await signEnvelope("chalito.command.v1", body, s.deviceId, k.sign.secretKey);
  await writeCommand(s, envelope);
  out(`sent ${String(body.payload.type)} (cid ${cid})`);
};

const writeCommand = async (s: State, envelope: unknown) => {
  const agent = agentOf(s);
  const { db, fs } = await deviceSession(s);
  await fs.addDoc(fs.collection(db, `users/${s.owner}/devices/${agent.deviceId}/commands`), {
    env: envelope,
    createdAt: Date.now(),
    expireAt: fs.Timestamp.fromMillis(Date.now() + COMMAND_TTL_MS),
    fromDeviceId: s.deviceId,
  });
};

/** Seals to the agent only, with the AAD the agent opens it with. */
const sealForAgent = async (s: State, value: unknown, cid: string): Promise<SealedEnvelope> => {
  const agent = agentOf(s);
  return sealJson(value, { [agent.deviceId]: await fromB64url(agent.pubBox) }, `command:${cid}`);
};

const signDecision = async (
  s: State,
  approval: { aid: string; requestId: string },
  allow: boolean,
  stepUp: boolean,
) => {
  const k = await keysOf(s);
  const now = Date.now();
  return signEnvelope(
    "chalito.decision.v1",
    {
      v: 1 as const,
      aid: approval.aid,
      requestId: approval.requestId,
      uid: s.owner,
      targetDeviceId: agentOf(s).deviceId,
      allow,
      nonce: await randomNonce(),
      issuedAt: now,
      expiresAt: now + APPROVAL_DECISION_TTL_MS,
      // M3 step-up is self-asserted (D-039); M5 replaces this with a WebAuthn assertion.
      ...(stepUp ? { stepUp: { method: "platform_biometric" as const, at: now } } : {}),
    },
    s.deviceId,
    k.sign.secretKey,
  );
};

const ask = async (q: string): Promise<string> => {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const a = await rl.question(q);
  rl.close();
  return a.trim().toLowerCase();
};

const commands: Record<string, { help: string; run: () => Promise<void> }> = {
  enrol: {
    help: "--uid <hubUserId> [--recovery CODE]   SSO-exchange (CHALITO_SSO_SECRET) and enrol as the first phone",
    run: async () => {
      if (existsSync(STATE_FILE) && !flags.force) die(`${STATE_FILE} exists; pass --force to replace it`);
      const owner = need("uid");
      const secret = env.CHALITO_SSO_SECRET ?? die("CHALITO_SSO_SECRET is required (the local api's SSO secret)");
      const payload = Buffer.from(
        JSON.stringify({
          user_id: owner,
          email: `${owner}@example.invalid`,
          tenant_id: owner,
          tier: "pro",
          exp: Math.floor(Date.now() / 1000) + 300,
        }),
      ).toString("base64url");
      const token = `${payload}.${createHmac("sha256", secret).update(payload).digest("base64url")}`;
      const user = await signIn(String((await post("/sso/exchange", { token })).customToken));

      const sign = await generateSigningKeyPair();
      const box = await generateBoxKeyPair();
      const deviceId = await deriveDeviceId(sign.publicKey);
      const registration = await signEnvelope(
        "chalito.device-register.v1",
        {
          v: 1 as const,
          owner,
          deviceId,
          kind: "phone" as const,
          platform: "ios" as const,
          name: "Teléfono de prueba",
          pubSign: await toB64url(sign.publicKey),
          pubBox: await toB64url(box.publicKey),
          issuedAt: Date.now(),
        },
        deviceId,
        sign.secretKey,
      );
      const recoveryCode = flag("recovery") ?? "ABCDE-FGHJK-MNPQR-STVWX-YZ0123";
      await post("/v1/devices/first", { registration, recoveryCode }, user.idToken);
      saveState({
        owner,
        deviceId,
        signPk: await toB64url(sign.publicKey),
        signSk: await toB64url(sign.secretKey),
        boxPk: await toB64url(box.publicKey),
        boxSk: await toB64url(box.secretKey),
      });
      out(`enrolled ${deviceId} for ${owner}`);
      out(`phone fingerprint: ${await fingerprint(sign.publicKey)}`);
    },
  },

  claim: {
    help: "--code <SHORTCODE>   resolve the code `chalito pair` printed, check the glyph, confirm, claim",
    run: async () => {
      const s = loadState();
      const { idToken } = await deviceSession(s);
      const glyph = (await post("/v1/pairing/resolve", { shortCode: need("code") }, idToken)).glyph as GlyphPayload;
      const check = await verifyGlyph(glyph, Date.now());
      if (!check.ok) die(`glyph rejected: ${check.reason}`);
      const agentPubSign = await fromB64url(glyph.body.issuerPubSign);
      const agentId = await deriveDeviceId(agentPubSign);
      const agentFp = await fingerprint(agentPubSign);
      const agentPubBox = glyph.body.issuerPubBox ?? die("the glyph carries no box key");
      out(`computer: ${glyph.body.label}  (${agentId})`);
      out(`computer fingerprint: ${agentFp}`);
      if (!flags.yes && !["y", "s"].includes(await ask("Does it match what `chalito pair` shows? [y/N] ")))
        die("not claimed");
      const k = await keysOf(s);
      const claim = await signEnvelope(
        "chalito.pairing-claim.v1",
        {
          v: 1 as const,
          owner: s.owner,
          codeId: glyph.body.codeId,
          agentDeviceId: agentId,
          agentFingerprint: agentFp,
          claimerDeviceId: s.deviceId,
          issuedAt: Date.now(),
        },
        s.deviceId,
        k.sign.secretKey,
      );
      await post("/v1/pairing/claim", { claim }, idToken);
      saveState({ ...s, agent: { deviceId: agentId, pubBox: agentPubBox, fingerprint: agentFp } });
      out(`claimed. On the computer, confirm this phone's fingerprint: ${await fingerprint(k.sign.publicKey)}`);
    },
  },

  start: {
    help: '--workspace <label> --prompt "<text>" [--mode default|plan|acceptEdits]   signed session.start',
    run: async () => {
      const s = loadState();
      await sendCommand(s, async (cid) => ({
        type: "session.start",
        adapter: "claude-code",
        workspaceLabel: need("workspace"),
        permissionMode: flag("mode") ?? "default",
        promptCt: await sealForAgent(s, need("prompt"), cid),
      }));
    },
  },

  prompt: {
    help: '--sid <sid> --text "<text>"   signed session.prompt',
    run: async () => {
      const s = loadState();
      await sendCommand(s, async (cid) => ({
        type: "session.prompt",
        sid: need("sid"),
        promptCt: await sealForAgent(s, need("text"), cid),
      }));
    },
  },

  answer: {
    help: '--sid <sid> --question <questionId> --json \'<{"question":"answer"}>\'   signed session.answer',
    run: async () => {
      const s = loadState();
      const answers = JSON.parse(need("json")) as unknown;
      await sendCommand(s, async (cid) => ({
        type: "session.answer",
        sid: need("sid"),
        questionId: need("question"),
        answerCt: await sealForAgent(s, answers, cid),
      }));
    },
  },

  mode: {
    help: "--sid <sid> --mode default|plan|acceptEdits   signed session.setPermissionMode",
    run: async () => {
      const s = loadState();
      await sendCommand(s, async () => ({
        type: "session.setPermissionMode",
        sid: need("sid"),
        permissionMode: need("mode"),
      }));
    },
  },

  interrupt: {
    help: "--sid <sid>   signed session.interrupt",
    run: async () => {
      const s = loadState();
      await sendCommand(s, async () => ({ type: "session.interrupt", sid: need("sid") }));
    },
  },

  "devmode-off": {
    help: "[--toggle allowSudo|autoApproveHigh|autoApproveCritical|bypassStyle]   signed devmode.off / toggleOff",
    run: async () => {
      const s = loadState();
      const toggle = flag("toggle");
      await sendCommand(s, async () => (toggle ? { type: "devmode.toggleOff", toggle } : { type: "devmode.off" }));
    },
  },

  "revoke-client": {
    help: "[--client <deviceId>]   signed device.revokeClient (defaults to this phone)",
    run: async () => {
      const s = loadState();
      await sendCommand(s, async () => ({ type: "device.revokeClient", clientDeviceId: flag("client") ?? s.deviceId }));
    },
  },

  revoke: {
    help: "[--device <deviceId>]   revoke through the api (defaults to this phone)",
    run: async () => {
      const s = loadState();
      const { idToken } = await deviceSession(s);
      out(JSON.stringify(await post("/v1/devices/revoke", { deviceId: flag("device") ?? s.deviceId }, idToken)));
    },
  },

  "send-forbidden": {
    help: "--mode bypassPermissions|dontAsk|auto   a session.start the agent must reject (runbook 5.10)",
    run: async () => {
      const s = loadState();
      // Signed like any command, but with a mode the schema can't represent.
      await sendCommand(s, async (cid) => ({
        type: "session.start",
        adapter: "claude-code",
        workspaceLabel: flag("workspace") ?? "e2e",
        permissionMode: need("mode"),
        promptCt: await sealForAgent(s, "this must never run", cid),
      }));
    },
  },

  sessions: {
    help: "   list this agent's sessions (sid, state, mode)",
    run: async () => {
      const s = loadState();
      const { db, fs } = await deviceSession(s);
      const snap = await fs.getDocs(fs.collection(db, `users/${s.owner}/sessions`));
      for (const d of snap.docs) {
        const v = d.data() as Record<string, unknown>;
        out(`${d.id}  ${String(v.state)}  ${String(v.permissionMode)}  ${String(v.cwdLabel)}`);
      }
    },
  },

  events: {
    help: "--sid <sid>   follow a session's events (opens sealed text); Ctrl-C to stop",
    run: async () => {
      const s = loadState();
      const k = await keysOf(s);
      const sid = need("sid");
      const { db, fs } = await deviceSession(s);
      const q = fs.query(fs.collection(db, `users/${s.owner}/sessions/${sid}/events`), fs.orderBy("seq"));
      fs.onSnapshot(q, (snap: { docChanges(): { type: string; doc: { data(): Record<string, unknown> } }[] }) => {
        for (const ch of snap.docChanges()) {
          if (ch.type !== "added") continue;
          const e = ch.doc.data();
          const { ct, ...meta } = e;
          void (async () => {
            const opened = ct
              ? await openJson(ct as SealedEnvelope, s.deviceId, k.box, `event:${sid}`).catch(() => "(sealed)")
              : undefined;
            out(
              `${String(e.seq).padStart(3)} ${JSON.stringify(meta)}${opened !== undefined ? ` ${JSON.stringify(opened)}` : ""}`,
            );
          })();
        }
      });
      await new Promise(() => undefined);
    },
  },

  approvals: {
    help: "[--auto allow|deny] [--step-up auto|always|never]   watch pending approvals, show details, sign decisions",
    run: async () => {
      const s = loadState();
      const k = await keysOf(s);
      const auto = flag("auto");
      const stepUpMode = flag("step-up") ?? "auto";
      const { db, fs } = await deviceSession(s);
      const seen = new Set<string>();
      let queue = Promise.resolve();
      const q = fs.query(fs.collection(db, `users/${s.owner}/approvals`), fs.where("status", "==", "pending"));
      fs.onSnapshot(q, (snap: { docs: { id: string; data(): Record<string, unknown> }[] }) => {
        for (const d of snap.docs) {
          if (seen.has(d.id)) continue;
          seen.add(d.id);
          const a = d.data();
          queue = queue.then(async () => {
            const details = await openJson(a.detailsCt as SealedEnvelope, s.deviceId, k.box, `approval:${d.id}`).catch(
              () => "(could not open: not sealed to this phone)",
            );
            out(
              `\n[${String(a.risk)}] approval ${d.id}  stepUpRequired=${String(a.stepUpRequired)}  origin=${String(a.origin)}`,
            );
            out(`  ${JSON.stringify(details)}`);
            const choice = auto ?? (await ask("  allow / deny / allow without step-up / skip [a/d/n/s] "));
            if (choice === "s" || choice === "skip") return;
            const allow = choice === "a" || choice === "allow" || choice === "n";
            const stepUp =
              stepUpMode === "always" || (stepUpMode === "auto" && a.stepUpRequired === true && choice !== "n");
            const decision = await signDecision(s, { aid: d.id, requestId: String(a.requestId) }, allow, stepUp);
            await fs.updateDoc(fs.doc(db, `users/${s.owner}/approvals/${d.id}`), { decision });
            saveState({ ...loadState(), lastDecision: decision });
            out(`  → signed ${allow ? "allow" : "deny"}${stepUp ? " with step-up" : ""}`);
          });
        }
      });
      await new Promise(() => undefined);
    },
  },

  "replay-last": {
    help: "--aid <aid>   attach the last signed decision to another approval (must be rejected; runbook 5.11)",
    run: async () => {
      const s = loadState();
      if (!s.lastDecision) die("no decision signed yet");
      const { db, fs } = await deviceSession(s);
      await fs.updateDoc(fs.doc(db, `users/${s.owner}/approvals/${need("aid")}`), { decision: s.lastDecision });
      out("replayed; the agent log should show approval.decision_rejected");
    },
  },

  whoami: {
    help: "   print this phone's ids and fingerprints",
    run: async () => {
      const s = loadState();
      out(`owner ${s.owner}\nphone ${s.deviceId}  ${await fingerprint(await fromB64url(s.signPk))}`);
      out(s.agent ? `agent ${s.agent.deviceId}  ${s.agent.fingerprint}` : "agent (not paired)");
    },
  },
};

if (cmd === "help" || !commands[cmd]) {
  out("pnpm tsx scripts/e2e-phone.ts <command> [flags]\n");
  for (const [name, c] of Object.entries(commands)) out(`  ${name} ${c.help}`);
  out(`\nEnv: CHALITO_API_BASE (${API}), CHALITO_FIREBASE_PROJECT_ID, CHALITO_FIREBASE_DATABASE_ID,`);
  out("     FIRESTORE_EMULATOR_HOST, FIREBASE_AUTH_EMULATOR_HOST, CHALITO_SSO_SECRET, CHALITO_E2E_PHONE_STATE");
  process.exit(cmd === "help" ? 0 : 1);
}
await commands[cmd].run();
// Firebase keeps sockets open; exit once stdout has drained (pipes are async in Node).
if (!["events", "approvals"].includes(cmd)) process.stdout.write("", () => process.exit(0));
