import type { Hono } from "hono";
import { randomUUID } from "node:crypto";
import {
  DEFAULT_ACCOUNT_ID,
  type Workstream,
  type WorkstreamStatus,
  type WorkstreamsSnapshot,
} from "#core/types.js";
import { readJsonBody } from "#server/hono-utils.js";
import type { AppEnv, HttpDeps } from "#server/route-types.js";

const MAX_NAME_LENGTH = 80;
const STATUSES: WorkstreamStatus[] = ["active", "paused", "done"];

function readName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.trim().replace(/\s+/g, " ");
  return name && name.length <= MAX_NAME_LENGTH ? name : null;
}

/**
 * Workstreams: long-lived, account-scoped chat groupings (`plans/workstreams.md`).
 * Phase 1 is names and membership only; no linked directory, no agent context.
 */
export function registerWorkstreamRoutes(app: Hono<AppEnv>, deps: HttpDeps): void {
  const { instanceManager } = deps;
  const db = () => instanceManager.sessionDb;

  // Absent or unknown ids are the default account, like every account-scoped route.
  const resolveAccountId = (raw: unknown): string => {
    if (typeof raw !== "string" || !raw) return DEFAULT_ACCOUNT_ID;
    return instanceManager.accounts.list().some((account) => account.id === raw)
      ? raw
      : DEFAULT_ACCOUNT_ID;
  };

  const snapshot = (accountId: string): WorkstreamsSnapshot => ({
    workstreams: db().listWorkstreams(accountId),
    members: db().listWorkstreamMembers(accountId),
  });

  app.get("/api/workstreams", (c) => c.json(snapshot(resolveAccountId(c.req.query("accountId")))));

  app.post("/api/workstreams", async (c) => {
    try {
      const body = await readJsonBody<{ name?: unknown; accountId?: unknown }>(c);
      const name = readName(body.name);
      if (!name) return c.json({ error: `Name must be 1-${MAX_NAME_LENGTH} characters` }, 400);
      const now = Date.now();
      const workstream: Workstream = {
        id: randomUUID(),
        accountId: resolveAccountId(body.accountId),
        name,
        status: "active",
        createdAt: now,
        updatedAt: now,
      };
      db().insertWorkstream(workstream);
      return c.json({ workstream });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "Failed to create" }, 400);
    }
  });

  app.patch("/api/workstreams/:id", async (c) => {
    try {
      const body = await readJsonBody<{ name?: unknown; status?: unknown }>(c);
      const patch: { name?: string; status?: WorkstreamStatus } = {};
      if (body.name !== undefined) {
        const name = readName(body.name);
        if (!name) return c.json({ error: `Name must be 1-${MAX_NAME_LENGTH} characters` }, 400);
        patch.name = name;
      }
      if (body.status !== undefined) {
        if (!STATUSES.includes(body.status as WorkstreamStatus)) {
          return c.json({ error: "Invalid status" }, 400);
        }
        patch.status = body.status as WorkstreamStatus;
      }
      const workstream = db().updateWorkstream(c.req.param("id"), patch, Date.now());
      if (!workstream) return c.json({ error: "Workstream not found" }, 404);
      return c.json({ workstream });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "Failed to update" }, 400);
    }
  });

  app.delete("/api/workstreams/:id", (c) => {
    if (!db().deleteWorkstream(c.req.param("id"))) {
      return c.json({ error: "Workstream not found" }, 404);
    }
    return c.json({ success: true });
  });

  // Put a chat in one workstream, or none (`workstreamId: null`). Works for
  // chats with no live instance: membership is keyed by chat id alone.
  app.post("/api/instances/:id/workstream", async (c) => {
    try {
      const body = await readJsonBody<{ workstreamId?: unknown }>(c);
      const workstreamId = body.workstreamId;
      if (workstreamId !== null && typeof workstreamId !== "string") {
        return c.json({ error: "workstreamId must be a string or null" }, 400);
      }
      if (workstreamId && !db().getWorkstream(workstreamId)) {
        return c.json({ error: "Workstream not found" }, 404);
      }
      db().setChatWorkstream(c.req.param("id"), workstreamId, "manual", Date.now());
      return c.json({ success: true });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "Failed to update" }, 400);
    }
  });
}
