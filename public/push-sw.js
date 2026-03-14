const DEFAULT_NOTIFICATION = {
  title: "Money Manager Reminder",
  body: "Bro, it's time to add money.",
  url: "/",
};

self.addEventListener("push", (event) => {
  let payload = DEFAULT_NOTIFICATION;

  if (event.data) {
    try {
      const parsed = event.data.json();
      payload = {
        ...DEFAULT_NOTIFICATION,
        ...parsed,
      };
    } catch {
      payload = {
        ...DEFAULT_NOTIFICATION,
        body: event.data.text() || DEFAULT_NOTIFICATION.body,
      };
    }
  }

  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      icon: "/logo.png",
      badge: "/logo.png",
      tag: "money-manager-reminder",
      data: {
        url: payload.url || "/",
      },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  const targetUrl = event.notification.data?.url || "/";

  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((windowClients) => {
      for (const client of windowClients) {
        if ("focus" in client) {
          client.focus();
          if ("navigate" in client) {
            client.navigate(targetUrl);
          }
          return;
        }
      }

      if (clients.openWindow) {
        return clients.openWindow(targetUrl);
      }

      return undefined;
    }),
  );
});
