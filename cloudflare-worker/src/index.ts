import { env as runtimeEnv } from 'cloudflare:workers';
import { httpServerHandler } from 'cloudflare:node';
import express from 'express';
import webpush from 'web-push';

type WorkersAiBinding = {
  run: (model: string, input: Record<string, unknown>) => Promise<unknown>;
};

type Env = {
  PUSH_DB: D1Database;
  AI?: WorkersAiBinding;
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
const VOICE_LOG_PREFIX = '[Voice/Worker]';
const VOICE_TRANSCRIBE_MODEL = '@cf/openai/whisper-large-v3-turbo';
const VOICE_MAX_AUDIO_BYTES = 12 * 1024 * 1024;
const SCHEDULED_REMINDER_TIMES_IST = [
  { hour: 20, minute: 0 }, // 8:00 PM IST
  { hour: 22, minute: 0 }, // 10:00 PM IST
];

const REMINDER_TITLES = [
  'Money Manager Reminder',
  'Daily Money Ping',
  'Wallet Check-in',
  'Budget Nudge',
  'Finance Streak Alert',
  'Aaj ka Money Check',
  'Ledger Time',
  'Cashflow Check',
  'Expense Log Call',
  'Streak Bachao',
  'Kharcha Control Ping',
  'Daily Entry Moment',
  'खर्चा याद दिलाना',
  'आज का हिसाब',
  'Wallet Discipline Alert',
  'Money Mode ON',
  'Paisa Tracker Ping',
  'Finance Focus Minute',
  'बजट चेक करो',
  'आमदनी-खर्चा अपडेट',
  'Cash Diary Reminder',
  'Saving Streak Call',
  'Khata Update Time',
  'कंजूसी नहीं, clarity',
];

const REMINDER_OPENERS = [
  'Bro,',
  'Boss mode:',
  'Suno yaar,',
  'Captain,',
  'Discipline check:',
  'Arre bhai,',
  'Zen mode:',
  'No excuses:',
  'Focus warrior,',
  'Aaj ka mission:',
  'सुनो,',
  'ओए चैंप,',
  'ध्यान से,',
  'यार,',
  'Budget सेनापति:',
  'Hero,',
  'बॉस,',
  'Discipline राजा:',
  'शांत दिमाग,',
  'आलस छोड़ो,',
];

const REMINDER_PROMPTS = [
  "wallet update karo - today's entry pending.",
  'add your daily money log right now.',
  'kharcha aur income note karo, future-you will thank you.',
  "sirf 30 seconds: open app and add today's numbers.",
  "don't ghost your budget, entry daal do.",
  'data nahi to control nahi - log it now.',
  "ek small step: today's transaction add karo.",
  'finance game XP chahiye? daily entry karo.',
  'calm mind, clear money - aaj ka record daal do.',
  'abhi karo, warna kal ka stress double hoga.',
  'आज का हिसाब लिखो, कल वाला confusion खत्म करो।',
  'खर्चा-आमदनी तुरंत note करो, warna budget फिसलेगा।',
  'sirf 1 minute, app kholo aur entry pakki karo.',
  'Aaj ka data daalo, future ka tension hatao.',
  'बेकार scrolling बंद, पैसा tracking चालू।',
  'khata saaf rakho, dimag half stress free ho jayega.',
  'budget ko respect do, daily line item add karo.',
  'आज नहीं लिखा तो कल matha-pacchi guaranteed.',
  'paisa ka game jeetna hai? log every day.',
  'daily entry = clarity + control + confidence.',
];

const REMINDER_MESSAGES = REMINDER_OPENERS.flatMap((opener) =>
  REMINDER_PROMPTS.map((prompt) => `${opener} ${prompt}`),
);

let vapidCacheKey = '';

const app = express();
app.use(express.json({ limit: '20mb' }));

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

app.post('/api/voice/transcribe', async (req, res) => {
  const env = getEnv();
  const body = (req.body || {}) as {
    audioBase64?: unknown;
    mimeType?: unknown;
    language?: unknown;
  };
  const audioBase64 = typeof body.audioBase64 === 'string' ? body.audioBase64 : '';
  const mimeType = typeof body.mimeType === 'string' ? body.mimeType : 'unknown';
  const language = typeof body.language === 'string' ? body.language.trim() : '';

  console.info(`${VOICE_LOG_PREFIX} transcribe request`, {
    hasAudio: Boolean(audioBase64),
    mimeType,
    language: language || null,
  });

  if (!audioBase64) {
    res.status(400).json({ error: 'Missing audioBase64 in request body.' });
    return;
  }

  if (!env.AI) {
    res.status(500).json({ error: 'AI binding is missing. Add Workers AI binding to wrangler config.' });
    return;
  }

  let audioBytes: Uint8Array;
  let normalizedBase64 = '';
  try {
    normalizedBase64 = normalizeBase64Audio(audioBase64);
    audioBytes = decodeBase64Audio(normalizedBase64);
  } catch (error) {
    console.error(`${VOICE_LOG_PREFIX} decode failed`, error);
    res.status(400).json({
      error: 'Invalid audio base64 payload.',
      details: errorToMessage(error),
    });
    return;
  }

  if (audioBytes.byteLength === 0) {
    res.status(400).json({ error: 'Audio payload is empty.' });
    return;
  }

  if (audioBytes.byteLength > VOICE_MAX_AUDIO_BYTES) {
    res.status(413).json({
      error: `Audio payload is too large. Max ${VOICE_MAX_AUDIO_BYTES} bytes is supported.`,
    });
    return;
  }

  try {
    const input: Record<string, unknown> = {
      audio: normalizedBase64,
    };
    if (language) {
      input.language = language;
    }

    const result = await env.AI.run(VOICE_TRANSCRIBE_MODEL, input);
    const transcript = extractTranscriptionText(result);

    if (!transcript) {
      console.error(`${VOICE_LOG_PREFIX} empty transcript result`, { result });
      res.status(502).json({ error: 'Transcription did not return any text.' });
      return;
    }

    console.info(`${VOICE_LOG_PREFIX} transcribe success`, {
      model: VOICE_TRANSCRIBE_MODEL,
      transcriptChars: transcript.length,
    });

    res.json({
      success: true,
      transcript,
      model: VOICE_TRANSCRIBE_MODEL,
    });
  } catch (error) {
    const details = errorToMessage(error);
    console.error(`${VOICE_LOG_PREFIX} transcription failed`, {
      details,
      audioBytes: audioBytes.byteLength,
      mimeType,
      language: language || null,
    });
    res.status(500).json({
      error: 'Failed to transcribe audio.',
      details,
    });
  }
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
    const payload = buildRandomReminderPayload();
    const sent = await sendPushToAll(env, payload, { endpoint });
    console.info(`${LOG_PREFIX} test send complete`, {
      sent,
      endpoint: endpoint || '(all)',
      title: payload.title,
      body: payload.body,
    });

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

  const payload = buildScheduledReminderPayload(nowIst);
  const slot = `${nowIst.year}-${nowIst.month}-${nowIst.day}-${String(nowIst.hour).padStart(2, '0')}-${String(nowIst.minute).padStart(2, '0')}`;
  console.info(`${LOG_PREFIX} scheduled trigger`, {
    slot,
    timezone: 'Asia/Kolkata',
    title: payload.title,
    body: payload.body,
  });
  await sendPushToAll(env, payload, { slot });
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

function hashString(value: string) {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }

  return hash >>> 0;
}

function buildScheduledReminderPayload(nowIst: ReturnType<typeof getIstDateParts>): PushPayload {
  const dateKey = `${nowIst.year}-${nowIst.month}-${nowIst.day}`;
  const slotKey = `${String(nowIst.hour).padStart(2, '0')}:${String(nowIst.minute).padStart(2, '0')}`;
  const messagePoolSize = REMINDER_MESSAGES.length;

  let messageIndex = hashString(`${dateKey}|${slotKey}|body`) % messagePoolSize;

  // Keep 10:00 PM and 8:00 PM reminders different on the same day.
  if (nowIst.hour === 22 && nowIst.minute === 0) {
    const eightPmIndex = hashString(`${dateKey}|20:00|body`) % messagePoolSize;
    if (messageIndex === eightPmIndex) {
      messageIndex = (messageIndex + 1) % messagePoolSize;
    }
  }

  const titleIndex = hashString(`${dateKey}|${slotKey}|title`) % REMINDER_TITLES.length;

  return {
    title: REMINDER_TITLES[titleIndex],
    body: REMINDER_MESSAGES[messageIndex],
    url: '/',
    icon: DEFAULT_ICON,
  };
}

function buildRandomReminderPayload(): PushPayload {
  const messageIndex = Math.floor(Math.random() * REMINDER_MESSAGES.length);
  const titleIndex = Math.floor(Math.random() * REMINDER_TITLES.length);

  return {
    title: REMINDER_TITLES[titleIndex],
    body: REMINDER_MESSAGES[messageIndex],
    url: '/',
    icon: DEFAULT_ICON,
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

function decodeBase64Audio(rawBase64: string) {
  const sanitized = normalizeBase64Audio(rawBase64);
  const binary = atob(sanitized);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
}

function normalizeBase64Audio(rawBase64: string) {
  return rawBase64.replace(/^data:[^,]+,/, '').replace(/\s+/g, '').trim();
}

function extractTranscriptionText(result: unknown) {
  const candidate = result as {
    text?: unknown;
    transcript?: unknown;
    result?: {
      text?: unknown;
      transcript?: unknown;
    };
    response?: {
      text?: unknown;
      transcript?: unknown;
    };
  };

  const possible = [
    candidate?.text,
    candidate?.transcript,
    candidate?.result?.text,
    candidate?.result?.transcript,
    candidate?.response?.text,
    candidate?.response?.transcript,
  ];

  for (const value of possible) {
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }

  return '';
}

function errorToMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }

  if (!error || typeof error !== 'object') {
    return String(error);
  }

  const maybeMessage = (error as { message?: unknown }).message;
  if (typeof maybeMessage === 'string' && maybeMessage.trim()) {
    return maybeMessage;
  }

  try {
    const serialized = JSON.stringify(error);
    return serialized.length > 500 ? `${serialized.slice(0, 500)}...` : serialized;
  } catch {
    return String(error);
  }
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
