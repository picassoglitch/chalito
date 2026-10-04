// packages/config/legal/*: bundled as plain text (next.config.ts asset/source rule).
declare module "@chalito/config/legal/*.md" {
  const text: string;
  export default text;
}
declare module "@chalito/config/legal/*.yaml" {
  const text: string;
  export default text;
}
