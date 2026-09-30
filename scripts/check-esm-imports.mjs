#!/usr/bin/env node
// Vercel runs the API as Node ESM, which needs explicit ".js" on relative imports. TypeScript and
// Vite both accept extensionless imports, so a missing ".js" passes the gate and then takes down
// every route at runtime. This fails the build instead. Checks api/** and the src/data modules the
// API imports. Type-only imports are erased at compile time and are allowed.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
const files = [];
const walk = (d) => { for (const f of readdirSync(d)) { const p = join(d, f); statSync(p).isDirectory() ? walk(p) : /\.ts$/.test(p) && files.push(p); } };
walk("api");
walk("src/data");
const bad = [];
for (const f of files) {
  readFileSync(f, "utf8").split("\n").forEach((line, i) => {
    const m = line.match(/^\s*(import|export)\s+(?!type\b)[^"']*from\s+["'](\.{1,2}\/[^"']+)["']/);
    if (m && !/\.(js|json|mjs)$/.test(m[2])) bad.push(`${f}:${i + 1}: ${line.trim()}`);
  });
}
if (bad.length) {
  console.error(`Relative imports without ".js" (breaks the API on Vercel):\n${bad.join("\n")}`);
  process.exit(1);
}
console.log(`ESM imports OK (${files.length} files)`);
