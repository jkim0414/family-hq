// Cloud data store (Upstash Redis) — the autonomous system's source of truth.
// Each collection is a Redis hash, one field per item (see "Collections" below), so writers
// that run at once (the ingest heartbeat, chat, texts, browser jobs, calendar sync) change
// only their own items and never overwrite each other's.

import { normalizeProfile } from "../../src/data/facts.js";
import { registerAliases } from "../../src/data/people.js";
import { CONFIG } from "../../src/data/config.js";

// Names the family uses for the caregiver, from config (server-only: never in the app bundle).
registerAliases({ grandma: [CONFIG.caregivers.grandma.name, CONFIG.caregivers.grandma.name.split(" ")[0], CONFIG.caregivers.grandma.callMe].filter(Boolean) });
import { Redis } from "@upstash/redis";
import { randomBytes } from "node:crypto";
import type { Kid, Contact, Place, Routine, Comm, CalEvent, Todo, Suggestion, HouseholdProfile, Task, Action, AuditEntry, FileDoc, Purchase, Schedule } from "../../src/data/types";

// Accept either the Upstash-native or Vercel-KV env var names.
export const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN!,
});

export interface AppState {
  kids: Kid[];
  places: Place[];
  contacts: Contact[];
  routines: Routine[];
  comms: Comm[];
  events: CalEvent[];
  todos: Todo[];
  suggestions: Suggestion[];
  actions: Action[];
  audit: AuditEntry[];
  spending: Purchase[];
  schedules: Schedule[];
}

type Collection = keyof AppState;
const COLLECTIONS: Collection[] = [
  "kids",
  "places",
  "contacts",
  "routines",
  "comms",
  "events",
  "todos",
  "suggestions",
  "actions",
  "audit",
  "spending",
  "schedules",
];

// ── Collections ──────────────────────────────────────────────────────────────
// Stored as a hash `c:<name>`: field = item id, value = "<seq>|<item JSON>". The sequence number
// keeps the list in insertion order (an update keeps its place). A read remembers each item's JSON;
// setCollection then writes only the items that changed since that read, and removes only the
// ones the caller dropped from what it read — never items another writer added meanwhile.
// (Until 2026-10-08 each collection was one JSON value rewritten whole: two overlapping writers
// silently lost one's change. Old values are migrated on first use and kept as bak:<name>.)

// DATA_NS: a separate namespace for tests (scripts/collections-check.ts) — never set in production.
const NS = process.env.DATA_NS || "";
const hashKey = (name: string) => `${NS}c:${name}`;
const seqKey = (name: string) => `${NS}cseq:${name}`;
const markKey = (name: string) => `${NS}cver:${name}`;

type Item = { id: string };
// What each item looked like when read, and the ids that read returned.
const snapshots = new WeakMap<object, { json: string; read: Set<string> }>();

// Upsert, keeping an existing item's place in the order.
const UPSERT_LUA = `
for i = 1, #ARGV, 2 do
  local cur = redis.call('HGET', KEYS[1], ARGV[i])
  local o = cur and string.match(cur, '^(%d+)|') or nil
  if not o then o = redis.call('INCR', KEYS[2]) end
  redis.call('HSET', KEYS[1], ARGV[i], o .. '|' .. ARGV[i + 1])
end
return #ARGV / 2`;

async function upsert(name: string, items: Item[]): Promise<void> {
  for (let i = 0; i < items.length; i += 100) {
    const args = items.slice(i, i + 100).flatMap((x) => [String(x.id), JSON.stringify(x)]);
    if (args.length) await redis.eval(UPSERT_LUA, [hashKey(name), seqKey(name)], args);
  }
}

function parseHash(h: Record<string, unknown> | null): Item[] {
  if (!h) return [];
  const rows: { o: number; v: Item }[] = [];
  for (const raw of Object.values(h)) {
    const s = typeof raw === "string" ? raw : JSON.stringify(raw);
    const bar = s.indexOf("|");
    try {
      rows.push({ o: Number(s.slice(0, bar)), v: JSON.parse(s.slice(bar + 1)) });
    } catch {
      /* a corrupt field: skip it rather than fail the whole read */
    }
  }
  return rows.sort((a, b) => a.o - b.o).map((r) => r.v);
}

// Spending reads newest purchase first (as it was always stored); everything else in insertion order.
function ordered(name: string, items: Item[]): Item[] {
  return name === "spending" ? [...items].sort((a: any, b: any) => String(b.date || "").localeCompare(String(a.date || ""))) : items;
}

function track<T extends Item>(items: T[]): T[] {
  const read = new Set(items.map((x) => String(x.id)));
  for (const x of items) snapshots.set(x, { json: JSON.stringify(x), read });
  return items;
}

const migrated = new Set<string>();
/** Move a collection from its old single value into its hash (once; safe if two run at once). */
async function ensureMigrated(names: readonly string[]): Promise<void> {
  const todo = names.filter((n) => !migrated.has(n));
  if (!todo.length) return;
  const marks = await redis.mget<(string | number | null)[]>(...todo.map(markKey));
  for (let i = 0; i < todo.length; i++) {
    const name = todo[i];
    if (marks[i]) {
      migrated.add(name);
      continue;
    }
    if (await redis.set(`${markKey(name)}:lock`, 1, { nx: true, ex: 60 })) {
      const old = await redis.get<Item[]>(`${NS}${name}`);
      if (Array.isArray(old) && old.length) await upsert(name, old.filter((x) => x && x.id));
      if (old != null) await redis.rename(`${NS}${name}`, `${NS}bak:${name}:2026-10-08`).catch(() => {});
      await redis.set(markKey(name), 2);
    } else {
      // Another instance is migrating it: wait for it to finish.
      for (let t = 0; t < 40 && !(await redis.get(markKey(name))); t++) await new Promise((r) => setTimeout(r, 250));
    }
    migrated.add(name);
  }
}

export async function getCollection<K extends Collection>(name: K): Promise<AppState[K]> {
  await ensureMigrated([name]);
  return track(ordered(name, parseHash(await redis.hgetall(hashKey(name))))) as unknown as AppState[K];
}

/**
 * Save a collection the caller read (with getCollection) and changed: writes only the items that
 * differ from that read (and new ones), and removes the ones it read but left out. Items others
 * added or changed in the meantime are untouched. To remove items by id without having read
 * the collection, use removeItems; to add, appendItems.
 */
export async function setCollection<K extends Collection>(name: K, value: AppState[K]): Promise<void> {
  await ensureMigrated([name]);
  const items = value as unknown as Item[];
  const kept = new Set<string>();
  const reads = new Set<Set<string>>();
  const changed: Item[] = [];
  for (const x of items) {
    if (!x?.id) continue;
    kept.add(String(x.id));
    const json = JSON.stringify(x);
    const snap = snapshots.get(x);
    if (snap) reads.add(snap.read);
    if (!snap || snap.json !== json) changed.push(x);
  }
  const dropped = new Set<string>();
  for (const r of reads) for (const id of r) if (!kept.has(id)) dropped.add(id);
  if (changed.length) await upsert(name, changed);
  if (dropped.size) await redis.hdel(hashKey(name), ...dropped);
  for (const x of changed) {
    const snap = snapshots.get(x);
    if (snap) snap.json = JSON.stringify(x);
  }
  if (changed.length || dropped.size) await bumpStateVersion();
}

/** Add (or replace by id) items without reading the collection. */
export async function appendItems<K extends Collection>(name: K, items: AppState[K]): Promise<void> {
  await ensureMigrated([name]);
  const xs = (items as unknown as Item[]).filter((x) => x?.id);
  if (!xs.length) return;
  await upsert(name, xs);
  await bumpStateVersion();
  if (name === "comms") await trimOldRaw().catch((e) => console.error("raw trim failed", e));
}

/** Remove items by id. */
export async function removeItems(name: Collection, ids: string[]): Promise<void> {
  await ensureMigrated([name]);
  if (!ids.length) return;
  await redis.hdel(hashKey(name), ...ids.map(String));
  await bumpStateVersion();
}

/** Replace a collection outright (seeding and repair scripts only). */
export async function replaceCollection<K extends Collection>(name: K, items: AppState[K]): Promise<void> {
  await ensureMigrated([name]);
  await redis.del(hashKey(name));
  await upsert(name, (items as unknown as Item[]).filter((x) => x?.id));
  await bumpStateVersion();
}

/** Keep the newest `keep` items (by order); at most once an hour per collection. */
export async function trimCollection(name: Collection, keep: number): Promise<void> {
  if (!(await redis.set(`${NS}ctrim:${name}`, 1, { nx: true, ex: 3600 }))) return;
  const all = parseHash(await redis.hgetall(hashKey(name)));
  if (all.length > keep) await removeItems(name, all.slice(0, all.length - keep).map((x) => String(x.id)));
}

// Filed messages keep their full text for a season, then only the summary: the archive
// shouldn't become a copy of the parents' mail. Once a day.
const RAW_KEEP_DAYS = 120;
async function trimOldRaw(): Promise<void> {
  if (!(await redis.set(`${NS}ctrim:comms_raw`, 1, { nx: true, ex: 86400 }))) return;
  const cutoff = new Date(Date.now() - RAW_KEEP_DAYS * 86400000).toISOString();
  const old = (parseHash(await redis.hgetall(hashKey("comms"))) as Comm[]).filter((c) => c.raw && c.receivedAt < cutoff);
  if (old.length) await upsert("comms", old.map(({ raw: _r, ...rest }) => rest));
}

/** Monotonic counter bumped on every write to app state; lets clients skip unchanged reloads. */
export async function bumpStateVersion(): Promise<void> {
  await redis.incr("state_ver").catch(() => {});
}
export async function getStateVersion(): Promise<number> {
  return Number((await redis.get<number>("state_ver")) || 0);
}

// The household profile is a singleton object (not an array collection).
export async function getProfile(): Promise<HouseholdProfile> {
  return normalizeProfile(await redis.get<HouseholdProfile>("profile"));
}
export async function setProfile(p: HouseholdProfile): Promise<void> {
  await redis.set("profile", p);
  await bumpStateVersion();
}

/** Everything, in one round trip (a pipeline of HGETALLs). */
export async function getState(): Promise<AppState & { profile: HouseholdProfile }> {
  await ensureMigrated(COLLECTIONS);
  const p = redis.pipeline();
  for (const c of COLLECTIONS) p.hgetall(hashKey(c));
  p.get("profile");
  const vals = (await p.exec()) as unknown[];
  const base = Object.fromEntries(COLLECTIONS.map((c, i) => [c, track(ordered(c, parseHash(vals[i] as Record<string, unknown> | null)))])) as unknown as AppState;
  return { ...base, profile: normalizeProfile(vals[COLLECTIONS.length] as HouseholdProfile | null) };
}

/** Track which IMAP message UIDs we've already ingested (idempotency). */
export async function markUidSeen(uid: number): Promise<void> {
  await redis.sadd("seen_uids", uid);
}
export async function isUidSeen(uid: number): Promise<boolean> {
  return (await redis.sismember("seen_uids", uid)) === 1;
}

/** Track which Google Calendar event ids we've already imported (idempotency for
 *  the Personal-calendar reader — survives the user deleting the in-app mirror). */
export async function markGcalSeen(ids: string[]): Promise<void> {
  if (ids.length) await redis.sadd("seen_gcal_ids", ids[0], ...ids.slice(1));
}
export async function isGcalSeen(id: string): Promise<boolean> {
  return (await redis.sismember("seen_gcal_ids", id)) === 1;
}

/** Timestamp (ms) of the last calendar sync — used to time-gate frequent polls. */
export async function getLastCalSync(): Promise<number> {
  return (await redis.get<number>("last_calsync")) ?? 0;
}
export async function setLastCalSync(ms: number): Promise<void> {
  await redis.set("last_calsync", ms);
}

/** Append to the audit log (kept to the most recent 300 entries). */
export async function addAudit(entry: Omit<AuditEntry, "id" | "at">): Promise<void> {
  await appendItems("audit", [{ id: `aud-${Date.now().toString(36)}-${randomBytes(2).toString("hex")}`, at: new Date().toISOString(), ...entry }]);
  await trimCollection("audit", 300);
}

// ── Files: one key per file (markdown bodies can be large). ──────────────────
export async function getFile(id: string): Promise<FileDoc | null> {
  return (await redis.get<FileDoc>(`file:${id}`)) ?? null;
}
export async function saveFile(f: FileDoc): Promise<void> {
  f.updatedAt = new Date().toISOString();
  await redis.set(`file:${f.id}`, f);
  await redis.sadd("files_index", f.id);
}
export async function listFileIds(): Promise<string[]> {
  return (await redis.smembers("files_index")) ?? [];
}

// ── Agent tasks ──────────────────────────────────────────────────────────────
// `task:<id>` holds the small part (status, log, …) that the UI and the cron
// read often; `task_thread:<id>` holds the model thread (can be hundreds of KB),
// read only when the agent actually runs. `tasks_active` lists tasks that are
// running, waiting, or have a check-in scheduled — the only ones the cron visits.
export type TaskMeta = Omit<Task, "thread">;

const isActive = (t: TaskMeta) => !isTerminal(t) && (t.status === "running" || t.status === "waiting" || !!t.nextCheckAt);
const isTerminal = (t: TaskMeta) => t.status === "done" || t.status === "failed" || t.status === "cancelled";

/** The task WITH its model thread (for the agent). */
export async function getTask(id: string): Promise<Task | null> {
  const [meta, thread] = await redis.mget<[(Task & { thread?: unknown[] }) | null, unknown[] | null]>(`task:${id}`, `task_thread:${id}`);
  if (!meta) return null;
  return { ...meta, thread: thread ?? meta.thread ?? [] };
}

/** The task WITHOUT its thread (status, log, reply) — cheap. */
export async function getTaskMeta(id: string): Promise<TaskMeta | null> {
  const t = await redis.get<Task>(`task:${id}`);
  if (!t) return null;
  const { thread: _t, ...meta } = t as Task;
  return meta;
}

export async function getTaskMetas(ids: string[]): Promise<TaskMeta[]> {
  if (!ids.length) return [];
  const vals = await redis.mget<(Task | null)[]>(...ids.map((i) => `task:${i}`));
  return vals.filter((v): v is Task => !!v).map(({ thread: _t, ...meta }) => meta);
}

export async function saveTask(task: Task): Promise<void> {
  task.updatedAt = new Date().toISOString();
  const { thread, ...meta } = task;
  await redis.set(`task:${task.id}`, meta);
  // A finished background job's thread is never read again — drop it (the log stays).
  if (isTerminal(meta) && meta.kind === "browser") await redis.del(`task_thread:${task.id}`);
  else await redis.set(`task_thread:${task.id}`, thread);
  await redis.sadd("tasks_index", task.id);
  if (isActive(meta)) await redis.sadd("tasks_active", task.id);
  else await redis.srem("tasks_active", task.id);
}

export async function listTaskIds(): Promise<string[]> {
  return (await redis.smembers("tasks_index")) ?? [];
}
export async function listActiveTaskIds(): Promise<string[]> {
  return (await redis.smembers("tasks_active")) ?? [];
}
/** Short exclusive lock so a chat request and the cron don't run the same task at once. */
export async function acquireTaskLock(id: string, ttlS = 300): Promise<boolean> {
  return (await redis.set(`task_lock:${id}`, "1", { nx: true, ex: ttlS })) === "OK";
}
export async function releaseTaskLock(id: string): Promise<void> {
  await redis.del(`task_lock:${id}`).catch(() => {});
}

/** Per-event last-synced version (Google's `updated` timestamp), keyed by gcalId.
 *  Lets the importer detect when an event was edited on Google Calendar. */
export async function getCalVersions(): Promise<Record<string, string>> {
  return (await redis.hgetall<Record<string, string>>("calsync_ver")) ?? {};
}
export async function setCalVersions(map: Record<string, string>): Promise<void> {
  if (Object.keys(map).length) await redis.hset("calsync_ver", map);
}
