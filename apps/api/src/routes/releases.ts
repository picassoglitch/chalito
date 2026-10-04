import { Hono } from "hono";
import { Channel, ReleaseManifest, isChannelObject } from "@chalito/releases";
import type { Deps } from "../deps.js";
import { fail } from "../lib/errors.js";
import { rateLimit } from "../lib/rate-limit.js";
import type { ReleaseStore } from "../releases/gcs.js";

/** Long enough for a slow download to start; short enough that links don't get shared around. */
export const SIGNED_URL_TTL_SEC = 15 * 60;

/**
 * GET /releases/{channel}/latest.json (ADR 0014): the channel's manifest with every artifact
 * path swapped for a short-lived signed URL. Public (the desktop updater and /descargar call it
 * signed out). Paths outside the channel are dropped, never signed.
 */
export const releasesRoutes = (deps: Deps, store: ReleaseStore) => {
  const app = new Hono();
  app.get("/:channel/latest.json", rateLimit({ capacity: 30, refillPerSec: 1, now: deps.now }), async (c) => {
    const channel = Channel.safeParse(c.req.param("channel"));
    if (!channel.success) return fail(404, "not_found");
    const ch = channel.data;
    const raw = await store.manifest(ch);
    if (raw === null) return fail(404, "no_release");
    const m = ReleaseManifest.safeParse(raw);
    if (!m.success) {
      console.error("[api] releases: malformed manifest", ch);
      return fail(503, "release_unavailable");
    }
    const sign = (p: string) => (isChannelObject(ch, p) ? store.signedUrl(p, SIGNED_URL_TTL_SEC) : null);
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
  });
  return app;
};
