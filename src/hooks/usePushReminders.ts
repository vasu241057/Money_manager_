import { useCallback, useEffect, useMemo, useState } from 'react';

const API_BASE_URL = (import.meta.env.VITE_PUSH_API_BASE_URL || '').replace(/\/$/, '');
const LOG_PREFIX = '[Push/Frontend]';

type PushStatus = 'checking' | 'unsupported' | 'disabled' | 'enabled' | 'blocked';

type PushServerKeyResponse = {
  publicKey: string;
};

type PushSubscriptionPayload = {
  endpoint: string;
  expirationTime: number | null;
  keys: {
    p256dh: string;
    auth: string;
  };
};

function apiUrl(path: string) {
  return `${API_BASE_URL}${path}`;
}

async function buildHttpError(response: Response, context: string) {
  let details = '';

  try {
    const raw = await response.text();
    if (raw) {
      details = raw.length > 300 ? `${raw.slice(0, 300)}...` : raw;
    }
  } catch {
    // Ignore body parse failures.
  }

  const suffix = details ? ` | response: ${details}` : '';
  return new Error(`${context} (HTTP ${response.status})${suffix}`);
}

function isPushSupported() {
  return (
    window.isSecureContext &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  );
}

function base64UrlToUint8Array(base64Url: string) {
  const padding = '='.repeat((4 - (base64Url.length % 4)) % 4);
  const base64 = (base64Url + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);

  return Uint8Array.from(rawData, (char) => char.charCodeAt(0));
}

function toSubscriptionPayload(subscription: PushSubscription): PushSubscriptionPayload {
  const json = subscription.toJSON();

  if (!json.endpoint || !json.keys?.p256dh || !json.keys.auth) {
    throw new Error('Push subscription payload is incomplete.');
  }

  return {
    endpoint: json.endpoint,
    expirationTime: json.expirationTime ?? null,
    keys: {
      p256dh: json.keys.p256dh,
      auth: json.keys.auth,
    },
  };
}

async function upsertSubscriptionOnBackend(subscription: PushSubscription) {
  const payload = {
    subscription: toSubscriptionPayload(subscription),
  };

  const response = await fetch(apiUrl('/api/push/subscribe'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw await buildHttpError(response, 'Failed to sync reminder subscription');
  }
}

async function getServiceWorkerRegistration() {
  console.info(`${LOG_PREFIX} checking service worker registration`, { scope: '/push-sw.js' });
  const existing = await navigator.serviceWorker.getRegistration();
  if (existing) {
    console.info(`${LOG_PREFIX} existing service worker found`, { scope: existing.scope });
    return existing;
  }

  const registration = await navigator.serviceWorker.register('/push-sw.js');
  console.info(`${LOG_PREFIX} service worker registered`, { scope: registration.scope });
  return registration;
}

async function getPublicKey() {
  const target = apiUrl('/api/push/public-key');
  console.info(`${LOG_PREFIX} fetching public key`, { url: target });
  const response = await fetch(target);
  console.info(`${LOG_PREFIX} public key response`, { status: response.status, ok: response.ok });

  if (!response.ok) {
    throw await buildHttpError(response, `Could not load push public key from backend: ${target}`);
  }

  const data = (await response.json()) as PushServerKeyResponse;

  if (!data.publicKey) {
    throw new Error('Push public key is missing from backend response.');
  }

  return data.publicKey;
}

export function usePushReminders() {
  const [status, setStatus] = useState<PushStatus>('checking');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refreshStatus = useCallback(async () => {
    console.info(`${LOG_PREFIX} refreshStatus`, {
      apiBaseUrl: API_BASE_URL || '(empty)',
      permission: Notification.permission,
      secureContext: window.isSecureContext,
    });

    if (!isPushSupported()) {
      setStatus('unsupported');
      console.warn(`${LOG_PREFIX} push not supported in current browser/context`);
      return;
    }

    if (Notification.permission === 'denied') {
      setStatus('blocked');
      return;
    }

    try {
      const registration = await getServiceWorkerRegistration();
      const existingSubscription = await registration.pushManager.getSubscription();
      console.info(`${LOG_PREFIX} refreshStatus subscription`, {
        hasSubscription: Boolean(existingSubscription),
      });
      if (existingSubscription) {
        try {
          await upsertSubscriptionOnBackend(existingSubscription);
          console.info(`${LOG_PREFIX} refreshStatus backend sync complete`);
        } catch (error) {
          console.error(`${LOG_PREFIX} refreshStatus backend sync failed`, error);
        }
      }
      setStatus(existingSubscription ? 'enabled' : 'disabled');
    } catch {
      console.error(`${LOG_PREFIX} refreshStatus failed`);
      setStatus('disabled');
    }
  }, []);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  const enableReminders = useCallback(async () => {
    console.info(`${LOG_PREFIX} enableReminders start`);
    if (!isPushSupported()) {
      setStatus('unsupported');
      console.warn(`${LOG_PREFIX} enableReminders aborted: unsupported`);
      return false;
    }

    setLoading(true);
    setError(null);

    try {
      const registration = await getServiceWorkerRegistration();

      let permission = Notification.permission;
      if (permission === 'default') {
        console.info(`${LOG_PREFIX} requesting notification permission`);
        permission = await Notification.requestPermission();
      }
      console.info(`${LOG_PREFIX} permission result`, { permission });

      if (permission !== 'granted') {
        setStatus('blocked');
        console.warn(`${LOG_PREFIX} enableReminders blocked by permission`, { permission });
        return false;
      }

      const publicKey = await getPublicKey();
      console.info(`${LOG_PREFIX} received public key`, { length: publicKey.length });
      const existingSubscription = await registration.pushManager.getSubscription();
      const subscription =
        existingSubscription ??
        (await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: base64UrlToUint8Array(publicKey),
        }));
      console.info(`${LOG_PREFIX} subscription ready`, {
        reused: Boolean(existingSubscription),
        endpoint: subscription.endpoint,
      });

      await upsertSubscriptionOnBackend(subscription);
      console.info(`${LOG_PREFIX} subscribe response`, { ok: true });

      setStatus('enabled');
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not enable reminders.';
      console.error('[Push] enableReminders failed:', err);
      setError(message);
      setStatus(Notification.permission === 'denied' ? 'blocked' : 'disabled');
      return false;
    } finally {
      setLoading(false);
    }
  }, []);

  const disableReminders = useCallback(async () => {
    console.info(`${LOG_PREFIX} disableReminders start`);
    if (!isPushSupported()) {
      setStatus('unsupported');
      console.warn(`${LOG_PREFIX} disableReminders aborted: unsupported`);
      return false;
    }

    setLoading(true);
    setError(null);

    try {
      const registration = await getServiceWorkerRegistration();
      const subscription = await registration.pushManager.getSubscription();

      if (!subscription) {
        setStatus('disabled');
        return true;
      }

      await fetch(apiUrl('/api/push/unsubscribe'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ endpoint: subscription.endpoint }),
      });
      console.info(`${LOG_PREFIX} unsubscribe API called`, { endpoint: subscription.endpoint });

      await subscription.unsubscribe();
      console.info(`${LOG_PREFIX} local subscription unsubscribed`);
      setStatus('disabled');
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not disable reminders.';
      setError(message);
      return false;
    } finally {
      setLoading(false);
    }
  }, []);

  const sendTestReminder = useCallback(async () => {
    console.info(`${LOG_PREFIX} sendTestReminder start`);
    if (!isPushSupported()) {
      console.warn(`${LOG_PREFIX} sendTestReminder aborted: unsupported`);
      return false;
    }

    setLoading(true);
    setError(null);

    try {
      const registration = await getServiceWorkerRegistration();
      const subscription = await registration.pushManager.getSubscription();

      if (!subscription) {
        throw new Error('Enable reminders first.');
      }

      try {
        await upsertSubscriptionOnBackend(subscription);
        console.info(`${LOG_PREFIX} pre-test backend sync complete`);
      } catch (error) {
        console.warn(`${LOG_PREFIX} pre-test backend sync failed`, error);
      }

      const response = await fetch(apiUrl('/api/push/test'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ endpoint: subscription.endpoint }),
      });
      console.info(`${LOG_PREFIX} test response`, { status: response.status, ok: response.ok });

      if (!response.ok) {
        throw await buildHttpError(response, 'Failed to send test reminder');
      }

      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not send test reminder.';
      setError(message);
      return false;
    } finally {
      setLoading(false);
    }
  }, []);

  const statusMessage = useMemo(() => {
    if (error) {
      return error;
    }

    switch (status) {
      case 'checking':
        return 'Checking reminder status...';
      case 'unsupported':
        return 'Push notifications are not supported in this browser.';
      case 'blocked':
        return 'Notifications are blocked. Enable them in Safari settings.';
      case 'enabled':
        return 'Daily reminders are active for 8:00 PM and 10:00 PM IST.';
      case 'disabled':
      default:
        return 'Turn on reminders to get nudges at 8:00 PM and 10:00 PM IST.';
    }
  }, [error, status]);

  return {
    isLoading: loading,
    status,
    statusMessage,
    enableReminders,
    disableReminders,
    sendTestReminder,
    refreshStatus,
  };
}
