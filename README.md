# Family HQ — Kimi, a family assistant

**Kimi** is a household assistant built for one family and meant to be forked and bent to
yours. She reads the parents' email, keeps the family calendar and to-dos, answers questions
in chat or by text, plans around work calendars, and — with one approval per job — acts on
the family's behalf in a real browser: registering for a class, placing an order, booking.

Everything family-specific lives in a few config files and in the app's own household
facts, so the code stays generic. The example family in this repo (Alex, Sam, and kids Max,
Theo, and Ava) is fictional.

## What it does

- **Reads the family's email.** Each parent's Gmail is watched read-only (IMAP with a Gmail
  app password). Known senders (school platforms, activities, invites, travel) go straight
  to filing; everything else is triaged on headers and a short excerpt by a small model, so
  unrelated mail is never read in full. Links in emails (invites, sign-up pages) are followed
  for details.
- **Files what matters.** Events go to Google Calendar, to-dos to the list, urgent items to
  the Home briefing. Prep is due before the event (buy it the day before, not the morning
  of), duplicates from several sources file once, and party invitations get a consistent
  checklist.
- **Answers and acts in chat.** One conversation shared by both parents, in the app or by
  SMS. Ask about the schedule, hand off a task, send a photo or PDF to file it.
- **Plans around work.** Both parents' work calendars are read as private context — never
  copied to the family calendar — with holds (drop-off, focus time, commutes) told apart from
  meetings.
- **Asks before anything irreversible — once.** Paying, booking, registering, cancelling:
  Kimi proposes, a parent approves, and only then does she act. A separate safety check
  reviews every payment click, card entry, and new browser job against what the parent
  actually asked for.
- **Pays without seeing your cards.** Logins and cards live in a 1Password vault and are
  filled straight into the page server-side; the model never sees them and page reads mask
  them. Payments to people are a Venmo link the parent confirms.
- **Keeps a spending log** from order and payment receipts in the inboxes.
- **Weather and drive times.** Daily digest with the forecast, rain/heat notes for outdoor
  events, and "leave by" times with a push before it's time to go.
- **Speaks as herself.** Kimi sends from her own address and number; she never writes to
  people as a parent.

## The app

An installable PWA (Vite + React + TypeScript + Tailwind) with five tabs: **Home** (what
needs you, today, tomorrow), **Chat**, **Agenda** (calendar and to-dos), **Household** (kids,
directory, household facts), and **Kimi** (connections, logins, files, spending, history).
Login is a 6-digit emailed code, parents only.

## How it works

- **Backend:** one Vercel serverless function (`api/router.ts`) serving every route in
  `api/_routes/**`.
- **Data:** Upstash Redis — collections as JSON documents, a version counter for cheap
  polling, tasks split into metadata and model thread.
- **AI:** Claude via the Anthropic API — a larger model for the agent, small models for
  triage, classification, receipts, and the safety check. Prompts are cached; finished chat
  turns are compacted.
- **The agent** (`api/_lib/agent.ts`) is a hand-built tool loop that checkpoints to Redis
  after every step, so long jobs outlive a serverless invocation; a per-minute cron resumes
  them.
- **Browser:** Browserbase (hosted Chrome over CDP, driven with `playwright-core`); a local
  Chromium in development.
- **Scheduling:** an external cron hits `/api/ingest` every minute; each stage self-gates
  (inbox watch and calendar mirror every ~15 minutes).
- **Weather / travel:** US National Weather Service; OpenStreetMap Nominatim + OSRM.

## Make it yours

1. **Your family.** Edit `src/data/config.ts` (parents, emails, calendar), `src/data/people.ts`
   (who's who, colors), `src/data/kids.ts` and `src/data/meta.ts` (seed roster and directory),
   and the family block at the top of the classifier prompt in `api/_lib/classify.ts`. The
   parent ids (`alex`, `sam`) and kid ids appear throughout the code — rename them with a
   project-wide find-and-replace if you like.
2. **Your inboxes.** Add your school district's and activities' email domains to
   `KNOWN_SENDERS` in `api/_lib/watch.ts`.
3. **Your URL.** Replace `https://your-app.vercel.app` across the repo with your deployment's
   URL (and set `APP_URL`).
4. **Your house rules.** Prep conventions live in `api/_lib/conventions.ts`; standing facts
   (allergies, who covers pickups, vendors) are household facts you edit in the app.
5. **Your SMS pages.** `public/sms.html`, `terms.html`, and `privacy.html` are templates for
   an A2P 10DLC registration — replace the placeholder number, email, and business name.
6. **Kimi's avatar.** `public/kimi.jpg` and `public/kimi-192.png` are placeholders.

## Local development

```bash
npm install
cp .env.local.example .env.local   # then fill it in
npm run dev          # Vite dev server (the API runs on Vercel)
npm run typecheck    # src and api
npm run build
```

Useful scripts in `scripts/` (run with `npx tsx`): `session.ts` mints a login cookie for
curl, `browser-e2e.ts` tests the approval loop against a local Chromium, `guard-check.ts`
exercises the safety check, `card-fill-check.ts` tests card filling with Stripe's test card,
`redis-count.ts` counts Redis commands per cron tick, `cache-check.ts` measures prompt
caching, and `demo/screenshots.ts` renders the app with fake data.

## Environment

See `.env.local.example` for every variable. Required: `ANTHROPIC_API_KEY`, the Upstash
`KV_REST_API_URL` / `KV_REST_API_TOKEN`, `CRON_SECRET`, the Google OAuth client, and an
inbox for Kimi (`IMAP_USER` / `IMAP_PASS`). Everything else (parents' Gmail, Browserbase,
1Password, Twilio, web push, weather) is optional and turns on the matching feature.

## Privacy and safety notes

- Gmail app passwords are full-mailbox credentials; the code only searches and reads them.
  Turn on 2-Step Verification and keep secrets in your host's environment, never in code.
- Everything the assistant reads from email and web pages is untrusted input. The approval
  gate, the separate safety check, and masking of secrets are there because of that; keep
  them if you change the agent.
- Your data lives in your own Redis and hosting accounts. Model providers process it under
  their API terms.

## License

MIT — see [LICENSE](LICENSE). Use it, fork it, make it yours.
