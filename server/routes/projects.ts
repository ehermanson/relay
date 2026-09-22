import type { Hono } from "hono";
import { existsSync } from "node:fs";
import * as taskManager from "#core/task-manager.js";
import {
  checkoutBranch,
  commitAll,
  getAheadBehind,
  gitFetch,
  gitPull,
  gitPush,
  isWorktreeDirty,
  listBranches,
  listWorktrees,
} from "#core/git.js";
import { resolveSuggestions } from "#core/actions.js";
import { searchWorkspaceEntries } from "#core/workspace-entries.js";
import { readJsonBody } from "#server/hono-utils.js";
import type { AppEnv, HttpDeps } from "#server/route-types.js";
import type { Project, SuggestionsConfig } from "#core/types.js";

class TaskScopeError extends Error {
  readonly status: 404 | 409;
  readonly code: "scope_not_found" | "scope_unavailable";

  constructor(message: string, status: 404 | 409, code: "scope_not_found" | "scope_unavailable") {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function resolveTaskScope(
  instanceManager: HttpDeps["instanceManager"],
  projectId: string,
  requestedSpaceId: string | undefined,
): { project: Project; directory: string; spaceId?: string } {
  const project = instanceManager.projectManager.getProject(projectId);
  if (!project) {
    throw new TaskScopeError("Project not found", 404, "scope_not_found");
  }

  const spaceId = requestedSpaceId?.trim();
  if (!spaceId) return { project, directory: project.directory };

  const space = instanceManager.getSpaceManager().getSpace(spaceId);
  if (!space || space.projectDirectory !== project.directory) {
    throw new TaskScopeError("Space not found for this project", 404, "scope_not_found");
  }

  // Main and the default Space are the same scope. Canonicalize both to an
  // omitted spaceId so websocket invalidation keys cannot diverge.
  if (space.isDefault) return { project, directory: project.directory };

  if (space.status !== "active" || !space.worktreePath || !existsSync(space.worktreePath)) {
    const reason =
      space.status === "completed" || space.status === "archived"
        ? `Space "${space.name}" is closed`
        : `Space "${space.name}" has no usable worktree`;
    throw new TaskScopeError(reason, 409, "scope_unavailable");
  }

  return { project, directory: space.worktreePath, spaceId: space.id };
}

function taskErrorDetails(error: unknown): {
  message: string;
  code?: string;
  status: 400 | 404 | 409;
} {
  const message = error instanceof Error ? error.message : "Task operation failed";
  const code =
    error && typeof error === "object" && "code" in error && typeof error.code === "string"
      ? error.code
      : undefined;
  if (code === "not_found") return { message, code, status: 404 };
  if (
    code === "conflict" ||
    code === "legacy_requires_migration" ||
    code === "ambiguous_sources" ||
    code === "lock_timeout"
  ) {
    return { message, code, status: 409 };
  }
  return { message, code, status: 400 };
}

function expectedRevisionFromRequest(c: {
  req: { query(name: string): string | undefined; header(name: string): string | undefined };
}): string | undefined {
  const value =
    c.req.query("expectedRevision") ?? c.req.query("revision") ?? c.req.header("If-Match");
  if (!value) return undefined;
  return value.replace(/^W\//, "").replace(/^"|"$/g, "");
}

export function registerProjectRoutes(app: Hono<AppEnv>, deps: HttpDeps): void {
  const { instanceManager } = deps;

  app.post("/api/projects/:id/tasks/init", (c) => {
    try {
      const scope = resolveTaskScope(instanceManager, c.req.param("id"), c.req.query("spaceId"));
      taskManager.initTasks(scope.directory);
      instanceManager.notifyTasksChanged(scope.project.id, scope.spaceId);
      return c.json({ snippet: taskManager.TASKS_CLAUDE_MD_SNIPPET });
    } catch (error) {
      if (error instanceof TaskScopeError) {
        return c.json({ error: error.message, code: error.code }, error.status);
      }
      const details = taskErrorDetails(error);
      return c.json({ error: details.message, code: details.code }, details.status);
    }
  });

  app.get("/api/projects/:id/tasks", (c) => {
    try {
      const scope = resolveTaskScope(instanceManager, c.req.param("id"), c.req.query("spaceId"));
      const tasks = taskManager.hasTasks(scope.directory)
        ? taskManager.loadTasks(scope.directory, {
            includeArchived: c.req.query("includeArchived") === "true",
          })
        : null;
      return c.json({ tasks });
    } catch (error) {
      if (error instanceof TaskScopeError) {
        return c.json({ error: error.message, code: error.code }, error.status);
      }
      const details = taskErrorDetails(error);
      return c.json({ error: details.message, code: details.code }, details.status);
    }
  });

  app.get("/api/projects/:id/tasks/:taskId", (c) => {
    try {
      const scope = resolveTaskScope(instanceManager, c.req.param("id"), c.req.query("spaceId"));
      const task = taskManager.getTask(scope.directory, c.req.param("taskId"));
      if (!task) return c.json({ error: "Task not found", code: "not_found" }, 404);
      return c.json(task);
    } catch (error) {
      if (error instanceof TaskScopeError) {
        return c.json({ error: error.message, code: error.code }, error.status);
      }
      const details = taskErrorDetails(error);
      return c.json({ error: details.message, code: details.code }, details.status);
    }
  });

  app.get("/api/projects/:id/tasks/:taskId/comments", (c) => {
    try {
      const scope = resolveTaskScope(instanceManager, c.req.param("id"), c.req.query("spaceId"));
      const comments = taskManager.listTaskComments(scope.directory, c.req.param("taskId"));
      return c.json({ comments });
    } catch (error) {
      if (error instanceof TaskScopeError) {
        return c.json({ error: error.message, code: error.code }, error.status);
      }
      const details = taskErrorDetails(error);
      return c.json({ error: details.message, code: details.code }, details.status);
    }
  });

  app.post("/api/projects/:id/tasks/:taskId/comments", async (c) => {
    try {
      const scope = resolveTaskScope(instanceManager, c.req.param("id"), c.req.query("spaceId"));
      const body = await readJsonBody<taskManager.AddTaskCommentInput>(c);
      const comment = taskManager.addTaskComment(scope.directory, c.req.param("taskId"), body);
      instanceManager.notifyTasksChanged(scope.project.id, scope.spaceId);
      return c.json(comment, 201);
    } catch (error) {
      if (error instanceof TaskScopeError) {
        return c.json({ error: error.message, code: error.code }, error.status);
      }
      const details = taskErrorDetails(error);
      return c.json({ error: details.message, code: details.code }, details.status);
    }
  });

  app.post("/api/projects/:id/tasks", async (c) => {
    const projectId = c.req.param("id");
    try {
      const scope = resolveTaskScope(instanceManager, projectId, c.req.query("spaceId"));
      const body = await readJsonBody<taskManager.CreateTaskInput>(c);
      if (!body.title || typeof body.title !== "string") {
        return c.json({ error: "Missing title" }, 400);
      }
      const task = taskManager.createTask(scope.directory, body);
      instanceManager.notifyTasksChanged(scope.project.id, scope.spaceId);
      return c.json(task, 201);
    } catch (error) {
      if (error instanceof TaskScopeError) {
        return c.json({ error: error.message, code: error.code }, error.status);
      }
      const details = taskErrorDetails(error);
      return c.json({ error: details.message, code: details.code }, details.status);
    }
  });

  app.patch("/api/projects/:id/tasks/:taskId", async (c) => {
    const projectId = c.req.param("id");
    const taskId = c.req.param("taskId");
    try {
      const scope = resolveTaskScope(instanceManager, projectId, c.req.query("spaceId"));
      const body = await readJsonBody<taskManager.UpdateTaskInput>(c);
      const task = taskManager.updateTask(scope.directory, taskId, {
        ...body,
        expectedRevision: body.expectedRevision ?? expectedRevisionFromRequest(c),
      });
      instanceManager.notifyTasksChanged(scope.project.id, scope.spaceId);
      return c.json(task);
    } catch (error) {
      if (error instanceof TaskScopeError) {
        return c.json({ error: error.message, code: error.code }, error.status);
      }
      const details = taskErrorDetails(error);
      return c.json({ error: details.message, code: details.code }, details.status);
    }
  });

  app.delete("/api/projects/:id/tasks/:taskId", (c) => {
    const projectId = c.req.param("id");
    const taskId = c.req.param("taskId");
    try {
      const scope = resolveTaskScope(instanceManager, projectId, c.req.query("spaceId"));
      taskManager.deleteTask(scope.directory, taskId, expectedRevisionFromRequest(c));
      instanceManager.notifyTasksChanged(scope.project.id, scope.spaceId);
      return c.body(null, 204);
    } catch (error) {
      if (error instanceof TaskScopeError) {
        return c.json({ error: error.message, code: error.code }, error.status);
      }
      const details = taskErrorDetails(error);
      return c.json({ error: details.message, code: details.code }, details.status);
    }
  });

  app.get("/api/projects/:id/chats", (c) => {
    const project = instanceManager.projectManager.getProject(c.req.param("id"));
    if (!project) {
      return c.json({ error: "Project not found" }, 404);
    }
    return c.json(instanceManager.listProjectChats(project.id));
  });

  app.get("/api/projects", (c) => {
    return c.json({ projects: instanceManager.projectManager.listProjects() });
  });

  app.post("/api/projects", async (c) => {
    try {
      const body = await readJsonBody<{
        directory?: string;
        name?: string;
        targetBranch?: string;
      }>(c);
      if (!body.directory || typeof body.directory !== "string") {
        return c.json({ error: "Missing directory" }, 400);
      }
      const project = instanceManager.projectManager.addProject(body.directory, {
        name: body.name,
        targetBranch: body.targetBranch,
      });
      instanceManager.rescanAll();
      return c.json(project, 201);
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : "Failed to register project" },
        400,
      );
    }
  });

  app.post("/api/projects/init", async (c) => {
    try {
      const body = await readJsonBody<{
        parentDirectory?: string;
        name?: string;
      }>(c);
      if (!body.parentDirectory || typeof body.parentDirectory !== "string") {
        return c.json({ error: "Missing parentDirectory" }, 400);
      }
      if (!body.name || typeof body.name !== "string") {
        return c.json({ error: "Missing name" }, 400);
      }
      const project = instanceManager.projectManager.initProject(
        body.parentDirectory,
        body.name.trim(),
      );
      instanceManager.rescanAll();
      return c.json(project, 201);
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : "Failed to create project" },
        400,
      );
    }
  });

  app.get("/api/projects/:id", (c) => {
    const project = instanceManager.projectManager.getProject(c.req.param("id"));
    if (!project) {
      return c.json({ error: "Project not found" }, 404);
    }
    return c.json(project);
  });

  app.patch("/api/projects/:id", async (c) => {
    try {
      const body = await readJsonBody<{
        name?: string;
        targetBranch?: string | null;
        customInstructions?: string | null;
        defaultSpaceBranch?: string | null;
        spaceBranchSource?: "local" | "remote" | null;
        defaultProvider?: string | null;
        defaultModel?: string | null;
        suggestions?: import("#core/types.js").SuggestionsConfig | null;
      }>(c);
      const project = instanceManager.projectManager.updateProject(c.req.param("id"), body);
      if (!project) {
        return c.json({ error: "Project not found" }, 404);
      }
      return c.json(project);
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : "Failed to update project" },
        400,
      );
    }
  });

  app.delete("/api/projects/:id", (c) => {
    const removed = instanceManager.projectManager.removeProject(c.req.param("id"));
    if (removed) {
      return c.json({ success: true });
    }
    return c.json({ error: "Project not found" }, 404);
  });

  /** Get resolved suggestions for a project (built-in + global + project layers). */
  app.get("/api/projects/:id/suggestions", (c) => {
    const project = instanceManager.projectManager.getProject(c.req.param("id"));
    if (!project) return c.json({ error: "Project not found" }, 404);

    const globalRow = instanceManager.sessionDb.getGlobalSettings();
    let globalSuggestions: SuggestionsConfig | null = null;
    if (globalRow.suggestions_json) {
      try {
        globalSuggestions = JSON.parse(globalRow.suggestions_json);
      } catch {}
    }

    // Check for open tasks (server-evaluated condition)
    let hasOpenTasks = false;
    if (taskManager.hasTasks(project.directory)) {
      try {
        const tasks = taskManager.loadTasks(project.directory);
        hasOpenTasks = tasks.some((t) => t.status === "open" || t.status === "in_progress");
      } catch (error) {
        deps.config.logger.warn(
          `[Projects] Could not load task files for suggestions in ${project.directory}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    return c.json(resolveSuggestions(globalSuggestions, project.suggestions, { hasOpenTasks }));
  });

  app.get("/api/project-icons", (c) => {
    return c.json(instanceManager.getProjectIcons());
  });

  app.get("/api/project-artifacts/:name", (c) => {
    const artifacts = instanceManager.getProjectArtifacts(c.req.param("name"));
    if (!artifacts) {
      return c.json({ error: "Project not found" }, 404);
    }
    return c.json(artifacts);
  });

  // Project-scoped file/dir search for @-mentions outside a running session
  // (e.g. the settings instructions editor). Mirrors /api/workspace-entries but
  // keys off the project's root directory instead of an instance's CWD.
  app.get("/api/projects/:id/workspace-entries", (c) => {
    const project = instanceManager.projectManager.getProject(c.req.param("id"));
    if (!project) {
      return c.json({ error: "Project not found" }, 404);
    }
    const query = c.req.query("q") || "";
    const entries = searchWorkspaceEntries(project.directory, query);
    return c.json({ entries });
  });

  app.get("/api/projects/:id/branches", (c) => {
    const project = instanceManager.projectManager.getProject(c.req.param("id"));
    if (!project) {
      return c.json({ error: "Project not found" }, 404);
    }
    const dir = project.repoRoot || project.directory;
    const branches = listBranches(dir);
    const aheadBehind = getAheadBehind(dir);
    const dirty = isWorktreeDirty(dir);
    const spaceManager = instanceManager.getSpaceManager();
    const worktrees = listWorktrees(dir)
      .filter((w) => !w.isPrimary && w.branch)
      .map((w) => ({
        branch: w.branch as string,
        path: w.path,
        spaceId: spaceManager.getSpaceByWorktreePath(w.path)?.id,
      }));
    return c.json({ ...branches, aheadBehind, dirty, worktrees });
  });

  app.post("/api/projects/:id/checkout", async (c) => {
    const project = instanceManager.projectManager.getProject(c.req.param("id"));
    if (!project) {
      return c.json({ error: "Project not found" }, 404);
    }
    try {
      const body = await readJsonBody<{ branch: string }>(c);
      if (!body.branch) {
        return c.json({ error: "branch is required" }, 400);
      }
      const dir = project.repoRoot || project.directory;
      checkoutBranch(dir, body.branch);
      const branches = listBranches(dir);
      const aheadBehind = getAheadBehind(dir);
      return c.json({ ...branches, aheadBehind });
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : "Failed to checkout branch" },
        400,
      );
    }
  });

  app.post("/api/projects/:id/git/fetch", async (c) => {
    const project = instanceManager.projectManager.getProject(c.req.param("id"));
    if (!project) {
      return c.json({ error: "Project not found" }, 404);
    }
    const dir = project.repoRoot || project.directory;
    const result = await gitFetch(dir);
    return c.json(result, result.success ? 200 : 400);
  });

  app.post("/api/projects/:id/git/pull", async (c) => {
    const project = instanceManager.projectManager.getProject(c.req.param("id"));
    if (!project) {
      return c.json({ error: "Project not found" }, 404);
    }
    const dir = project.repoRoot || project.directory;
    const body = await readJsonBody<{ rebase?: boolean }>(c).catch(
      () => ({}) as { rebase?: boolean },
    );
    const result = await gitPull(dir, { rebase: body.rebase === true });
    return c.json(result, result.success ? 200 : 400);
  });

  app.post("/api/projects/:id/git/push", async (c) => {
    const project = instanceManager.projectManager.getProject(c.req.param("id"));
    if (!project) {
      return c.json({ error: "Project not found" }, 404);
    }
    try {
      const body = await readJsonBody<{
        branch?: string;
        setUpstream?: boolean;
      }>(c);
      const dir = project.repoRoot || project.directory;
      const result = await gitPush(dir, body.branch, body.setUpstream);
      return c.json(result, result.success ? 200 : 400);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "Failed to push" }, 400);
    }
  });

  app.post("/api/projects/:id/git/commit", async (c) => {
    const project = instanceManager.projectManager.getProject(c.req.param("id"));
    if (!project) {
      return c.json({ error: "Project not found" }, 404);
    }
    try {
      const body = await readJsonBody<{ message?: string }>(c);
      const dir = project.repoRoot || project.directory;
      if (!isWorktreeDirty(dir)) {
        return c.json({ success: false, error: "Nothing to commit — working tree is clean" }, 400);
      }
      const result = commitAll(dir, body.message || "Commit via Relay");
      return c.json(result, result.success ? 200 : 400);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "Failed to commit" }, 400);
    }
  });
}
