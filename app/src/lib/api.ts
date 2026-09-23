import { videoContentType, MAX_VIDEO_UPLOAD } from "@shared/video-attachments";
import type {
  CreateInstancePayload,
  HistoryEntry,
  InstanceInfo,
  NativeOpenTargetsResponse,
  Project,
  ProviderDescriptor,
  ProviderUpdateResponse,
  ProviderKind,
  ProviderModelsResponse,
  ProjectArtifacts,
  SpinOffInfo,
  SpaceInfo,
  SpacePrStatusResponse,
  UpdateInstallResult,
  UpdateSnapshot,
} from "@shared/types";
import { getDefaultProviderCapabilities } from "@shared/provider-catalog";

export class ApiError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export class TaskApiError extends ApiError {
  code?: string;

  constructor(message: string, status: number, code?: string) {
    super(message, status);
    this.name = "TaskApiError";
    this.code = code;
  }
}

/**
 * Thrown by createInstance when the server rejects with the concurrent-process
 * cap (`code: "max_processes"`). Callers can catch this to open the
 * "free up capacity" dialog instead of surfacing a bare toast.
 */
export class MaxProcessesError extends ApiError {
  readonly limit: number;

  constructor(message: string, limit: number) {
    super(message, 400);
    this.name = "MaxProcessesError";
    this.limit = limit;
  }
}

export interface HealthResponse {
  status: string;
  uptime: number;
  instances: number;
  version: string;
  authRequired: boolean;
  git: { branch: string; isWorktree: boolean; spaceName?: string } | null;
}

export async function fetchHealth(): Promise<HealthResponse> {
  const res = await fetch("/health");
  if (!res.ok) throw new Error("Failed to fetch health");
  return res.json();
}

export async function login(password: string): Promise<{ success: boolean; error?: string }> {
  const res = await fetch("/auth", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  });

  if (res.ok) {
    return { success: true };
  }

  let error = "Authentication failed";
  try {
    const data = await res.json();
    if (data.error) error = data.error;
  } catch {
    // Use default
  }
  return { success: false, error };
}

export interface PairingCodeResponse {
  code: string;
  createdAt: number;
  expiresAt: number;
}

export interface ConnectEndpoint {
  id: string;
  label: string;
  url: string;
  kind: "tailscale" | "lan" | "localhost" | "browser";
}

export async function createPairingCode(): Promise<PairingCodeResponse> {
  const res = await fetch("/api/pairing", {
    method: "POST",
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: "Failed to create pairing code" }));
    throw new Error(data.error || "Failed to create pairing code");
  }
  return res.json();
}

export async function fetchConnectEndpoints(): Promise<{ endpoints: ConnectEndpoint[] }> {
  const res = await fetch("/api/connect-endpoints");
  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: "Failed to fetch connect endpoints" }));
    throw new Error(data.error || "Failed to fetch connect endpoints");
  }
  return res.json();
}

export async function pairWithCode(code: string): Promise<{ success: boolean; error?: string }> {
  const res = await fetch("/auth/pair", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
  });

  if (res.ok) {
    return { success: true };
  }

  const data = await res.json().catch(() => ({ error: "Pairing failed" }));
  return { success: false, error: data.error || "Pairing failed" };
}

export async function fetchDirectories(): Promise<{
  defaultDirectory: string;
  directories: { path: string; lastUsed: number }[];
}> {
  const res = await fetch("/api/directories");
  if (!res.ok) throw new Error("Failed to fetch directories");
  return res.json();
}

export async function fetchGitRepos(): Promise<string[]> {
  const res = await fetch("/api/git-repos");
  if (!res.ok) return [];
  const data = (await res.json()) as { repos?: string[] };
  return data.repos ?? [];
}

export async function browsePath(
  prefix: string,
  opts?: { gitOnly?: boolean },
): Promise<{ home: string; directories: string[]; gitRepos?: string[] }> {
  const params = new URLSearchParams({ prefix });
  if (opts?.gitOnly) params.set("gitOnly", "1");
  const res = await fetch("/api/browse?" + params.toString());
  if (!res.ok) return { home: "", directories: [] };
  return res.json();
}

export async function fetchWorkspaceEntries(
  instanceId: string,
  query: string,
): Promise<{ entries: Array<{ path: string; kind: "file" | "directory" }> }> {
  const res = await fetch(
    `/api/workspace-entries?instanceId=${encodeURIComponent(instanceId)}&q=${encodeURIComponent(query)}`,
  );
  if (!res.ok) return { entries: [] };
  return res.json();
}

/** Project-scoped variant for @-mentions outside a running session (settings editor). */
export async function fetchProjectWorkspaceEntries(
  projectId: string,
  query: string,
): Promise<{ entries: Array<{ path: string; kind: "file" | "directory" }> }> {
  const res = await fetch(
    `/api/projects/${encodeURIComponent(projectId)}/workspace-entries?q=${encodeURIComponent(query)}`,
  );
  // Guard against the SPA fallback (HTML 200) when the route isn't live yet, and
  // any non-JSON/parse failure — degrade to empty rather than throwing.
  if (!res.ok || !res.headers.get("content-type")?.includes("application/json")) {
    return { entries: [] };
  }
  try {
    return await res.json();
  } catch {
    return { entries: [] };
  }
}

export async function fetchProviderModels(provider: ProviderKind): Promise<ProviderModelsResponse> {
  const res = await fetch(`/api/provider-models?provider=${encodeURIComponent(provider)}`);
  if (!res.ok) throw new Error("Failed to fetch provider models");
  const data = (await res.json()) as ProviderModelsResponse;
  return {
    provider,
    models: data.models ?? [],
    capabilities: data.capabilities ?? getDefaultProviderCapabilities(provider),
    defaultModel: data.defaultModel,
  };
}

export async function fetchProviders(): Promise<ProviderDescriptor[]> {
  const res = await fetch("/api/providers");
  if (!res.ok) throw new Error("Failed to fetch providers");
  const data = (await res.json()) as { providers?: ProviderDescriptor[] };
  return data.providers ?? [];
}

/**
 * Force a fresh version probe against the npm registry, bypassing the
 * server's 1h in-memory cache. Returns the refreshed provider list so callers
 * can update react-query in one shot.
 */
export async function recheckProviderVersions(
  provider?: ProviderKind,
): Promise<ProviderDescriptor[]> {
  const params = provider ? `?provider=${encodeURIComponent(provider)}` : "";
  const res = await fetch(`/api/providers/recheck-version${params}`, { method: "POST" });
  if (!res.ok) {
    const message = await res.text().catch(() => "");
    throw new Error(message || "Failed to recheck provider version");
  }
  const data = (await res.json()) as { providers?: ProviderDescriptor[] };
  return data.providers ?? [];
}

/**
 * Run the provider CLI's update command server-side. Resolves once the update
 * finishes and the server has re-probed the version advisory; returns the
 * verified outcome, command output, and refreshed provider list.
 */
export async function runProviderUpdate(provider: ProviderKind): Promise<ProviderUpdateResponse> {
  const res = await fetch(`/api/providers/update?provider=${encodeURIComponent(provider)}`, {
    method: "POST",
  });
  const data = (await res.json().catch(() => ({}))) as {
    error?: string;
    result?: ProviderUpdateResponse["result"];
    providers?: ProviderDescriptor[];
  };
  if (!res.ok) {
    throw new Error(data.error || "Update failed");
  }
  if (!data.result)
    throw new Error("Update response missing verification details. Refresh Relay and try again.");
  return { result: data.result, providers: data.providers ?? [] };
}

export async function addProviderMcpServer(
  provider: ProviderKind,
  input: {
    name: string;
    transport?: "http" | "sse" | "stdio";
    url?: string;
    command?: string;
    args?: string[];
    bearerTokenEnvVar?: string;
    scope?: "global" | "project";
    projectId?: string;
  },
): Promise<void> {
  const res = await fetch(`/api/providers/${encodeURIComponent(provider)}/mcp-servers`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(data.error || "Failed to add MCP server");
}

export async function fetchProjectMcpServers(
  provider: ProviderKind,
  projectId: string,
): Promise<
  Array<{
    name: string;
    transport: "http" | "sse" | "stdio" | "unknown";
    target?: string;
    scope: "local" | "project";
  }>
> {
  const res = await fetch(
    `/api/providers/${encodeURIComponent(provider)}/mcp-servers?projectId=${encodeURIComponent(projectId)}`,
  );
  if (!res.ok) throw new Error("Failed to load Project MCP servers");
  const data = (await res.json()) as {
    servers?: Array<{
      name: string;
      transport: "http" | "sse" | "stdio" | "unknown";
      target?: string;
      scope: "local" | "project";
    }>;
  };
  return data.servers ?? [];
}

export async function fetchUpdateStatus(): Promise<UpdateSnapshot> {
  const res = await fetch("/api/system/update");
  if (!res.ok) throw new Error("Failed to fetch update status");
  return res.json();
}

export async function checkForUpdates(force = false): Promise<UpdateSnapshot> {
  const params = force ? "?force=1" : "";
  const res = await fetch(`/api/system/update/check${params}`, {
    method: "POST",
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: "Failed to check for updates" }));
    throw new Error(data.error || "Failed to check for updates");
  }
  return res.json();
}

export async function installUpdate(): Promise<UpdateInstallResult> {
  const res = await fetch("/api/system/update/install", {
    method: "POST",
  });
  const data = (await res.json().catch(() => ({
    ok: false,
    action: "restart",
    error: "Failed to install update",
  }))) as UpdateInstallResult;
  if (!res.ok) {
    throw new Error(data.error || "Failed to install update");
  }
  return data;
}

export async function createInstance(
  payload: Omit<CreateInstancePayload, "type">,
): Promise<InstanceInfo> {
  const res = await fetch("/api/instances", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: "Failed to create instance" }));
    if (data.code === "max_processes") {
      throw new MaxProcessesError(
        data.error || "Maximum processes reached",
        typeof data.limit === "number" ? data.limit : 0,
      );
    }
    throw new Error(data.error || "Failed to create instance");
  }

  return res.json();
}

export async function fetchInstanceHistory(instanceId: string): Promise<HistoryEntry[]> {
  const res = await fetch(`/api/instances/${encodeURIComponent(instanceId)}/history`);
  if (!res.ok) throw new Error("Failed to fetch instance history");
  return res.json();
}

/**
 * Detailed transcript of one delegated agent (`agentId` is the Relay agent key,
 * `AgentInfo.agentId`). Served from transcript files — never boots or resumes
 * anything. Returns `null` when the server has no history for this agent (404).
 */
export async function fetchAgentHistory(
  instanceId: string,
  agentId: string,
): Promise<HistoryEntry[] | null> {
  const res = await fetch(
    `/api/instances/${encodeURIComponent(instanceId)}/agents/${encodeURIComponent(agentId)}/history`,
  );
  if (res.status === 404) return null;
  if (!res.ok) throw new Error("Failed to fetch agent history");
  const data = (await res.json()) as { history?: HistoryEntry[] };
  return Array.isArray(data.history) ? data.history : [];
}

export async function fetchAgentModel(instanceId: string, agentId: string): Promise<string | null> {
  const res = await fetch(
    `/api/instances/${encodeURIComponent(instanceId)}/agents/${encodeURIComponent(agentId)}/model`,
  );
  if (!res.ok) throw new Error("Failed to fetch agent model");
  const data = (await res.json()) as { model: string | null };
  return data.model;
}

export async function fetchInstanceSummary(instanceId: string): Promise<InstanceInfo | null> {
  const res = await fetch(`/api/instances/${encodeURIComponent(instanceId)}/summary`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error("Failed to fetch instance summary");
  return res.json();
}

// Extension -> Content-Type fallback used when the OS reports an empty MIME
// (common for .md, .log, .yaml, etc. dragged from the filesystem). Values must
// match an entry in the server's ALLOWED_MIMES table (server/routes/uploads.ts).
const EXT_TO_MIME: Record<string, string> = {
  ".pdf": "application/pdf",
  ".json": "application/json",
  ".csv": "text/csv",
  ".md": "text/markdown",
  ".txt": "text/plain",
  ".log": "text/plain",
  ".html": "text/html",
  ".yaml": "application/yaml",
  ".yml": "application/yaml",
  ".xml": "application/xml",
  ".diff": "text/x-diff",
  ".patch": "text/x-patch",
  ".sql": "application/sql",
};

function inferContentType(file: File): string {
  const videoMime = videoContentType(file.name, file.type);
  if (videoMime) return videoMime;
  if (file.type) return file.type;
  const dot = file.name.lastIndexOf(".");
  if (dot < 0) return "application/octet-stream";
  return EXT_TO_MIME[file.name.slice(dot).toLowerCase()] ?? "application/octet-stream";
}

/**
 * Upload a single file attachment (image, video, or supported document) to the server.
 * Returns the absolute path on disk where the file was staged (~/.relay/uploads/<uuid>.ext).
 */
export async function uploadAttachment(file: File): Promise<string> {
  const limit = videoContentType(file.name, file.type) ? MAX_VIDEO_UPLOAD : 10 * 1024 * 1024;
  if (file.size > limit) throw new Error(`File too large (${limit / (1024 * 1024)}MB limit)`);
  const res = await fetch("/api/upload", {
    method: "POST",
    headers: { "Content-Type": inferContentType(file) },
    body: file,
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: "Upload failed" }));
    throw new Error(data.error || "Upload failed");
  }
  const data = await res.json();
  return data.path;
}

// ─── Task CRUD ────────────────────────────────────────────────────────────

interface CreateTaskInput {
  title: string;
  description?: string;
  priority?: number;
  type?: import("@shared/types").TaskType;
  tags?: string[];
  parent?: string | null;
  blockedBy?: string[];
}

interface UpdateTaskInput {
  title?: string;
  description?: string;
  status?: import("@shared/types").TaskStatus;
  priority?: number;
  type?: import("@shared/types").TaskType;
  tags?: string[];
  parent?: string | null;
  blockedBy?: string[];
  expectedRevision?: string;
}

export interface TaskScopeOptions {
  spaceId?: string;
  includeArchived?: boolean;
}

function taskScopeQuery(options: TaskScopeOptions = {}): string {
  const params = new URLSearchParams();
  if (options.spaceId) params.set("spaceId", options.spaceId);
  if (options.includeArchived) params.set("includeArchived", "true");
  const query = params.toString();
  return query ? `?${query}` : "";
}

async function taskApiError(res: Response, fallback: string): Promise<TaskApiError> {
  const data = (await res.json().catch(() => null)) as { error?: string; code?: string } | null;
  return new TaskApiError(data?.error || fallback, res.status, data?.code);
}

export async function fetchTasks(
  projectId: string,
  options: TaskScopeOptions = {},
): Promise<import("@shared/types").Task[] | null> {
  const res = await fetch(
    `/api/projects/${encodeURIComponent(projectId)}/tasks${taskScopeQuery(options)}`,
  );
  if (!res.ok) throw await taskApiError(res, "Failed to load tasks");
  const data = await res.json();
  return data.tasks;
}

export async function createTaskApi(
  projectId: string,
  input: CreateTaskInput,
  options: TaskScopeOptions = {},
): Promise<import("@shared/types").Task> {
  const res = await fetch(
    `/api/projects/${encodeURIComponent(projectId)}/tasks${taskScopeQuery(options)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    },
  );
  if (!res.ok) {
    throw await taskApiError(res, "Failed to create task");
  }
  return res.json();
}

export async function updateTaskApi(
  projectId: string,
  taskId: string,
  patch: UpdateTaskInput,
  options: TaskScopeOptions = {},
): Promise<import("@shared/types").Task> {
  const res = await fetch(
    `/api/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}${taskScopeQuery(options)}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    },
  );
  if (!res.ok) {
    throw await taskApiError(res, "Failed to update task");
  }
  return res.json();
}

export async function deleteTaskApi(
  projectId: string,
  taskId: string,
  expectedRevision: string,
  options: TaskScopeOptions = {},
): Promise<void> {
  const params = new URLSearchParams();
  if (options.spaceId) params.set("spaceId", options.spaceId);
  params.set("expectedRevision", expectedRevision);
  const res = await fetch(
    `/api/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}?${params}`,
    { method: "DELETE" },
  );
  if (!res.ok) {
    throw await taskApiError(res, "Failed to delete task");
  }
}

export async function fetchTask(
  projectId: string,
  taskId: string,
  options: TaskScopeOptions = {},
): Promise<import("@shared/types").Task | null> {
  const res = await fetch(
    `/api/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}${taskScopeQuery(options)}`,
  );
  if (res.status === 404) return null;
  if (!res.ok) throw await taskApiError(res, "Failed to load task");
  return res.json();
}

export async function fetchTaskComments(
  projectId: string,
  taskId: string,
  options: TaskScopeOptions = {},
): Promise<import("@shared/types").TaskComment[]> {
  const res = await fetch(
    `/api/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}/comments${taskScopeQuery(options)}`,
  );
  if (!res.ok) throw await taskApiError(res, "Failed to load discussion");
  const data = await res.json();
  return data.comments;
}

export async function addTaskCommentApi(
  projectId: string,
  taskId: string,
  input: { body: string; author?: string; replyTo?: string },
  options: TaskScopeOptions = {},
): Promise<import("@shared/types").TaskComment> {
  const res = await fetch(
    `/api/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}/comments${taskScopeQuery(options)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    },
  );
  if (!res.ok) throw await taskApiError(res, "Failed to add comment");
  return res.json();
}

export async function initTasksApi(
  projectId: string,
  options: TaskScopeOptions = {},
): Promise<{ snippet: string }> {
  const res = await fetch(
    `/api/projects/${encodeURIComponent(projectId)}/tasks/init${taskScopeQuery(options)}`,
    {
      method: "POST",
    },
  );
  if (!res.ok) throw new Error("Failed to initialize tasks");
  return res.json();
}

export async function fetchProjectIcons(): Promise<Record<string, string>> {
  const res = await fetch("/api/project-icons");
  if (!res.ok) return {};
  return res.json();
}

export async function fetchProject(projectId: string): Promise<Project> {
  const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}`);
  if (!res.ok) throw new ApiError("Failed to fetch project", res.status);
  return res.json();
}

export async function fetchProjectArtifacts(projectId: string): Promise<ProjectArtifacts> {
  const res = await fetch(`/api/project-artifacts/${encodeURIComponent(projectId)}`);
  if (!res.ok) throw new ApiError("Failed to fetch project", res.status);
  return res.json();
}

export async function fetchProjectChats(projectId: string): Promise<InstanceInfo[]> {
  const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/chats`);
  if (!res.ok) return [];
  return res.json();
}

export async function setInstancePinned(instanceId: string, pinned: boolean): Promise<void> {
  const res = await fetch(`/api/instances/${encodeURIComponent(instanceId)}/pinned`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pinned }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: "Failed to pin chat" }));
    throw new ApiError(data.error || "Failed to pin chat", res.status);
  }
}

export async function setInstanceDone(instanceId: string, done: boolean): Promise<void> {
  const res = await fetch(`/api/instances/${encodeURIComponent(instanceId)}/done`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ done }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: "Failed to update chat" }));
    throw new ApiError(data.error || "Failed to update chat", res.status);
  }
}

/** Mark many chats done in one request; resolves to the number updated. */
export async function setInstancesDone(instanceIds: string[], done: boolean): Promise<number> {
  const res = await fetch("/api/instances/done-bulk", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ instanceIds, done }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: "Failed to update chats" }));
    throw new ApiError(data.error || "Failed to update chats", res.status);
  }
  const data = (await res.json()) as { updated?: number };
  return data.updated ?? 0;
}

export async function fetchSpaceChats(spaceId: string): Promise<InstanceInfo[]> {
  const res = await fetch(`/api/spaces/${encodeURIComponent(spaceId)}/chats`);
  if (!res.ok) return [];
  return res.json();
}

export async function openNativePath(target: {
  path: string;
  line?: number;
  column?: number;
  targetId?: string;
  rememberForProject?: boolean;
}): Promise<void> {
  const res = await fetch("/api/open", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(target),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: "Failed to open path" }));
    throw new Error(data.error || "Failed to open path");
  }
}

export async function fetchOpenTargets(targetPath: string): Promise<NativeOpenTargetsResponse> {
  const res = await fetch(`/api/open-targets?path=${encodeURIComponent(targetPath)}`);
  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: "Failed to fetch open targets" }));
    throw new Error(data.error || "Failed to fetch open targets");
  }
  return res.json();
}

export async function fetchInstanceDiff(instanceId: string, filePath?: string): Promise<string> {
  const params = new URLSearchParams();
  if (filePath) params.set("path", filePath);
  const qs = params.toString();
  const url = `/api/instances/${encodeURIComponent(instanceId)}/diff${qs ? `?${qs}` : ""}`;
  const res = await fetch(url);
  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: "Failed to fetch diff" }));
    throw new Error(data.error || "Failed to fetch diff");
  }
  const data = await res.json();
  return data.diff;
}

export async function gitPushInstance(
  instanceId: string,
  opts?: { branch?: string; setUpstream?: boolean; commitMessage?: string },
): Promise<GitOpResult> {
  const res = await fetch(`/api/instances/${encodeURIComponent(instanceId)}/git/push`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(opts ?? {}),
  });
  return res.json();
}

export async function fetchInstanceGitStatus(instanceId: string): Promise<GitWorktreeStatus> {
  const res = await fetch(`/api/instances/${encodeURIComponent(instanceId)}/git/status`);
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error || "Failed to read git status");
  }
  return data;
}

export async function gitCommitInstance(
  instanceId: string,
  opts?: { message?: string },
): Promise<GitOpResult> {
  const res = await fetch(`/api/instances/${encodeURIComponent(instanceId)}/git/commit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(opts ?? {}),
  });
  return res.json();
}

export async function gitFetchInstance(instanceId: string): Promise<GitOpResult> {
  const res = await fetch(`/api/instances/${encodeURIComponent(instanceId)}/git/fetch`, {
    method: "POST",
  });
  return res.json();
}

export async function gitPullInstance(
  instanceId: string,
  opts?: { rebase?: boolean },
): Promise<GitOpResult> {
  const res = await fetch(`/api/instances/${encodeURIComponent(instanceId)}/git/pull`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(opts ?? {}),
  });
  return res.json();
}

// =========================================================================
// Project CRUD
// =========================================================================

export async function fetchProjects(): Promise<Project[]> {
  const res = await fetch("/api/projects");
  if (!res.ok) return [];
  const data = (await res.json()) as { projects?: Project[] };
  return data.projects ?? [];
}

export async function addProject(
  directory: string,
  opts?: { name?: string; targetBranch?: string },
): Promise<Project> {
  const res = await fetch("/api/projects", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ directory, ...opts }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: "Failed to add project" }));
    throw new Error(data.error || "Failed to add project");
  }
  return res.json();
}

export async function createProject(parentDirectory: string, name: string): Promise<Project> {
  const res = await fetch("/api/projects/init", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ parentDirectory, name }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: "Failed to create project" }));
    throw new Error(data.error || "Failed to create project");
  }
  return res.json();
}

export async function updateProject(
  id: string,
  updates: {
    name?: string;
    targetBranch?: string | null;
    customInstructions?: string | null;
    defaultSpaceBranch?: string | null;
    spaceBranchSource?: "local" | "remote" | null;
    defaultProvider?: string | null;
    defaultModel?: string | null;
    suggestions?: import("@shared/types").SuggestionsConfig | null;
  },
): Promise<Project> {
  const res = await fetch(`/api/projects/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(updates),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: "Failed to update project" }));
    throw new Error(data.error || "Failed to update project");
  }
  return res.json();
}

export async function fetchProjectSuggestions(
  projectId: string,
): Promise<import("@shared/types").ResolvedSuggestion[]> {
  try {
    const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/suggestions`);
    if (!res.ok) return [];
    const ct = res.headers.get("content-type") ?? "";
    if (!ct.includes("application/json")) return [];
    return await res.json();
  } catch {
    return [];
  }
}

export async function removeProject(id: string): Promise<void> {
  const res = await fetch(`/api/projects/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: "Failed to remove project" }));
    throw new Error(data.error || "Failed to remove project");
  }
}

// =========================================================================
// Space API
// =========================================================================

export async function createSpace(
  projectId: string,
  opts?: { name?: string; baseBranch?: string; description?: string },
): Promise<SpaceInfo> {
  const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/spaces`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(opts ?? {}),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: "Failed to create space" }));
    throw new Error(data.error || "Failed to create space");
  }
  return res.json();
}

export interface ConvertibleWorktree {
  path: string;
  branch: string;
}

export async function fetchConvertibleWorktrees(projectId: string): Promise<ConvertibleWorktree[]> {
  const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/convertible-worktrees`);
  if (!res.ok) throw new Error("Failed to fetch convertible worktrees");
  const data: { worktrees: ConvertibleWorktree[] } = await res.json();
  return data.worktrees;
}

export async function convertWorktreeToSpace(
  projectId: string,
  opts: { worktreePath: string; name?: string; description?: string },
): Promise<SpaceInfo> {
  const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/convert-worktree`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(opts),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: "Failed to convert worktree" }));
    throw new Error(data.error || "Failed to convert worktree");
  }
  return res.json();
}

export async function fetchSpaceDetail(spaceId: string): Promise<SpaceInfo> {
  const res = await fetch(`/api/spaces/${encodeURIComponent(spaceId)}`);
  if (!res.ok) throw new Error("Failed to fetch space");
  return res.json();
}

export async function setSpacePinned(spaceId: string, pinned: boolean): Promise<SpaceInfo> {
  const res = await fetch(`/api/spaces/${encodeURIComponent(spaceId)}/pinned`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pinned }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: "Failed to pin space" }));
    throw new Error(data.error || "Failed to pin space");
  }
  return res.json();
}

/**
 * Complete refused (nothing merged). `errorKind === "conflict"` carries the
 * conflicting paths; the message already includes resolution guidance.
 */
export class SpaceCompleteError extends Error {
  readonly errorKind?: string;
  readonly conflicts: string[];
  readonly targetBranch?: string;
  readonly worktreePath?: string | null;
  constructor(data: {
    error?: string;
    errorKind?: string;
    conflicts?: string[];
    targetBranch?: string;
    worktreePath?: string | null;
  }) {
    super(data.error || "Failed to complete space");
    this.name = "SpaceCompleteError";
    this.errorKind = data.errorKind;
    this.conflicts = Array.isArray(data.conflicts) ? data.conflicts : [];
    this.targetBranch = data.targetBranch;
    this.worktreePath = data.worktreePath;
  }
}

export async function completeSpace(
  spaceId: string,
  opts?: { mergeMethod?: string; squashMessage?: string },
): Promise<{
  success: boolean;
  targetBranch: string;
  mergeCommit?: string;
  mergeMethod?: string;
  /** Checkout whose files were updated, or null when only the branch ref moved. */
  updatedCheckout?: string | null;
  alreadyMerged?: boolean;
}> {
  const res = await fetch(`/api/spaces/${encodeURIComponent(spaceId)}/complete`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(opts ?? {}),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: "Failed to complete space" }));
    throw new SpaceCompleteError(data);
  }
  return res.json();
}

export async function markSpaceMerged(
  spaceId: string,
): Promise<{ success: boolean; targetBranch: string }> {
  const res = await fetch(`/api/spaces/${encodeURIComponent(spaceId)}/mark-merged`, {
    method: "POST",
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: "Failed to mark space as merged" }));
    throw new Error(data.error || "Failed to mark space as merged");
  }
  return res.json();
}

export async function fetchAllSpaces(projectId: string): Promise<SpaceInfo[]> {
  const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/spaces/all`);
  if (!res.ok) throw new Error("Failed to fetch spaces");
  return res.json();
}

export async function deleteSpace(spaceId: string): Promise<void> {
  const res = await fetch(`/api/spaces/${encodeURIComponent(spaceId)}`, {
    method: "DELETE",
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: "Failed to delete space" }));
    throw new Error(data.error || "Failed to delete space");
  }
}

export async function fetchSpaceDiff(spaceId: string): Promise<string> {
  const res = await fetch(`/api/spaces/${encodeURIComponent(spaceId)}/diff`);
  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: "Failed to fetch space diff" }));
    throw new Error(data.error || "Failed to fetch space diff");
  }
  const data = await res.json();
  return data.diff;
}

export async function fetchSpacePrStatus(
  spaceId: string,
  opts?: { refresh?: boolean },
): Promise<SpacePrStatusResponse> {
  const query = opts?.refresh ? "?refresh=1" : "";
  const res = await fetch(`/api/spaces/${encodeURIComponent(spaceId)}/pr${query}`);
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new Error(data?.error || "Failed to fetch PR status");
  }
  return res.json();
}

export async function fetchSpaceContext(spaceId: string): Promise<string | null> {
  const res = await fetch(`/api/spaces/${encodeURIComponent(spaceId)}/context`);
  if (!res.ok) return null;
  const data = await res.json();
  return data.content;
}
// ─── Branch & Git Operations ──────────────────────────────────────────────

export interface WorktreeBranchInfo {
  branch: string;
  path: string;
  spaceId?: string;
}

interface BranchesResponse {
  local: string[];
  remote: string[];
  current: string | null;
  aheadBehind: { ahead: number; behind: number };
  /** False when the branch has no upstream (aheadBehind is then 0/0). */
  hasUpstream?: boolean;
  dirty?: boolean;
  worktrees?: WorktreeBranchInfo[];
}

interface GitOpResult {
  success: boolean;
  error?: string;
  errorKind?: string;
  pushed?: boolean;
  message?: string;
}

interface GitWorktreeStatus {
  dirty: boolean;
  changeCount: number;
  aheadBehind: { ahead: number; behind: number };
  /** False when the branch has no upstream (aheadBehind is then 0/0). */
  hasUpstream?: boolean;
  /**
   * True when the worktree is dirty OR (in a space) commits exist on the
   * space branch that aren't in the base branch. Broader than `dirty` —
   * captures committed-but-unmerged space work.
   */
  reviewableDiff?: boolean;
}

export async function fetchBranches(projectId: string): Promise<BranchesResponse> {
  const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/branches`);
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new Error(data?.error || "Failed to fetch branches");
  }
  return res.json();
}

export async function checkoutBranch(projectId: string, branch: string): Promise<BranchesResponse> {
  const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/checkout`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ branch }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: "Failed to switch branch" }));
    throw new Error(data.error || "Failed to switch branch");
  }
  return res.json();
}

export async function gitFetch(projectId: string): Promise<GitOpResult> {
  const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/git/fetch`, {
    method: "POST",
  });
  return res.json();
}

export async function gitPull(
  projectId: string,
  opts?: { rebase?: boolean },
): Promise<GitOpResult> {
  const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/git/pull`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(opts ?? {}),
  });
  return res.json();
}

export async function gitPush(
  projectId: string,
  opts?: { branch?: string; setUpstream?: boolean },
): Promise<GitOpResult> {
  const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/git/push`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(opts ?? {}),
  });
  return res.json();
}

// ─── Space Commit ────────────────────────────────────────────────────────

export async function commitSpace(
  spaceId: string,
  opts?: { message?: string },
): Promise<GitOpResult> {
  const res = await fetch(`/api/spaces/${encodeURIComponent(spaceId)}/commit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(opts ?? {}),
  });
  return res.json();
}

// ─── Space Push ───────────────────────────────────────────────────────────

interface PushSpaceResult {
  pushed: boolean;
  prUrl?: string;
  /** `opened_existing` when an open PR for the branch already existed. */
  prAction?: "created" | "opened_existing";
  error?: string;
  errorKind?: string;
  ghNotFound?: boolean;
  ghNotAuthenticated?: boolean;
}

// ─── Global Settings ──────────────────────────────────────────────────────

export async function fetchGlobalSettings(): Promise<import("@shared/types").GlobalSettings> {
  const res = await fetch("/api/settings");
  if (!res.ok) throw new Error("Failed to fetch global settings");
  return res.json();
}

export async function updateGlobalSettings(
  patch: Partial<import("@shared/types").GlobalSettings>,
): Promise<import("@shared/types").GlobalSettings> {
  const res = await fetch("/api/settings", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: "Failed to update settings" }));
    throw new Error(data.error || "Failed to update settings");
  }
  return res.json();
}

export async function pushSpace(
  spaceId: string,
  opts?: { createPR?: boolean },
): Promise<PushSpaceResult> {
  const res = await fetch(`/api/spaces/${encodeURIComponent(spaceId)}/push`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(opts ?? {}),
  });
  return res.json();
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

export interface SearchResultItem {
  instanceId: string;
  source: "session" | "managed";
  projectId: string | null;
  spaceId: string | null;
  lastActivityAt: number;
  lastMessageAt: number | null;
  createdAt: number;
  title: string;
  summary: string | null;
  gitBranch: string | null;
  snippet: string | null;
  matchField: string | null;
  rank: number;
  /** True when the result came from the OR fallback (not all terms matched) */
  partial?: boolean;
}

export async function searchChats(
  query: string,
  opts?: { projectId?: string; boostProjectId?: string; limit?: number },
): Promise<SearchResultItem[]> {
  const params = new URLSearchParams({ q: query });
  if (opts?.projectId) params.set("projectId", opts.projectId);
  if (opts?.boostProjectId) params.set("boostProjectId", opts.boostProjectId);
  if (opts?.limit) params.set("limit", String(opts.limit));
  const res = await fetch("/api/search?" + params.toString());
  if (!res.ok) return [];
  const data = await res.json();
  return data.results ?? [];
}

// ── Spin-offs ──────────────────────────────────────────────────────────

export interface SpinOffDraft extends SpinOffInfo {
  renderedText: string;
}

export async function createSpinOff(
  sourceChatId: string,
  anchorIndex?: number,
): Promise<SpinOffDraft> {
  const res = await fetch("/api/spin-offs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sourceChatId, anchorIndex }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: "Failed to create spin-off draft" }));
    throw new Error(data.error || "Failed to create spin-off draft");
  }
  return res.json();
}

export async function markSpinOffSent(
  spinOffId: string,
  targetChatId: string,
): Promise<SpinOffInfo> {
  const res = await fetch(`/api/spin-offs/${encodeURIComponent(spinOffId)}/send`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ targetChatId }),
  });
  if (!res.ok) throw new Error("Failed to mark spin-off as sent");
  return res.json();
}
