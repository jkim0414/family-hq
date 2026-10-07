#!/usr/bin/env tsx
// Checks for travel cards, typed household facts, file versions, and moved screenshots.
// Restores everything it touches (travel cards are snapshotted and put back). No texts, no
// model calls unless --model (then: a throwaway chat asks Kimi to update a fact and save a
// loyalty number, and the result is checked and undone).
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split("\n")) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m) process.env[m[1]] = m[2].trim();
}
const db = await import("../api/_lib/db");
const { createSession, userById } = await import("../api/_lib/auth");
const { travelSecret, listTravelers } = await import("../api/_lib/travelers");
const { normalizeProfile, renderFacts } = await import("../src/data/facts");
const { createFile, updateFile, renderFile } = await import("../api/_lib/files");
const { proposeAction, actionScreenshot } = await import("../api/_lib/actions");
const routes = {
  travelers: (await import("../api/_routes/travelers")).default,
  profile: (await import("../api/_routes/profile")).default,
  data: (await import("../api/_routes/data")).default,
};

let pass = 0, fail = 0;
const check = (label: string, ok: boolean, detail = "") => { ok ? pass++ : fail++; console.log(`${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`); };
async function call(route: keyof typeof routes, sid: string, opts: { method?: string; body?: unknown } = {}) {
  let status = 200, body: any;
  const req: any = { method: opts.method || "GET", query: {}, headers: { cookie: `fhq_session=${sid}`, host: "localhost" }, body: opts.body, url: "/" };
  const res: any = { setHeader() { return this; }, status(c: number) { status = c; return this; }, json(b: any) { body = b; return this; }, send(b: any) { body = b; return this; }, end() { return this; } };
  await routes[route](req, res);
  return { status, body: typeof body === "string" ? (() => { try { return JSON.parse(body); } catch { return body; } })() : body };
}

const snapshot = (await db.redis.hgetall<Record<string, unknown>>("travelers")) || {};
// Real cards live here too: keep a copy for a day in case anything goes wrong mid-run.
if (Object.keys(snapshot).length) await db.redis.set(`travelers_backup:${Date.now()}`, snapshot, { ex: 86400 });
const alex = await createSession(userById("alex")!);
const grandma = await createSession(userById("grandma")!);
const cleanup: (() => Promise<unknown>)[] = [];
try {
  // ── Travel cards ──
  const all = (await call("travelers", alex)).body;
  check("a parent sees every travel card", all.travelers?.length === 6, `${all.travelers?.length}`);
  const mine = (await call("travelers", grandma)).body;
  check("Grandma sees only her own", mine.travelers?.length === 1 && mine.travelers[0].id === "grandma");
  const s403 = (await call("travelers", grandma, { method: "POST", body: { id: "alex", seat: "aisle" } })).status;
  check("Grandma can't edit Alex's card", s403 === 403, `HTTP ${s403}`);
  const saved = await call("travelers", alex, { method: "POST", body: { id: "theo", firstName: "Test", lastName: "Check", dob: "2015-06-15", passportNumber: "X1234567", passportExpires: "2031-05-01", ktn: "TT12345678", loyalty: [{ program: "United MileagePlus", number: "ZZ999999" }] } });
  check("saving a card with a passport works", saved.status === 200, JSON.stringify(saved.body).slice(0, 120));
  const shown = JSON.stringify((await call("travelers", alex)).body);
  check("the app never gets the full numbers", !shown.includes("X1234567") && !shown.includes("TT12345678") && shown.includes('"last4":"4567"'));
  check("the vault returns them for filling", (await travelSecret("theo", "passport")) === "X1234567" && (await travelSecret("theo", "ktn")) === "TT12345678");
  const lo = await call("travelers", alex, { method: "POST", body: { id: "theo", loyalty: [{ program: "mileageplus", number: "ab 123-456" }, { program: "Marriott", number: "123456789" }] } });
  check("loyalty: known programs get their full name; numbers are cleaned", JSON.stringify(lo.body?.traveler?.loyalty) === JSON.stringify([{ program: "United MileagePlus", number: "AB123456" }, { program: "Marriott Bonvoy", number: "123456789" }]), JSON.stringify(lo.body?.traveler?.loyalty));
  const lbad = await call("travelers", alex, { method: "POST", body: { id: "theo", loyalty: [{ program: "Delta SkyMiles", number: "12!" }] } });
  check("loyalty: a malformed number is refused", lbad.status === 400, lbad.body?.error);
  const { loyaltyWarning } = await import("../src/data/loyalty");
  check("loyalty: an unusual format only warns", !!loyaltyWarning({ program: "Delta SkyMiles", number: "123456789" }) && !loyaltyWarning({ program: "Delta SkyMiles", number: "1234567890" }) && !loyaltyWarning({ program: "My Local Club", number: "XYZ123" }));
  const bad = await call("travelers", alex, { method: "POST", body: { id: "theo", dob: "Jan 2" } });
  check("bad dates are refused", bad.status === 400, bad.body?.error);
  const cleared = await call("travelers", alex, { method: "POST", body: { id: "theo", passportNumber: null } });
  check("a passport can be removed", cleared.status === 200 && !cleared.body.traveler.passport && (await travelSecret("theo", "passport")) === null);
  const raw = JSON.stringify(await db.redis.hget("travelers", "theo"));
  check("stored encrypted (no plaintext in Redis)", !raw.includes("TT12345678"));

  // ── Household facts ──
  const legacy = normalizeProfile({ sections: [{ key: "allergies", title: "Allergies", body: "- Max: wears glasses\n- Theo: needs sunscreen" }], people: [] } as any);
  check("old sections read as facts", legacy.facts.length === 2 && legacy.facts[0].topic === "health");
  check("facts render by topic with ids", /Health & allergies:\n- \[f-legacy-0\] Max: wears glasses/.test(renderFacts(legacy.facts, { withIds: true })));
  const ps = (await call("profile", grandma, { method: "POST", body: { profile: { facts: [], people: [] } } })).status;
  check("Grandma can't rewrite household facts", ps === 401 || ps === 403, `HTTP ${ps}`);
  const d = (await call("data", alex)).body;
  check("the app gets typed facts", Array.isArray(d.profile?.facts) && d.profile.facts.length > 10, `${d.profile?.facts?.length} facts`);

  // ── Files ──
  const f = await createFile({ title: "(travel-check) plan", markdown: "first" });
  cleanup.push(async () => { await db.redis.del(`file:${f.id}`); await db.redis.srem("files_index", f.id); });
  const f2 = await updateFile(f.id, { title: "(travel-check) plan", markdown: "second" });
  check("revising keeps one file with its history", f2?.id === f.id && f2.markdown === "second" && f2.versions?.length === 1 && f2.versions[0].markdown === "first");
  check("old versions render on request", renderFile(f2!, { version: 1 }).includes("<p>first</p>") && renderFile(f2!).includes("<p>second</p>") && renderFile(f2!).includes("versions:"));

  // ── Screenshots ──
  const a = await proposeAction({ kind: "confirm_step", title: "(travel-check) step", summary: "test", payload: { taskId: "task-web-x", description: "(travel-check)", screenshot: "AAAA" } as any, requestedBy: "agent", channel: "app" });
  cleanup.push(async () => { await db.setCollection("actions", (await db.getCollection("actions")).filter((x) => x.id !== a.id)); await db.redis.del(`action_shot:${a.id}`); });
  const stored = (await db.getCollection("actions")).find((x) => x.id === a.id);
  check("approval screenshots are stored outside the list", !(stored?.payload as any).screenshot && (stored?.payload as any).hasScreenshot === true && (await actionScreenshot(stored!)) === "AAAA");

  // ── Kimi (real model) ──
  if (process.argv.includes("--model")) {
    const agent = await import("../api/_lib/agent");
    const id = `task-verify-travel-${Date.now().toString(36)}`;
    cleanup.push(async () => { await db.redis.del(`task:${id}`, `task_thread:${id}`); await db.redis.srem("tasks_index", id); await db.redis.srem("tasks_active", id); });
    // A throwaway fact to update (removed afterwards), so the check works on any household's data.
    const { newFactId } = await import("../src/data/facts");
    const planted = { id: newFactId(), topic: "food" as const, about: ["theo"], text: "(travel-check) Theo's favorite snack is pretzels.", updatedAt: new Date().toISOString() };
    { const p = await db.getProfile(); await db.setProfile({ ...p, facts: [...p.facts, planted] }); }
    cleanup.push(async () => { const p = await db.getProfile(); await db.setProfile({ ...p, facts: p.facts.filter((x) => x.id !== planted.id) }); });
    const before = (await db.getProfile()).facts;
    const run = async (text: string) => {
      const t: any = (await db.getTask(id)) || agent.newTask(id, "test", "alex", "app");
      agent.addUserMessage(t, "alex", "app", text);
      await db.saveTask(t);
      const reply = await agent.runAgent(t, { deadlineMs: Date.now() + 150_000 });
      return { reply, tools: t.log.filter((e: any) => e.kind === "tool").map((e: any) => e.text.slice(0, 140)) };
    };
    const tang = before.find((x) => x.id === planted.id);
    const r1 = await run("(Test) Update: Theo's favorite snack is now apple slices, not pretzels.");
    const after = (await db.getProfile()).facts;
    const now = after.find((x) => x.id === tang?.id);
    check("remember updates the fact instead of adding one", !!tang && !!now && now.text !== tang.text && after.length === before.length, `${now?.text} | ${r1.tools.filter((x: string) => x.startsWith("remember")).join(" ")}`);
    const r2 = await run("(Test) Theo's MileagePlus number is QQ123456.");
    const jc = (await listTravelers("alex")).find((t) => t.id === "theo");
    check("a loyalty number from chat lands on the travel card", !!jc?.loyalty.some((l) => l.number === "QQ123456"), r2.tools.filter((x: string) => x.startsWith("save_traveler")).join(" "));
  }
} catch (e) {
  fail++;
  console.error("✗ check crashed:", e);
} finally {
  for (const c of cleanup.reverse()) await c().catch((e) => console.error("cleanup failed", e));
  await db.redis.del("travelers");
  if (Object.keys(snapshot).length) await db.redis.hset("travelers", snapshot);
  const audit = await db.getCollection("audit");
  await db.setCollection("audit", audit.filter((x) => !/travel-check|Theo's travel card/.test(String(x.summary))));
  await db.redis.del(`session:${alex}`, `session:${grandma}`);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
