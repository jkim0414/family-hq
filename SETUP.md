# Setting up your own Kimi

Kimi runs on a handful of services. Five are required; the rest each switch on one feature and
stay off until their keys are set. Once you can sign in, **Kimi tab → Setup** shows what's on,
what's off, and links back to the right section here.

| Piece | What it unlocks | Required? | Rough cost |
|---|---|---|---|
| [Claude](#claude) | Kimi's brain | Yes | Pay-as-you-go API usage |
| [Database](#database) | Where everything is kept | Yes | Free tier is enough |
| [Kimi's email](#kimi-email) | Her inbox, login codes, and the address she writes from | Yes | Free (Gmail) |
| [Every-minute heartbeat](#heartbeat) | Email checks, background jobs, scheduled tasks | Yes | Free (cron-job.org) |
| [Google Calendar](#google-calendar) | The family calendar Kimi files to | Yes | Free |
| [Parents' Gmail](#parents-gmail) | Watching each parent's inbox (read-only) | Optional | Free |
| [Work calendars](#work-calendars) | Planning around meetings and travel | Optional | Free |
| [Texting](#texting) | Texting Kimi, one-on-one and in a family group text | Optional | A few dollars a month, plus a carrier registration |
| [Web tasks](#web-tasks) | Registering, ordering, booking in a real browser | Optional | Free tier, paid plan for real use |
| [Logins & cards](#logins-and-cards) | Signing in and paying without seeing passwords or cards | Optional | Your password manager plan |
| [Push notifications](#push) | Alerts on your phone | Optional | Free |
| [Weather](#weather) | Forecasts in the digest and on outdoor events | Optional | Free |

All keys go in your host's environment variables (Vercel → Project → Settings → Environment
Variables), never in code. `.env.local.example` lists every one. After changing them, redeploy.

## 0. Deploy

1. Fork the repo and import it into [Vercel](https://vercel.com/new) (the Hobby plan is fine).
2. Set **`APP_URL`** to your deployment's address, e.g. `https://my-family-hq.vercel.app`.
   Kimi uses it for links in texts and emails, the Google sign-in return address, and the
   group-text webhook.
3. Set **`CRON_SECRET`** to a long random string (`openssl rand -hex 24`). It protects the
   background endpoints and the one-time calendar connection.
4. Edit `src/data/config.ts` (the parents' names, emails, and phones: only those emails can sign
   in) and the other family files listed under **Make it yours** in the README.

<a id="claude"></a>
## Claude

Create an API key at [console.anthropic.com](https://console.anthropic.com) and set
**`ANTHROPIC_API_KEY`**. Usage is pay-as-you-go; prompts are cached and a small model handles
triage, so a household's day-to-day use is modest. Set a monthly limit in the console if you
want a ceiling.

<a id="database"></a>
## Database

In Vercel → Storage, add **Upstash Redis** (Marketplace). It sets `KV_REST_API_URL` and
`KV_REST_API_TOKEN` for you. The free tier is enough for one family.

<a id="kimi-email"></a>
## Kimi's email

Kimi needs her own Gmail account. Login codes come from it, so set this up before you try to
sign in.

1. Create a new Gmail account for her (not a parent's).
2. Turn on 2-Step Verification, then create an **app password** at
   [myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords).
3. Set **`IMAP_USER`** (the address) and **`IMAP_PASS`** (the 16-character app password).

Anything forwarded to this inbox gets filed too, which is handy for mail that doesn't reach
either parent's Gmail.

<a id="heartbeat"></a>
## Every-minute heartbeat

Most of Kimi's work happens in the background: checking email, finishing a browser job after an
approval, running scheduled tasks, leave-by alerts. A timer calls her every minute to do it.
Vercel's built-in cron only runs daily on the Hobby plan, so use a free external one:

1. At [cron-job.org](https://cron-job.org) (free), create a job that calls
   `https://<your-app>/api/ingest` **every minute**, with a request header
   `Authorization: Bearer <CRON_SECRET>` (Advanced → Headers). Not `?secret=` in the URL: it isn't
   accepted, since URLs end up in logs.
2. Within a minute, **Kimi tab → Setup** shows the heartbeat as running.

Without it, the app works when you chat with her, but nothing happens on its own.

<a id="google-calendar"></a>
## Google Calendar

Kimi writes events to one Google Calendar and invites the other parent.

1. In [Google Cloud Console](https://console.cloud.google.com), create a project and enable the
   **Google Calendar API**.
2. Set up the **OAuth consent screen** (External), then set it to **In production**. In
   *Testing* mode Google disconnects you every 7 days. You'll see an "unverified app" warning
   when you connect; that's expected for a personal app, so click through.
3. Create an **OAuth client ID** (Web application) with the redirect URI
   `<APP_URL>/api/oauth/callback`.
4. Set **`GOOGLE_CLIENT_ID`** and **`GOOGLE_CLIENT_SECRET`**, and redeploy.
5. Signed in to the app as a parent, open `<APP_URL>/api/oauth/start?for=calendar` once and
   choose the Google account that owns the family calendar. The connection is saved (encrypted
   when `VAULT_KEY` is set).
6. In `src/data/config.ts`, set `calendar.targetCalendarId` (the calendar to write to, usually
   that account's address) and `calendar.alwaysInvite`.

<a id="parents-gmail"></a>
## Parents' Gmail (optional)

With this on, Kimi watches each parent's own inbox for school, activity, and travel mail, so
nobody has to forward anything. She only ever reads and searches; she never sends from a
parent's account.

For each parent, create an app password (as in [Kimi's email](#kimi-email)) and set
**`GMAIL_IMAP_<PARENT>_USER`** and **`GMAIL_IMAP_<PARENT>_PASS`**, where `<PARENT>` is that
parent's id from `config.ts` in capitals. An app password opens the whole mailbox, so keep these
only in your host's environment.

<a id="work-calendars"></a>
## Work calendars (optional)

Kimi reads work calendars as private context (never copied to the family calendar), so she can
plan around meetings, office days, and trips. Each parent connects their own in **Kimi tab →
Connections → Work calendar**, with either:

- the calendar's **secret iCal link** (Google: Settings → the calendar → *Secret address in iCal
  format*; Outlook: *Publish calendar* → ICS link), or
- the work calendar **shared** with the family Google account (enter its address).

<a id="texting"></a>
## Texting (optional)

Parents can text Kimi, one-on-one or in a family group text she starts once both have opted in.
US carriers require every app that texts people to be registered, so this one takes a few days
of waiting.

1. In [Twilio](https://www.twilio.com), buy a US local number and create a **Messaging Service**
   containing it.
2. Edit `public/sms.html`, `public/terms.html`, and `public/privacy.html` (number, email,
   program name), and the matching welcome and help texts in `api/_lib/twilio.ts`. Deploy them.
   The registration links to these pages, and the texts must match what you register word
   for word.
3. Register for **A2P 10DLC** in the Twilio console: a brand (Sole Proprietor if you have no
   business tax ID) and a campaign. Describe it as account notifications to household members,
   use **START** as the opt-in keyword (confirmed with **Y**), and link the three pages above.
   Approval usually takes days.
4. In the Messaging Service → **Integration**, send incoming messages to the webhook
   `<APP_URL>/api/sms` (HTTP POST). Under **Opt-Out Management**, clear Twilio's own opt-in and
   help replies; the app sends the registered ones.
5. Set **`TWILIO_ACCOUNT_SID`**, **`TWILIO_AUTH_TOKEN`**, **`TWILIO_MESSAGING_SERVICE_SID`**, and
   **`TWILIO_FROM`** (Kimi's number, e.g. `+15551234567`).
6. Each parent texts **START** to Kimi's number, then **Y**. She replies with a contact card
   (`public/kimi.vcf`: update its number and photo) and starts the group text once both are in.

Costs are a monthly fee for the number and the campaign, small one-time registration fees, and
per-message charges; check Twilio's current pricing.

<a id="web-tasks"></a>
## Web tasks (optional)

For jobs that need a real browser (sign-ups, orders, bookings), Kimi drives a hosted Chrome. Every
purchase or submission stops for one approval first.

Create an account at [Browserbase](https://www.browserbase.com) and set
**`BROWSERBASE_API_KEY`** and **`BROWSERBASE_PROJECT_ID`**. The free tier's minutes run out
quickly; when they do, tasks stop with a "payment required" message.

<a id="logins-and-cards"></a>
## Logins & cards (optional)

Kimi signs in to sites and fills cards without the model ever seeing them: the values go
straight from the vault into the page.

- **1Password (recommended):** create a vault just for Kimi, move in the logins and cards she may
  use, then create a **service account** with read access to that vault only (1Password.com →
  Developer → Service Accounts; check that your plan includes them). Set
  **`OP_SERVICE_ACCOUNT_TOKEN`** and **`OP_VAULT`** (the vault's name).
- **Or the built-in vault:** set **`VAULT_KEY`** (`openssl rand -hex 32`) and add logins in
  **Kimi tab → Logins**.

Travel cards (Household → Travel) store passport and Known Traveler numbers encrypted with
`VAULT_KEY`, so set it even if logins and cards come from 1Password.

<a id="search"></a>
## Flight, hotel & place search (optional)

Kimi compares flights (Google Flights data), hotels, and local businesses through
[SerpApi](https://serpapi.com) instead of a slow browser task. Create an account and set
**`SERPAPI_API_KEY`**. Searches count against your plan (a flight round trip with returns is 2–3
searches). Without it, Kimi falls back to web search. Booking still happens on the airline's or
hotel's own site, with one approval.

<a id="push"></a>
## Push notifications (optional)

1. Run `npx web-push generate-vapid-keys` and set **`VAPID_PUBLIC_KEY`**,
   **`VAPID_PRIVATE_KEY`**, and **`VAPID_SUBJECT`** (`mailto:` plus an address).
2. On each phone, open the app and add it to the home screen (on iPhone this is required for
   notifications), then turn on **Kimi tab → Connections → Notifications**.

<a id="weather"></a>
## Weather (optional)

Set **`WEATHER_LAT`** and **`WEATHER_LON`** to your home's coordinates. Forecasts come from the US
National Weather Service, so this works in the US only. Drive times and leave-by alerts need no
key; set `TRAVEL_VIEWBOX` (a `minLon,maxLat,maxLon,minLat` box around home; see `.env.local.example`) so place lookups stay near home.

## Checking it all

Sign in, open **Kimi tab → Setup**, and work down anything still marked off. Then say hi to Kimi
in Chat.
