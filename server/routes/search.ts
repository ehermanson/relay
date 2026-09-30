import type { Hono } from "hono";
import { accountLoginRootFilter } from "#core/db.js";
import type { AppEnv, HttpDeps } from "#server/route-types.js";

export function registerSearchRoutes(app: Hono<AppEnv>, deps: HttpDeps): void {
  const { instanceManager } = deps;

  app.get("/api/search", (c) => {
    const q = c.req.query("q") ?? "";
    const projectId = c.req.query("projectId") || undefined;
    const boostProjectId = c.req.query("boostProjectId") || undefined;
    const accountId = c.req.query("accountId") || undefined;
    const rawLimit = Number(c.req.query("limit"));
    const limit = Math.max(
      1,
      Math.min(Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : 20, 50),
    );

    // Results carry the account they belong to (absent = default) so the
    // dialog can scope to the active account: managed chats report their
    // stored `account_id` (or the account owning their bound login), external
    // chats resolve by (provider, transcript root).
    const accounts = instanceManager.accounts;

    // `accountId` scopes the query to that account's logins *inside* the SQL,
    // before ranking and the limit — filtering the top-N afterwards let N
    // recent chats of one account hide every chat of another. Absent or
    // unknown ids apply no filter (the single-account wire is unchanged); the
    // default account excludes every other account's logins.
    const loginRoots = accountLoginRootFilter(accounts.list(), accountId);

    // Empty query → recent chats, so the search dialog doubles as a chat switcher
    const results = q.trim()
      ? instanceManager.sessionDb.search(q, {
          projectId,
          boostProjectId,
          limit,
          accounts,
          loginRoots,
        })
      : instanceManager.sessionDb.recentChats({ projectId, limit, accounts, loginRoots });
    return c.json({ results });
  });

  app.post("/api/search/rebuild", (c) => {
    instanceManager.sessionDb.rebuildSearchIndex();
    return c.json({ success: true });
  });
}
