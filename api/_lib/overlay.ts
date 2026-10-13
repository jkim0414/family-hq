import type { Redis } from "@upstash/redis";

// ─────────────────────────────────────────────────────────────────────────────
// Local runs can't change the family's data. Outside the deployed app (checks and scripts),
// every write goes to a private overlay that expires on its own, while reads still see the real
// data (copy-on-write, per key). A test that forgets to clean up, or that Kimi surprises with a
// to-do of her own, leaves nothing in the family's app. A deliberate repair of live data runs with LIVE_DATA=1.
// Like sandbox.ts for texts, email, and calendar writes, but for the store itself.
// ─────────────────────────────────────────────────────────────────────────────

export const overlayOn = (): boolean => !process.env.VERCEL && process.env.LIVE_DATA !== "1";

const TTL_S = 6 * 3600;
const prefix = `ovl:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}:`;

/** Wrap a client: reads fall through to the real data until a key is written; writes stay private. */
export function withOverlay(raw: Redis): Redis {
  const copied = new Set<string>(); // keys that live in the overlay now
  const gone = new Set<string>(); // keys deleted in the overlay (the real one still exists)
  const P = (k: string) => prefix + k;
  const where = (k: string) => (gone.has(k) ? null : copied.has(k) ? P(k) : k);

  async function copy(k: string): Promise<void> {
    if (copied.has(k)) return;
    copied.add(k);
    if (gone.delete(k)) return; // deleted, then written again: starts empty
    const type = await raw.type(k);
    if (type === "string") await raw.set(P(k), await raw.get(k));
    else if (type === "hash") { const h = await raw.hgetall(k); if (h && Object.keys(h).length) await raw.hset(P(k), h); }
    else if (type === "set") { const m = await raw.smembers(k); if (m.length) await raw.sadd(P(k), m[0], ...m.slice(1)); }
    else if (type === "list") { const l = await raw.lrange(k, 0, -1); if (l.length) await raw.rpush(P(k), ...l); }
    else if (type === "zset") {
      const z = (await raw.zrange(k, 0, -1, { withScores: true })) as unknown[];
      for (let i = 0; i < z.length; i += 2) await raw.zadd(P(k), { score: Number(z[i + 1]), member: z[i] as string });
    }
  }
  const touch = (k: string) => raw.expire(P(k), TTL_S).catch(() => 0);
  async function write<T>(k: string, fn: (pk: string) => Promise<T>): Promise<T> {
    await copy(k);
    const r = await fn(P(k));
    await touch(k);
    return r;
  }
  const read = async <T>(k: string, fn: (key: string) => Promise<T>, empty: T): Promise<T> => {
    const w = where(k);
    return w === null ? empty : fn(w);
  };
  const globRe = (g: string) => new RegExp(`^${g.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`);

  const api: Record<string, (...a: any[]) => Promise<any>> = {
    get: (k: string) => read(k, (x) => raw.get(x), null),
    mget: async (...ks: any[]) => Promise.all((Array.isArray(ks[0]) ? ks[0] : ks).map((k: string) => read(k, (x) => raw.get(x), null))),
    set: async (k: string, v: unknown, opts?: any) => {
      if (opts?.nx && (await api.exists(k))) return null;
      await copy(k);
      const r = await raw.set(P(k), v, { ...(opts || {}), ...(opts?.ex || opts?.px ? {} : { ex: TTL_S }) } as any);
      return r;
    },
    getdel: async (k: string) => { const v = await api.get(k); await api.del(k); return v; },
    getex: (k: string) => api.get(k),
    exists: async (...ks: string[]) => { let n = 0; for (const k of ks) { const w = where(k); if (w && (await raw.exists(w))) n++; } return n; },
    del: async (...ks: string[]) => { for (const k of ks) { copied.delete(k); gone.add(k); await raw.del(P(k)); } return ks.length; },
    incr: (k: string) => write(k, (x) => raw.incr(x)),
    expire: async (k: string, s: number) => { await copy(k); return raw.expire(P(k), Math.min(s, TTL_S)); },
    rename: async (a: string, b: string) => { await copy(a); await raw.rename(P(a), P(b)); copied.delete(a); gone.add(a); copied.add(b); gone.delete(b); await touch(b); return "OK"; },
    hgetall: (k: string) => read(k, (x) => raw.hgetall(x), null),
    hget: (k: string, f: string) => read(k, (x) => raw.hget(x, f), null),
    hset: (k: string, v: any) => write(k, (x) => raw.hset(x, v)),
    hdel: (k: string, ...f: string[]) => write(k, (x) => raw.hdel(x, ...f)),
    smembers: (k: string) => read(k, (x) => raw.smembers(x), []),
    sismember: (k: string, m: unknown) => read(k, (x) => raw.sismember(x, m), 0),
    smismember: (k: string, ms: unknown[]) => read(k, (x) => raw.smismember(x, ms), ms.map(() => 0)),
    sadd: (k: string, ...m: any[]) => write(k, (x) => (raw.sadd as any)(x, ...m)),
    srem: (k: string, ...m: any[]) => write(k, (x) => (raw.srem as any)(x, ...m)),
    lrange: (k: string, a: number, b: number) => read(k, (x) => raw.lrange(x, a, b), []),
    rpush: (k: string, ...v: any[]) => write(k, (x) => (raw.rpush as any)(x, ...v)),
    zadd: (k: string, ...a: any[]) => write(k, (x) => (raw.zadd as any)(x, ...a)),
    zmscore: (k: string, ms: unknown[]) => read(k, (x) => (raw as any).zmscore(x, ms), ms.map(() => null)),
    zremrangebyscore: (k: string, a: number, b: number) => write(k, (x) => raw.zremrangebyscore(x, a, b)),
    eval: async (script: string, keys: string[], args: unknown[]) => { for (const k of keys) await copy(k); const r = await raw.eval(script, keys.map(P), args); for (const k of keys) await touch(k); return r; },
    keys: async (pattern: string) => {
      const re = globRe(pattern);
      const live = (await raw.keys(pattern)).filter((k) => !k.startsWith("ovl:") && !gone.has(k));
      return [...new Set([...live, ...[...copied].filter((k) => re.test(k))])];
    },
    scan: async (cursor: string | number, opts?: { match?: string; count?: number }) => {
      // One page with everything (checks scan small prefixes).
      return [0, await api.keys(opts?.match || "*")];
    },
    type: (k: string) => read(k, (x) => raw.type(x), "none"),
  };
  const pipeline = () => {
    const ops: (() => Promise<unknown>)[] = [];
    const p: any = new Proxy({}, { get: (_t, m: string) => (m === "exec" ? async () => { const out = []; for (const op of ops) out.push(await op()); return out; } : (...a: unknown[]) => { ops.push(() => (api as any)[m](...a)); return p; }) });
    return p;
  };
  return new Proxy(raw, {
    get(target, m: string) {
      if (m === "pipeline" || m === "multi") return pipeline;
      if (m in api) return api[m];
      const v = (target as any)[m];
      if (typeof v === "function") return () => { throw new Error(`overlay: redis.${m} isn't supported in a local run — add it to api/_lib/overlay.ts`); };
      return v;
    },
  }) as Redis;
}

/** Drop this run's overlay (checks call it at the end; it also expires on its own). */
export async function dropOverlay(raw: Redis): Promise<void> {
  const keys = await raw.keys(`${prefix}*`);
  for (let i = 0; i < keys.length; i += 200) await raw.del(...keys.slice(i, i + 200));
}
