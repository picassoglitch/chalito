/**
 * The Chalito art style, shared by the free roster (scripts/generate-roster.ts) and custom companions
 * made from a photo (src/creation.ts), so a custom companion looks like it belongs in the catalog.
 * Art is drawn on flat magenta, which makeCard keys out to transparency.
 */
export const STYLE =
  "Cute, friendly chibi character art for an app companion: soft cel shading, clean thick dark-brown outline, warm pastel palette, " +
  "full body, centered, facing the viewer, the whole character visible with generous margin. " +
  "Background: a perfectly flat, uniform, solid pure magenta (#FF00FF) fill, edge to edge. No shadow on the ground, no text, no letters, no border, no frame.";

/** The four emotion drawings, each an edit of the neutral one (the roster's five drawings). */
export const EMOTIONS: Record<string, string> = {
  happy: "joyful: a big open smile, eyes curved with delight, arms or paws raised a little in excitement",
  sad: "sad: teary glossy eyes, a small frown, shoulders and ears drooping",
  surprised: "surprised: wide round eyes, small open 'o' mouth, hands or paws raised near the face",
  tired: "tired and sleepy: half-closed heavy eyelids, a small yawn, slightly slumped posture",
};

/** The neutral pose the emotions are edits of. */
export const NEUTRAL = "Neutral, calm, gently smiling expression, relaxed standing pose.";

/** An emotion edit of the neutral drawing (passed as the reference image). */
export const emotionPrompt = (how: string) =>
  `This exact same character, with an identical design, colors, outline, proportions and art style, the same framing and size, ` +
  `on the same flat pure magenta (#FF00FF) background. Change only the expression and pose to look ${how}. No text, no letters.`;

/** What the model answers, alone, when the photo isn't one usable person (no image is drawn then). */
export const NO_PERSON = "NO_PERSON";

/**
 * A custom companion from a photo: the photo is only a reference for broad traits. The result must
 * be a stylized cartoon in the roster's style, never photorealistic and never a copy of the photo.
 */
export const photoPrompt = () =>
  "Draw an original cartoon character inspired by the person in the attached reference photo: a cute chibi version of them " +
  "(big head, small body), keeping only broad, recognizable traits: hair style and color, skin tone, eye color, glasses, " +
  "facial hair, and the main colors of their clothes. It must be a stylized hand-drawn illustration: never photorealistic, " +
  "never a trace or copy of the photo, no photographic texture, no realistic face. Friendly and wholesome, fully clothed. " +
  "Draw only this one character: ignore the photo's background, other people, text, logos and objects. " +
  `If the photo does not clearly show one real person, do not draw anything and answer only with the word ${NO_PERSON}. ` +
  `${NEUTRAL} ${STYLE}`;
