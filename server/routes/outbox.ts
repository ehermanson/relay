import type { Hono } from "hono";
import type { AppEnv, HttpDeps } from "#server/route-types.js";
import { readBodyBuffer } from "#server/hono-utils.js";
import { createHash } from "node:crypto";

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Durable send receipts prevent a reconnect from blindly duplicating a turn.
 * A reserved receipt after a crash is deliberately reported as uncertain. */
export function registerOutboxRoutes(app: Hono<AppEnv>, deps: HttpDeps): void {
  const db = deps.instanceManager.sessionDb;
  app.get("/api/outbox/identity", (c) => {
    const session = c.get("session");
    const identity = session ? createHash("sha256").update(session.id).digest("hex") : "open";
    return c.json({ identity });
  });
  app.get("/api/outbox/:id", (c) => {
    const id = c.req.param("id");
    if (!ID.test(id)) return c.json({ error: "Invalid send ID" }, 400);
    const receipt = db.getOutboxReceipt(id);
    return receipt ? c.json(receipt) : c.json({ state: "missing" });
  });

  app.post("/api/outbox/:id", async (c) => {
    const id = c.req.param("id");
    if (!ID.test(id)) return c.json({ error: "Invalid send ID" }, 400);
    let body: unknown;
    try {
      body = JSON.parse((await readBodyBuffer(c, 512 * 1024)).toString("utf8"));
    } catch {
      return c.json({ error: "Invalid message" }, 400);
    }
    if (!body || typeof body !== "object") return c.json({ error: "Invalid message" }, 400);
    const data = body as Record<string, unknown>;
    const instanceId = data.instanceId;
    const text = data.text;
    const images = data.images;
    const attachments = data.attachments;
    if (
      typeof instanceId !== "string" ||
      !instanceId ||
      typeof text !== "string" ||
      text.length > 300_000 ||
      (images !== undefined &&
        (!Array.isArray(images) || images.some((p) => typeof p !== "string"))) ||
      (attachments !== undefined &&
        (!Array.isArray(attachments) || attachments.some((p) => typeof p !== "string"))) ||
      (!text.trim() && !images?.length && !attachments?.length)
    )
      return c.json({ error: "Invalid message" }, 400);
    if (!deps.instanceManager.getInstance(instanceId))
      return c.json({ error: "Chat not found" }, 404);

    let state: "new" | "reserved" | "accepted";
    try {
      state = db.reserveOutboxReceipt(id, instanceId);
    } catch {
      return c.json({ error: "Send ID belongs to another chat" }, 409);
    }
    if (state === "accepted") return c.json({ state: "accepted" });
    if (state === "reserved") return c.json({ state: "uncertain" }, 409);

    try {
      await deps.instanceManager.sendMessage(
        instanceId,
        text,
        images as string[] | undefined,
        false,
        attachments as string[] | undefined,
        false,
      );
      db.acceptOutboxReceipt(id);
      return c.json({ state: "accepted" });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Send failed";
      if (message.startsWith("Chat is busy") || message.startsWith("Chat needs input")) {
        db.releaseOutboxReceipt(id);
        return c.json({ state: "busy" }, 409);
      }
      // The provider may have accepted the turn before throwing. Keep the
      // reservation and require the user to decide whether to retry.
      return c.json({ state: "uncertain", error: message }, 409);
    }
  });
}
