import { Hono, type Context } from "hono";
import { Channel, LEGACY_MANIFEST, ReleaseManifest, UPDATER_MANIFEST, isChannelObject } from "@chalito/releases";
import type { Deps } from "../deps.js";
import { fail } from "../lib/errors.js";
import { rateLimit } from "../lib/rate-limit.js";
import type { ReleaseStore } from "../releases/gcs.js";

/** Long enough for a slow download to start; short enough that links don't get shared around. */
export const SIGNED_URL_TTL_SEC = 15 * 60;

/** Public manifests, each artifact path swapped for a short-lived signed URL; paths outside the channel are
 * dropped, never signed. latest.json stays frozen at the bridge release (ADR 0014). */
export const releasesRoutes = (deps: Deps, store: ReleaseStore) => {
  const app = new Hono();
  /** `fallback`: v2 serves the legacy file until the bridge release uploads the first latest-v2.json. */
  const serve = (file: string, fallback?: string) => async (c: Context) => {
    const channel = Channel.safeParse(c.req.param("channel"));
    if (!channel.success) return fail(404, "not_found");
    const ch = channel.data;
    let raw: unknown;
    try {
      raw = await store.manifest(ch, file);
      if (raw === null && fallback) {
        raw = await store.manifest(ch, fallback);
        if (raw !== null) console.warn("[api] releases: no", file, "yet; serving", fallback, "for", ch);
      }
    } catch (err) {
      // The bucket or the signer (IAM signBlob) can't answer right now: the updater retries later.
      console.error("[api] releases: manifest unavailable", ch, err instanceof Error ? err.message : "error");
      return fail(503, "release_unavailable");
    }
    if (raw === null) return fail(404, "no_release");
    const m = ReleaseManifest.safeParse(raw);
    if (!m.success) {
      console.error("[api] releases: malformed manifest", ch);
      return fail(503, "release_unavailable");
    }
    const sign = async (p: string) => {
      if (!isChannelObject(ch, p)) return null;
      try {
        return await store.signedUrl(p, SIGNED_URL_TTL_SEC);
      } catch (err) {
        console.error("[api] releases: signing failed", err instanceof Error ? err.message : "error");
        return fail(503, "release_unavailable");
      }
    };
    const platforms: ReleaseManifest["platforms"] = {};
    for (const [k, v] of Object.entries(m.data.platforms)) {
      const url = await sign(v.url);
      if (url) platforms[k as keyof typeof platforms] = { ...v, url };
    }
    const downloads: NonNullable<ReleaseManifest["downloads"]> = {};
    for (const [os, files] of Object.entries(m.data.downloads ?? {})) {
      const signed = [];
      for (const f of files) {
        const url = await sign(f.url);
        if (url) signed.push({ ...f, url });
      }
      downloads[os as keyof typeof downloads] = signed;
    }
    c.header("Cache-Control", "private, max-age=60");
    return c.json({ ...m.data, platforms, downloads });
  };
  // One bucket per caller across both manifests (the same data): a burst of 30, then about 60 a minute.
  const limit = rateLimit({ capacity: 30, refillPerSec: 1, now: deps.now });
  app.get(`/:channel/${UPDATER_MANIFEST}`, limit, serve(UPDATER_MANIFEST, LEGACY_MANIFEST));
  app.get(`/:channel/${LEGACY_MANIFEST}`, limit, serve(LEGACY_MANIFEST));
  return app;
};
