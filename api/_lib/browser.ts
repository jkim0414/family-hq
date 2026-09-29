import { chromium, type Browser, type Page } from "playwright-core";
import { redis } from "./db.js";

// ─────────────────────────────────────────────────────────────────────────────
// The agent's hands: a real Chromium the assistant drives over CDP.
//   • Production: Browserbase hosted sessions (keepAlive) — they outlive our
//     serverless invocations, so a task can span cron ticks and reconnect.
//   • Dev/tests: BROWSER_CDP_URL points at a local Chromium started with
//     --remote-debugging-port.
// Pages are exposed to the model as text: a numbered list of interactive
// elements plus the visible text. Screenshots only on request.
// ─────────────────────────────────────────────────────────────────────────────

const BB = "https://api.browserbase.com/v1";
const bbHeaders = () => ({ "x-bb-api-key": process.env.BROWSERBASE_API_KEY!, "content-type": "application/json" });

export function browserConfigured(): boolean {
  return !!process.env.BROWSER_CDP_URL || !!(process.env.BROWSERBASE_API_KEY && process.env.BROWSERBASE_PROJECT_ID);
}

export interface BrowserHandle {
  browser: Browser;
  page: Page;
  sessionId: string; // "local" in dev
}

// One persistent browser profile (cookies, local storage) shared by every task,
// so a site the assistant signed into once stays signed in — no 2FA dance on
// every job. Created on first use and remembered.
async function bbContextId(): Promise<string | null> {
  const cached = await redis.get<string>("bb_context_id").catch(() => null);
  if (cached) return cached;
  const r = await fetch(`${BB}/contexts`, { method: "POST", headers: bbHeaders(), body: JSON.stringify({ projectId: process.env.BROWSERBASE_PROJECT_ID }) });
  if (!r.ok) {
    console.error("Browserbase context create failed", r.status, (await r.text()).slice(0, 200));
    return null;
  }
  const { id } = (await r.json()) as { id: string };
  await redis.set("bb_context_id", id).catch(() => {});
  return id;
}

async function bbCreate(): Promise<{ id: string; connectUrl: string }> {
  const contextId = await bbContextId();
  const r = await fetch(`${BB}/sessions`, {
    method: "POST",
    headers: bbHeaders(),
    body: JSON.stringify({
      projectId: process.env.BROWSERBASE_PROJECT_ID,
      keepAlive: true,
      // An abandoned session (killed function, forgotten task) bills until this
      // expires — keep it short. Login state lives in the persistent context.
      timeout: 300,
      ...(contextId ? { browserSettings: { context: { id: contextId, persist: true } } } : {}),
    }),
  });
  if (!r.ok) throw new Error(`Browserbase create ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return (await r.json()) as { id: string; connectUrl: string };
}

async function bbGet(id: string): Promise<{ id: string; status: string; connectUrl?: string } | null> {
  const r = await fetch(`${BB}/sessions/${id}`, { headers: bbHeaders() });
  if (!r.ok) return null;
  return (await r.json()) as { id: string; status: string; connectUrl?: string };
}

/** End a hosted session (no-op for local). Best-effort. */
export async function releaseSession(sessionId?: string): Promise<void> {
  if (!sessionId || sessionId === "local" || !process.env.BROWSERBASE_API_KEY) return;
  await fetch(`${BB}/sessions/${sessionId}`, { method: "POST", headers: bbHeaders(), body: JSON.stringify({ status: "REQUEST_RELEASE" }) }).catch(() => {});
}

async function pickPage(browser: Browser): Promise<Page> {
  const ctx = browser.contexts()[0] || (await browser.newContext());
  const pages = ctx.pages();
  return pages[pages.length - 1] || (await ctx.newPage());
}

/** Connect to the task's existing session if it's still alive, else start one. */
export async function openBrowser(existingSessionId?: string): Promise<BrowserHandle> {
  if (process.env.BROWSER_CDP_URL) {
    const browser = await chromium.connectOverCDP(process.env.BROWSER_CDP_URL);
    return { browser, page: await pickPage(browser), sessionId: "local" };
  }
  if (!browserConfigured()) throw new Error("No browser configured (set BROWSERBASE_API_KEY + BROWSERBASE_PROJECT_ID)");
  let sessionId = existingSessionId;
  let connectUrl: string | undefined;
  if (sessionId) {
    const s = await bbGet(sessionId).catch(() => null);
    if (s?.status === "RUNNING" && s.connectUrl) connectUrl = s.connectUrl;
  }
  if (!connectUrl) {
    const s = await bbCreate();
    sessionId = s.id;
    connectUrl = s.connectUrl;
  }
  const browser = await chromium.connectOverCDP(connectUrl);
  return { browser, page: await pickPage(browser), sessionId: sessionId! };
}

// ── Page operations ──────────────────────────────────────────────────────────

const SEL = (n: number) => `[data-hq="${n}"]`;

async function settle(page: Page): Promise<void> {
  await page.waitForLoadState("domcontentloaded", { timeout: 8000 }).catch(() => {});
  await page.waitForLoadState("networkidle", { timeout: 4000 }).catch(() => {});
  await page.waitForTimeout(400);
}

const READ_SCRIPT = (maxText: number) => `(() => {
  const sel = 'a[href],button,input,select,textarea,[role="button"],[role="link"],[role="checkbox"],[role="tab"],[role="menuitem"],[contenteditable="true"]';
  const vis = (e) => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
  document.querySelectorAll('[data-hq]').forEach((e) => e.removeAttribute('data-hq'));
  const els = Array.from(document.querySelectorAll(sel)).filter(vis).slice(0, 220);
  const lines = els.map((e, i) => {
    e.setAttribute('data-hq', String(i));
    const tag = e.tagName.toLowerCase();
    const type = (e.getAttribute('type') || '').toLowerCase();
    let text = (e.innerText || '').trim();
    if (!text && e.labels && e.labels[0]) text = (e.labels[0].innerText || '').trim();
    if (!text) text = e.getAttribute('aria-label') || e.getAttribute('placeholder') || e.getAttribute('title') || e.getAttribute('name') || '';
    text = String(text).replace(/\\s+/g, ' ').slice(0, 80);
    const extra = [];
    if (tag === 'input' && (type === 'radio' || type === 'checkbox')) extra.push('name=' + e.name + ' value=' + e.value + (e.checked ? ' checked' : ''));
    else if (tag === 'input' || tag === 'textarea') {
      // Never show the model a secret it didn't type: passwords, anything Kimi filled from the vault, card fields.
      const secret = type === 'password' || e.hasAttribute('data-hq-secret') || /^cc-/.test(e.getAttribute('autocomplete') || '') || /card.?num|cc.?num|cvc|cvv|csc|security.?code/i.test((e.name || '') + ' ' + (e.id || ''));
      if (e.value) extra.push(secret ? 'value=(hidden, filled)' : 'value="' + String(e.value).slice(0, 40) + '"');
      if (e.required) extra.push('required');
    }
    if (tag === 'select') extra.push('options: ' + Array.from(e.options).slice(0, 15).map((o) => o.value + (o.selected ? '*' : '')).join('|'));
    if (tag === 'a') extra.push('→ ' + (e.getAttribute('href') || '').slice(0, 80));
    return '[' + i + '] ' + tag + (type ? '(' + type + ')' : '') + ' "' + text + '"' + (extra.length ? ' ' + extra.join(' ') : '');
  });
  const text = (document.body && document.body.innerText || '').replace(/\\n{3,}/g, '\\n\\n').slice(0, ${maxText});
  return { elements: lines.join('\\n'), text };
})()`;

/** The page as the model sees it: URL, title, numbered interactive elements, visible text. */
export async function readPage(page: Page, maxText = 6000): Promise<string> {
  await settle(page);
  const data = (await page.evaluate(READ_SCRIPT(maxText))) as { elements: string; text: string };
  return `URL: ${page.url()}\nTITLE: ${await page.title()}\n\nINTERACTIVE ELEMENTS (reference by [n]):\n${data.elements || "(none)"}\n\nPAGE TEXT:\n${data.text || "(empty)"}`;
}

/** The page's visible text (for the safety check's short list of facts). */
export async function pageText(page: Page): Promise<string> {
  return String(await page.evaluate("document.body ? document.body.innerText : ''").catch(() => ""));
}

export async function elementText(page: Page, n: number): Promise<string> {
  return (await page
    .$eval(SEL(n), (e: any) => (e.innerText || e.value || e.getAttribute("aria-label") || e.getAttribute("title") || "").trim())
    .catch(() => "")) as string;
}

export async function goto(page: Page, url: string): Promise<void> {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
  await settle(page);
}

export async function click(page: Page, n: number): Promise<void> {
  await page.click(SEL(n), { timeout: 10000 });
  await settle(page);
}

export async function type(page: Page, n: number, text: string, pressEnter = false): Promise<void> {
  await page.fill(SEL(n), text, { timeout: 10000 });
  if (pressEnter) {
    await page.press(SEL(n), "Enter");
    await settle(page);
  }
}

/** Type a vault secret into [n] and hide it from later reads and screenshots. */
export async function typeSecret(page: Page, n: number, text: string): Promise<void> {
  await page.fill(SEL(n), text, { timeout: 10000 });
  await page.$eval(SEL(n), (e: any) => {
    e.setAttribute("data-hq-secret", "1");
    e.style.setProperty("-webkit-text-security", "disc");
  }).catch(() => {});
}


export async function select(page: Page, n: number, value: string): Promise<void> {
  await page.selectOption(SEL(n), value, { timeout: 10000 }).catch(async () => {
    await page.selectOption(SEL(n), { label: value }, { timeout: 10000 });
  });
  await settle(page);
}

export async function press(page: Page, key: string): Promise<void> {
  await page.keyboard.press(key);
  await settle(page);
}

// ── Payment cards ────────────────────────────────────────────────────────────
// Checkout forms put card fields in the page or, very often, in a payment
// provider's iframe (Stripe, Braintree, Adyen…), which the element list can't
// see. So card filling finds the fields itself, across every frame, by the
// standard autocomplete names and common field names. Filled fields are masked.

export interface CardFill {
  number: string;
  expMonth: string; // MM
  expYear: string; // YYYY
  cvc: string;
  name: string;
  zip: string | null;
}

const CARD_FIELDS: Record<"number" | "exp" | "expMonth" | "expYear" | "cvc" | "name" | "zip", string[]> = {
  number: [
    'input[autocomplete="cc-number"]', 'input[name*="cardnumber" i]', 'input[name*="card_number" i]', 'input[name*="card-number" i]',
    'input[name*="ccnumber" i]', 'input[name*="cc-number" i]', 'input[name*="cc_number" i]', 'input[id*="cardnumber" i]', 'input[id*="card-number" i]',
    'input[id*="card_number" i]', 'input[data-elements-stable-field-name="cardNumber"]', 'input[name="encryptedCardNumber"]',
    'input[placeholder*="card number" i]', 'input[aria-label*="card number" i]', 'input[name="number"]',
  ],
  exp: [
    'input[autocomplete="cc-exp"]', 'input[data-elements-stable-field-name="cardExpiry"]', 'input[name*="exp-date" i]', 'input[name*="expdate" i]',
    'input[name*="expiry" i]', 'input[name*="expiration" i]', 'input[id*="expiry" i]', 'input[id*="exp-date" i]', 'input[id*="expiration" i]',
    'input[name="encryptedExpiryDate"]', 'input[placeholder*="MM / YY" i]', 'input[placeholder*="MM/YY" i]', 'input[aria-label*="expir" i]',
  ],
  expMonth: [
    'select[autocomplete="cc-exp-month"]', 'input[autocomplete="cc-exp-month"]', 'select[name*="exp_month" i]', 'select[name*="expmonth" i]',
    'select[name*="month" i]', 'select[id*="month" i]', 'input[name*="exp_month" i]', 'input[name*="expmonth" i]', 'input[name="encryptedExpiryMonth"]',
  ],
  expYear: [
    'select[autocomplete="cc-exp-year"]', 'input[autocomplete="cc-exp-year"]', 'select[name*="exp_year" i]', 'select[name*="expyear" i]',
    'select[name*="year" i]', 'select[id*="year" i]', 'input[name*="exp_year" i]', 'input[name*="expyear" i]', 'input[name="encryptedExpiryYear"]',
  ],
  cvc: [
    'input[autocomplete="cc-csc"]', 'input[data-elements-stable-field-name="cardCvc"]', 'input[name*="cvc" i]', 'input[name*="cvv" i]', 'input[name*="csc" i]',
    'input[name*="securitycode" i]', 'input[name*="security_code" i]', 'input[name*="security-code" i]', 'input[id*="cvc" i]', 'input[id*="cvv" i]',
    'input[name="encryptedSecurityCode"]', 'input[placeholder*="CVC" i]', 'input[placeholder*="CVV" i]', 'input[aria-label*="security code" i]',
  ],
  name: ['input[autocomplete="cc-name"]', 'input[name*="cardholder" i]', 'input[name*="nameoncard" i]', 'input[name*="name_on_card" i]', 'input[id*="cardholder" i]', 'input[placeholder*="name on card" i]'],
  // Billing-specific ZIP fields only; a generic ZIP counts only inside a payment provider's own frame.
  zip: ['input[autocomplete="billing postal-code"]', 'input[name*="billingpostal" i]', 'input[id*="billingpostal" i]', 'input[name*="billing_zip" i]', 'input[name*="billingzip" i]', 'input[data-elements-stable-field-name="postalCode"]'],
};
const GENERIC_ZIP = ['input[autocomplete="postal-code"]', 'input[name*="postal" i]', 'input[name*="zip" i]', 'input[placeholder*="ZIP" i]'];
const PAYMENT_FRAME_RE = /stripe|braintree|adyen|squareup|square\.site|checkout\.com|paypal|authorize\.net|cybersource|worldpay|recurly|chargebee|spreedly|vgs/i;

async function firstVisible(frame: import("playwright-core").Frame, sels: string[]) {
  for (const sel of sels) {
    const loc = frame.locator(sel);
    const count = await loc.count().catch(() => 0);
    for (let i = 0; i < Math.min(count, 3); i++) {
      const el = loc.nth(i);
      if (await el.isVisible().catch(() => false)) return el;
    }
  }
  return null;
}

async function mask(el: import("playwright-core").Locator) {
  await el.evaluate((e: any) => {
    e.setAttribute("data-hq-secret", "1");
    e.style.setProperty("-webkit-text-security", "disc");
  }).catch(() => {});
}

async function typeInto(el: import("playwright-core").Locator, value: string) {
  await el.click({ timeout: 5000 }).catch(() => {});
  await el.fill("", { timeout: 5000 }).catch(() => {});
  // Typing key by key works with the formatting/masking inputs payment providers use.
  await el.pressSequentially(value, { delay: 35, timeout: 15000 });
}

async function chooseOption(el: import("playwright-core").Locator, candidates: string[]) {
  for (const v of candidates) {
    if (await el.selectOption(v, { timeout: 3000 }).then(() => true).catch(() => false)) return true;
    if (await el.selectOption({ label: v }, { timeout: 3000 }).then(() => true).catch(() => false)) return true;
  }
  return false;
}

/** Fill whatever card fields the checkout shows. Returns which fields were filled (never the values). */
export async function fillCard(page: Page, card: CardFill): Promise<string[]> {
  const filled: string[] = [];
  const mm = card.expMonth.padStart(2, "0");
  const yy = card.expYear.slice(-2);
  for (const frame of page.frames()) {
    const num = await firstVisible(frame, CARD_FIELDS.number);
    const exp = await firstVisible(frame, CARD_FIELDS.exp);
    const cvc = await firstVisible(frame, CARD_FIELDS.cvc);
    const month = exp ? null : await firstVisible(frame, CARD_FIELDS.expMonth);
    const year = exp ? null : await firstVisible(frame, CARD_FIELDS.expYear);
    const name = await firstVisible(frame, CARD_FIELDS.name);
    if (!num && !exp && !cvc && !month) continue;
    if (num && !filled.includes("number")) {
      await typeInto(num, card.number);
      await mask(num);
      filled.push("number");
    }
    if (exp && !filled.includes("expiry")) {
      const ph = ((await exp.getAttribute("placeholder").catch(() => "")) || "").toUpperCase();
      const max = Number((await exp.getAttribute("maxlength").catch(() => "")) || 0);
      const value = ph.includes("YYYY") || max >= 7 ? `${mm}/${card.expYear}` : ph.includes("/") || max === 5 ? `${mm}/${yy}` : `${mm}${yy}`;
      await typeInto(exp, value);
      filled.push("expiry");
    }
    if (month && !filled.includes("expiry")) {
      const tag = await month.evaluate((e: any) => e.tagName.toLowerCase()).catch(() => "input");
      if (tag === "select") await chooseOption(month, [mm, String(Number(mm)), new Date(2000, Number(mm) - 1, 1).toLocaleString("en-US", { month: "long" }), `${mm} - ${new Date(2000, Number(mm) - 1, 1).toLocaleString("en-US", { month: "long" })}`]);
      else await typeInto(month, mm);
      if (year) {
        const ytag = await year.evaluate((e: any) => e.tagName.toLowerCase()).catch(() => "input");
        if (ytag === "select") await chooseOption(year, [card.expYear, yy]);
        else {
          const max = Number((await year.getAttribute("maxlength").catch(() => "")) || 0);
          await typeInto(year, max === 2 ? yy : card.expYear);
        }
      }
      filled.push("expiry");
    }
    if (cvc && !filled.includes("security code")) {
      await typeInto(cvc, card.cvc);
      await mask(cvc);
      filled.push("security code");
    }
    if (name && card.name && !filled.includes("name")) {
      const cur = await name.inputValue().catch(() => "");
      if (!cur) {
        await typeInto(name, card.name);
        filled.push("name");
      }
    }
    // Billing ZIP only inside the card's own frame/form, and only if empty (never a shipping ZIP).
    if (num && card.zip && !filled.includes("billing ZIP")) {
      const inProviderFrame = frame !== page.mainFrame() && PAYMENT_FRAME_RE.test(frame.url());
      const zip = (await firstVisible(frame, CARD_FIELDS.zip)) || (inProviderFrame ? await firstVisible(frame, GENERIC_ZIP) : null);
      if (zip && !(await zip.inputValue().catch(() => ""))) {
        await typeInto(zip, card.zip);
        filled.push("billing ZIP");
      }
    }
  }
  await settle(page);
  return filled;
}

export async function screenshot(page: Page): Promise<string> {
  const buf = await page.screenshot({ type: "jpeg", quality: 45, fullPage: false });
  return buf.toString("base64");
}
