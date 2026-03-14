# Cloudflare Push Worker (Express + D1)

This Worker powers push reminders for the Money Manager PWA.
It does not store user profiles, auth data, or PostgreSQL records.
It stores only anonymous push subscription endpoints in D1.

## What it does

- Exposes Express endpoints for push subscription management.
- Stores anonymous subscriptions in D1 (endpoint + keys only).
- Runs every 5 minutes via a cron trigger.
- Sends reminders at 8 PM and 10 PM IST for everyone.
- Sends push notifications when a transaction is created.

## Endpoints

- `GET /api/push/public-key`
- `POST /api/push/subscribe`
- `POST /api/push/unsubscribe`
- `POST /api/push/test`
- `POST /api/push/broadcast-transaction`

## Setup

1. Install dependencies:

```bash
cd cloudflare-worker
npm install
```

2. Create D1 database and update `wrangler.jsonc` with your `database_id`.

3. Run migration:

```bash
npx wrangler d1 execute money-manager-push --file=./migrations/0001_push_subscriptions.sql
```

4. Generate VAPID keys and keep the output values:

```bash
npx web-push generate-vapid-keys
```

5. Set Worker secrets/vars:

```bash
npx wrangler secret put VAPID_PRIVATE_KEY
```

Set these in `wrangler.jsonc`:
- `VAPID_PUBLIC_KEY`
- `VAPID_SUBJECT` (for example, `mailto:you@example.com`)
- `ALLOWED_ORIGIN` (your frontend URL)

6. Deploy:

```bash
npm run deploy
```

## Frontend wiring

In your frontend root `.env`:

```bash
VITE_PUSH_API_BASE_URL=https://money-manager-push-api.<your-subdomain>.workers.dev
```
