/** Pure parts of the legal-text Markdown renderer (components/Markdown.tsx). */

/** App routes a document may link to (next-intl maps them per locale). */
export const APP_ROUTES = new Set(["/privacidad", "/terminos", "/ajustes", "/dispositivos", "/creditos"]);

export const safeHref = (href: string): string | null => {
  if (APP_ROUTES.has(href)) return href;
  if (/^https:\/\/[^\s/]+/.test(href) || /^mailto:[^\s]+$/.test(href)) return href;
  return null;
};

export type Block =
  | { t: "h"; level: 1 | 2 | 3; text: string }
  | { t: "p"; text: string }
  | { t: "ul"; items: string[] }
  | { t: "quote"; lines: string[] };

export const parseBlocks = (md: string): Block[] => {
  const blocks: Block[] = [];
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  let para: string[] = [];
  const flush = () => {
    if (para.length) blocks.push({ t: "p", text: para.join(" ") });
    para = [];
  };
  for (const raw of lines) {
    const line = raw.trimEnd();
    const h = /^(#{1,3}) (.+)$/.exec(line);
    if (h) {
      flush();
      blocks.push({ t: "h", level: h[1]!.length as 1 | 2 | 3, text: h[2]! });
    } else if (/^- /.test(line)) {
      flush();
      const prev = blocks.at(-1);
      if (prev?.t === "ul") prev.items.push(line.slice(2));
      else blocks.push({ t: "ul", items: [line.slice(2)] });
    } else if (/^>/.test(line)) {
      flush();
      const prev = blocks.at(-1);
      const text = line.replace(/^> ?/, "");
      if (prev?.t === "quote") prev.lines.push(text);
      else blocks.push({ t: "quote", lines: [text] });
    } else if (line === "") flush();
    else para.push(line.trim());
  }
  flush();
  return blocks;
};
