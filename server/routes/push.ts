import type { Hono } from "hono";
import type { AppEnv, HttpDeps } from "#server/route-types.js";
import { readBodyBuffer } from "#server/hono-utils.js";
import type webpush from "web-push";

export function registerPushRoutes(app: Hono<AppEnv>, deps: HttpDeps): void {
  const push = deps.pushNotifications;
  app.get("/api/push/key", (c) =>
    push
      ? c.json({ publicKey: push.publicKey })
      : c.json({ error: "Notifications unavailable" }, 503),
  );

  app.post("/api/push/subscription", async (c) => {
    if (!push) return c.json({ error: "Notifications unavailable" }, 503);
    let subscription: webpush.PushSubscription;
    try {
      subscription = JSON.parse((await readBodyBuffer(c, 4096)).toString("utf8"));
    } catch {
      return c.json({ error: "Invalid subscription" }, 400);
    }
    try {
      push.subscribe(c.get("session")?.id ?? "open", subscription);
      return c.json({ enabled: true });
    } catch (error) {
      return c.json(
        { error: error instanceof Error ? error.message : "Invalid subscription" },
        400,
      );
    }
  });

  app.post("/api/push/unsubscribe", async (c) => {
    if (!push) return c.json({ error: "Notifications unavailable" }, 503);
    let endpoint: unknown;
    try {
      endpoint = JSON.parse((await readBodyBuffer(c, 4096)).toString("utf8")).endpoint;
    } catch {
      return c.json({ error: "Invalid endpoint" }, 400);
    }
    if (typeof endpoint !== "string") return c.json({ error: "Invalid endpoint" }, 400);
    push.unsubscribe(c.get("session")?.id ?? "open", endpoint);
    return c.json({ enabled: false });
  });

  app.post("/api/push/status", async (c) => {
    if (!push) return c.json({ error: "Notifications unavailable" }, 503);
    let endpoint: unknown;
    try {
      endpoint = JSON.parse((await readBodyBuffer(c, 4096)).toString("utf8")).endpoint;
    } catch {
      return c.json({ error: "Invalid endpoint" }, 400);
    }
    return c.json({
      enabled: typeof endpoint === "string" && push.has(c.get("session")?.id ?? "open", endpoint),
    });
  });

  app.post("/api/push/presence", async (c) => {
    if (!push) return c.json({ error: "Notifications unavailable" }, 503);
    let body: { endpoint?: unknown; instanceId?: unknown };
    try {
      body = JSON.parse((await readBodyBuffer(c, 4096)).toString("utf8"));
    } catch {
      return c.json({ error: "Invalid presence" }, 400);
    }
    if (
      typeof body.endpoint !== "string" ||
      (body.instanceId !== null && typeof body.instanceId !== "string")
    ) {
      return c.json({ error: "Invalid presence" }, 400);
    }
    push.setPresence(c.get("session")?.id ?? "open", body.endpoint, body.instanceId || null);
    return c.json({ ok: true });
  });
}
