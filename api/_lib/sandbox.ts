// ─────────────────────────────────────────────────────────────────────────────
// Outward effects — writing to Google Calendar (which emails invitations), texts, group texts,
// email, and push — only happen in the deployed app. A local script or test that runs Kimi
// against the real data reads everything but reaches no one, unless ALLOW_LOCAL_SIDE_EFFECTS=1.
// (A failed test run once put a fake event on the shared calendar, inviting a parent.)
// ─────────────────────────────────────────────────────────────────────────────

const deployed = () => !!process.env.VERCEL;

/** Whether outward effects are on here (the deployed app, or a local run that explicitly allows them). */
export const outwardEnabled = () => deployed() || process.env.ALLOW_LOCAL_SIDE_EFFECTS === "1";

/** True (and logged) when this outward step must be skipped because we're not the deployed app. */
export function localSkip(what: string): boolean {
  if (deployed() || process.env.ALLOW_LOCAL_SIDE_EFFECTS === "1") return false;
  console.log(`[local run] skipped ${what}`);
  return true;
}
