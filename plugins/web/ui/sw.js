// me service worker: shows Web Push notifications and opens the right screen.
// No caching here; API data is never stored in the worker.
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }
  const title = typeof data.title === "string" && data.title ? data.title : "me";
  const body = typeof data.body === "string" ? data.body : "";
  const url = typeof data.url === "string" && data.url.startsWith("#/") ? data.url : "#/settings/device";
  event.waitUntil(self.registration.showNotification(title, { body, data: { url }, lang: "ko" }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const hash = event.notification.data && event.notification.data.url ? event.notification.data.url : "#/settings/device";
  const target = new URL(hash, self.location.origin).href;
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const w of windows) {
        try {
          await w.navigate(target);
          return w.focus();
        } catch {
          // A tab we may not touch (another origin): leave it and keep looking.
        }
      }
      return self.clients.openWindow(target);
    })(),
  );
});
