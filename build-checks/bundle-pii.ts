#!/usr/bin/env tsx
// Build gate: nothing in dist/ (the public app bundle — static files need no sign-in) may contain
// the family's details. The terms come from the server-side sources themselves (kids, config, the
// directory), so a new kid, teacher, or phone number is covered without editing this file.
// Runs after `vite build` (package.json "build"); fails the build on any match. It lives outside
// scripts/ because .vercelignore keeps scripts/ out of the deploy, and Vercel runs this check.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { KIDS } from "../src/data/kids";
import { CONFIG } from "../src/data/config";
import { CONTACTS, PLACES, ROUTINES } from "../src/data/meta";

const DIST = process.argv[2] || "dist";

// The SMS program's public pages name the operator's contact email (carrier registration needs it).
const ALLOWED: Record<string, string[]> = {
  "sms.html": [CONFIG.parents.alex.email],
  "terms.html": [CONFIG.parents.alex.email],
  "privacy.html": [CONFIG.parents.alex.email],
};

const terms = new Set<string>();
const add = (s: unknown) => {
  const t = String(s ?? "").trim();
  // Long enough to be specific: first names are the app's ids (and its chips) and can't be hidden.
  if (t.length >= 6) terms.add(t);
};
const addPhone = (p: unknown) => {
  const d = String(p ?? "").replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
  if (d.length !== 10) return;
  for (const f of [d, `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`, `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`, `${d.slice(3, 6)}-${d.slice(6)}`]) terms.add(f);
};

for (const k of KIDS as any[]) {
  add(k.fullName);
  add(k.dob);
  for (const year of [k.current, k.fall].filter(Boolean)) {
    add(year.school);
    add(year.aftercare);
    for (const t of year.teachers || []) add(t);
  }
}
for (const who of [...Object.values(CONFIG.parents), ...Object.values(CONFIG.caregivers)] as any[]) {
  add(who.name);
  add(who.email);
  addPhone(who.phone);
}
for (const e of CONFIG.calendar.alwaysInvite) add(e);
add(CONFIG.calendar.targetCalendarId);
for (const c of CONTACTS as any[]) {
  add(c.name);
  add(c.email);
  addPhone(c.phone);
}
for (const p of PLACES as any[]) {
  add(p.address);
  addPhone(p.phone);
  if (/\s/.test(p.name || "")) add(p.name);
}
for (const r of ROUTINES as any[]) add(r.detail);
// Work domains and the like that live only in prose elsewhere.
for (const t of CONFIG.bundleTerms) terms.add(t);

function* files(dir: string): Generator<string> {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) yield* files(p);
    else if (/\.(js|mjs|css|html|json|webmanifest|txt|map|vcf)$/.test(f)) yield p;
  }
}

const hits: string[] = [];
for (const path of files(DIST)) {
  const text = readFileSync(path, "utf8").toLowerCase();
  const name = relative(DIST, path);
  for (const t of terms) {
    if ((ALLOWED[name] || []).some((a) => a.toLowerCase() === t.toLowerCase())) continue;
    const i = text.indexOf(t.toLowerCase());
    if (i >= 0) hits.push(`${name}: "${t.length > 4 ? t.slice(0, 3) + "…" : t}" (${t.length} chars) at ${i}`);
  }
}
if (hits.length) {
  // Masked: the build log shouldn't repeat what it caught.
  console.error(`✗ The app bundle contains family details (${hits.length}):\n  ${hits.join("\n  ")}\nMove them behind /api/data (signed in); see build-checks/bundle-pii.ts.`);
  process.exit(1);
}
console.log(`✓ bundle clean: ${terms.size} family terms checked in ${DIST}/`);
