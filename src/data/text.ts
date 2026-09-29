// Plain-text helpers shared by the API and the UI.

/** Convert HTML (e.g. a Google Calendar description) to readable plain text. Non-HTML input passes through. */
export function htmlToText(s?: string | null): string {
  if (!s) return "";
  if (!/<[a-z!/][^>]*>/i.test(s) && !/&[a-z#0-9]+;/i.test(s)) return s.trim();
  return s
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Cut a string at a word boundary with an ellipsis. */
export function shortTitle(s: string, max = 80): string {
  const t = s.trim().replace(/\s+/g, " ");
  if (t.length <= max) return t;
  return t.slice(0, max - 1).replace(/\s+\S*$/, "") + "…";
}
