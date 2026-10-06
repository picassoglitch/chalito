/**
 * Content-Security-Policy (review R-M12). The Supabase session and usable (non-extractable) device
 * keys live on this origin, so scripts are nonce-only ('strict-dynamic' for the chunks Next loads),
 * network access is limited to Chalito's own backends, and nothing may frame or re-base the page.
 */
export interface CspOrigins {
  supabaseUrl: string;
  apiBase: string;
  orchestratorBase: string;
}

/** `https://x.supabase.co/path` → `https://x.supabase.co` (empty or invalid → null). */
const originOf = (url: string): string | null => {
  try {
    return url ? new URL(url).origin : null;
  } catch {
    return null;
  }
};

/** Google Cloud Storage's signed-URL host (the private avatar bucket). */
const GCS = "https://storage.googleapis.com";

export const buildCsp = (nonce: string, o: CspOrigins, dev: boolean): string => {
  const supabase = originOf(o.supabaseUrl);
  const connect = new Set(["'self'"]);
  for (const u of [supabase, originOf(o.apiBase), originOf(o.orchestratorBase)]) if (u) connect.add(u);
  // Realtime is a websocket on the same host.
  if (supabase) connect.add(supabase.replace(/^http/, "ws"));
  // Custom companions: the photo is PUT to a signed URL on the avatar bucket, and the finished
  // drawings are read from signed URLs there (apps/api src/avatar).
  connect.add(GCS);
  return [
    "default-src 'self'",
    // libsodium (device keys) is WebAssembly: 'wasm-unsafe-eval' allows compiling wasm and nothing
    // else. React needs full eval only for dev error overlays.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' 'wasm-unsafe-eval'${dev ? " 'unsafe-eval'" : ""}`,
    `style-src 'self' 'nonce-${nonce}'`,
    // React renders `style={…}` as attributes, which a nonce can't cover.
    "style-src-attr 'unsafe-inline'",
    `img-src 'self' data: blob: ${GCS}`,
    "font-src 'self'",
    `connect-src ${[...connect].join(" ")}`,
    "media-src 'self' blob:",
    "worker-src 'self'",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(dev ? [] : ["upgrade-insecure-requests"]),
  ].join("; ");
};

/** Report-only while developing (nothing breaks, the console says what would); enforced in builds. */
export const cspHeaderName = (dev: boolean) =>
  dev ? "Content-Security-Policy-Report-Only" : "Content-Security-Policy";
