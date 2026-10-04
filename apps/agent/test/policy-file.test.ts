import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { generateSigningKeyPair } from "@chalito/crypto";
import { AnchorStore } from "../src/anchor.js";
import { MemorySecretStore } from "../src/secrets.js";
import { DENY_ALL_POLICY, FilePolicyHolder, parsePolicyYaml, policyToYaml } from "../src/policy-file.js";
import { DEFAULT_POLICY, policyHash, type Policy } from "../src/policy/index.js";

const KEYS = await generateSigningKeyPair();
const fresh = () => mkdtempSync(join(tmpdir(), "chalito-policy-"));
const withWs = (p: Policy): Policy => ({ ...p, workspaces: [{ label: "chalito", path: "/home/u/chalito" }] });

const waitFor = async (cond: () => boolean, ms = 3000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("timeout waiting for condition");
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe("FilePolicyHolder", () => {
  it("creates the beta defaults (no workspaces) with a signed lock, 0600", () => {
    const dir = fresh();
    const h = new FilePolicyHolder(dir, KEYS);
    expect(h.get()).toEqual(DEFAULT_POLICY);
    expect(h.get().workspaces).toEqual([]);
    expect(h.hash).toBe(policyHash(DEFAULT_POLICY));
    expect(h.tampered).toBe(false);
    expect(statSync(h.file).mode & 0o777).toBe(0o600);
    expect(statSync(h.lockFile).mode & 0o777).toBe(0o600);
    expect(readFileSync(h.file, "utf8")).toContain("# Chalito local policy");
  });

  it("set() re-hashes, re-signs, reports and persists", async () => {
    const dir = fresh();
    const changes: [string, string][] = [];
    const h = new FilePolicyHolder(dir, KEYS, { onChange: (hash, via) => void changes.push([hash, via]) });
    const next = withWs(h.get());
    await h.set(next, "remote_tighten");
    expect(h.hash).toBe(policyHash(next));
    expect(changes).toEqual([[policyHash(next), "remote_tighten"]]);
    const again = new FilePolicyHolder(dir, KEYS);
    expect(again.get()).toEqual(next);
    expect(again.tampered).toBe(false);
  });

  it("an edited policy.yaml without a re-signed lock is refused on load; the signed one stays", async () => {
    const dir = fresh();
    const h = new FilePolicyHolder(dir, KEYS);
    await h.set(withWs(DEFAULT_POLICY), "local");
    const loosened = { ...withWs(DEFAULT_POLICY), workspaces: [{ label: "root", path: "/" }] };
    writeFileSync(h.file, policyToYaml(loosened));

    const tampers: unknown[] = [];
    const reloaded = new FilePolicyHolder(dir, KEYS, { onTamper: (i) => void tampers.push(i) });
    expect(reloaded.tampered).toBe(true);
    expect(reloaded.get()).toEqual(withWs(DEFAULT_POLICY));
    expect(tampers).toEqual([{ fileHash: policyHash(loosened), inForceHash: policyHash(withWs(DEFAULT_POLICY)) }]);
  });

  it("a policy.yaml with no lock at all falls back to deny-all", () => {
    const dir = fresh();
    writeFileSync(join(dir, "policy.yaml"), policyToYaml(withWs(DEFAULT_POLICY)));
    const h = new FilePolicyHolder(dir, KEYS);
    expect(h.tampered).toBe(true);
    expect(h.get()).toEqual(DENY_ALL_POLICY);
  });

  it("a lock signed by another key is not trusted", async () => {
    const dir = fresh();
    await new FilePolicyHolder(dir, await generateSigningKeyPair()).set(withWs(DEFAULT_POLICY), "local");
    const h = new FilePolicyHolder(dir, KEYS);
    expect(h.tampered).toBe(true);
    expect(h.get()).toEqual(DENY_ALL_POLICY);
  });

  it("reload() applies a signed change from another process and refuses an unsigned edit", async () => {
    const dir = fresh();
    const changes: string[] = [];
    const tampers: unknown[] = [];
    const daemon = new FilePolicyHolder(dir, KEYS, {
      onChange: (_h, via) => void changes.push(via),
      onTamper: (i) => void tampers.push(i),
    });
    // `chalito policy edit` in another process.
    await new FilePolicyHolder(dir, KEYS).set(withWs(DEFAULT_POLICY), "local");
    expect(await daemon.reload()).toBe(true);
    expect(daemon.get()).toEqual(withWs(DEFAULT_POLICY));
    expect(changes).toEqual(["local"]);

    writeFileSync(daemon.file, policyToYaml({ ...withWs(DEFAULT_POLICY), approvals: { ttlSeconds: 30 } }));
    expect(await daemon.reload()).toBe(false);
    expect(daemon.get()).toEqual(withWs(DEFAULT_POLICY));
    expect(daemon.tampered).toBe(true);
    expect(tampers).toHaveLength(1);
  });

  it("a deleted lock is re-sealed from the policy in force", async () => {
    const dir = fresh();
    const h = new FilePolicyHolder(dir, KEYS);
    rmSync(h.lockFile);
    expect(await h.reload()).toBe(false);
    expect(h.tampered).toBe(false);
    expect(new FilePolicyHolder(dir, KEYS).tampered).toBe(false);
  });

  it("invalid YAML never replaces the policy in force", async () => {
    const dir = fresh();
    const h = new FilePolicyHolder(dir, KEYS);
    writeFileSync(h.file, "version: 1\nworkspaces: [oops");
    expect(await h.reload()).toBe(false);
    expect(h.get()).toEqual(DEFAULT_POLICY);
  });

  it("watch() picks up a signed local edit", async () => {
    const dir = fresh();
    const seen: string[] = [];
    const h = new FilePolicyHolder(dir, KEYS, { onChange: (hash) => void seen.push(hash), debounceMs: 20 }).watch();
    try {
      await new FilePolicyHolder(dir, KEYS).set(withWs(DEFAULT_POLICY), "local");
      await waitFor(() => seen.length > 0);
      expect(seen).toEqual([policyHash(withWs(DEFAULT_POLICY))]);
    } finally {
      h.close();
    }
  });

  it("parsePolicyYaml reports schema errors with their path", () => {
    const res = parsePolicyYaml("version: 1\napprovals: { ttlSeconds: 5 }\n");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/approvals\.ttlSeconds/);
  });
});

describe("policy.lock rollback (seq + keychain anchor)", () => {
  const lockOf = (dir: string) => JSON.parse(readFileSync(join(dir, "policy.lock"), "utf8"));

  it("every seal bumps seq and chains prevHash; the anchor follows", async () => {
    const dir = fresh();
    const anchor = await new AnchorStore(new MemorySecretStore()).load();
    const h = new FilePolicyHolder(dir, KEYS, { anchor });
    expect(lockOf(dir)).toMatchObject({ seq: 1, prevHash: "0".repeat(64) });
    await h.set(withWs(DEFAULT_POLICY), "local");
    expect(lockOf(dir)).toMatchObject({ seq: 2, prevHash: policyHash(DEFAULT_POLICY) });
    expect(anchor.policy()).toEqual({ seq: 2, hash: policyHash(withWs(DEFAULT_POLICY)) });
  });

  it("an older signed lock + yaml restored from a backup is refused → deny-all", async () => {
    const dir = fresh();
    const secrets = new MemorySecretStore();
    const h = new FilePolicyHolder(dir, KEYS, { anchor: await new AnchorStore(secrets).load() });
    await h.set(withWs(DEFAULT_POLICY), "local");
    const backupLock = readFileSync(h.lockFile, "utf8");
    const backupYaml = readFileSync(h.file, "utf8");
    // A phone tightens: drop the workspace's adapters.
    await h.set({ ...withWs(DEFAULT_POLICY), adapters: { claudeCode: false, codex: false } }, "remote_tighten");
    await h.flush();

    writeFileSync(h.lockFile, backupLock);
    writeFileSync(h.file, backupYaml);
    const tampers: unknown[] = [];
    const restarted = new FilePolicyHolder(dir, KEYS, {
      anchor: await new AnchorStore(secrets).load(),
      onTamper: (i) => void tampers.push(i),
    });
    expect(restarted.tamperReason).toBe("rollback");
    expect(restarted.get()).toEqual(DENY_ALL_POLICY);
    expect(tampers).toHaveLength(1);
  });

  it("a running holder refuses a lower seq on reload (in-memory high-water mark), even without an anchor", async () => {
    const dir = fresh();
    const h = new FilePolicyHolder(dir, KEYS);
    await h.set(withWs(DEFAULT_POLICY), "local");
    const old = { lock: readFileSync(h.lockFile, "utf8"), yaml: readFileSync(h.file, "utf8") };
    await h.set({ ...withWs(DEFAULT_POLICY), approvals: { ttlSeconds: 60 } }, "local");
    writeFileSync(h.lockFile, old.lock);
    writeFileSync(h.file, old.yaml);
    expect(await h.reload()).toBe(false);
    expect(h.tamperReason).toBe("rollback");
    expect(h.get().approvals.ttlSeconds).toBe(60);
  });

  it("with no anchor in the keychain only a first (seq ≤ 1) lock is accepted", async () => {
    const dir = fresh();
    const h = new FilePolicyHolder(dir, KEYS);
    await h.set(withWs(DEFAULT_POLICY), "local");
    const fresh2 = new FilePolicyHolder(dir, KEYS, { anchor: await new AnchorStore(new MemorySecretStore()).load() });
    expect(fresh2.tamperReason).toBe("rollback");
  });

  it("a newer lock from another process (CLI) is accepted and moves the anchor", async () => {
    const dir = fresh();
    const secrets = new MemorySecretStore();
    const daemon = new FilePolicyHolder(dir, KEYS, { anchor: await new AnchorStore(secrets).load() });
    const cli = new FilePolicyHolder(dir, KEYS, { anchor: await new AnchorStore(secrets).load() });
    await cli.set(withWs(DEFAULT_POLICY), "local");
    expect(await daemon.reload()).toBe(true);
    expect(daemon.seq).toBe(2);
  });
});
