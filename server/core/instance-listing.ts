import {
  getReviewInstanceIdFromRuntimePayload,
  getReviewSessionFromRuntimePayload,
} from "#core/session-context.js";
import type { InstanceInfo, ProviderKind, ProviderRuntimeMode, SessionStats } from "#core/types.js";
import type { ManagedInstanceRow, SessionRow } from "#core/db.js";

/**
 * Lookup from project UUID to slug. Built by callers (typically once per listing
 * call) from `ProjectManager.listProjects()` so the summary helpers stay pure.
 */
export type ProjectSlugLookup = Map<string, string>;

function slugFor(
  projectId: string | null | undefined,
  lookup: ProjectSlugLookup | undefined,
): string | undefined {
  if (!projectId || !lookup) return undefined;
  return lookup.get(projectId);
}

export function hasSessionStats(stats: SessionStats | undefined): stats is SessionStats {
  if (!stats) return false;
  return (
    stats.inputTokens > 0 ||
    stats.outputTokens > 0 ||
    stats.cacheCreationTokens > 0 ||
    stats.cacheReadTokens > 0 ||
    typeof stats.model === "string" ||
    typeof stats.contextTokens === "number" ||
    typeof stats.contextWindow === "number"
  );
}

export function lastMessageFromDb(entry: {
  last_message_text: string | null;
  last_message_from: string | null;
  last_message_at: number | null;
}): InstanceInfo["lastMessage"] | undefined {
  if (!entry.last_message_text || !entry.last_message_from) return undefined;
  const from =
    entry.last_message_from === "user"
      ? "user"
      : entry.last_message_from === "assistant" || entry.last_message_from === "claude"
        ? "assistant"
        : null;
  if (!from) return undefined;
  return {
    text: entry.last_message_text,
    from,
    timestamp: entry.last_message_at ?? 0,
  };
}

export function dbStatsToSessionStats(entry: {
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  model?: string | null;
}): SessionStats | undefined {
  const stats: SessionStats = {
    inputTokens: entry.input_tokens,
    outputTokens: entry.output_tokens,
    cacheCreationTokens: entry.cache_creation_tokens,
    cacheReadTokens: entry.cache_read_tokens,
    model: entry.model ?? undefined,
  };
  return hasSessionStats(stats) ? stats : undefined;
}

export function gitInfoFromDb(entry: {
  git_info_branch: string | null;
  git_info_is_worktree: number | null;
}): { branch: string; isWorktree: boolean } | undefined {
  if (!entry.git_info_branch) return undefined;
  return {
    branch: entry.git_info_branch,
    isWorktree: entry.git_info_is_worktree === 1,
  };
}

export function toChatSummaryInfo(info: InstanceInfo): InstanceInfo {
  const { lastMessage: _, ...summary } = info;
  return { ...summary };
}

export function summaryFromSessionRow(
  entry: SessionRow,
  projectSlugs?: ProjectSlugLookup,
): InstanceInfo {
  return {
    id: entry.instance_id,
    provider: (entry.provider_name as ProviderKind) || "claude",
    name: entry.name,
    workingDirectory: entry.working_directory,
    status: "stopped",
    createdAt: entry.created_at,
    lastActivityAt: entry.last_activity_at,
    external: true,
    sessionId: entry.session_id,
    customTitle: entry.custom_title === 1,
    pinned: entry.pinned === 1,
    doneAt: entry.done_at ?? undefined,
    stats: dbStatsToSessionStats(entry),
    gitBranch: entry.git_branch ?? undefined,
    originalDirectory: entry.original_directory ?? undefined,
    gitInfo: gitInfoFromDb(entry),
    parentSessionId: entry.parent_session_id ?? undefined,
    preferredModel: entry.preferred_model ?? undefined,
    runtimeMode: (entry.runtime_mode as ProviderRuntimeMode | null) ?? undefined,
    spaceId: entry.space_id ?? undefined,
    projectId: entry.project_id ?? undefined,
    projectSlug: slugFor(entry.project_id, projectSlugs),
  };
}

export function summaryFromManagedRow(
  entry: ManagedInstanceRow,
  projectSlugs?: ProjectSlugLookup,
): InstanceInfo {
  let runtimePayload: Record<string, unknown> | undefined;
  try {
    runtimePayload = entry.runtime_payload_json
      ? (JSON.parse(entry.runtime_payload_json) as Record<string, unknown>)
      : undefined;
  } catch {
    runtimePayload = undefined;
  }
  return {
    id: entry.instance_id,
    provider: entry.provider_name as ProviderKind,
    name: entry.name,
    workingDirectory: entry.working_directory,
    status: "stopped",
    createdAt: entry.created_at,
    lastActivityAt: entry.last_activity_at,
    sessionId: entry.provider_session_id ?? undefined,
    customTitle: entry.custom_title === 1,
    pinned: entry.pinned === 1,
    doneAt: entry.done_at ?? undefined,
    stats: dbStatsToSessionStats(entry),
    gitBranch: entry.git_branch ?? undefined,
    originalDirectory: entry.original_directory ?? undefined,
    gitInfo: gitInfoFromDb(entry),
    originalGitBranch:
      entry.original_git_branch ?? entry.git_branch ?? entry.git_info_branch ?? undefined,
    parentSessionId: entry.parent_session_id ?? undefined,
    preferredModel: entry.preferred_model ?? undefined,
    configDir: entry.config_dir ?? undefined,
    runtimeMode: (entry.runtime_mode as ProviderRuntimeMode | null) ?? undefined,
    spaceId: entry.space_id ?? undefined,
    projectId: entry.project_id ?? undefined,
    projectSlug: slugFor(entry.project_id, projectSlugs),
    review: getReviewSessionFromRuntimePayload(runtimePayload),
    reviewInstanceId: getReviewInstanceIdFromRuntimePayload(runtimePayload),
  };
}

export function sortChatsByLastActivity(chats: InstanceInfo[]): InstanceInfo[] {
  return [...chats].sort((a, b) => b.lastActivityAt - a.lastActivityAt);
}
