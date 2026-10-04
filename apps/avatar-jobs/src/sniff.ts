/** What a byte buffer really is, from its magic bytes (never from the name or a header). */
export type ImageType = "png" | "jpeg" | "webp";

const starts = (b: Uint8Array, sig: number[], at = 0) => sig.every((v, i) => b[at + i] === v);
const ascii = (b: Uint8Array, s: string, at = 0) =>
  starts(
    b,
    [...s].map((c) => c.charCodeAt(0)),
    at,
  );

export const sniffImage = (b: Uint8Array): ImageType | null => {
  if (starts(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "png";
  if (starts(b, [0xff, 0xd8, 0xff])) return "jpeg";
  if (ascii(b, "RIFF") && ascii(b, "WEBP", 8)) return "webp";
  return null;
};

/**
 * Things that must never be accepted as an avatar, whatever they claim to be: executables,
 * archives (zip polyglots), scripts, PDFs and markup (SVG/HTML can carry script).
 */
export const looksExecutableOrMarkup = (b: Uint8Array): string | null => {
  const head = Buffer.from(b.subarray(0, 512)).toString("latin1").trimStart().toLowerCase();
  if (starts(b, [0x4d, 0x5a])) return "windows executable";
  if (starts(b, [0x7f, 0x45, 0x4c, 0x46])) return "elf executable";
  if (starts(b, [0xcf, 0xfa, 0xed, 0xfe]) || starts(b, [0xca, 0xfe, 0xba, 0xbe])) return "mach-o executable";
  if (starts(b, [0x50, 0x4b, 0x03, 0x04])) return "zip archive";
  if (head.startsWith("#!")) return "script";
  if (head.startsWith("%pdf")) return "pdf";
  if (/^<(\?xml|svg|!doctype|html|script)/.test(head)) return "markup";
  return null;
};
