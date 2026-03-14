CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint TEXT PRIMARY KEY,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  timezone TEXT NOT NULL,
  reminder_hours TEXT NOT NULL DEFAULT '[20,22]',
  active INTEGER NOT NULL DEFAULT 1,
  last_sent_slot TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_push_subscriptions_active
  ON push_subscriptions(active);
