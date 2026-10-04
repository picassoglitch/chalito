import { existsSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { extname, join } from "node:path";
import { build } from "esbuild";
import { chromium, type Browser } from "@playwright/test";

/** Bundles a browser entry (iife) for the local page. */
export const bundle = async (entry: string): Promise<string> => {
  const out = await build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    target: "es2022",
    logLevel: "silent",
  });
  return out.outputFiles[0]!.text;
};

/** A local page with one canvas, the bundle at /page.js and @chalito/roster under /roster/. */
export const serve = async (js: string, rosterDir: string): Promise<{ server: Server; url: string }> => {
  const types: Record<string, string> = {
    ".webp": "image/webp",
    ".png": "image/png",
    ".js": "text/javascript",
    ".json": "application/json",
  };
  const server = createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
    let body: Buffer | string | null = null;
    if (path === "/")
      body = `<!doctype html><html><body style="margin:0;background:transparent"><canvas></canvas><script src="/page.js"></script></body></html>`;
    else if (path === "/page.js") body = js;
    else if (path.startsWith("/roster/") && !path.includes("..")) {
      const f = join(rosterDir, path.slice("/roster/".length));
      if (existsSync(f)) body = readFileSync(f);
    }
    if (body === null) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "content-type": types[extname(path)] ?? "text/html" }).end(body);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address() as { port: number };
  return { server, url: `http://127.0.0.1:${addr.port}/` };
};

/** Headless Chromium on the software renderer (SwiftShader): the same pixels on any machine. */
export const launchSoftwareGl = (): Promise<Browser> =>
  chromium.launch({
    args: ["--use-angle=swiftshader", "--use-gl=angle", "--enable-unsafe-swiftshader", "--disable-gpu-rasterization"],
  });
