import { createHash } from "node:crypto";
import { buildManifest, classify, verifyMinisign, type BuiltArtifact, type DownloadOs } from "@chalito/releases";
import { labelName, type Plan } from "./plan.js";

export interface FoundFile {
  name: string;
  bytes: Uint8Array;
  /** Contents of `<name>.sig` when the bundler wrote one. */
  sig?: string;
}

/**
 * One OS's bundle output → the artifacts to upload: labelled names, size, sha256, and the
 * updater signature, each VERIFIED against the build's updater public key (a release whose
 * signatures don't verify would be refused by every installed app, so it stops here).
 */
export const collectArtifacts = async (
  files: readonly FoundFile[],
  o: { pubkey: string; label: Plan["label"] },
): Promise<(BuiltArtifact & { source: string })[]> => {
  const out: (BuiltArtifact & { source: string })[] = [];
  for (const f of files) {
    const c = classify(f.name);
    if (!c) continue;
    if (c.updater.length) {
      if (!f.sig) throw new Error(`${f.name}: updater artifact without a .sig`);
      const check = await verifyMinisign(o.pubkey, f.sig, f.bytes);
      if (!check.ok) throw new Error(`${f.name}: updater signature ${check.reason}`);
    }
    out.push({
      source: f.name,
      name: labelName(f.name, o.label),
      size: f.bytes.byteLength,
      sha256: createHash("sha256").update(f.bytes).digest("hex"),
      ...(f.sig ? { signature: f.sig.trim() } : {}),
    });
  }
  if (!out.length) throw new Error("no release artifacts found");
  return out;
};

/** The per-OS results merged into the channel's latest.json. */
export const mergeManifest = (o: {
  channel: "stable" | "beta";
  version: string;
  notes?: string;
  pubDate: Date;
  parts: readonly { os: DownloadOs; label: Plan["label"]; artifacts: readonly BuiltArtifact[] }[];
}) =>
  buildManifest({
    channel: o.channel,
    version: o.version,
    notes: o.notes,
    pubDate: o.pubDate,
    artifacts: o.parts.flatMap((p) => p.artifacts),
    unsigned: Object.fromEntries(o.parts.map((p) => [p.os, p.label === "unsigned"])),
  });
