import { z } from "zod";

/**
 * The release manifest (`latest.json`), one per channel in the private `releases` bucket
 * (ADR 0014). Its `version / notes / pub_date / platforms` part is exactly Tauri's static
 * updater format; `downloads` and `unsigned` are Chalito's additions for /descargar (the
 * updater ignores unknown top-level fields). URLs are OBJECT PATHS in the bucket
 * (`stable/1.2.0/Chalito_1.2.0_amd64.AppImage`): the api's /releases route swaps them for
 * short-lived signed URLs, so the bucket is never public.
 */

export const CHANNELS = ["stable", "beta"] as const;
export const Channel = z.enum(CHANNELS);
export type Channel = z.infer<typeof Channel>;

/** Tauri updater targets (`{os}-{arch}`). The universal macOS build serves both darwin keys. */
export const UPDATER_PLATFORMS = ["linux-x86_64", "windows-x86_64", "darwin-aarch64", "darwin-x86_64"] as const;
export const UpdaterPlatform = z.enum(UPDATER_PLATFORMS);
export type UpdaterPlatform = z.infer<typeof UpdaterPlatform>;

export const DOWNLOAD_OSES = ["windows", "macos", "linux"] as const;
export const DownloadOs = z.enum(DOWNLOAD_OSES);
export type DownloadOs = z.infer<typeof DownloadOs>;
export const DownloadKind = z.enum(["nsis", "dmg", "appimage", "deb", "rpm"]);
export type DownloadKind = z.infer<typeof DownloadKind>;

const Semver = z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
/** An object path under the bucket (relative, no traversal) or, once signed, an https URL. */
const ArtifactUrl = z.string().min(1).max(2048);

export const ReleaseManifest = z.object({
  version: Semver,
  notes: z.string().max(10_000).default(""),
  pub_date: z.iso.datetime({ offset: true }),
  platforms: z.partialRecord(UpdaterPlatform, z.object({ signature: z.string().min(1), url: ArtifactUrl })),
  downloads: z
    .partialRecord(
      DownloadOs,
      z.array(
        z.object({
          kind: DownloadKind,
          name: z.string().min(1).max(255),
          url: ArtifactUrl,
          size: z.number().int().nonnegative(),
          sha256: z.string().regex(/^[0-9a-f]{64}$/),
        }),
      ),
    )
    .optional(),
  /** Per OS: true when the installers were NOT code-signed (shown on /descargar). */
  unsigned: z.partialRecord(DownloadOs, z.boolean()).optional(),
});
export type ReleaseManifest = z.infer<typeof ReleaseManifest>;

export interface BuiltArtifact {
  /** File name as the bundler produced it. */
  name: string;
  size: number;
  sha256: string;
  /** Contents of the `.sig` file Tauri writes next to updater artifacts (base64 minisign). */
  signature?: string;
}

/** Which installer / updater role a bundler output plays, from its file name. */
export const classify = (
  name: string,
): { os: DownloadOs; kind: DownloadKind | null; updater: UpdaterPlatform[] } | null => {
  if (name.endsWith(".AppImage")) return { os: "linux", kind: "appimage", updater: ["linux-x86_64"] };
  if (name.endsWith(".deb")) return { os: "linux", kind: "deb", updater: [] };
  if (name.endsWith(".rpm")) return { os: "linux", kind: "rpm", updater: [] };
  if (/-setup\.exe$/.test(name)) return { os: "windows", kind: "nsis", updater: ["windows-x86_64"] };
  if (name.endsWith(".dmg")) return { os: "macos", kind: "dmg", updater: [] };
  // The universal app bundle updates both Apple architectures.
  if (name.endsWith(".app.tar.gz")) return { os: "macos", kind: null, updater: ["darwin-aarch64", "darwin-x86_64"] };
  return null;
};

export const objectPath = (channel: Channel, version: string, name: string) => `${channel}/${version}/${name}`;

/**
 * Builds `latest.json` from what CI produced. Every updater artifact must carry its signature
 * (the updater refuses unsigned updates anyway; failing here keeps a broken release out).
 */
export const buildManifest = (o: {
  channel: Channel;
  version: string;
  notes?: string;
  pubDate: Date;
  artifacts: readonly BuiltArtifact[];
  unsigned: Partial<Record<DownloadOs, boolean>>;
}): ReleaseManifest => {
  const platforms: ReleaseManifest["platforms"] = {};
  const downloads: NonNullable<ReleaseManifest["downloads"]> = {};
  for (const a of o.artifacts) {
    const c = classify(a.name);
    if (!c) continue;
    const url = objectPath(o.channel, o.version, a.name);
    for (const p of c.updater) {
      if (!a.signature) throw new Error(`updater artifact ${a.name} has no signature`);
      if (platforms[p]) throw new Error(`two updater artifacts for ${p}`);
      platforms[p] = { signature: a.signature.trim(), url };
    }
    if (c.kind) (downloads[c.os] ??= []).push({ kind: c.kind, name: a.name, url, size: a.size, sha256: a.sha256 });
  }
  return ReleaseManifest.parse({
    version: o.version,
    notes: o.notes ?? "",
    pub_date: o.pubDate.toISOString(),
    platforms,
    downloads,
    unsigned: o.unsigned,
  });
};

/** Only paths this channel's manifest may point at (no traversal, no other channel, no URL). */
export const isChannelObject = (channel: Channel, path: string): boolean =>
  path.startsWith(`${channel}/`) &&
  !path.includes("..") &&
  !path.includes("//") &&
  !path.includes("\\") &&
  !/^[a-z][a-z0-9+.-]*:/i.test(path) &&
  /^[A-Za-z0-9._/+-]+$/.test(path);
