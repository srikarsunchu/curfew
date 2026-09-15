# Curfew

A merchant-side fraud layer for Whop that acts while you sleep. It learns what normal looks like for *your* shop, watches every payment as it lands, and contains a card-testing attack before it turns into a hundred chargebacks.

Sentry for payment fraud. Zero dependencies. One process.

## What it does

1. **Learns your baseline** from your payment history: paid rate per hour of day, first-time-buyer share, decline share, spend distribution, which countries you actually sell to.
2. **Watches the webhook stream** (`payment.succeeded`, `payment.failed`) over a rolling window and scores six signals:
   `velocity`, `new_buyers`, `declines`, `geo_spread`, `card_reuse`, `spend_shift`.
3. **Acts only when 3+ signals fire together.** A real launch fires velocity and new buyers. A card-testing bot also fires declines, unfamiliar countries, and the same card across many accounts. Two signals is "elevated": you get pinged, nothing happens.
4. **On attack:** alerts you with the exact signals and a one-click undo, then after `REFUND_DELAY_MIN` (default 10) revokes access and refunds every suspect payment. Refunding before a dispute is filed is what keeps your dispute ratio and your account clean.
5. **Undo** cancels the hold. **Launch mode** suppresses action for N hours while still recording, for drop days.

## What it cannot do

Whop is the merchant of record. This tool cannot decline a charge, and it cannot stop Whop from suspending an account. It shrinks the damage window from "when you wake up" to ten minutes. Refunds still cost the processing fee.

## Use it

Hosted: **https://curfew-blush.vercel.app** → Connect your Whop → paste an account API key with the scopes the page lists. Curfew pulls sixty days of payments, learns your baseline, registers a webhook on your account, and starts watching. Disconnect removes the webhook and deletes everything it stored.

Keys and webhook secrets are encrypted at rest (AES-256-GCM). Curfew can read your payments, refund them, and cancel memberships, so grant only the listed scopes. Read `src/` before trusting a hosted instance; it is short.

## Self-host

```bash
npm install
cp .env.example .env    # PUBLIC_URL, ENCRYPTION_KEY (32 random bytes hex), CRON_SECRET
npm start               # SQLite at ./curfew.db, http://localhost:8787
```

On Vercel: `vercel deploy`, add a Postgres integration (Neon works), and set `ENCRYPTION_KEY`, `CRON_SECRET`, `PUBLIC_URL`. `vercel.json` routes everything to one function and runs `/api/tick` every minute so holds fire even when no webhook arrives.

Needs Node 22.18+ (type stripping and `node:sqlite`).

## Demo without a Whop account

```bash
DRY_RUN=1 npm start    # seeds 60 days of synthetic history, no API calls ever made
```

The dashboard shows two demo buttons: **simulate card-testing attack** and **simulate real launch**. Or just print the verdicts:

```bash
npm run simulate
```

```
ATTACK -> attack (5/6), 36 suspects
  🔴 velocity     36 paid in window vs usual 0.06±0
  🔴 new_buyers   100% first-time buyers vs usual 58%
  🔴 declines     44 declines, 55% of attempts vs usual 4%
  🔴 geo_spread   100% from countries you rarely sell to (EG, NG, MA, TR, VN, ID)
  🔴 card_reuse   10 cards used by 3+ accounts, 17 accounts cycling 3+ cards
  ⚪ spend_shift  avg $49 vs usual $65.02

LAUNCH -> elevated (2/6), 0 suspects
  🔴 velocity     76 paid in window vs usual 0.06±0
  🔴 new_buyers   100% first-time buyers vs usual 58%
  ⚪ declines     4 declines, 5% of attempts vs usual 4%
  ⚪ geo_spread   0% from countries you rarely sell to (none)
  ⚪ card_reuse   0 cards used by 3+ accounts, 0 accounts cycling 3+ cards
  ⚪ spend_shift  avg $62.16 vs usual $65.02
```

## Layout

```
src/whop.ts       API client, webhook verification (Standard Webhooks HMAC), payment flattening
src/baseline.ts   learn "normal" from history
src/detector.ts   six signals -> normal | elevated | attack, plus the suspect list
src/responder.ts  hold, alert, act, undo, launch mode
src/engine.ts     ingest a payment and re-evaluate the window
src/server.ts     request handler: webhooks per tenant, connect flow, JSON API, pages
src/local.ts      local Node server around the handler; api/index.ts is the Vercel function
src/tenant.ts     connect, learn, disconnect
src/store.ts      Store interface: SQLite locally, Postgres on Vercel
src/crypto.ts     AES-256-GCM for keys and secrets at rest
src/simulate.ts   synthetic history and bursts, used by tests and the demo
tests/            node:test, runs in dry run
```

## Config

| env | default | |
|---|---|---|
| `WINDOW_MIN` | 10 | rolling window the detector scores |
| `REFUND_DELAY_MIN` | 10 | hold before refund + revoke; undo inside this |
| `IMMEDIATE_REVOKE` | 0 | set `1` to revoke access the moment an attack is called (refund still waits) |
| `ALERT_WEBHOOK_URL` | | Slack / Discord incoming webhook |

Thresholds live at the top of each signal in `src/detector.ts`. They are deliberately boring numbers you can read in an alert.

MIT.
