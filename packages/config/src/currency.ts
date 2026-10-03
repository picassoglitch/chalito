/**
 * Currency-literal lint (`pnpm lint:currency`). Prices live only in packages/config;
 * no source file under apps/** may contain a currency amount literal.
 */
const PATTERNS: [RegExp, string][] = [
  [/(?<![$\w])\$\s?\d/, "dollar amount"],
  [/\b(?:MX|US)\$\s?\d/, "MX$/US$ amount"],
  [/\b\d[\d,]*(?:\.\d+)?\s?(?:USD|MXN|EUR)\b/, "amount with currency code"],
  [/\b(?:USD|MXN|EUR)\s?\d/, "currency code with amount"],
];

export interface CurrencyIssue {
  file: string;
  line: number;
  kind: string;
  text: string;
}

export const lintCurrency = (file: string, source: string): CurrencyIssue[] => {
  const issues: CurrencyIssue[] = [];
  source.split("\n").forEach((text, i) => {
    if (text.includes("currency-lint-ignore")) return;
    for (const [re, kind] of PATTERNS) {
      if (re.test(text)) {
        issues.push({ file, line: i + 1, kind, text: text.trim() });
        break;
      }
    }
  });
  return issues;
};

/** Files the rule applies to: app source, not tests or generated output. */
export const isLintedFile = (path: string): boolean =>
  /^apps\//.test(path) &&
  /\.(ts|tsx|js|jsx|mjs|json)$/.test(path) &&
  !/(^|\/)(node_modules|dist|\.next|\.turbo|test|tests|__tests__)\//.test(path) &&
  !/\.(test|spec)\.\w+$/.test(path);
