import { Hono, type Context } from "hono";
import { Channel, ReleaseManifest, UPDATER_MANIFEST, isChannelObject, type UpdaterPlatform } from "@chalito/releases";
import type { Deps } from "../deps.js";
import { fail } from "../lib/errors.js";
import { rateLimit } from "../lib/rate-limit.js";
import type { ReleaseStore } from "../releases/gcs.js";

/** Long enough for a slow download to start; short enough that links don't get shared around. */
export const SIGNED_URL_TTL_SEC = 15 * 60;

/** Left out of the legacy latest.json: Linux builds from before the Ubuntu 24.04 one have no glibc
 * gate, so they'd install an update that can't start on their system. */
export const LEGACY_HIDDEN: readonly UpdaterPlatform[] = ["linux-x86_64"];

/**
 * GET /releases/{channel}/latest.json and UPDATER_MANIFEST (ADR 0014): the channel's manifest with every
 * artifact path swapped for a short-lived signed URL. Public (the updater and /descargar call them signed
 * out). Paths outside the channel are dropped, never signed. latest.json is the legacy updater view.
 */
export const releasesRoutes = (deps: Deps, store: ReleaseStore) => {
  const app = new Hono();
  const serve = (legacy: boolean) => async (c: Context) => {
    const channel = Channel.safeParse(c.req.param("channel"));
    if (!channel.success) return fail(404, "not_found");
    const ch = channel.data;
    let raw: unknown;
    try {
      raw = await store.manifest(ch);
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
      if (legacy && LEGACY_HIDDEN.includes(k as UpdaterPlatform)) continue;
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
  const limit = () => rateLimit({ capacity: 30, refillPerSec: 1, now: deps.now });
  app.get("/:channel/latest.json", limit(), serve(true));
  app.get(`/:channel/${UPDATER_MANIFEST}`, limit(), serve(false));
  return app;
};
