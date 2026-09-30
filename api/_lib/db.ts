// Cloud data store (Upstash Redis) — the autonomous system's source of truth.
// Each collection is stored as a single JSON value under a stable key. The
// @upstash/redis client serializes/parses objects automatically.

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

export async function getCollection<K extends Collection>(
  name: K
): Promise<AppState[K]> {
  const val = await redis.get<AppState[K]>(name);
  return (val ?? []) as AppState[K];
}

export async function setCollection<K extends Collection>(
  name: K,
  value: AppState[K]
): Promise<void> {
  await redis.set(name, value);
  await bumpStateVersion();
}

/** Monotonic counter bumped on every write to app state; lets clients skip unchanged reloads. */
export async function bumpStateVersion(): Promise<void> {
  await redis.incr("state_ver").catch(() => {});
}
export async function getStateVersion(): Promise<number> {
  return Number((await redis.get<number>("state_ver")) || 0);
}

// The household profile is a singleton object (not an array collection).
const DEFAULT_PROFILE: HouseholdProfile = { sections: [], people: [] };
export async function getProfile(): Promise<HouseholdProfile> {
  return (await redis.get<HouseholdProfile>("profile")) ?? DEFAULT_PROFILE;
}
export async function setProfile(p: HouseholdProfile): Promise<void> {
  await redis.set("profile", p);
  await bumpStateVersion();
}

/** Everything in one round trip (MGET). */
export async function getState(): Promise<AppState & { profile: HouseholdProfile }> {
  const vals = await redis.mget<unknown[]>(...COLLECTIONS, "profile");
  const base = Object.fromEntries(COLLECTIONS.map((c, i) => [c, (vals[i] as unknown) ?? []])) as unknown as AppState;
  return { ...base, profile: (vals[COLLECTIONS.length] as HouseholdProfile) ?? DEFAULT_PROFILE };
}

/** Append items to a collection, de-duplicating by id. */
export async function appendItems<K extends "comms" | "events" | "todos">(
  name: K,
  items: AppState[K]
): Promise<void> {
  const existing = await getCollection(name);
  const byId = new Map(existing.map((x) => [x.id, x]));
  for (const item of items) byId.set(item.id, item);
  await setCollection(name, Array.from(byId.values()) as AppState[K]);
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
  const audit = await getCollection("audit");
  audit.push({ id: `aud-${Date.now().toString(36)}-${randomBytes(2).toString("hex")}`, at: new Date().toISOString(), ...entry });
  await setCollection("audit", audit.slice(-300));
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
