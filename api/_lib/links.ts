import { htmlToText } from "../../src/data/text.js";
import * as web from "./browser.js";

// ─────────────────────────────────────────────────────────────────────────────
// Emails often keep the details behind a link — "RSVP here", "see the full
// schedule", a Google Doc, an Evite. Before classifying, follow the few links
// that look like they hold details and hand the page text to the classifier.
// Plain fetch first; if a page is JS-rendered (an invite site) and the hosted
// browser is available, render it there.
// ─────────────────────────────────────────────────────────────────────────────

export interface Link {
  label: string;
  url: string;
}

const MAX_LINKS = 3;
const MAX_PAGE_CHARS = 6000;
const FETCH_TIMEOUT_MS = 8000;

// Links worth following: their anchor text or URL suggests details live there.
const WANT_RE = /\b(detail|info|event|invit|rsvp|sign ?up|schedule|register|registration|calendar|form|flyer|view|read more|learn more|click here|here|itinerary|confirm|ticket|agenda|program|newsletter|announcement)\b|docs\.google|forms\.gle|drive\.google|evite|paperlesspost|punchbowl|partiful|signupgenius|teamsnap|leagueapps|parentsquare|smore\.com|bit\.ly|tinyurl|lnk\.to/i;
// Never follow.
// (Tracking redirects are NOT skipped — invite and school platforms wrap every
// real link in one; fetch follows the redirect to the actual page.)
const SKIP_RE = /unsubscribe|opt.?out|manage (your )?preferences|notification settings|settings|privacy|terms of|mailto:|tel:|\.(png|jpe?g|gif|svg|webp|pdf|ics)(\?|$)|facebook\.com|twitter\.com|x\.com\/|instagram\.com|linkedin\.com|youtube\.com|apps\.apple\.com|play\.google\.com|list-manage\.com\/(unsubscribe|profile)/i;

/** Links from an HTML body (labelled) and bare URLs from text. */
export function extractLinks(text: string, html?: string): Link[] {
  const out: Link[] = [];
  const seen = new Set<string>();
  const add = (url: string, label: string) => {
    const u = url.trim().replace(/[)\].,;]+$/, "");
    if (!/^https?:\/\//i.test(u) || seen.has(u)) return;
    seen.add(u);
    out.push({ url: u, label: label.replace(/\s+/g, " ").trim().slice(0, 80) });
  };
  if (html) {
    for (const m of html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) add(m[1], htmlToText(m[2]));
  }
  for (const m of (text || "").matchAll(/https?:\/\/[^\s<>"')\]]+/g)) add(m[0], "");
  return out;
}

/** The subset worth fetching, most promising first. */
export function pickLinks(links: Link[], max = MAX_LINKS): Link[] {
  const scored = links
    .filter((l) => !SKIP_RE.test(l.url) && !SKIP_RE.test(l.label))
    .map((l) => ({ l, score: (WANT_RE.test(l.label) ? 2 : 0) + (WANT_RE.test(l.url) ? 1 : 0) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, max).map((x) => x.l);
}

async function fetchText(url: string): Promise<{ text: string; finalUrl: string } | null> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(url, { redirect: "follow", signal: ctl.signal, headers: { "user-agent": "Mozilla/5.0 (FamilyHQ; +https://your-app.vercel.app)", accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5" } });
    if (!r.ok) return null;
    const ct = r.headers.get("content-type") || "";
    if (!/text\/html|text\/plain|application\/xhtml/i.test(ct)) return null;
    const raw = (await r.text()).slice(0, 600_000);
    const body = raw.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<nav[\s\S]*?<\/nav>|<footer[\s\S]*?<\/footer>/gi, " ");
    return { text: htmlToText(body).replace(/\n{3,}/g, "\n\n").slice(0, MAX_PAGE_CHARS), finalUrl: r.url || url };
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

/** Render a JS-heavy page in the hosted browser (best-effort, one page, short). */
// Hosted-browser time is metered; only render the invite platforms that are
// known to need JavaScript. Everything else gets the plain fetch only.
const RENDER_RE = /evite\.com|paperlesspost\.com|punchbowl\.com|partiful\.com|signupgenius\.com|greenvelope\.com/i;

async function renderText(url: string): Promise<string | null> {
  if (!web.browserConfigured() || !RENDER_RE.test(url)) return null;
  let handle: web.BrowserHandle | null = null;
  try {
    handle = await web.openBrowser();
    await web.goto(handle.page, url);
    const t = await handle.page.evaluate("(document.body && document.body.innerText) || ''");
    return String(t).replace(/\n{3,}/g, "\n\n").slice(0, MAX_PAGE_CHARS);
  } catch {
    return null;
  } finally {
    if (handle) {
      await handle.browser.close().catch(() => {});
      await web.releaseSession(handle.sessionId).catch(() => {});
    }
  }
}

/**
 * Follow the most promising links and return a block of page text for the
 * classifier ("" when nothing useful). Pages that come back nearly empty
 * (client-rendered) are re-read in the hosted browser when available.
 */
export async function fetchLinkedPages(links: Link[], opts: { max?: number; render?: boolean } = {}): Promise<string> {
  const chosen = pickLinks(links, opts.max ?? MAX_LINKS);
  if (!chosen.length) return "";
  const blocks: string[] = [];
  let didRender = false; // the hosted browser is slow (~20s) — at most one render per message
  for (const l of chosen) {
    let got = await fetchText(l.url);
    let text = got?.text || "";
    if (text.replace(/\s+/g, " ").length < 300 && opts.render !== false && !didRender) {
      didRender = true;
      const rendered = await renderText(got?.finalUrl || l.url);
      if (rendered && rendered.length > text.length) text = rendered;
    }
    if (text.replace(/\s+/g, " ").length < 80) continue;
    blocks.push(`--- ${l.label ? `"${l.label}" → ` : ""}${got?.finalUrl || l.url} ---\n${text}`);
  }
  return blocks.length ? `LINKED PAGES (fetched from links in the message; treat as part of it):\n${blocks.join("\n\n")}` : "";
}

/** Read one URL as text (plain fetch; hosted-browser render for JS-only invite pages). For the agent's read_link tool. */
export async function readUrl(url: string): Promise<string> {
  const got = await fetchText(url);
  let text = got?.text || "";
  if (text.replace(/\s+/g, " ").length < 300) {
    const rendered = await renderText(got?.finalUrl || url);
    if (rendered && rendered.length > text.length) text = rendered;
  }
  return text;
}

/** True when an invite page shows the family has already responded yes. */
export const ATTENDING_RE = /you('| a)re (attending|going|confirmed)|your rsvp:? ?(yes|attending)|you replied yes|you('| ha)ve rsvp'?d|rsvp'?d yes|attending:? yes/i;
