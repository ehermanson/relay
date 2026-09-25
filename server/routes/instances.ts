import type { Hono } from "hono";
import {
  commitAll,
  getCommitsAhead,
  getDefaultBranch,
  getWorktreeStatus,
  gitFetch,
  gitPull,
  gitPush,
  isWorktreeDirty,
} from "#core/git.js";
import { MaxProcessesError } from "#core/instance-manager.js";
import type { ProviderKind, ProviderModelOptions, ProviderRuntimeMode } from "#core/types.js";
import { readJsonBody } from "#server/hono-utils.js";
import { gitErrorResponse, gitResultStatus } from "#server/git-http.js";
import type { AppEnv, HttpDeps } from "#server/route-types.js";

export function registerInstanceRoutes(app: Hono<AppEnv>, deps: HttpDeps): void {
  const { instanceManager } = deps;

  app.get("/api/instances", (c) => {
    return c.json(instanceManager.listInstances());
  });

  app.post("/api/instances", async (c) => {
    try {
      const body = await readJsonBody<{
        provider?: ProviderKind;
        name?: string;
        workingDirectory?: string;
        runtimeMode?: ProviderRuntimeMode;
        resumeSessionId?: string;
        model?: string;
        spaceId?: string;
        modelOptions?: ProviderModelOptions;
        parentSessionId?: string;
        review?: import("#core/types.js").ReviewSessionInfo;
        profileId?: string;
      }>(c);
      const info = instanceManager.createInstance({
        provider: body.provider,
        name: body.name,
        workingDirectory: body.workingDirectory,
        runtimeMode: body.runtimeMode,
        resumeSessionId: body.resumeSessionId,
        model: body.model,
        spaceId: body.spaceId,
        modelOptions: body.modelOptions,
        parentSessionId: body.parentSessionId,
        review: body.review,
        profileId: body.profileId,
      });
      return c.json(info, 201);
    } catch (err) {
      if (err instanceof MaxProcessesError) {
        return c.json({ error: err.message, code: "max_processes", limit: err.limit }, 400);
      }
      return c.json(
        { error: err instanceof Error ? err.message : "Failed to create instance" },
        400,
      );
    }
  });

  app.get("/api/instances/:id/summary", (c) => {
    const summary = instanceManager.getChatSummary(c.req.param("id"));
    if (!summary) {
      return c.json({ error: "Instance not found" }, 404);
    }
    return c.json(summary);
  });

  app.post("/api/instances/:id/pinned", async (c) => {
    try {
      const body = await readJsonBody<{ pinned?: boolean }>(c);
      const updated = await instanceManager.setInstancePinned(
        c.req.param("id"),
        body.pinned === true,
      );
      if (!updated) {
        return c.json({ error: "Instance not found" }, 404);
      }
      return c.json({ success: true });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "Failed to pin chat" }, 400);
    }
  });

  app.post("/api/instances/:id/done", async (c) => {
    try {
      const body = await readJsonBody<{ done?: unknown }>(c);
      // Strict: a malformed `done` must not silently clear the marker.
      if (typeof body.done !== "boolean") {
        return c.json({ error: "done must be a boolean" }, 400);
      }
      const updated = await instanceManager.setInstanceDone(c.req.param("id"), body.done);
      if (!updated) {
        return c.json({ error: "Instance not found" }, 404);
      }
      return c.json({ success: true });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "Failed to update chat" }, 400);
    }
  });

  // Bulk done, used by the inbox's "sweep stale chats" action. The client sends
  // explicit ids rather than a cutoff because it is the side that knows each
  // chat's true recency (last activity *or* last transcript message).
  app.post("/api/instances/done-bulk", async (c) => {
    try {
      const body = await readJsonBody<{ instanceIds?: unknown; done?: unknown }>(c);
      if (typeof body.done !== "boolean") {
        return c.json({ error: "done must be a boolean" }, 400);
      }
      if (
        !Array.isArray(body.instanceIds) ||
        body.instanceIds.some((id) => typeof id !== "string")
      ) {
        return c.json({ error: "instanceIds must be an array of strings" }, 400);
      }
      const updated = instanceManager.setInstancesDone(body.instanceIds as string[], body.done);
      return c.json({ success: true, updated });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "Failed to update chats" }, 400);
    }
  });

  app.delete("/api/instances/:id", (c) => {
    const removed = instanceManager.removeInstance(c.req.param("id"));
    if (removed) {
      return c.json({ success: true });
    }
    return c.json({ error: "Instance not found" }, 404);
  });

  app.post("/api/instances/:id/merge", async (c) => {
    try {
      const { targetBranch } = await instanceManager.mergeInstance(c.req.param("id"));
      return c.json({ success: true, targetBranch });
    } catch (err) {
      const { body, status } = gitErrorResponse(err, "Failed to merge");
      return c.json(body, status);
    }
  });

  app.get("/api/instances/:id/history", (c) => {
    try {
      return c.json(instanceManager.getHistory(c.req.param("id")));
    } catch {
      return c.json({ error: "Instance not found" }, 404);
    }
  });

  // Delegated agents known for a chat (live + replayed), keyed by Relay agent key.
  app.get("/api/instances/:id/agents", (c) => {
    try {
      return c.json({ agents: instanceManager.getAgents(c.req.param("id")) });
    } catch {
      return c.json({ error: "Instance not found" }, 404);
    }
  });

  // Small metadata lookup for collapsed agent surfaces.
  app.get("/api/instances/:id/agents/:agentId/model", (c) => {
    const model = instanceManager.readAgentModel(c.req.param("id"), c.req.param("agentId"));
    return c.json({ model: model ?? null });
  });

  // A delegated agent's detailed transcript, read from disk on demand. The
  // `:agentId` is the Relay key (AgentInfo.agentId); the manager resolves the
  // provider-native id. Never boots or resumes a session.
  app.get("/api/instances/:id/agents/:agentId/history", async (c) => {
    const history = await instanceManager.readAgentHistory(
      c.req.param("id"),
      c.req.param("agentId"),
    );
    if (!history) {
      return c.json({ error: "Agent history not available" }, 404);
    }
    return c.json({ history });
  });

  app.get("/api/instances/:id/diff", async (c) => {
    const diff = await instanceManager.getInstanceDiff(c.req.param("id"), c.req.query("path"));
    if (diff === null) {
      return c.json({ error: "Instance not found or not a git repo" }, 404);
    }
    return c.json({ diff });
  });

  app.post("/api/instances/:id/git/commit", async (c) => {
    const instance = instanceManager.getInstance(c.req.param("id"));
    if (!instance) {
      return c.json({ error: "Instance not found" }, 404);
    }
    try {
      const body = await readJsonBody<{ message?: string }>(c);
      const dir = instance.workingDirectory;
      if (!(await isWorktreeDirty(dir))) {
        return c.json({ success: false, error: "Nothing to commit — working tree is clean" }, 400);
      }
      const result = await commitAll(dir, body.message || "Commit via Relay");
      return c.json(result, gitResultStatus(result));
    } catch (err) {
      const { body, status } = gitErrorResponse(err, "Failed to commit");
      return c.json(body, status);
    }
  });

  app.get("/api/instances/:id/git/status", async (c) => {
    const instance = instanceManager.getInstance(c.req.param("id"));
    if (!instance) {
      return c.json({ error: "Instance not found" }, 404);
    }
    try {
      const status = await getWorktreeStatus(instance.workingDirectory);

      // `reviewableDiff` is broader than `dirty`: for a space chat, committed
      // work on the space branch (not yet in the base branch) also counts as
      // "reviewable", so suggestions like "Review Changes" stay relevant after
      // the agent has already committed its work.
      let reviewableDiff = status.dirty;
      if (!reviewableDiff) {
        const spaceId = instance.spaceId;
        if (spaceId) {
          const space = instanceManager.getSpaceManager().getSpace(spaceId);
          const baseRef =
            space?.targetBranch || (await getDefaultBranch(instance.workingDirectory)) || null;
          if (baseRef && baseRef !== space?.gitBranch) {
            // An unknown base ref means "can't tell" — not reviewable.
            reviewableDiff =
              (await getCommitsAhead(instance.workingDirectory, baseRef).catch(() => 0)) > 0;
          }
        }
      }

      return c.json({ ...status, reviewableDiff });
    } catch (err) {
      const { body, status } = gitErrorResponse(err, "Failed to read git status");
      return c.json(body, status);
    }
  });

  app.post("/api/instances/:id/git/push", async (c) => {
    const instance = instanceManager.getInstance(c.req.param("id"));
    if (!instance) {
      return c.json({ error: "Instance not found" }, 404);
    }
    try {
      const body = await readJsonBody<{
        branch?: string;
        setUpstream?: boolean;
        commitMessage?: string;
      }>(c);
      const dirty = await isWorktreeDirty(instance.workingDirectory);
      const commitMessage = body.commitMessage?.trim();
      if (dirty && !commitMessage) {
        return c.json(
          { success: false, error: "Commit or stash uncommitted changes before pushing" },
          400,
        );
      }
      if (dirty && commitMessage) {
        const commitResult = await commitAll(instance.workingDirectory, commitMessage);
        if (!commitResult.success) {
          return c.json(commitResult, gitResultStatus(commitResult));
        }
      }
      const result = await gitPush(
        instance.workingDirectory,
        body.branch || instance.gitInfo?.branch || instance.gitBranch,
        body.setUpstream,
      );
      return c.json(result, gitResultStatus(result));
    } catch (err) {
      const { body, status } = gitErrorResponse(err, "Failed to push");
      return c.json(body, status);
    }
  });

  app.post("/api/instances/:id/git/fetch", async (c) => {
    const instance = instanceManager.getInstance(c.req.param("id"));
    if (!instance) {
      return c.json({ error: "Instance not found" }, 404);
    }
    const result = await gitFetch(instance.workingDirectory);
    return c.json(result, gitResultStatus(result));
  });

  app.post("/api/instances/:id/git/pull", async (c) => {
    const instance = instanceManager.getInstance(c.req.param("id"));
    if (!instance) {
      return c.json({ error: "Instance not found" }, 404);
    }
    const body = await readJsonBody<{ rebase?: boolean }>(c).catch(
      () => ({}) as { rebase?: boolean },
    );
    const result = await gitPull(instance.workingDirectory, { rebase: body.rebase === true });
    return c.json(result, gitResultStatus(result));
  });
}
