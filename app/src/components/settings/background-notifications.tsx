import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { SettingRow } from "@/components/settings/settings-shared";

function keyBytes(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

async function post(url: string, body: unknown): Promise<{ enabled?: boolean }> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Could not update notifications");
  return data;
}

export function BackgroundNotificationsSetting() {
  const supported =
    typeof window !== "undefined" &&
    window.isSecureContext &&
    "Notification" in window &&
    "serviceWorker" in navigator &&
    "PushManager" in window;
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!supported) return;
    let cancelled = false;
    void (async () => {
      const registration = await navigator.serviceWorker.getRegistration("/sw.js");
      const subscription = await registration?.pushManager.getSubscription();
      if (!subscription) return;
      const result = await post("/api/push/status", { endpoint: subscription.endpoint });
      if (!cancelled) setEnabled(!!result.enabled);
    })().catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [supported]);

  const enable = async () => {
    // This permission call must begin directly inside the user's click gesture.
    const permission = await Notification.requestPermission();
    if (permission !== "granted") {
      setError("Allow notifications in your browser settings to enable this device.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const keyResponse = await fetch("/api/push/key");
      const keyData = await keyResponse.json();
      if (!keyResponse.ok) throw new Error(keyData.error || "Notifications unavailable");
      await navigator.serviceWorker.register("/sw.js");
      const ready = await navigator.serviceWorker.ready;
      const subscription =
        (await ready.pushManager.getSubscription()) ??
        (await ready.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: keyBytes(keyData.publicKey),
        }));
      await post("/api/push/subscription", subscription.toJSON());
      setEnabled(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not enable notifications");
    } finally {
      setBusy(false);
    }
  };

  const disable = async () => {
    setBusy(true);
    setError(null);
    try {
      const registration = await navigator.serviceWorker.getRegistration("/sw.js");
      const subscription = await registration?.pushManager.getSubscription();
      if (subscription) {
        // Remove server delivery first, even if the browser later refuses to unsubscribe.
        await post("/api/push/unsubscribe", { endpoint: subscription.endpoint });
        await subscription.unsubscribe().catch(() => false);
      }
      setEnabled(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not disable notifications");
    } finally {
      setBusy(false);
    }
  };

  const ios =
    /iPhone|iPad|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const standalone = window.matchMedia("(display-mode: standalone)").matches;
  const canEnable = supported && (!ios || standalone);
  return (
    <SettingRow
      label="Background notifications"
      description="Get a device notification when a chat needs input or finishes responding."
    >
      <div className="flex flex-col items-start gap-2">
        {canEnable ? (
          <Button disabled={busy} onClick={() => void (enabled ? disable() : enable())}>
            {busy ? "Updating…" : enabled ? "Turn off" : "Turn on"}
          </Button>
        ) : (
          <span className="text-sm text-muted">
            {ios && !standalone
              ? "Add Relay to the Home Screen to enable notifications."
              : "Requires a secure connection and browser push support."}
          </span>
        )}
        {error && (
          <span role="alert" className="text-xs text-destructive">
            {error}
          </span>
        )}
      </div>
    </SettingRow>
  );
}
