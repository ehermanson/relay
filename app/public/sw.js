self.addEventListener("push", (event) => {
  let payload;
  try {
    payload = event.data?.json();
  } catch {
    return;
  }
  if (!payload || typeof payload.title !== "string" || typeof payload.url !== "string") return;
  const url =
    payload.url.startsWith("/projects/") && !payload.url.startsWith("//") ? payload.url : "/";
  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: typeof payload.body === "string" ? payload.body : "",
      icon: "/icon-192.png",
      tag: typeof payload.tag === "string" ? payload.tag : undefined,
      data: { url },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const path = event.notification.data?.url || "/";
  const url = new URL(path, self.location.origin).href;
  event.waitUntil(
    (async () => {
      const windows = await clients.matchAll({ type: "window", includeUncontrolled: true });
      const existing = windows.find((client) => client.url.startsWith(self.location.origin));
      if (existing) {
        await existing.navigate(url);
        await existing.focus();
      } else {
        await clients.openWindow(url);
      }
    })(),
  );
});
