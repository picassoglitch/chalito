import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { errorMessage, installConsoleRedaction } from "@chalito/redact";
import { Storage } from "@google-cloud/storage";
import postgres from "postgres";
import { loadModels, loadPrices } from "@chalito/config";
import { processCreation } from "./creation.js";
import { PostgresCreationStore } from "./creations.js";
import { geminiImageModel } from "./gemini.js";
import { UploadRejected, makeCard, validateImage, type CardManifest } from "./process.js";
import { GcsBlobStore, UPLOAD, outputPrefix, type BlobStore } from "./storage.js";

export type JobResult =
  { status: "ok"; prefix: string; manifest: CardManifest } | { status: "rejected"; prefix: string; reason: string };

/**
 * One upload → one card. Reads uploads/<owner>/<assetId>/original, validates it (type sniffing,
 * size and dimension caps, no executables or markup), re-encodes from decoded pixels (so no
 * metadata survives), and writes the layers, thumbnails and card.json under
 * avatars/<owner>/<assetId>/. A rejected upload gets rejected.json there instead. Owner scoping
 * is by path: the job only ever writes under the uploading owner's prefix.
 */
export const processUpload = async (store: BlobStore, path: string): Promise<JobResult> => {
  const m = UPLOAD.exec(path);
  if (!m) throw new Error(`not an upload path: ${path}`);
  const prefix = outputPrefix(m[1]!, m[2]!);
  const upload = await store.read(path);
  if (!upload) throw new Error(`upload missing: ${path}`);
  try {
    await validateImage(upload.bytes, upload.contentType ?? undefined);
    const card = await makeCard([{ emotion: "neutral", bytes: upload.bytes }]);
    for (const f of card.files) await store.write(`${prefix}${f.name}`, f.bytes, f.contentType);
    return { status: "ok", prefix, manifest: card.manifest };
  } catch (err) {
    if (!(err instanceof UploadRejected)) throw err;
    await store.write(
      `${prefix}rejected.json`,
      Buffer.from(JSON.stringify({ v: 1, reason: err.reason })),
      "application/json",
    );
    return { status: "rejected", prefix, reason: err.reason };
  }
};

/**
 * Cloud Run job entry: AVATAR_BUCKET and UPLOAD_PATH (one upload per execution, set by the
 * Workflow on the bucket's finalize event). With GEMINI_API_KEY (and DATABASE_URL) an upload is a
 * custom companion creation (src/creation.ts); without it, the plain image card (processUpload).
 */
/** Run as the entry point, also through a symlink (the container's /app/entry.ts). */
const isEntry = () => {
  try {
    return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
};

const runCreation = async (store: GcsBlobStore, path: string) => {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required with GEMINI_API_KEY");
  // DATABASE_ROLE: `chalito_server` when the login only holds it with SET (as in apps/api).
  const sql = postgres(url, {
    max: 2,
    onnotice: () => {},
    ...(process.env.DATABASE_ROLE ? { connection: { role: process.env.DATABASE_ROLE } } : {}),
  });
  try {
    const modelRef = loadModels().images.avatar;
    const r = await processCreation(
      {
        store,
        creations: new PostgresCreationStore(sql),
        model: geminiImageModel({ apiKey: process.env.GEMINI_API_KEY!, model: modelRef.model }),
        modelRef,
        prices: loadPrices(),
        now: Date.now,
        log: (msg, meta) => process.stderr.write(`${JSON.stringify({ msg, ...meta })}\n`),
      },
      path,
    );
    return {
      status: r.status,
      ...(r.status === "failed" ? { failure: r.failure } : {}),
      images: "images" in r ? r.images : 0,
    };
  } finally {
    await sql.end({ timeout: 5 });
  }
};

if (isEntry()) {
  installConsoleRedaction();
  const bucket = process.env.AVATAR_BUCKET;
  const path = process.env.UPLOAD_PATH;
  if (!bucket || !path) {
    process.stderr.write("AVATAR_BUCKET and UPLOAD_PATH are required\n");
    process.exit(2);
  }
  const store = new GcsBlobStore(new Storage(), bucket);
  const run = process.env.GEMINI_API_KEY
    ? runCreation(store, path)
    : processUpload(store, path).then((r) => ({ status: r.status, prefix: r.prefix }));
  run.then(
    (r) => process.stdout.write(`${JSON.stringify(r)}\n`),
    (e: unknown) => {
      process.stderr.write(`${errorMessage(e)}\n`);
      process.exit(1);
    },
  );
}
