# avatar-jobs

A Cloud Run job (Node) that turns one uploaded image into a 2.5D image card (brief §5 M8, D-060).

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

## Free roster

The free roster is built with the same pipeline:

```sh
GEMINI_API_KEY=… pnpm --filter @chalito/avatar-jobs roster:generate <rawDir>              # characters, ≤ 40 calls
GEMINI_API_KEY=… pnpm --filter @chalito/avatar-jobs roster:generate <rawDir> --cosmetics
pnpm --filter @chalito/avatar-jobs roster:build <rawDir>                                 # → packages/roster
```

- Generation uses Google AI Studio (`gemini-3.1-flash-image`). Every call is logged to `<rawDir>/provenance.jsonl`, and the log is copied into `docs/ASSET_PROVENANCE.md`.
- Raw generations aren't committed; the built cards are.
