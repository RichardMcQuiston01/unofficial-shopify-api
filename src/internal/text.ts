const snippetLength: number = 200;

/** Collapses whitespace and truncates `text` for use inside an error message. */
export function snippet(text: string): string {
  const collapsed: string = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > snippetLength
    ? `${collapsed.slice(0, snippetLength)}…`
    : collapsed;
}
