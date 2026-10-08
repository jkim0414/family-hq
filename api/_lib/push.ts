import { localSkip } from "./sandbox.js";
import webpush from "web-push";
import { redis } from "./db.js";

// Web Push for the installed PWA (iOS 16.4+ / Android / desktop). Subscriptions
// are stored per parent; delivery is best-effort and dead subscriptions are
// pruned on 404/410.

export interface PushSub {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export function pushConfigured(): boolean {
  return !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
}

export function publicKey(): string {
  return process.env.VAPID_PUBLIC_KEY || "";
}

let vapidReady = false;
function setup() {
  if (vapidReady) return;
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || "mailto:assistant@example.com", process.env.VAPID_PUBLIC_KEY!, process.env.VAPID_PRIVATE_KEY!);
  vapidReady = true;
}

const key = (userId: string) => `push:${userId}`;

export async function getSubscriptions(userId: string): Promise<PushSub[]> {
  return (await redis.get<PushSub[]>(key(userId))) ?? [];
}

export async function addSubscription(userId: string, sub: PushSub): Promise<number> {
  const list = (await getSubscriptions(userId)).filter((s) => s.endpoint !== sub.endpoint);
  list.push(sub);
  await redis.set(key(userId), list);
  return list.length;
}

export async function removeSubscription(userId: string, endpoint: string): Promise<number> {
  const list = (await getSubscriptions(userId)).filter((s) => s.endpoint !== endpoint);
  await redis.set(key(userId), list);
  return list.length;
}

/** Send a notification to every device the parent enabled. Returns how many were delivered. */
export async function sendPush(userId: string, payload: { title: string; body: string; url?: string; tag?: string }): Promise<number> {
  if (localSkip(`push to ${userId}`)) return 0;
  if (!pushConfigured()) return 0;
  setup();
  const subs = await getSubscriptions(userId);
  let sent = 0;
  const dead: string[] = [];
  for (const sub of subs) {
    try {
      await webpush.sendNotification(sub, JSON.stringify(payload), { TTL: 60 * 60 * 6 });
      sent++;
    } catch (e: any) {
      if (e?.statusCode === 404 || e?.statusCode === 410) dead.push(sub.endpoint);
      else console.error("push failed", e?.statusCode || e);
    }
  }
  if (dead.length) await redis.set(key(userId), subs.filter((s) => !dead.includes(s.endpoint)));
  return sent;
}
