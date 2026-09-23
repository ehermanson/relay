import { useEffect } from "react";

/** A visible Relay window gets its in-app state/toasts; push is for background. */
export function usePushPresence(chatId?: string) {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    let disposed = false;
    const update = async () => {
      try {
        const registration = await navigator.serviceWorker.getRegistration("/sw.js");
        const subscription = await registration?.pushManager.getSubscription();
        if (!subscription || disposed) return;
        await fetch("/api/push/presence", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            endpoint: subscription.endpoint,
            instanceId: document.visibilityState === "visible" ? "*" : null,
          }),
          keepalive: true,
        });
      } catch {
        /* Presence expires server-side if the device disappears. */
      }
    };
    void update();
    const timer = setInterval(() => void update(), 30_000);
    const onVisibility = () => void update();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      disposed = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [chatId]);
}
