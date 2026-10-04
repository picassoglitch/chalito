import { readFileSync } from "node:fs";
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from "@firebase/rules-unit-testing";
import { deleteDoc, doc, getDoc, setDoc, updateDoc } from "firebase/firestore";
import { afterAll, beforeAll, beforeEach, describe, it } from "vitest";

let env: RulesTestEnvironment;
const U = "user-1";
const OTHER = "user-2";

const device = (id: string, role: "client" | "agent", revoked = false, owner = U) => ({
  v: 1,
  deviceId: id,
  owner,
  role,
  revoked,
  devMode: { on: false, toggles: [], since: null },
  policyHash: null,
  lastSeenAt: null,
});

const as = (role: string, owner: string, deviceId?: string) =>
  env
    .authenticatedContext(deviceId ? `d_${deviceId}` : owner, { role, owner, ...(deviceId ? { deviceId } : {}) })
    .firestore();

beforeAll(async () => {
  const [host, port] = (process.env.FIRESTORE_EMULATOR_HOST ?? "127.0.0.1:8080").split(":");
  env = await initializeTestEnvironment({
    projectId: "demo-chalito",
    firestore: {
      rules: readFileSync(new URL("../../../firestore.rules", import.meta.url), "utf8"),
      host,
      port: Number(port),
    },
  });
});
afterAll(() => env.cleanup());
beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, `users/${U}`), { v: 1 });
    await setDoc(doc(db, `users/${U}/devices/phone1`), device("phone1", "client"));
    await setDoc(doc(db, `users/${U}/devices/agent1`), device("agent1", "agent"));
    await setDoc(doc(db, `users/${U}/devices/oldphone`), device("oldphone", "client", true));
    await setDoc(doc(db, `users/${U}/devices/oldagent`), device("oldagent", "agent", true));
    await setDoc(doc(db, `users/${OTHER}/devices/phoneX`), device("phoneX", "client", false, OTHER));
    await setDoc(doc(db, `users/${U}/devices/agent1/commands/c1`), { env: {}, createdAt: 1, fromDeviceId: "phone1" });
    await setDoc(doc(db, `users/${U}/approvals/a1`), { deviceId: "agent1", status: "pending", decision: null });
    await setDoc(doc(db, `users/${U}/private/recovery`), { hash: "x" });
    await setDoc(doc(db, `users/${U}/companions/c1`), { name: "Chalito", equipped: {} });
    await setDoc(doc(db, `pairingCodes/code123`), { claimed: false });
  });
});

const cmd = (from = "phone1") => ({ env: { ctx: "chalito.command.v1" }, createdAt: 2, fromDeviceId: from });

describe("commands", () => {
  it("an active client of the same owner may send a command to an agent", async () => {
    await assertSucceeds(setDoc(doc(as("client", U, "phone1"), `users/${U}/devices/agent1/commands/c2`), cmd()));
  });
  it("a revoked client, another account's client, a user session or an agent may not", async () => {
    await assertFails(
      setDoc(doc(as("client", U, "oldphone"), `users/${U}/devices/agent1/commands/c2`), cmd("oldphone")),
    );
    await assertFails(
      setDoc(doc(as("client", OTHER, "phoneX"), `users/${U}/devices/agent1/commands/c2`), cmd("phoneX")),
    );
    await assertFails(setDoc(doc(as("user", U), `users/${U}/devices/agent1/commands/c2`), cmd()));
    await assertFails(setDoc(doc(as("agent", U, "agent1"), `users/${U}/devices/agent1/commands/c2`), cmd("agent1")));
  });
  it("a client can't spoof the sender", async () => {
    await assertFails(
      setDoc(doc(as("client", U, "phone1"), `users/${U}/devices/agent1/commands/c2`), cmd("someoneelse")),
    );
  });
  it("only the target agent reads its commands, and a revoked agent can't", async () => {
    await assertSucceeds(getDoc(doc(as("agent", U, "agent1"), `users/${U}/devices/agent1/commands/c1`)));
    await assertFails(getDoc(doc(as("client", U, "phone1"), `users/${U}/devices/agent1/commands/c1`)));
    await assertFails(getDoc(doc(as("agent", U, "oldagent"), `users/${U}/devices/agent1/commands/c1`)));
  });
});

describe("devices", () => {
  it("devMode and policyHash are written only by the device itself", async () => {
    await assertSucceeds(
      updateDoc(doc(as("agent", U, "agent1"), `users/${U}/devices/agent1`), {
        policyHash: "ab",
        devMode: { on: false, toggles: [], since: null },
      }),
    );
    await assertFails(
      updateDoc(doc(as("client", U, "phone1"), `users/${U}/devices/agent1`), {
        devMode: { on: true, toggles: ["allowSudo"], since: 1 },
      }),
    );
    await assertFails(updateDoc(doc(as("user", U), `users/${U}/devices/agent1`), { policyHash: "ab" }));
  });
  it("no client can add, un-revoke or delete devices (server only)", async () => {
    await assertFails(setDoc(doc(as("client", U, "phone1"), `users/${U}/devices/evil`), device("evil", "client")));
    await assertFails(updateDoc(doc(as("agent", U, "oldagent"), `users/${U}/devices/oldagent`), { revoked: false }));
    await assertFails(updateDoc(doc(as("agent", U, "agent1"), `users/${U}/devices/agent1`), { pubSign: "x" }));
    await assertFails(deleteDoc(doc(as("client", U, "phone1"), `users/${U}/devices/agent1`)));
  });
  it("owners read their devices; other accounts can't", async () => {
    await assertSucceeds(getDoc(doc(as("user", U), `users/${U}/devices/phone1`)));
    await assertFails(getDoc(doc(as("client", OTHER, "phoneX"), `users/${U}/devices/phone1`)));
  });
});

describe("approvals", () => {
  it("a client may attach a decision only; the agent resolves only status fields", async () => {
    await assertSucceeds(
      updateDoc(doc(as("client", U, "phone1"), `users/${U}/approvals/a1`), { decision: { sig: "x" } }),
    );
    await assertFails(updateDoc(doc(as("client", U, "phone1"), `users/${U}/approvals/a1`), { status: "approved" }));
    await assertSucceeds(
      updateDoc(doc(as("agent", U, "agent1"), `users/${U}/approvals/a1`), {
        status: "approved",
        resolvedAt: 3,
        reason: "signed_allow",
      }),
    );
  });
});

describe("server-only and scoped docs", () => {
  it("private docs, inventory and equipping are server only", async () => {
    await assertFails(getDoc(doc(as("client", U, "phone1"), `users/${U}/private/recovery`)));
    await assertFails(setDoc(doc(as("client", U, "phone1"), `users/${U}/inventory/viking_hat`), { via: "free" }));
    await assertFails(
      updateDoc(doc(as("client", U, "phone1"), `users/${U}/companions/c1`), { equipped: { head: "viking_hat" } }),
    );
    await assertSucceeds(
      updateDoc(doc(as("client", U, "phone1"), `users/${U}/companions/c1`), { name: "Batman", isRenamed: true }),
    );
  });
  it("a pairing watch token reads only its own code", async () => {
    const watch = env.authenticatedContext("p_code123", { role: "pairing", pairingCode: "code123" }).firestore();
    await assertSucceeds(getDoc(doc(watch, "pairingCodes/code123")));
    await assertFails(getDoc(doc(watch, "pairingCodes/other")));
    await assertFails(getDoc(doc(watch, `users/${U}`)));
    await assertFails(getDoc(doc(as("client", U, "phone1"), "pairingCodes/code123")));
  });
  it("unauthenticated access is denied", async () => {
    await assertFails(getDoc(doc(env.unauthenticatedContext().firestore(), `users/${U}`)));
  });
});
