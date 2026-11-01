import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  CHANNELS,
  DOWNLOAD_OSES,
  UPDATER_PLATFORMS,
  LEGACY_BRIDGE_VERSION,
  ReleaseManifest,
  verifyMinisign,
  type Channel,
} from "@chalito/releases";

/** Semver precedence, including numeric prereleases (beta.10 follows beta.9). */
export const compareVersions = (a: string, b: string): number => {
  const split = (v: string) => {
    if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(v)) throw new Error(`Invalid version: ${v}`);
    const dash = v.indexOf("-");
    return [v.slice(0, dash < 0 ? v.length : dash).split("."), dash < 0 ? [] : v.slice(dash + 1).split(".")] as const;
  };
  const [baseA, preA] = split(a),
    [baseB, preB] = split(b);
  for (let i = 0; i < 3; i++) {
    const x = BigInt(baseA[i]!),
      y = BigInt(baseB[i]!);
    if (x !== y) return x > y ? 1 : -1;
  }
  if (!preA.length || !preB.length) return Number(!preA.length) - Number(!preB.length);
  for (let i = 0; i < Math.max(preA.length, preB.length); i++) {
    const x = preA[i],
      y = preB[i];
    if (x === y) continue;
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    const nx = /^\d+$/.test(x),
      ny = /^\d+$/.test(y);
    if (nx && ny) {
      if (BigInt(x) === BigInt(y)) continue;
      return BigInt(x) > BigInt(y) ? 1 : -1;
    }
    if (nx !== ny) return nx ? -1 : 1;
    return x > y ? 1 : -1;
  }
  return 0;
};

export const publicationFiles = async (o: {
  manifest: unknown;
  version: string;
  channel: Channel;
  publicKey: string;
  read: (name: string) => Uint8Array;
}): Promise<string[]> => {
  const m = ReleaseManifest.parse(o.manifest);
  if (m.version !== o.version) throw new Error("Manifest version does not match tag");
  if ((o.version.includes("-") ? "beta" : "stable") !== o.channel) throw new Error("Tag/channel mismatch");
  if (o.version === LEGACY_BRIDGE_VERSION) throw new Error("The legacy bridge must not be republished automatically");
  const prefix = `${o.channel}/${o.version}/`;
  const names = new Set<string>();
  const file = (url: string) => {
    const name = url.slice(prefix.length);
    if (!url.startsWith(prefix) || !/^[A-Za-z0-9._+-]+$/.test(name) || name.startsWith("UNWIRED"))
      throw new Error(`Invalid release object: ${url}`);
    if (o.channel === "stable" && name.startsWith("UNSIGNED_")) throw new Error("Unsigned stable artifact");
    names.add(name);
    return o.read(name);
  };
  for (const os of DOWNLOAD_OSES) {
    if (typeof m.unsigned?.[os] !== "boolean" || !m.downloads?.[os]?.length) throw new Error(`Missing ${os} build`);
    if (o.channel === "stable" && os !== "linux" && m.unsigned[os]) throw new Error(`Unsigned stable ${os} build`);
    for (const d of m.downloads[os]!) {
      const bytes = file(d.url);
      if (
        d.url !== prefix + d.name ||
        bytes.byteLength !== d.size ||
        createHash("sha256").update(bytes).digest("hex") !== d.sha256
      )
        throw new Error(`Artifact integrity mismatch: ${d.name}`);
    }
  }
  for (const platform of UPDATER_PLATFORMS) {
    const p = m.platforms[platform];
    if (!p) throw new Error(`Missing updater: ${platform}`);
    const result = await verifyMinisign(o.publicKey, p.signature, file(p.url));
    if (!result.ok) throw new Error(`Invalid production updater signature: ${platform}: ${result.reason}`);
  }
  return [...names].sort();
};

/** Upload immutable installers first, then atomically advance the channel manifest. */
export const publishRelease = async (o: {
  dir: string;
  bucket: string;
  version: string;
  channel: Channel;
  publicKey: string;
}) => {
  if (!/^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$/.test(o.bucket) || !CHANNELS.includes(o.channel))
    throw new Error("Invalid release destination");
  const manifestBytes = readFileSync(join(o.dir, "latest-v2.json"));
  const manifest: unknown = JSON.parse(manifestBytes.toString("utf8"));
  const read = (name: string) => readFileSync(join(o.dir, name));
  // All files, hashes and updater signatures checked before the first cloud mutation.
  const files = await publicationFiles({ ...o, manifest, read });
  const token = execFileSync("gcloud", ["auth", "print-access-token"], { encoding: "utf8" }).trim();
  const request = async (url: string, init: RequestInit = {}) => {
    const res = await fetch(url, { ...init, headers: { ...init.headers, Authorization: `Bearer ${token}` } });
    if (!res.ok && res.status !== 404) throw new Error(`Release storage HTTP ${res.status}: ${await res.text()}`);
    return res;
  };
  const objectUrl = (name: string) =>
    `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(o.bucket)}/o/${encodeURIComponent(name)}`;
  const channelObject = `${o.channel}/latest-v2.json`;
  const current = await request(objectUrl(channelObject));
  let generation = "0";
  if (current.ok) {
    const meta = (await current.json()) as { generation: string };
    generation = meta.generation;
    const data = await request(`${objectUrl(channelObject)}?alt=media&generation=${encodeURIComponent(generation)}`);
    if (!data.ok) throw new Error("Current manifest disappeared; retry publication");
    const previous = ReleaseManifest.parse(await data.json());
    const comparison = compareVersions(o.version, previous.version);
    if (comparison < 0) throw new Error(`Refusing channel downgrade from ${previous.version} to ${o.version}`);
    if (comparison === 0) {
      // An already published tag is immutable. Retrying only completes the GitHub publication.
      const next = ReleaseManifest.parse(manifest);
      const payload = (m: ReturnType<typeof ReleaseManifest.parse>) =>
        JSON.stringify([m.platforms, m.downloads, m.unsigned]);
      if (payload(previous) !== payload(next))
        throw new Error("Published version has different artifacts; choose a new version");
      process.stdout.write(`${o.version} already published to ${o.channel}\n`);
      return;
    }
  }
  const upload = async (name: string, bytes: Uint8Array, expectedGeneration: string, json = false) => {
    const url = new URL(`https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(o.bucket)}/o`);
    url.searchParams.set("uploadType", "media");
    url.searchParams.set("name", name);
    url.searchParams.set("ifGenerationMatch", expectedGeneration);
    const res = await request(url.toString(), {
      method: "POST",
      body: new Uint8Array(bytes),
      headers: {
        "Content-Type": json ? "application/json" : "application/octet-stream",
        "X-Goog-Hash": `md5=${createHash("md5").update(bytes).digest("base64")}`,
      },
    });
    if (!res.ok) throw new Error(`Upload failed: ${name}`);
  };
  for (const name of files) {
    const path = `${o.channel}/${o.version}/${name}`,
      bytes = read(name);
    const existing = await request(objectUrl(path));
    if (existing.ok) {
      const metadata = (await existing.json()) as { md5Hash?: string };
      if (metadata.md5Hash !== createHash("md5").update(bytes).digest("base64"))
        throw new Error(`Existing artifact differs: ${path}`);
    } else await upload(path, bytes, "0");
  }
  // Compare-and-swap rejects a concurrent publisher. Never write legacy latest.json.
  await upload(channelObject, manifestBytes, generation, true);
  process.stdout.write(`Published ${o.version} to ${o.channel} (${files.length} artifacts)\n`);
};
