import type { Hono } from "hono";
import type { AppEnv, HttpDeps } from "#server/route-types.js";
import { getRepoStatusService } from "#core/repo-status-service.js";
import type { RepoStatusTarget } from "#core/types.js";
import { resolveRepoStatusDir } from "#server/repo-status-targets.js";

/**
 * REST fallback for the push-based `repo_status` WebSocket stream: one
 * snapshot for `?instanceId=` / `?spaceId=` / `?projectId=`. Serves the cached
 * snapshot when the directory is already subscribed, otherwise computes once.
 */
export function registerRepoStatusRoutes(app: Hono<AppEnv>, deps: HttpDeps): void {
  const { instanceManager } = deps;

  app.get("/api/repo-status", async (c) => {
    const instanceId = c.req.query("instanceId");
    const spaceId = c.req.query("spaceId");
    const projectId = c.req.query("projectId");
    const target: RepoStatusTarget | null = instanceId
      ? { kind: "instance", instanceId }
      : spaceId
        ? { kind: "space", spaceId }
        : projectId
          ? { kind: "project", projectId }
          : null;
    if (!target) {
      return c.json({ error: "One of instanceId, spaceId, or projectId is required" }, 400);
    }
    const dir = resolveRepoStatusDir(instanceManager, target);
    if (!dir) return c.json({ error: "Target not found" }, 404);
    const status = await getRepoStatusService().getSnapshot(dir);
    return c.json({ target, status });
  });
}
