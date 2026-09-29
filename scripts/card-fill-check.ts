#!/usr/bin/env tsx
// Check browser card filling (api/_lib/browser.ts fillCard) with Stripe's public TEST card only.
// Never submits anything. Uses a local Chromium (playwright).
import { chromium } from "playwright";
import { fillCard, readPage } from "../api/_lib/browser";
const TEST = { number: "4242424242424242", expMonth: "12", expYear: "2034", cvc: "123", name: "Test Parent", zip: "12345" };
const browser = await chromium.launch();
const page = await browser.newPage();

// 1) Mock checkout: fields in the page (separate month/year selects) + an embedded payment frame.
await page.setContent(`
  <h1>Checkout</h1><p>Order total: $13.87</p>
  <label>Name on card <input autocomplete="cc-name" name="ccname"></label>
  <select name="exp_month"><option value="">MM</option>${Array.from({ length: 12 }, (_, i) => `<option value="${String(i + 1).padStart(2, "0")}">${String(i + 1).padStart(2, "0")}</option>`).join("")}</select>
  <select name="exp_year"><option value="">YYYY</option>${Array.from({ length: 12 }, (_, i) => `<option>${2026 + i}</option>`).join("")}</select>
  <iframe id="pay" srcdoc='<input data-elements-stable-field-name="cardNumber" placeholder="Card number"><input data-elements-stable-field-name="cardCvc" placeholder="CVC"><input data-elements-stable-field-name="postalCode" placeholder="ZIP">'></iframe>
  <label>Shipping ZIP <input name="shipping_zip" value="12345"></label>
  <button>Place order</button>`);
await page.waitForTimeout(300);
const filled1 = await fillCard(page, TEST);
const frame = page.frames().find((f) => f !== page.mainFrame())!;
const got = {
  number: await frame.locator('[data-elements-stable-field-name="cardNumber"]').inputValue(),
  cvc: await frame.locator('[data-elements-stable-field-name="cardCvc"]').inputValue(),
  zip: await frame.locator('[data-elements-stable-field-name="postalCode"]').inputValue(),
  month: await page.locator('select[name="exp_month"]').inputValue(),
  year: await page.locator('select[name="exp_year"]').inputValue(),
  name: await page.locator('input[name="ccname"]').inputValue(),
};
const ok1 = got.number === TEST.number && got.cvc === "123" && got.zip === "12345" && got.month === "12" && got.year === "2034" && got.name === "Test Parent";
console.log(`mock checkout: filled [${filled1.join(", ")}] → ${ok1 ? "✓ all values correct" : "✗ " + JSON.stringify(got)}`);
const masked = await frame.locator('[data-elements-stable-field-name="cardNumber"]').evaluate((e: any) => getComputedStyle(e).getPropertyValue("-webkit-text-security"));
console.log(`card number masked on screen: ${masked === "disc" ? "✓" : "✗ " + masked}`);

// Page reads never show secrets: a password field typed by the site, and a cc-number in the main page.
await page.setContent(`<input type="password" value="hunter2"><input autocomplete="cc-number" value="4242424242424242"><input name="email" value="parent@example.com">`);
const read = await readPage(page, 500);
console.log(`page read hides password + card, shows email: ${!read.includes("hunter2") && !read.includes("4242424242424242") && read.includes("parent@example.com") ? "✓" : "✗\n" + read}`);

// 2) Stripe's public demo checkout (real Stripe Elements iframes), test card only, not submitted.
try {
  await page.goto("https://checkout.stripe.dev/preview", { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(4000);
  // The demo opens on a chooser: pick "Full page" (Stripe's hosted checkout, used by many stores), then "View demo".
  await page.getByText("Full page", { exact: true }).first().click({ timeout: 10000 }).catch(() => {});
  await page.getByText("View demo").first().click({ timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(8000);
  // Some layouts show a "Card" payment tab first.
  for (const f of page.frames()) await f.getByText("Card", { exact: true }).first().click({ timeout: 1500 }).catch(() => {});
  await page.waitForTimeout(2500);
  console.log("frames:", page.frames().map((f) => new URL(f.url() || "about:blank", "https://x").host || "(inline)").join(", "));
  const filled2 = await fillCard(page, TEST);
  console.log(`Stripe demo checkout: filled [${filled2.join(", ") || "nothing"}]`);
  await page.screenshot({ path: process.env.SHOT || "/tmp/stripe-fill.png" });
} catch (e) {
  console.log("Stripe demo unreachable:", String(e).slice(0, 120));
}
await browser.close();
