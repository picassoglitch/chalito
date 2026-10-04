import { Storage } from "@google-cloud/storage";
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

/** Cloud Run job entry: AVATAR_BUCKET and UPLOAD_PATH (one upload per execution). */
if (process.argv[1]?.endsWith("job.ts") || process.argv[1]?.endsWith("job.js")) {
  const bucket = process.env.AVATAR_BUCKET;
  const path = process.env.UPLOAD_PATH;
  if (!bucket || !path) {
    process.stderr.write("AVATAR_BUCKET and UPLOAD_PATH are required\n");
    process.exit(2);
  }
  processUpload(new GcsBlobStore(new Storage(), bucket), path).then(
    (r) => process.stdout.write(`${JSON.stringify({ status: r.status, prefix: r.prefix })}\n`),
    (e: unknown) => {
      process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
      process.exit(1);
    },
  );
}
