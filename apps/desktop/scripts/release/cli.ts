/**
 * Release CLI for .github/workflows/release.yml (runs with tsx):
 *
 *   plan     --os <os> --version <v> --channel <c> --api <url> --pubkey-file <f> --updater-key release|test
 *            writes src-tauri/tauri.release.conf.json, appends signed/label to $GITHUB_OUTPUT
 *            and the signing env to $GITHUB_ENV
 *   sidecar  --os <os> --agent-dist <dir>   puts the agent binaries in src-tauri/binaries (lipo on macOS)
 *   collect  --os <os> --bundle <dir> --out <dir> --label <l> --pubkey-file <f>
 *            verifies updater signatures, copies labelled artifacts, writes <out>/artifacts-<os>.json
 *   manifest --channel <c> --version <v> --in <dir> --out <file>
 *            merges artifacts-*.json into latest.json
 */
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { BuiltArtifact, DownloadOs } from "@chalito/releases";
import { collectArtifacts, mergeManifest, type FoundFile } from "./collect.js";
import { releasePlan, type Os, type Plan } from "./plan.js";
import { sidecarPlan } from "./sidecar.js";

const here = dirname(fileURLToPath(import.meta.url));
const tauriDir = resolve(here, "../../src-tauri");
const [cmd, ...rest] = process.argv.slice(2);
const arg = (name: string) => {
  const i = rest.indexOf(`--${name}`);
  const v = i >= 0 ? rest[i + 1] : undefined;
  if (!v) throw new Error(`--${name} is required`);
  return v;
};
const os = () => {
  const v = arg("os");
  if (v !== "linux" && v !== "windows" && v !== "macos") throw new Error(`bad --os ${v}`);
  return v as Os;
};
const gh = (file: string | undefined, lines: Record<string, string>) => {
  if (!file) return;
  for (const [k, v] of Object.entries(lines)) appendFileSync(file, `${k}=${v}\n`);
};
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((e) => {
    const p = join(dir, e);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });

switch (cmd) {
  case "plan": {
    const plan = releasePlan({
      os: os(),
      env: process.env,
      version: arg("version"),
      channel: arg("channel") as "stable" | "beta",
      apiBase: arg("api"),
      updaterPubkey: readFileSync(arg("pubkey-file"), "utf8"),
      updaterKey: arg("updater-key") as "release" | "test",
    });
    writeFileSync(join(tauriDir, "tauri.release.conf.json"), `${JSON.stringify(plan.overlay, null, 2)}\n`);
    gh(process.env.GITHUB_OUTPUT, { signed: String(plan.signed), label: plan.label });
    gh(process.env.GITHUB_ENV, plan.buildEnv);
    for (const n of plan.notes) console.log(`::warning::${n}`);
    console.log(`release plan: ${plan.label}`);
    break;
  }
  case "sidecar": {
    const bin = join(tauriDir, "binaries");
    mkdirSync(bin, { recursive: true });
    for (const s of sidecarPlan(os(), resolve(arg("agent-dist")), bin)) {
      for (const f of s.from) if (!existsSync(f)) throw new Error(`missing agent binary ${f}`);
      if (s.kind === "copy") copyFileSync(s.from[0]!, s.to);
      else {
        const r = spawnSync("lipo", ["-create", ...s.from, "-output", s.to], { stdio: "inherit" });
        if (r.status !== 0) throw new Error("lipo failed");
      }
      console.log(`sidecar: ${basename(s.to)}`);
    }
    break;
  }
  case "collect": {
    const bundle = resolve(arg("bundle"));
    const out = resolve(arg("out"));
    const label = arg("label") as Plan["label"];
    mkdirSync(out, { recursive: true });
    const paths = walk(bundle).filter((p) => !p.endsWith(".sig"));
    const files: FoundFile[] = paths.map((p) => ({
      name: basename(p),
      bytes: new Uint8Array(readFileSync(p)),
      ...(existsSync(`${p}.sig`) ? { sig: readFileSync(`${p}.sig`, "utf8") } : {}),
    }));
    const arts = await collectArtifacts(files, { pubkey: readFileSync(arg("pubkey-file"), "utf8"), label });
    for (const a of arts)
      copyFileSync(
        paths.find((p) => basename(p) === a.source)!,
        join(out, a.name),
      );
    const o = os();
    const part = { os: o === "macos" ? "macos" : o, label, artifacts: arts.map(({ source: _s, ...a }) => a) };
    writeFileSync(join(out, `artifacts-${o}.json`), `${JSON.stringify(part, null, 2)}\n`);
    console.log(`collected ${arts.length} artifacts (${label})`);
    break;
  }
  case "manifest": {
    const dir = resolve(arg("in"));
    const parts = readdirSync(dir)
      .filter((f) => /^artifacts-(linux|windows|macos)\.json$/.test(f))
      .map(
        (f) =>
          JSON.parse(readFileSync(join(dir, f), "utf8")) as {
            os: DownloadOs;
            label: Plan["label"];
            artifacts: BuiltArtifact[];
          },
      );
    const m = mergeManifest({
      channel: arg("channel") as "stable" | "beta",
      version: arg("version"),
      pubDate: new Date(),
      parts,
    });
    writeFileSync(arg("out"), `${JSON.stringify(m, null, 2)}\n`);
    console.log(`latest.json: ${Object.keys(m.platforms).join(", ")}`);
    break;
  }
  default:
    throw new Error(`unknown command ${cmd ?? ""}`);
}
