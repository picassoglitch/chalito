import { Fragment, type ReactNode } from "react";
import { Link } from "@/i18n/navigation";
import { APP_ROUTES, parseBlocks, safeHref } from "@/lib/markdown";

/**
 * A deliberately small Markdown renderer for Chalito's own texts (legal pages): headings, paragraphs,
 * lists, block quotes, **bold**, `code` and links. It builds React elements, never HTML strings, and
 * links only to app paths, https or mailto: anything else renders as plain text.
 */

const inline = (text: string, key: string): ReactNode[] => {
  const out: ReactNode[] = [];
  const re = /\*\*([^*]+)\*\*|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const k = `${key}-${i++}`;
    if (m[1] !== undefined) out.push(<strong key={k}>{m[1]}</strong>);
    else if (m[2] !== undefined)
      out.push(
        <code key={k} className="rounded bg-neutral-100 px-1 text-sm">
          {m[2]}
        </code>,
      );
    else {
      const href = safeHref(m[4]!);
      if (!href) out.push(m[3]!);
      else if (APP_ROUTES.has(href))
        out.push(
          <Link key={k} href={href as "/privacidad"} className="text-emerald-700 underline">
            {m[3]}
          </Link>,
        );
      else
        out.push(
          <a key={k} href={href} rel="noopener noreferrer" className="text-emerald-700 underline">
            {m[3]}
          </a>,
        );
    }
    last = re.lastIndex;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
};

const H = { 1: "text-2xl font-bold", 2: "mt-4 text-lg font-semibold", 3: "font-semibold" } as const;

export const Markdown = ({ source }: { source: string }) => (
  <div className="grid gap-3 leading-relaxed">
    {parseBlocks(source).map((b, i) => {
      const k = `b${i}`;
      if (b.t === "h") {
        const Tag = `h${b.level}` as "h1" | "h2" | "h3";
        return (
          <Tag key={k} className={H[b.level]}>
            {inline(b.text, k)}
          </Tag>
        );
      }
      if (b.t === "ul")
        return (
          <ul key={k} className="ml-5 list-disc space-y-1">
            {b.items.map((it, j) => (
              <li key={j}>{inline(it, `${k}-${j}`)}</li>
            ))}
          </ul>
        );
      if (b.t === "quote")
        return (
          <blockquote key={k} className="border-l-4 border-neutral-300 pl-3 text-neutral-700">
            {b.lines.map((l, j) => (
              <Fragment key={j}>
                {j > 0 ? <br /> : null}
                {inline(l, `${k}-${j}`)}
              </Fragment>
            ))}
          </blockquote>
        );
      return <p key={k}>{inline(b.text, k)}</p>;
    })}
  </div>
);
