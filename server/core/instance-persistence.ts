import { buildPersistedRuntimePayload } from "#core/managed-session-identity.js";
import type { ManagedInstanceRow, SessionRow } from "#core/db.js";
import type { InstanceInfo, ProviderRuntimeBinding, SessionStats } from "#core/types.js";

export function toSessionRow(options: {
  info: InstanceInfo;
  sessionId: string;
  jsonlPath: string;
  gitBranch?: string;
  worktreePath?: string;
  originalDirectory?: string;
}): SessionRow {
  const { info, sessionId, jsonlPath, gitBranch, worktreePath, originalDirectory } = options;
  const stats = info.stats;
  return {
    session_id: sessionId,
    instance_id: info.id,
    provider_name: info.provider,
    name: info.name,
    working_directory: info.workingDirectory,
    jsonl_path: jsonlPath,
    created_at: info.createdAt,
    last_activity_at: info.lastActivityAt,
    type: info.external ? "external" : "managed",
    archived: 0,
    custom_title: info.customTitle ? 1 : 0,
    pinned: info.pinned ? 1 : 0,
    done_at: info.doneAt ?? null,
    input_tokens: stats?.inputTokens ?? 0,
    output_tokens: stats?.outputTokens ?? 0,
    cache_creation_tokens: stats?.cacheCreationTokens ?? 0,
    cache_read_tokens: stats?.cacheReadTokens ?? 0,
    summary: null,
    first_prompt: null,
    git_branch: gitBranch ?? null,
    message_count: 0,
    allowed_tools: "[]",
    worktree_path: worktreePath ?? null,
    original_directory: originalDirectory ?? null,
    parent_session_id: info.parentSessionId ?? null,
    preferred_model: info.preferredModel ?? null,
    reasoning_budget: null,
    runtime_mode: info.runtimeMode ?? null,
    last_message_text: info.lastMessage?.text ?? null,
    last_message_from: info.lastMessage?.from ?? null,
    last_message_at: info.lastMessage?.timestamp ?? null,
    git_info_branch: info.gitInfo?.branch ?? null,
    git_info_is_worktree:
      info.gitInfo?.isWorktree !== undefined ? (info.gitInfo.isWorktree ? 1 : 0) : null,
    space_id: info.spaceId ?? null,
    project_id: info.projectId ?? null,
    model: stats?.model ?? null,
  };
}

export function toManagedInstanceRow(options: {
  info: InstanceInfo;
  binding?: ProviderRuntimeBinding;
  sessionId?: string;
  jsonlPath?: string;
  gitBranch?: string;
  worktreePath?: string;
  originalDirectory?: string;
  defaultRuntimeMode: string;
}): ManagedInstanceRow {
  const {
    info,
    binding,
    sessionId,
    jsonlPath,
    gitBranch,
    worktreePath,
    originalDirectory,
    defaultRuntimeMode,
  } = options;
  const stats = info.stats;
  const runtimePayload = buildPersistedRuntimePayload(binding?.runtimePayload, info);
  return {
    instance_id: info.id,
    provider_name: info.provider,
    provider_session_id: binding?.providerSessionId ?? sessionId ?? info.sessionId ?? null,
    name: info.name,
    working_directory: info.workingDirectory,
    created_at: info.createdAt,
    last_activity_at: info.lastActivityAt,
    archived: 0,
    custom_title: info.customTitle ? 1 : 0,
    pinned: info.pinned ? 1 : 0,
    done_at: info.doneAt ?? null,
    input_tokens: stats?.inputTokens ?? 0,
    output_tokens: stats?.outputTokens ?? 0,
    cache_creation_tokens: stats?.cacheCreationTokens ?? 0,
    cache_read_tokens: stats?.cacheReadTokens ?? 0,
    git_branch: gitBranch ?? null,
    worktree_path: worktreePath ?? null,
    original_directory: originalDirectory ?? null,
    parent_session_id: info.parentSessionId ?? null,
    preferred_model: info.preferredModel ?? null,
    reasoning_budget: null,
    runtime_mode: info.runtimeMode ?? defaultRuntimeMode,
    resume_cursor_json: binding?.resumeCursor ? JSON.stringify(binding.resumeCursor) : null,
    runtime_payload_json: runtimePayload ? JSON.stringify(runtimePayload) : null,
    transcript_path: binding?.transcriptPath ?? jsonlPath ?? null,
    last_message_text: info.lastMessage?.text ?? null,
    last_message_from: info.lastMessage?.from ?? null,
    last_message_at: info.lastMessage?.timestamp ?? null,
    git_info_branch: info.gitInfo?.branch ?? null,
    git_info_is_worktree:
      info.gitInfo?.isWorktree !== undefined ? (info.gitInfo.isWorktree ? 1 : 0) : null,
    space_id: info.spaceId ?? null,
    project_id: info.projectId ?? null,
    model: stats?.model ?? null,
    model_options_json: info.modelOptions ? JSON.stringify(info.modelOptions) : null,
    original_git_branch: info.originalGitBranch ?? null,
    config_dir: info.configDir ?? null,
  };
}

export function hasPersistedTokenUsage(
  row: Pick<
    SessionRow | ManagedInstanceRow,
    "input_tokens" | "output_tokens" | "cache_creation_tokens" | "cache_read_tokens"
  >,
): boolean {
  return (
    row.input_tokens > 0 ||
    row.output_tokens > 0 ||
    row.cache_creation_tokens > 0 ||
    row.cache_read_tokens > 0
  );
}

export function isSameManagedSessionIdentity(
  a: ManagedInstanceRow,
  b: ManagedInstanceRow,
): boolean {
  return !!(
    (a.provider_session_id &&
      b.provider_session_id &&
      a.provider_session_id === b.provider_session_id) ||
    (a.transcript_path && b.transcript_path && a.transcript_path === b.transcript_path)
  );
}

export function compareManagedCanonicalRows(
  a: ManagedInstanceRow,
  b: ManagedInstanceRow,
  preferredInstanceId?: string,
): number {
  if (preferredInstanceId) {
    if (a.instance_id === preferredInstanceId && b.instance_id !== preferredInstanceId) return 1;
    if (b.instance_id === preferredInstanceId && a.instance_id !== preferredInstanceId) return -1;
  }
  if (a.last_activity_at !== b.last_activity_at) return a.last_activity_at - b.last_activity_at;
  if (!!a.resume_cursor_json !== !!b.resume_cursor_json) return a.resume_cursor_json ? 1 : -1;
  if (!!a.provider_session_id !== !!b.provider_session_id) return a.provider_session_id ? 1 : -1;
  if (!!a.transcript_path !== !!b.transcript_path) return a.transcript_path ? 1 : -1;
  if (a.created_at !== b.created_at) return a.created_at - b.created_at;
  return a.instance_id.localeCompare(b.instance_id);
}

export function mergeBackfilledStats(
  current: SessionStats | undefined,
  stats: SessionStats,
): SessionStats {
  return {
    inputTokens: stats.inputTokens,
    outputTokens: stats.outputTokens,
    cacheCreationTokens: stats.cacheCreationTokens,
    cacheReadTokens: stats.cacheReadTokens,
    model: stats.model ?? current?.model,
    contextTokens: stats.contextTokens ?? current?.contextTokens,
    contextWindow: stats.contextWindow ?? current?.contextWindow,
    contextCategories: stats.contextCategories ?? current?.contextCategories,
    reasoningTokens: stats.reasoningTokens ?? current?.reasoningTokens,
  };
}

export function buildBackfilledSessionRow(row: SessionRow, stats: SessionStats): SessionRow | null {
  const nextRow: SessionRow = {
    ...row,
    input_tokens: stats.inputTokens,
    output_tokens: stats.outputTokens,
    cache_creation_tokens: stats.cacheCreationTokens,
    cache_read_tokens: stats.cacheReadTokens,
    model: row.model ?? stats.model ?? null,
  };
  if (
    nextRow.input_tokens === row.input_tokens &&
    nextRow.output_tokens === row.output_tokens &&
    nextRow.cache_creation_tokens === row.cache_creation_tokens &&
    nextRow.cache_read_tokens === row.cache_read_tokens &&
    nextRow.model === row.model
  ) {
    return null;
  }
  return nextRow;
}

export function buildBackfilledManagedRow(
  row: ManagedInstanceRow,
  stats: SessionStats,
  transcriptPath: string,
): ManagedInstanceRow | null {
  const nextRow: ManagedInstanceRow = {
    ...row,
    input_tokens: stats.inputTokens,
    output_tokens: stats.outputTokens,
    cache_creation_tokens: stats.cacheCreationTokens,
    cache_read_tokens: stats.cacheReadTokens,
    model: row.model ?? stats.model ?? null,
    transcript_path: transcriptPath,
  };
  if (
    nextRow.input_tokens === row.input_tokens &&
    nextRow.output_tokens === row.output_tokens &&
    nextRow.cache_creation_tokens === row.cache_creation_tokens &&
    nextRow.cache_read_tokens === row.cache_read_tokens &&
    nextRow.model === row.model &&
    nextRow.transcript_path === row.transcript_path
  ) {
    return null;
  }
  return nextRow;
}
