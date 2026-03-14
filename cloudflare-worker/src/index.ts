import { env as runtimeEnv } from 'cloudflare:workers';
import { httpServerHandler } from 'cloudflare:node';
import express from 'express';
import webpush from 'web-push';

type Env = {
  PUSH_DB: D1Database;
  VAPID_PUBLIC_KEY: string;
  VAPID_PRIVATE_KEY: string;
  VAPID_SUBJECT: string;
  ALLOWED_ORIGIN?: string;
};

type PushSubscriptionPayload = {
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
};

type StoredSubscription = {
  endpoint: string;
  p256dh: string;
  auth: string;
  last_sent_slot: string | null;
};

type PushPayload = {
  title: string;
  body: string;
  url: string;
  icon?: string;
};

type NodeServerFetchHandler =
  | ((request: Request, env: Env, ctx: ExecutionContext) => Promise<Response>)
  | {
      fetch: (request: Request, env: Env, ctx: ExecutionContext) => Promise<Response>;
    };

const PORT = 3000;
const DEFAULT_ICON = '/logo.png';
const LOG_PREFIX = '[Push/Worker]';
const SCHEDULED_REMINDER_TIMES_IST = [
  { hour: 1, minute: 31 }, // Temporary test slot
  { hour: 20, minute: 0 }, // 8:00 PM IST
  { hour: 22, minute: 0 }, // 10:00 PM IST
];

const REMINDER_PAYLOAD: PushPayload = {
  title: 'Money Manager Reminder',
  body: "Bro, it's time to add money.",
  url: '/',
  icon: DEFAULT_ICON,
};

let vapidCacheKey = '';

const app = express();
app.use(express.json());

app.use((req, res, next) => {
  const env = getEnv();
  const allowedOrigin = env.ALLOWED_ORIGIN || '*';

  res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  next();
});

app.get('/health', (_req, res) => {
  console.info(`${LOG_PREFIX} health check hit`);
  res.json({ ok: true });
});

app.get('/api/push/public-key', (_req, res) => {
  const env = getEnv();
  console.info(`${LOG_PREFIX} public key requested`);

  if (!env.VAPID_PUBLIC_KEY) {
    res.status(500).json({ error: 'Missing VAPID_PUBLIC_KEY.' });
    return;
  }

  res.json({ publicKey: env.VAPID_PUBLIC_KEY });
});

app.post('/api/push/subscribe', async (req, res) => {
  const env = getEnv();
  const subscription = parseSubscription((req.body || {}).subscription);
  console.info(`${LOG_PREFIX} subscribe request`, {
    hasSubscription: Boolean(subscription),
    endpoint: subscription?.endpoint || null,
  });

  if (!subscription) {
    res.status(400).json({ error: 'Invalid push subscription payload.' });
    return;
  }

  const now = new Date().toISOString();

  try {
    await env.PUSH_DB.prepare(
      `
      INSERT INTO push_subscriptions (
        endpoint,
        p256dh,
        auth,
        timezone,
        reminder_hours,
        active,
        last_sent_slot,
        created_at,
        updated_at
      )
      VALUES (?1, ?2, ?3, 'Asia/Kolkata', '[20,22]', 1, NULL, ?4, ?4)
      ON CONFLICT(endpoint) DO UPDATE SET
        p256dh = excluded.p256dh,
        auth = excluded.auth,
        timezone = 'Asia/Kolkata',
        reminder_hours = '[20,22]',
        active = 1,
        updated_at = excluded.updated_at
      `,
    )
      .bind(subscription.endpoint, subscription.keys.p256dh, subscription.keys.auth, now)
      .run();

    res.json({ success: true });
    console.info(`${LOG_PREFIX} subscribe saved`, { endpoint: subscription.endpoint });
  } catch (error) {
    console.error('Subscribe error:', error);
    res.status(500).json({ error: 'Failed to save subscription.' });
  }
});

app.post('/api/push/unsubscribe', async (req, res) => {
  const env = getEnv();
  const endpoint = typeof req.body?.endpoint === 'string' ? req.body.endpoint : '';
  console.info(`${LOG_PREFIX} unsubscribe request`, { endpoint: endpoint || null });

  if (!endpoint) {
    res.status(400).json({ error: 'Missing subscription endpoint.' });
    return;
  }

  try {
    await deactivateSubscription(env, endpoint);
    res.json({ success: true });
  } catch (error) {
    console.error('Unsubscribe error:', error);
    res.status(500).json({ error: 'Failed to unsubscribe.' });
  }
});

app.post('/api/push/test', async (req, res) => {
  const env = getEnv();
  const endpoint = typeof req.body?.endpoint === 'string' ? req.body.endpoint : undefined;
  console.info(`${LOG_PREFIX} test request`, { endpoint: endpoint || '(broadcast all)' });

  try {
    assertPushConfig(env);
    const sent = await sendPushToAll(env, REMINDER_PAYLOAD, { endpoint });
    console.info(`${LOG_PREFIX} test send complete`, { sent, endpoint: endpoint || '(all)' });

    if (sent === 0) {
      res.status(404).json({ error: 'No active subscriptions found.' });
      return;
    }

    res.json({ success: true, sent });
  } catch (error) {
    console.error('Push test error:', error);
    res.status(500).json({ error: 'Failed to send test notification.' });
  }
});

app.post('/api/push/broadcast-transaction', async (req, res) => {
  const env = getEnv();
  console.info(`${LOG_PREFIX} transaction broadcast request`, { body: req.body || null });

  try {
    assertPushConfig(env);
    const payload = createTransactionPayload(req.body);
    const sent = await sendPushToAll(env, payload);
    console.info(`${LOG_PREFIX} transaction broadcast complete`, { sent, payload });

    res.json({ success: true, sent });
  } catch (error) {
    console.error('Transaction broadcast error:', error);
    res.status(500).json({ error: 'Failed to broadcast transaction notification.' });
  }
});

app.listen(PORT);
const nodeServer = httpServerHandler({ port: PORT }) as unknown as NodeServerFetchHandler;

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    return dispatchFetch(request, env, ctx);
  },
  scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(sendScheduledReminders(env));
  },
} satisfies ExportedHandler<Env>;

function getEnv() {
  return runtimeEnv as unknown as Env;
}

function dispatchFetch(request: Request, env: Env, ctx: ExecutionContext) {
  const path = new URL(request.url).pathname;
  console.info(`${LOG_PREFIX} fetch`, { method: request.method, path });
  if (typeof nodeServer === 'function') {
    return nodeServer(request, env, ctx);
  }

  return nodeServer.fetch(request, env, ctx);
}

function parseSubscription(candidate: unknown): PushSubscriptionPayload | null {
  if (!candidate || typeof candidate !== 'object') {
    return null;
  }

  const subscription = candidate as {
    endpoint?: unknown;
    keys?: {
      p256dh?: unknown;
      auth?: unknown;
    };
  };

  if (
    typeof subscription.endpoint !== 'string' ||
    typeof subscription.keys?.p256dh !== 'string' ||
    typeof subscription.keys.auth !== 'string'
  ) {
    return null;
  }

  return {
    endpoint: subscription.endpoint,
    keys: {
      p256dh: subscription.keys.p256dh,
      auth: subscription.keys.auth,
    },
  };
}

function createTransactionPayload(body: unknown): PushPayload {
  const input = (body || {}) as {
    type?: unknown;
    amount?: unknown;
    category?: unknown;
  };

  const type = input.type === 'income' ? 'income' : 'expense';
  const category = typeof input.category === 'string' && input.category.trim() ? input.category.trim() : null;
  const amount =
    typeof input.amount === 'number' && Number.isFinite(input.amount) ? Math.abs(input.amount) : null;

  const title = type === 'income' ? 'Income transaction added' : 'Expense transaction added';
  const parts: string[] = [];

  if (category) {
    parts.push(category);
  }

  if (amount !== null) {
    parts.push(`₹${amount.toFixed(2)}`);
  }

  return {
    title,
    body: parts.length > 0 ? parts.join(' • ') : 'A new transaction was added.',
    url: '/',
    icon: DEFAULT_ICON,
  };
}

async function sendScheduledReminders(env: Env) {
  try {
    assertPushConfig(env);
  } catch (error) {
    console.error(error);
    return;
  }

  const nowIst = getIstDateParts(new Date());
  const shouldSendNow = SCHEDULED_REMINDER_TIMES_IST.some(
    (slot) => slot.hour === nowIst.hour && slot.minute === nowIst.minute,
  );

  if (!shouldSendNow) {
    return;
  }

  const slot = `${nowIst.year}-${nowIst.month}-${nowIst.day}-${String(nowIst.hour).padStart(2, '0')}-${String(nowIst.minute).padStart(2, '0')}`;
  console.info(`${LOG_PREFIX} scheduled trigger`, { slot, timezone: 'Asia/Kolkata' });
  await sendPushToAll(env, REMINDER_PAYLOAD, { slot });
}

function getIstDateParts(now: Date) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });

  const mapped = new Map<string, string>();
  for (const part of formatter.formatToParts(now)) {
    if (part.type !== 'literal') {
      mapped.set(part.type, part.value);
    }
  }

  return {
    year: mapped.get('year') || '0000',
    month: mapped.get('month') || '01',
    day: mapped.get('day') || '01',
    hour: Number(mapped.get('hour') || '0'),
    minute: Number(mapped.get('minute') || '0'),
  };
}

async function sendPushToAll(
  env: Env,
  payload: PushPayload,
  options?: {
    slot?: string;
    endpoint?: string;
  },
) {
  configureVapid(env);

  const rows = options?.endpoint
    ? await env.PUSH_DB.prepare(
        `
        SELECT endpoint, p256dh, auth, last_sent_slot
        FROM push_subscriptions
        WHERE active = 1 AND endpoint = ?1
        `,
      )
        .bind(options.endpoint)
        .all<StoredSubscription>()
    : await env.PUSH_DB.prepare(
        `
        SELECT endpoint, p256dh, auth, last_sent_slot
        FROM push_subscriptions
        WHERE active = 1
        `,
      ).all<StoredSubscription>();

  const results = rows.results || [];
  console.info(`${LOG_PREFIX} sendPushToAll start`, {
    targets: results.length,
    slot: options?.slot || null,
    endpointFilter: options?.endpoint || null,
  });
  let sent = 0;
  let skipped = 0;
  let gone = 0;
  let failed = 0;

  for (const row of results) {
    if (options?.slot && row.last_sent_slot === options.slot) {
      skipped += 1;
      continue;
    }

    const status = await sendPushToSubscription(row, payload);

    if (status === 'sent') {
      sent += 1;
      if (options?.slot) {
        await setLastSentSlot(env, row.endpoint, options.slot);
      }
      continue;
    }

    if (status === 'gone') {
      gone += 1;
      await deactivateSubscription(env, row.endpoint);
      continue;
    }

    if (status === 'failed') {
      failed += 1;
    }
  }

  console.info(`${LOG_PREFIX} sendPushToAll complete`, { sent, skipped, gone, failed });
  return sent;
}

async function sendPushToSubscription(
  row: StoredSubscription,
  payload: PushPayload,
): Promise<'sent' | 'gone' | 'failed'> {
  const subscription = {
    endpoint: row.endpoint,
    keys: {
      p256dh: row.p256dh,
      auth: row.auth,
    },
  };

  try {
    await webpush.sendNotification(subscription, JSON.stringify(payload));
    console.info(`${LOG_PREFIX} push sent`, { endpoint: row.endpoint, title: payload.title });
    return 'sent';
  } catch (error: unknown) {
    const status = getPushErrorStatus(error);
    if (status === 404 || status === 410) {
      console.warn(`${LOG_PREFIX} push endpoint expired`, { endpoint: row.endpoint, status });
      return 'gone';
    }

    console.error(`[Push] Failed for ${row.endpoint}:`, status || 'unknown', getPushErrorBody(error));
    return 'failed';
  }
}

function configureVapid(env: Env) {
  const nextKey = `${env.VAPID_SUBJECT}|${env.VAPID_PUBLIC_KEY}|${env.VAPID_PRIVATE_KEY}`;
  if (nextKey === vapidCacheKey) {
    return;
  }

  webpush.setVapidDetails(
    env.VAPID_SUBJECT || 'mailto:admin@example.com',
    env.VAPID_PUBLIC_KEY,
    env.VAPID_PRIVATE_KEY,
  );
  console.info(`${LOG_PREFIX} vapid config applied`, { subject: env.VAPID_SUBJECT });
  vapidCacheKey = nextKey;
}

async function deactivateSubscription(env: Env, endpoint: string) {
  console.info(`${LOG_PREFIX} deactivate subscription`, { endpoint });
  await env.PUSH_DB.prepare(
    `
    UPDATE push_subscriptions
    SET active = 0, updated_at = ?1
    WHERE endpoint = ?2
    `,
  )
    .bind(new Date().toISOString(), endpoint)
    .run();
}

async function setLastSentSlot(env: Env, endpoint: string, slot: string) {
  console.info(`${LOG_PREFIX} set last sent slot`, { endpoint, slot });
  await env.PUSH_DB.prepare(
    `
    UPDATE push_subscriptions
    SET last_sent_slot = ?1, updated_at = ?2
    WHERE endpoint = ?3
    `,
  )
    .bind(slot, new Date().toISOString(), endpoint)
    .run();
}

function assertPushConfig(env: Env) {
  const missing: string[] = [];
  if (!env.VAPID_PUBLIC_KEY) missing.push('VAPID_PUBLIC_KEY');
  if (!env.VAPID_PRIVATE_KEY) missing.push('VAPID_PRIVATE_KEY');
  if (!env.VAPID_SUBJECT) missing.push('VAPID_SUBJECT');

  if (missing.length > 0) {
    throw new Error(`Missing required push vars: ${missing.join(', ')}`);
  }
}

function getPushErrorStatus(error: unknown) {
  if (!error || typeof error !== 'object') {
    return 0;
  }

  const statusCode = (error as { statusCode?: unknown }).statusCode;
  if (typeof statusCode === 'number') {
    return statusCode;
  }

  const status = (error as { status?: unknown }).status;
  if (typeof status === 'number') {
    return status;
  }

  return 0;
}

function getPushErrorBody(error: unknown) {
  if (!error || typeof error !== 'object') {
    return error;
  }

  const body = (error as { body?: unknown }).body;
  return body ?? error;
}
