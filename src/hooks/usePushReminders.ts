import { useCallback, useEffect, useMemo, useState } from 'react';

const API_BASE_URL = (import.meta.env.VITE_PUSH_API_BASE_URL || '').replace(/\/$/, '');

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

async function getServiceWorkerRegistration() {
  const existing = await navigator.serviceWorker.getRegistration();
  if (existing) {
    return existing;
  }

  return navigator.serviceWorker.register('/push-sw.js');
}

async function getPublicKey() {
  const response = await fetch(apiUrl('/api/push/public-key'));

  if (!response.ok) {
    throw new Error('Could not load push public key from backend.');
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
    if (!isPushSupported()) {
      setStatus('unsupported');
      return;
    }

    if (Notification.permission === 'denied') {
      setStatus('blocked');
      return;
    }

    try {
      const registration = await getServiceWorkerRegistration();
      const existingSubscription = await registration.pushManager.getSubscription();
      setStatus(existingSubscription ? 'enabled' : 'disabled');
    } catch {
      setStatus('disabled');
    }
  }, []);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  const enableReminders = useCallback(async () => {
    if (!isPushSupported()) {
      setStatus('unsupported');
      return false;
    }

    setLoading(true);
    setError(null);

    try {
      const registration = await getServiceWorkerRegistration();

      let permission = Notification.permission;
      if (permission === 'default') {
        permission = await Notification.requestPermission();
      }

      if (permission !== 'granted') {
        setStatus('blocked');
        return false;
      }

      const publicKey = await getPublicKey();
      const existingSubscription = await registration.pushManager.getSubscription();
      const subscription =
        existingSubscription ??
        (await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: base64UrlToUint8Array(publicKey),
        }));

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
        throw new Error('Failed to save reminder subscription.');
      }

      setStatus('enabled');
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not enable reminders.';
      setError(message);
      setStatus(Notification.permission === 'denied' ? 'blocked' : 'disabled');
      return false;
    } finally {
      setLoading(false);
    }
  }, []);

  const disableReminders = useCallback(async () => {
    if (!isPushSupported()) {
      setStatus('unsupported');
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

      await subscription.unsubscribe();
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
    if (!isPushSupported()) {
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

      const response = await fetch(apiUrl('/api/push/test'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ endpoint: subscription.endpoint }),
      });

      if (!response.ok) {
        throw new Error('Failed to send test reminder.');
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
