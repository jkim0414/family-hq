#!/usr/bin/env tsx
// Demo screenshots of the app with dummy data (scripts/demo/data.ts). Serves a build of the
// app and answers every /api call with fake data — nothing real is read.
// Usage: npx vite build --outDir <dist>
//        npx tsx scripts/demo/screenshots.ts <dist> <outDir>
import { chromium, type Page } from "playwright";
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { join, extname } from "node:path";
import * as d from "./data";

const [dist, out] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const ORIGIN = "https://kimi.demo";
const TYPES: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".json": "application/json", ".webmanifest": "application/manifest+json", ".ico": "image/x-icon" };

function api(path: string, q: URLSearchParams): unknown {
  if (path === "/api/data") return { kids: d.kids, places: d.places, contacts: d.contacts, routines: d.routines, comms: d.comms, events: d.events, todos: d.todos, suggestions: [], actions: d.actions, audit: d.audit, spending: d.spending, profile: d.profile, v: 1 };
  if (path === "/api/tasks" && q.get("after")) return { unread: 0 };
  if (path === "/api/tasks" && q.get("id")) return { task: { id: "task-main", title: "Family chat", status: "open", log: d.chatLog } };
  if (path === "/api/tasks") return { tasks: d.tasks };
  if (path === "/api/files") return { files: d.files };
  if (path === "/api/gmail") return { me: { connected: true, email: "alex@example.com", via: "imap", watch: true }, other: { id: "sam", connected: true, email: "sam@example.com", via: "imap", watch: true } };
  if (path === "/api/workcal") return { alex: { connected: true, source: "google", label: "alex@work.example", next7days: 24 }, sam: { connected: true, source: "google", label: "sam@work.example", next7days: 61 }, shareWith: "family@example.com" };
  if (path === "/api/vault")
    return {
      configured: true,
      onePassword: { connected: true, vault: "Family HQ" },
      credentials: [
        { name: "Amazon", site: "amazon.com", username: "family@example.com", source: "1password", hasOtp: true },
        { name: "Springfield Rec", site: "springfield.example.gov", username: "family@example.com", source: "1password" },
        { name: "Instacart", site: "instacart.com", username: "family@example.com", source: "1password" },
        { name: "Paperless Post", site: "paperlesspost.com", username: "family@example.com", source: "1password" },
      ],
    };
  return {};
}

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, timezoneId: "America/Los_Angeles", serviceWorkers: "block", colorScheme: (process.env.SCHEME as "light" | "dark") || "light" });
await ctx.route("**/*", async (route) => {
  const url = new URL(route.request().url());
  if (url.origin !== ORIGIN) return route.abort();
  if (url.pathname.startsWith("/api/")) return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(api(url.pathname, url.searchParams)) });
  const file = join(dist, url.pathname === "/" ? "index.html" : url.pathname);
  const body = existsSync(file) && extname(file) ? readFileSync(file) : readFileSync(join(dist, "index.html"));
  return route.fulfill({ status: 200, contentType: TYPES[extname(file)] || "text/html", body });
});
// Show notifications as on (a subscribed phone) instead of the headless browser's "blocked".
// Passed as a string: the TS runner rewrites functions with helpers that don't exist in the page.
await ctx.addInitScript(`
  try { Object.defineProperty(Notification, "permission", { configurable: true, get: () => "granted" }); } catch (e) {}
  try {
    const reg = { pushManager: { getSubscription: async () => ({ endpoint: "demo" }) }, update: async () => {}, addEventListener() {} };
    const sw = { ready: Promise.resolve(reg), register: async () => reg, getRegistrations: async () => [], addEventListener() {}, controller: null };
    Object.defineProperty(Navigator.prototype, "serviceWorker", { configurable: true, get: () => sw });
  } catch (e) {}
`);
await ctx.grantPermissions(["notifications"], { origin: ORIGIN });
const page = await ctx.newPage();
await page.clock.setFixedTime(new Date("2026-09-28T08:15:00-07:00"));

async function shot(path: string, name: string, prep?: (p: Page) => Promise<void>) {
  await page.goto(ORIGIN + path, { waitUntil: "networkidle" });
  await page.waitForTimeout(700);
  if (prep) await prep(page);
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(out, name) });
  console.log("saved", name);
}

await shot("/", "1-home.png");
await shot("/chat", "2-chat-latest.png");
const scrollChatTo = (text: string) => async (p: Page) => {
  await p.getByText(text, { exact: false }).first().evaluate((el) => el.closest("div.flex")?.scrollIntoView({ block: "start" }));
};
await shot("/chat", "3-chat-rsvp.png", scrollChatTo("Did we RSVP to Maya"));
await shot("/chat", "4-chat-trip-planning.png", scrollChatTo("When could we get away"));
await shot("/agenda", "5-agenda.png");
await shot("/assistant", "6-kimi-connections.png");
await shot("/assistant", "7-kimi-spending.png", async (p) => {
  await p.getByRole("button", { name: /Spending/ }).first().click().catch(() => {});
  await p.waitForTimeout(300);
  await p.locator("#spending").scrollIntoViewIfNeeded().catch(() => {});
  await p.evaluate(() => document.getElementById("spending")?.scrollIntoView({ block: "start" }));
});
await shot("/household", "8-household.png");
await browser.close();
