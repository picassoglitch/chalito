# Asset provenance

Every image asset shipped with Chalito, where it came from and under what terms. New assets are added here in the same change that adds them.

## Free roster (M8)

**Source and model:** generated with Google AI Studio, model `gemini-3.1-flash-image`, through the Gemini API. This follows the owner's standing instruction to make art with AI Studio. The script is `apps/avatar-jobs/scripts/generate-roster.ts`.

**Volume and date:** 30 generations in total on 2026-10-04: one neutral drawing per character, then four edits of that drawing, one per emotion.

**Processing:** the model draws on flat magenta. `apps/avatar-jobs/scripts/build-roster.ts` keys that out, crops, re-encodes to WebP, builds each 2.5D card (layers + anchors) and makes the thumbnails, using the same pipeline as user uploads. The results are in `packages/roster/assets/<id>/`.

**License (`proprietary-generated`):** the images are original generations owned by the owner and made for Chalito. They are not trained on, traced from, or named after third-party characters.

**Model outputs:** the model returned JPEG data although the files are named `.png`. The type is recorded below, and the pipeline sniffs the actual format.

**Icons (D-057):** `packages/roster/icons/*` are cut from `chalito/layer-neutral.webp`, placed on a cream background. There is no separate generation.

**Out of scope:** rigged VRMs (D-060).

### Assets

| Source file | Shipped as | Model | Seed | Reference | Generated (UTC) | Output type |
|---|---|---|---|---|---|---|
| `chalito-neutral.png` | `packages/roster/assets/chalito/layer-neutral.webp` | `gemini-3.1-flash-image` | 1000 | — | 2026-10-04 03:34:35 | image/jpeg |
| `chalito-happy.png` | `packages/roster/assets/chalito/layer-happy.webp` | `gemini-3.1-flash-image` | 1000 | `chalito-neutral.png` | 2026-10-04 03:35:05 | image/jpeg |
| `chalito-sad.png` | `packages/roster/assets/chalito/layer-sad.webp` | `gemini-3.1-flash-image` | 1000 | `chalito-neutral.png` | 2026-10-04 03:35:15 | image/jpeg |
| `chalito-surprised.png` | `packages/roster/assets/chalito/layer-surprised.webp` | `gemini-3.1-flash-image` | 1000 | `chalito-neutral.png` | 2026-10-04 03:35:25 | image/jpeg |
| `chalito-tired.png` | `packages/roster/assets/chalito/layer-tired.webp` | `gemini-3.1-flash-image` | 1000 | `chalito-neutral.png` | 2026-10-04 03:35:33 | image/jpeg |
| `bruno-neutral.png` | `packages/roster/assets/bruno/layer-neutral.webp` | `gemini-3.1-flash-image` | 1001 | — | 2026-10-04 03:35:42 | image/jpeg |
| `bruno-happy.png` | `packages/roster/assets/bruno/layer-happy.webp` | `gemini-3.1-flash-image` | 1001 | `bruno-neutral.png` | 2026-10-04 03:36:06 | image/jpeg |
| `bruno-sad.png` | `packages/roster/assets/bruno/layer-sad.webp` | `gemini-3.1-flash-image` | 1001 | `bruno-neutral.png` | 2026-10-04 03:36:14 | image/jpeg |
| `bruno-surprised.png` | `packages/roster/assets/bruno/layer-surprised.webp` | `gemini-3.1-flash-image` | 1001 | `bruno-neutral.png` | 2026-10-04 03:36:24 | image/jpeg |
| `bruno-tired.png` | `packages/roster/assets/bruno/layer-tired.webp` | `gemini-3.1-flash-image` | 1001 | `bruno-neutral.png` | 2026-10-04 03:36:32 | image/jpeg |
| `luna-neutral.png` | `packages/roster/assets/luna/layer-neutral.webp` | `gemini-3.1-flash-image` | 1002 | — | 2026-10-04 03:36:45 | image/jpeg |
| `luna-happy.png` | `packages/roster/assets/luna/layer-happy.webp` | `gemini-3.1-flash-image` | 1002 | `luna-neutral.png` | 2026-10-04 03:36:54 | image/jpeg |
| `luna-sad.png` | `packages/roster/assets/luna/layer-sad.webp` | `gemini-3.1-flash-image` | 1002 | `luna-neutral.png` | 2026-10-04 03:37:02 | image/jpeg |
| `luna-surprised.png` | `packages/roster/assets/luna/layer-surprised.webp` | `gemini-3.1-flash-image` | 1002 | `luna-neutral.png` | 2026-10-04 03:37:11 | image/jpeg |
| `luna-tired.png` | `packages/roster/assets/luna/layer-tired.webp` | `gemini-3.1-flash-image` | 1002 | `luna-neutral.png` | 2026-10-04 03:37:19 | image/jpeg |
| `tito-neutral.png` | `packages/roster/assets/tito/layer-neutral.webp` | `gemini-3.1-flash-image` | 1003 | — | 2026-10-04 03:37:26 | image/jpeg |
| `tito-happy.png` | `packages/roster/assets/tito/layer-happy.webp` | `gemini-3.1-flash-image` | 1003 | `tito-neutral.png` | 2026-10-04 03:37:36 | image/jpeg |
| `tito-sad.png` | `packages/roster/assets/tito/layer-sad.webp` | `gemini-3.1-flash-image` | 1003 | `tito-neutral.png` | 2026-10-04 03:37:44 | image/jpeg |
| `tito-surprised.png` | `packages/roster/assets/tito/layer-surprised.webp` | `gemini-3.1-flash-image` | 1003 | `tito-neutral.png` | 2026-10-04 03:37:52 | image/jpeg |
| `tito-tired.png` | `packages/roster/assets/tito/layer-tired.webp` | `gemini-3.1-flash-image` | 1003 | `tito-neutral.png` | 2026-10-04 03:38:01 | image/jpeg |
| `canela-neutral.png` | `packages/roster/assets/canela/layer-neutral.webp` | `gemini-3.1-flash-image` | 1004 | — | 2026-10-04 03:38:09 | image/jpeg |
| `canela-happy.png` | `packages/roster/assets/canela/layer-happy.webp` | `gemini-3.1-flash-image` | 1004 | `canela-neutral.png` | 2026-10-04 03:38:18 | image/jpeg |
| `canela-sad.png` | `packages/roster/assets/canela/layer-sad.webp` | `gemini-3.1-flash-image` | 1004 | `canela-neutral.png` | 2026-10-04 03:38:24 | image/jpeg |
| `canela-surprised.png` | `packages/roster/assets/canela/layer-surprised.webp` | `gemini-3.1-flash-image` | 1004 | `canela-neutral.png` | 2026-10-04 03:38:32 | image/jpeg |
| `canela-tired.png` | `packages/roster/assets/canela/layer-tired.webp` | `gemini-3.1-flash-image` | 1004 | `canela-neutral.png` | 2026-10-04 03:38:41 | image/jpeg |
| `nube-neutral.png` | `packages/roster/assets/nube/layer-neutral.webp` | `gemini-3.1-flash-image` | 1005 | — | 2026-10-04 03:38:49 | image/jpeg |
| `nube-happy.png` | `packages/roster/assets/nube/layer-happy.webp` | `gemini-3.1-flash-image` | 1005 | `nube-neutral.png` | 2026-10-04 03:38:58 | image/jpeg |
| `nube-sad.png` | `packages/roster/assets/nube/layer-sad.webp` | `gemini-3.1-flash-image` | 1005 | `nube-neutral.png` | 2026-10-04 03:39:05 | image/jpeg |
| `nube-surprised.png` | `packages/roster/assets/nube/layer-surprised.webp` | `gemini-3.1-flash-image` | 1005 | `nube-neutral.png` | 2026-10-04 03:39:13 | image/jpeg |
| `nube-tired.png` | `packages/roster/assets/nube/layer-tired.webp` | `gemini-3.1-flash-image` | 1005 | `nube-neutral.png` | 2026-10-04 03:39:19 | image/jpeg |

### Prompts

Neutral drawings use `<character>. Neutral, calm, gently smiling expression, relaxed standing pose. <style>`. Emotion variants send the neutral drawing as a reference image, with the edit prompt below.

- **`chalito-neutral.png`** (seed 1000): Chalito, a small human-ish companion: a cheerful round-faced kid-like figure in an oversized teal hoodie with the hood down, short messy dark hair, big warm brown eyes, rosy cheeks, a tiny glowing yellow star clip in the hair. Neutral, calm, gently smiling expression, relaxed standing pose. Cute, friendly chibi character art for an app companion: soft cel shading, clean thick dark-brown outline, warm pastel palette, full body, centered, facing the viewer, the whole character visible with generous margin. Background: a perfectly flat, uniform, solid pure magenta (#FF00FF) fill, edge to edge. No shadow on the ground, no text, no letters, no border, no frame.
- **`bruno-neutral.png`** (seed 1001): Bruno, a chubby honey-brown teddy bear with a cream muzzle and belly patch, small round ears, a little red scarf. Neutral, calm, gently smiling expression, relaxed standing pose. Cute, friendly chibi character art for an app companion: soft cel shading, clean thick dark-brown outline, warm pastel palette, full body, centered, facing the viewer, the whole character visible with generous margin. Background: a perfectly flat, uniform, solid pure magenta (#FF00FF) fill, edge to edge. No shadow on the ground, no text, no letters, no border, no frame.
- **`luna-neutral.png`** (seed 1002): Luna, a fluffy grey kitten with big green eyes, white paws and chest, a pink nose, a thin crescent-moon collar charm. Neutral, calm, gently smiling expression, relaxed standing pose. Cute, friendly chibi character art for an app companion: soft cel shading, clean thick dark-brown outline, warm pastel palette, full body, centered, facing the viewer, the whole character visible with generous margin. Background: a perfectly flat, uniform, solid pure magenta (#FF00FF) fill, edge to edge. No shadow on the ground, no text, no letters, no border, no frame.
- **`tito-neutral.png`** (seed 1003): Tito, a round little owl with soft brown and cream feathers, huge amber eyes, tiny tufted ears, small wings. Neutral, calm, gently smiling expression, relaxed standing pose. Cute, friendly chibi character art for an app companion: soft cel shading, clean thick dark-brown outline, warm pastel palette, full body, centered, facing the viewer, the whole character visible with generous margin. Background: a perfectly flat, uniform, solid pure magenta (#FF00FF) fill, edge to edge. No shadow on the ground, no text, no letters, no border, no frame.
- **`canela-neutral.png`** (seed 1004): Canela, a small orange fox with a white-tipped bushy tail, white chest, dark paws, big curious eyes. Neutral, calm, gently smiling expression, relaxed standing pose. Cute, friendly chibi character art for an app companion: soft cel shading, clean thick dark-brown outline, warm pastel palette, full body, centered, facing the viewer, the whole character visible with generous margin. Background: a perfectly flat, uniform, solid pure magenta (#FF00FF) fill, edge to edge. No shadow on the ground, no text, no letters, no border, no frame.
- **`nube-neutral.png`** (seed 1005): Nube, a fluffy white bunny with long floppy ears with pink insides, a pink nose, a round cotton tail, sky-blue eyes. Neutral, calm, gently smiling expression, relaxed standing pose. Cute, friendly chibi character art for an app companion: soft cel shading, clean thick dark-brown outline, warm pastel palette, full body, centered, facing the viewer, the whole character visible with generous margin. Background: a perfectly flat, uniform, solid pure magenta (#FF00FF) fill, edge to edge. No shadow on the ground, no text, no letters, no border, no frame.

Emotion edit prompts (the same for every character):

- **happy**: This exact same character, with an identical design, colors, outline, proportions and art style, the same framing and size, on the same flat pure magenta (#FF00FF) background. Change only the expression and pose to look joyful: a big open smile, eyes curved with delight, arms or paws raised a little in excitement. No text, no letters.
- **sad**: This exact same character, with an identical design, colors, outline, proportions and art style, the same framing and size, on the same flat pure magenta (#FF00FF) background. Change only the expression and pose to look sad: teary glossy eyes, a small frown, shoulders and ears drooping. No text, no letters.
- **surprised**: This exact same character, with an identical design, colors, outline, proportions and art style, the same framing and size, on the same flat pure magenta (#FF00FF) background. Change only the expression and pose to look surprised: wide round eyes, small open 'o' mouth, hands or paws raised near the face. No text, no letters.
- **tired**: This exact same character, with an identical design, colors, outline, proportions and art style, the same framing and size, on the same flat pure magenta (#FF00FF) background. Change only the expression and pose to look tired and sleepy: half-closed heavy eyelids, a small yawn, slightly slumped posture. No text, no letters.

## Cosmetics (M8)

**Source and model:** same model and script (`generate-roster.ts --cosmetics`): 6 generations on 2026-10-04, one per item, each a single object on flat magenta. They are keyed, trimmed and resized to 512 px by `build-roster.ts`, and ship as `packages/roster/cosmetics/<id>.webp`. Same license (`proprietary-generated`). That makes **36 generations in all**, under the cap of 40.

| Source file | Shipped as | Model | Seed | Generated (UTC) | Output type | Prompt |
|---|---|---|---|---|---|---|
| `cosmetic-viking_hat.png` | `packages/roster/cosmetics/viking_hat.webp` | `gemini-3.1-flash-image` | 2000 | 2026-10-04 03:46:07 | image/jpeg | a small cute horned Viking helmet, rounded grey metal with two cream horns and a brown leather band, front view. Cute sticker-style game item art matching a chibi companion: soft cel shading, clean thick dark-brown outline, warm pastel palette, a single centered object with generous margin. Background: a perfectly flat, uniform, solid pure magenta (#FF00FF) fill, edge to edge. No text, no letters, no border, no shadow. |
| `cosmetic-flower_crown.png` | `packages/roster/cosmetics/flower_crown.webp` | `gemini-3.1-flash-image` | 2001 | 2026-10-04 03:46:17 | image/jpeg | a small flower crown of pink, yellow and white daisies with green leaves, front view, as worn on a head. Cute sticker-style game item art matching a chibi companion: soft cel shading, clean thick dark-brown outline, warm pastel palette, a single centered object with generous margin. Background: a perfectly flat, uniform, solid pure magenta (#FF00FF) fill, edge to edge. No text, no letters, no border, no shadow. |
| `cosmetic-round_glasses.png` | `packages/roster/cosmetics/round_glasses.webp` | `gemini-3.1-flash-image` | 2002 | 2026-10-04 03:46:25 | image/jpeg | a pair of round dark-brown rimmed glasses with light blue lenses, front view, nothing else. Cute sticker-style game item art matching a chibi companion: soft cel shading, clean thick dark-brown outline, warm pastel palette, a single centered object with generous margin. Background: a perfectly flat, uniform, solid pure magenta (#FF00FF) fill, edge to edge. No text, no letters, no border, no shadow. |
| `cosmetic-star_cape.png` | `packages/roster/cosmetics/star_cape.webp` | `gemini-3.1-flash-image` | 2003 | 2026-10-04 03:46:32 | image/jpeg | a small midnight-blue cape covered in tiny gold stars, seen from the front as if draped behind shoulders, the collar at the top. Cute sticker-style game item art matching a chibi companion: soft cel shading, clean thick dark-brown outline, warm pastel palette, a single centered object with generous margin. Background: a perfectly flat, uniform, solid pure magenta (#FF00FF) fill, edge to edge. No text, no letters, no border, no shadow. |
| `cosmetic-sparkle_aura.png` | `packages/roster/cosmetics/sparkle_aura.webp` | `gemini-3.1-flash-image` | 2004 | 2026-10-04 03:46:40 | image/jpeg | a soft glowing ring of pastel sparkles and tiny stars forming an oval halo, airy and light. Cute sticker-style game item art matching a chibi companion: soft cel shading, clean thick dark-brown outline, warm pastel palette, a single centered object with generous margin. Background: a perfectly flat, uniform, solid pure magenta (#FF00FF) fill, edge to edge. No text, no letters, no border, no shadow. |
| `cosmetic-portal_swirl.png` | `packages/roster/cosmetics/portal_swirl.webp` | `gemini-3.1-flash-image` | 2005 | 2026-10-04 03:46:49 | image/jpeg | a flat glowing swirl portal seen from slightly above, teal and violet light ring on the ground with small sparkles. Cute sticker-style game item art matching a chibi companion: soft cel shading, clean thick dark-brown outline, warm pastel palette, a single centered object with generous margin. Background: a perfectly flat, uniform, solid pure magenta (#FF00FF) fill, edge to edge. No text, no letters, no border, no shadow. |
