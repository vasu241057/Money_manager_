# Money Manager (PWA + Push Reminders)

This app is a React + Vite personal money manager with iPhone home-screen support and scheduled push reminders.

## Frontend

Run locally:

```bash
npm install
npm run dev
```

### Push reminder UI

The app now includes:

- A reminder toggle in the header (`Reminders On` / `Reminders Off`)
- A `Test` button to trigger a test push
- A service worker at `public/push-sw.js`
- A web app manifest at `public/manifest.webmanifest`

Reminders are configured for **8:00 PM** and **10:00 PM IST**.
When any user creates a new transaction, a broadcast push notification is also sent.

## Backend (Cloudflare Worker + Express + D1)

Backend files are in [`cloudflare-worker`](./cloudflare-worker).

The Worker provides:

- `GET /api/push/public-key`
- `POST /api/push/subscribe`
- `POST /api/push/unsubscribe`
- `POST /api/push/test`
- `POST /api/push/broadcast-transaction`
- Cron-based sending every 5 minutes (sends at 8 PM and 10 PM IST for all subscribers)

No PostgreSQL is required for this flow.
D1 stores only push subscription endpoints/keys (no user profiles).

Use `cloudflare-worker/README.md` for full setup and deploy steps.

## Frontend environment variable

Create a local env file for Vite:

```bash
VITE_PUSH_API_BASE_URL=https://money-manager-push-api.<your-subdomain>.workers.dev
```

If frontend and backend are served from the same domain, this can be left empty.
