import type { Bucket } from "@google-cloud/storage";

/**
 * Deletes every object under `prefix` and every noncurrent version of each (the buckets are
 * versioned: a plain delete only makes the live version noncurrent, kept for the 30-day undo
 * window). `getFiles({ versions: true })` lists every generation and each File carries its
 * generation, so `delete()` removes exactly that one. Returns how many generations went.
 */
export const deleteAllVersions = async (bucket: Pick<Bucket, "getFiles">, prefix: string): Promise<number> => {
  if (!prefix.endsWith("/")) throw new Error("unsafe prefix");
  const [files] = await bucket.getFiles({ prefix, versions: true });
  let n = 0;
  for (const f of files) {
    if (!f.name.startsWith(prefix)) continue;
    await f.delete({ ignoreNotFound: true });
    n++;
  }
  return n;
};
