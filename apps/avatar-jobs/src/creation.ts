import sharp from "sharp";
import type { PricesConfig } from "@chalito/config";
import { AVATAR_EMOTIONS, avatarUsageEvent, imageCostMicros, type AvatarModel } from "@chalito/billing";
import { errorMessage } from "@chalito/redact";
import type { CreationStore, Failure } from "./creations.js";
import type { ImageModel, Part } from "./gemini.js";
import { UploadRejected, makeCard, validateImage, type CardManifest } from "./process.js";
import { UPLOAD, outputPrefix, type BlobStore } from "./storage.js";
import { EMOTIONS, emotionPrompt, photoPrompt } from "./style.js";

export interface CreationDeps {
  store: BlobStore;
  creations: CreationStore;
  model: ImageModel;
  /** Which model `model` is (models.yaml images.avatar), for the price and the usage event. */
  modelRef: AvatarModel;
  prices: PricesConfig;
  now: () => number;
  log?: (msg: string, meta: Record<string, unknown>) => void;
}

export type CreationResult =
  | { status: "succeeded"; prefix: string; images: number; costMicros: number; manifest: CardManifest }
  | { status: "failed"; failure: Failure; images: number; costMicros: number }
  | { status: "skipped"; reason: "busy" | "no_creation" | "lost" };

/** Attempts per image call when the provider errors (network, 429, 5xx); a refusal is never retried. */
export const ATTEMPTS = 3;
/** The photo as sent to the model: re-encoded (no EXIF/GPS), at most this big. */
const REFERENCE_SIDE = 1024;

class Refused extends Error {}
class ProviderFailed extends Error {}

/**
 * One custom companion from one photo (uploads/<owner>/<assetId>/original):
 *   1. claim the creation (the api made it; a paid one was admitted by the hub already);
 *   2. validate the photo (src/process.ts) and re-encode it (no metadata reaches the model);
 *   3. the model draws the person as a chibi in the roster's style (src/style.ts, magenta background),
 *      then the four emotions as edits of that drawing, like the roster;
 *   4. makeCard (swap mode, magenta keyed out) → avatars/<owner>/<assetId>/;
 *   5. record the outcome; a paid success also queues its image.generations usage event (real cost).
 * The photo is deleted in every outcome (the bucket's uploads/ lifecycle rule is the safety net).
 * A refusal or failure is never billed, and a failed free creation doesn't use up the free credit.
 */
export const processCreation = async (deps: CreationDeps, path: string): Promise<CreationResult> => {
  const m = UPLOAD.exec(path);
  if (!m) throw new Error(`not an upload path: ${path}`);
  const [owner, assetId] = [m[1]!, m[2]!];
  const prefix = outputPrefix(owner, assetId);
  const claimed = await deps.creations.claim(owner, assetId, deps.now());
  // Another execution is on it and still needs the photo.
  if (claimed.state === "busy") return { status: "skipped", reason: "busy" };

  let images = 0;
  const cost = () => imageCostMicros(deps.prices, deps.modelRef.provider, deps.modelRef.model, images);
  const written: string[] = [];
  try {
    if (claimed.state === "none") return { status: "skipped", reason: "no_creation" };
    const { creationId, free, reservationId } = claimed.claim;
    const fail = async (failure: Failure, detail: string): Promise<CreationResult> => {
      for (const w of written) await deps.store.deleteAll(w).catch(() => undefined);
      deps.log?.("avatar creation failed", { creationId, failure, detail, images });
      await deps.creations.fail({ creationId, failure, images, costMicros: cost(), now: deps.now() });
      return { status: "failed", failure, images, costMicros: cost() };
    };

    const generate = async (): Promise<CreationResult> => {
      const upload = await deps.store.read(path);
      if (!upload) return await fail("upload_missing", "no upload");
      try {
        await validateImage(upload.bytes, upload.contentType ?? undefined);
      } catch (err) {
        if (err instanceof UploadRejected) return await fail("rejected", err.reason);
        throw err;
      }

      const draw = async (parts: Part[]) => {
        for (let attempt = 1; ; attempt++) {
          const r = await deps.model.generate(parts);
          if (r.ok) {
            images++;
            return r;
          }
          if (r.kind === "refused") throw new Refused(r.detail);
          if (!r.retryable || attempt >= ATTEMPTS) throw new ProviderFailed(r.detail);
        }
      };

      let drawings: { emotion: string; bytes: Buffer }[];
      try {
        const reference = await sharp(upload.bytes, { failOn: "error" })
          .rotate()
          .resize(REFERENCE_SIDE, REFERENCE_SIDE, { fit: "inside", withoutEnlargement: true })
          .jpeg({ quality: 90 })
          .toBuffer();
        const neutral = await draw([
          { text: photoPrompt() },
          { inlineData: { mimeType: "image/jpeg", data: reference.toString("base64") } },
        ]);
        drawings = [{ emotion: "neutral", bytes: neutral.bytes }];
        const ref = { inlineData: { mimeType: neutral.mime, data: neutral.bytes.toString("base64") } };
        for (const emotion of AVATAR_EMOTIONS) {
          const e = await draw([{ text: emotionPrompt(EMOTIONS[emotion]!) }, ref]);
          drawings.push({ emotion, bytes: e.bytes });
        }
      } catch (err) {
        if (err instanceof Refused) return await fail("refused", err.message);
        if (err instanceof ProviderFailed) return await fail("provider", err.message);
        throw err;
      }

      let card: Awaited<ReturnType<typeof makeCard>>;
      try {
        card = await makeCard(drawings, { keyBackground: true });
      } catch (err) {
        return await fail("provider", `card: ${errorMessage(err)}`);
      }
      for (const f of card.files) {
        await deps.store.write(`${prefix}${f.name}`, f.bytes, f.contentType);
        written.push(`${prefix}${f.name}`);
      }
      const costMicros = cost();
      const event = free
        ? null
        : avatarUsageEvent({
            owner,
            creationId,
            images,
            costMicros,
            reservationId: reservationId!,
            model: deps.modelRef,
            occurredAt: deps.now(),
          });
      const ok = await deps.creations.succeed({
        creationId,
        owner,
        manifest: card.manifest,
        images,
        costMicros,
        event,
        now: deps.now(),
      });
      if (!ok) {
        // Timed out meanwhile (the api already cancelled it): no card, no charge.
        for (const w of written) await deps.store.deleteAll(w).catch(() => undefined);
        return { status: "skipped", reason: "lost" };
      }
      return { status: "succeeded", prefix, images, costMicros, manifest: card.manifest };
    };

    try {
      return await generate();
    } catch (err) {
      // Unexpected (storage, database): record a failure if we can, so nothing is billed, then rethrow.
      await fail("provider", errorMessage(err)).catch(() => undefined);
      throw err;
    }
  } finally {
    // The photo is only a reference: it never outlives the job, whatever happened above.
    await deps.store.deleteAll(path);
  }
};
