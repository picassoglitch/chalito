# avatar-jobs

A Cloud Run job (Node) that turns one uploaded image into a 2.5D image card (brief §5 M8, D-060), or a photo into a custom companion (below).

**Paths (one upload per execution: `AVATAR_BUCKET`, `UPLOAD_PATH`):**
- reads `uploads/<owner>/<assetId>/original`;
- writes under `avatars/<owner>/<assetId>/`. The job writes only under the uploader's prefix; any other path is refused.

**Validation:** in `src/process.ts`; a failure writes `rejected.json` with the reason.
- the type is sniffed from the bytes, PNG/JPEG/WebP only, and must match the declared content type;
- at most 10 MB, sides 256–4096 px, 16 MP;
- no animation;
- executables, archives, scripts and SVG/HTML markup are refused;
- the whole image is decoded once, so truncated files are refused too.

**Output:** re-encoded from decoded pixels, so no EXIF, ICC or trailing payload survives:
- `layer-neutral.webp`;
- `thumb-128.webp` and `thumb-256.webp`;
- `card.json`: layers, emotion mode (`overlay` for uploads, `swap` for the roster), shadow, and slot anchors (`head`, `face`, `body`, `back`, `aura`, `portal_fx`, normalized, with z order).

Tests run with an in-memory bucket. Nothing touches GCS.

## Custom companions (a photo → the roster's five drawings)

With `GEMINI_API_KEY` and `DATABASE_URL` set, an upload is a **creation** started by the api (`/v1/avatar`, `apps/api/src/avatar`), and the job runs `src/creation.ts`:

1. **Claim** the creation in `chalito.avatar_creations` (only one execution generates it; an upload no creation waits for is deleted untouched).
2. **Validate** the photo (the same checks as above) and **re-encode** it to a 1024 px JPEG, so no EXIF or GPS reaches the model.
3. **Draw** with the image model in `packages/config/models.yaml` (`images.avatar`): the person as a chibi in the roster's style (`src/style.ts`, shared with `scripts/generate-roster.ts`, on flat magenta), then the four emotions as edits of that drawing, exactly as the roster is made. The prompt asks for a stylized cartoon, never photorealistic, and lets the model decline (`NO_PERSON`).
4. **Card** with `makeCard(…, { keyBackground: true })`: `swap` mode, five layers, like every roster character.
5. **Record** the outcome. A paid success queues one `image.generations` usage event (`avatar:<creationId>`) with the real cost, `images × prices.yaml images.<provider>.<model>.perImage`, in the same transaction as the status; the hub adds its margin. A free creation records the cost on the row and bills nothing.

**The photo is deleted in every outcome** (every version: the bucket is versioned). The bucket's `uploads/` lifecycle rule (1 day) is the safety net for a crash.

**Consent and the free creation** are the api's (`apps/api/src/avatar/routes.ts`, migration `20261005000200`): a creation is started only with the person's self-attestation (own photo; 18+, or 13–17 with a parent's or guardian's permission), recorded on the row. The free creation is once per person: a free success leaves keyed-hash markers (`chalito_private.avatar_free_markers`, written by a trigger on the success) that account deletion keeps. A creation started in onboarding (`use_when_ready`) is put on the companion by the same trigger.

**Deleting a character** is the api's too ("Eliminar mi personaje", `DELETE /v1/avatar/creations/:id`, migration `20261005000400`, `docs/RUNBOOK.md` 6.8): it deletes every version of everything under `avatars/<owner>/<assetId>/` and keeps the row as `deleted` (no refund; the free creation stays used). It's refused while the creation is in flight, so it never races this job.

**`GEMINI_API_KEY` must be a paid-tier key** (billing-enabled AI Studio project), so photos aren't used for training: `docs/OPS.md` §5, `docs/RUNBOOK.md` 1.3.

**Failures are never billed:** a safety block or a refusal (`refused`), provider errors after 3 attempts (`provider`), a rejected file (`rejected`), or a missing upload. A failed free attempt doesn't use up the free credit. The api settles the hub reservation (`cancelled` for failures).

Tests mock the model and the bucket (`test/creation.test.ts`); nothing calls Gemini.

## Free roster

The free roster is built with the same pipeline:

```sh
GEMINI_API_KEY=… pnpm --filter @chalito/avatar-jobs roster:generate <rawDir>              # characters, ≤ 40 calls
GEMINI_API_KEY=… pnpm --filter @chalito/avatar-jobs roster:generate <rawDir> --cosmetics
pnpm --filter @chalito/avatar-jobs roster:build <rawDir>                                 # → packages/roster
```

- Generation uses Google AI Studio (`gemini-3.1-flash-image`). The style prompts live in `src/style.ts`. Every call is logged to `<rawDir>/provenance.jsonl`, and the log is copied into `docs/ASSET_PROVENANCE.md`.
- Raw generations aren't committed; the built cards are.
