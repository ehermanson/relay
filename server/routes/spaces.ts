import type { Hono } from "hono";
import { commitAll, isWorktreeDirty, getPrimaryRemote } from "#core/git.js";
import { readJsonBody } from "#server/hono-utils.js";
import { gitErrorResponse, gitErrorStatus, gitResultStatus } from "#server/git-http.js";
import { SpaceCompletionError } from "#core/space-manager.js";
import { isGitCommandError } from "#core/git-runner.js";
import type { AppEnv, HttpDeps } from "#server/route-types.js";

export function registerSpaceRoutes(app: Hono<AppEnv>, deps: HttpDeps): void {
  const { instanceManager } = deps;

  app.get("/api/projects/:id/spaces", (c) => {
    const project = instanceManager.projectManager.getProject(c.req.param("id"));
    if (!project) {
      return c.json({ error: "Project not found" }, 404);
    }
    return c.json(instanceManager.getSpaceManager().listSpaces(project.directory));
  });

  app.post("/api/projects/:id/spaces", async (c) => {
    const project = instanceManager.projectManager.getProject(c.req.param("id"));
    if (!project) {
      return c.json({ error: "Project not found" }, 404);
    }
    try {
      const body = await readJsonBody<{ name?: string; baseBranch?: string; description?: string }>(
        c,
      );
      let effectiveBranch = body.baseBranch;
      if (!effectiveBranch && project.defaultSpaceBranch) {
        effectiveBranch = project.defaultSpaceBranch;
      }
      // Fall back to global defaults if no project-level branch configured
      const globalSettings = instanceManager.sessionDb.getGlobalSettings();
      if (!effectiveBranch && globalSettings.default_space_branch) {
        effectiveBranch = globalSettings.default_space_branch;
      }
      const branchSource = project.spaceBranchSource ?? globalSettings.space_branch_source;
      if (effectiveBranch && branchSource === "remote" && project.repoRoot) {
        const remote = await getPrimaryRemote(project.repoRoot);
        if (remote && !effectiveBranch.includes("/")) {
          effectiveBranch = `${remote}/${effectiveBranch}`;
        }
      }
      const space = await instanceManager.getSpaceManager().createSpace(project.directory, {
        name: body.name,
        baseBranch: effectiveBranch,
        description: body.description,
      });
      return c.json(space, 201);
    } catch (err) {
      const { body, status } = gitErrorResponse(err, "Failed to create space");
      return c.json(body, status);
    }
  });

  app.get("/api/projects/:id/convertible-worktrees", async (c) => {
    const project = instanceManager.projectManager.getProject(c.req.param("id"));
    if (!project) {
      return c.json({ error: "Project not found" }, 404);
    }
    const dir = project.repoRoot || project.directory;
    try {
      const worktrees = (await instanceManager.getSpaceManager().listConvertibleWorktrees(dir)).map(
        (w) => ({ path: w.path, branch: w.branch }),
      );
      return c.json({ worktrees });
    } catch (err) {
      const { body, status } = gitErrorResponse(err, "Failed to list worktrees");
      return c.json(body, status);
    }
  });

  app.post("/api/projects/:id/convert-worktree", async (c) => {
    const project = instanceManager.projectManager.getProject(c.req.param("id"));
    if (!project) {
      return c.json({ error: "Project not found" }, 404);
    }
    try {
      const body = await readJsonBody<{
        worktreePath: string;
        name?: string;
        description?: string;
      }>(c);
      if (!body.worktreePath) {
        return c.json({ error: "worktreePath is required" }, 400);
      }
      const dir = project.repoRoot || project.directory;
      const space = await instanceManager
        .getSpaceManager()
        .convertWorktreeToSpace(dir, body.worktreePath, {
          name: body.name,
          description: body.description,
        });
      instanceManager.claimChatsForSpace(space.id);
      return c.json(space, 201);
    } catch (err) {
      const { body, status } = gitErrorResponse(err, "Failed to convert worktree");
      return c.json(body, status);
    }
  });

  app.get("/api/projects/:id/spaces/all", (c) => {
    const project = instanceManager.projectManager.getProject(c.req.param("id"));
    if (!project) {
      return c.json({ error: "Project not found" }, 404);
    }
    return c.json(instanceManager.getSpaceManager().listAllSpaces(project.directory));
  });

  app.get("/api/spaces/:id", (c) => {
    const space = instanceManager.getSpaceManager().getSpace(c.req.param("id"));
    if (!space) {
      return c.json({ error: "Space not found" }, 404);
    }
    return c.json(space);
  });

  app.get("/api/spaces/:id/chats", (c) => {
    const space = instanceManager.getSpaceManager().getSpace(c.req.param("id"));
    if (!space) {
      return c.json({ error: "Space not found" }, 404);
    }
    return c.json(instanceManager.listSpaceChats(space.id));
  });

  app.post("/api/spaces/:id/pinned", async (c) => {
    try {
      const body = await readJsonBody<{ pinned?: boolean }>(c);
      if (typeof body.pinned !== "boolean") {
        return c.json({ error: "pinned must be a boolean" }, 400);
      }
      const space = instanceManager
        .getSpaceManager()
        .setSpacePinned(c.req.param("id"), body.pinned);
      return c.json(space);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to pin space";
      return c.json({ error: message }, message.includes("not found") ? 404 : 400);
    }
  });

  app.post("/api/spaces/:id/complete", async (c) => {
    try {
      const body = await readJsonBody<{ mergeMethod?: string; squashMessage?: string }>(c);
      const validMethods = ["squash", "merge-commit"];
      if (body.mergeMethod && !validMethods.includes(body.mergeMethod)) {
        return c.json({ error: `Invalid merge method: ${body.mergeMethod}` }, 400);
      }
      const spaceManager = instanceManager.getSpaceManager();
      if (!spaceManager.getSpace(c.req.param("id"))) {
        return c.json({ error: "Space not found" }, 404);
      }
      const result = await spaceManager.completeSpace(c.req.param("id"), {
        mergeMethod: body.mergeMethod as "squash" | "merge-commit" | undefined,
        squashMessage: body.squashMessage,
      });
      return c.json({ success: true, ...result });
    } catch (err) {
      if (err instanceof SpaceCompletionError) {
        // Refused before anything merged. `conflict` carries the file list.
        return c.json(
          {
            success: false,
            error: err.message,
            errorKind: err.code,
            targetBranch: err.targetBranch,
            conflicts: err.conflicts,
            worktreePath: err.worktreePath,
          },
          err.code === "target_missing" || err.code === "unsupported" ? 400 : 409,
        );
      }
      const { body, status } = gitErrorResponse(err, "Failed to complete space");
      return c.json(body, status);
    }
  });

  app.post("/api/spaces/:id/mark-merged", async (c) => {
    try {
      const result = await instanceManager.getSpaceManager().markSpaceMerged(c.req.param("id"));
      return c.json({ success: true, ...result });
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : "Failed to mark space as merged" },
        400,
      );
    }
  });

  app.delete("/api/spaces/:id", async (c) => {
    try {
      await instanceManager.getSpaceManager().deleteSpace(c.req.param("id"));
      return c.json({ success: true });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "Failed to delete space" }, 400);
    }
  });

  app.post("/api/spaces/:id/commit", async (c) => {
    const space = instanceManager.getSpaceManager().getSpace(c.req.param("id"));
    if (!space) {
      return c.json({ error: "Space not found" }, 404);
    }
    try {
      const body = await readJsonBody<{ message?: string }>(c);
      const dir = space.worktreePath;
      if (!dir) {
        return c.json({ success: false, error: "Space has no worktree" }, 400);
      }
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

  app.post("/api/spaces/:id/push", async (c) => {
    try {
      const body = await readJsonBody<{ createPR?: boolean }>(c);
      const spaceManager = instanceManager.getSpaceManager();
      if (!spaceManager.getSpace(c.req.param("id"))) {
        return c.json({ pushed: false, error: "Space not found" }, 404);
      }
      const result = await spaceManager.pushSpace(c.req.param("id"), { createPR: body.createPR });
      if (result.pushed) return c.json(result, 200);
      return c.json(
        result,
        result.errorKind
          ? gitErrorStatus(result.errorKind as Parameters<typeof gitErrorStatus>[0])
          : 400,
      );
    } catch (err) {
      const { body, status } = gitErrorResponse(err, "Failed to push space");
      return c.json({ pushed: false, ...body }, status);
    }
  });

  app.get("/api/spaces/:id/diff", async (c) => {
    try {
      const diff = await instanceManager.getSpaceManager().getSpaceDiff(c.req.param("id"));
      if (diff == null) {
        return c.json({ error: "Space not found" }, 404);
      }
      return c.json({ diff });
    } catch (err) {
      // A real git failure — distinct from a missing space (404 above).
      const { body, status } = gitErrorResponse(err, "Failed to compute space diff");
      const gitFailed = isGitCommandError(err) && err.kind === "failed";
      return c.json(body, gitFailed ? 500 : status);
    }
  });

  /**
   * PR status for a space (60s cache, backoff on gh failures). `?refresh=1`
   * bypasses the cache. `stale: true` means `pr` is the last persisted
   * snapshot because the live read failed.
   */
  app.get("/api/spaces/:id/pr", async (c) => {
    const force = c.req.query("refresh") === "1" || c.req.query("refresh") === "true";
    const status = await instanceManager
      .getSpaceManager()
      .getSpacePrStatus(c.req.param("id"), { force });
    if (!status) return c.json({ error: "Space not found" }, 404);
    return c.json(status);
  });

  app.get("/api/spaces/:id/context", (c) => {
    const content = instanceManager.getSpaceManager().readSpaceContext(c.req.param("id"));
    return c.json({ content });
  });
}
