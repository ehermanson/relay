import {
  getSessionContextFromRuntimePayload,
  hasSessionBootstrapBlock,
} from "#core/session-context.js";
import { CUSTOM_INSTRUCTIONS_BLOCK_KIND, TASK_CONTEXT_BLOCK_KIND } from "#core/session-context.js";
import type { ManagedInstanceRow, SessionRow } from "#core/db.js";
import { dbStatsToSessionStats, gitInfoFromDb, lastMessageFromDb } from "#core/instance-listing.js";
import type {
  InstanceInfo,
  ProviderKind,
  ProviderModelOptions,
  ProviderRuntimeBinding,
  ProviderRuntimeMode,
} from "#core/types.js";

export function buildExternalRestoreState(options: {
  entry: SessionRow;
  provider: ProviderKind;
  workingDirectory: string;
  worktreePath?: string;
  originalDirectory?: string;
  gitBranch?: string;
  inferredSpaceId?: string;
  defaultRuntimeMode: ProviderRuntimeMode;
}): {
  info: InstanceInfo;
  providerBinding: ProviderRuntimeBinding;
  actualCwd: string | undefined;
} {
  const {
    entry,
    provider,
    workingDirectory,
    worktreePath,
    originalDirectory,
    gitBranch,
    inferredSpaceId,
    defaultRuntimeMode,
  } = options;
  const info: InstanceInfo = {
    id: entry.instance_id,
    provider,
    name: entry.name,
    workingDirectory,
    status: "stopped",
    createdAt: entry.created_at,
    lastActivityAt: entry.last_activity_at,
    external: true,
    lastMessage: lastMessageFromDb(entry),
    sessionId: entry.session_id,
    customTitle: entry.custom_title === 1,
    pinned: entry.pinned === 1,
    doneAt: entry.done_at ?? undefined,
    stats: dbStatsToSessionStats(entry),
    gitBranch,
    originalDirectory,
    gitInfo: gitInfoFromDb(entry),
    parentSessionId: entry.parent_session_id ?? undefined,
    preferredModel: entry.preferred_model ?? undefined,
    runtimeMode: (entry.runtime_mode as ProviderRuntimeMode | null) ?? undefined,
    spaceId: inferredSpaceId ?? undefined,
    projectId: entry.project_id ?? undefined,
  };
  return {
    info,
    providerBinding: {
      provider,
      providerSessionId: entry.session_id,
      resumeCursor: { sessionId: entry.session_id },
      runtimePayload: { cwd: workingDirectory },
      transcriptPath: entry.jsonl_path,
      runtimeMode: (entry.runtime_mode as ProviderRuntimeMode | null) ?? defaultRuntimeMode,
    },
    actualCwd: worktreePath ? worktreePath : undefined,
  };
}

export function buildManagedRestoreState(options: {
  entry: ManagedInstanceRow;
  workingDirectory: string;
  worktreePath?: string;
  originalDirectory?: string;
  gitBranch?: string;
  inferredSpaceId?: string;
  resumeCursor: unknown;
  runtimePayload: Record<string, unknown> | undefined;
  resumeSessionId?: string;
  transcriptPath?: string;
  modelOptions?: ProviderModelOptions;
  review: InstanceInfo["review"];
  reviewInstanceId?: string;
}): {
  info: InstanceInfo;
  providerBinding: ProviderRuntimeBinding;
  actualCwd: string | undefined;
  taskContextInjected: boolean;
  customInstructionsInjected: boolean;
} {
  const {
    entry,
    workingDirectory,
    worktreePath,
    originalDirectory,
    gitBranch,
    inferredSpaceId,
    resumeCursor,
    runtimePayload,
    resumeSessionId,
    transcriptPath,
    modelOptions,
    review,
    reviewInstanceId,
  } = options;
  const sessionContext = getSessionContextFromRuntimePayload(runtimePayload);
  const info: InstanceInfo = {
    id: entry.instance_id,
    provider: entry.provider_name as ProviderKind,
    name: entry.name,
    workingDirectory,
    status: "stopped",
    createdAt: entry.created_at,
    lastActivityAt: entry.last_activity_at,
    lastMessage: lastMessageFromDb(entry),
    sessionId: resumeSessionId,
    customTitle: entry.custom_title === 1,
    pinned: entry.pinned === 1,
    doneAt: entry.done_at ?? undefined,
    stats: dbStatsToSessionStats(entry),
    gitBranch,
    originalDirectory,
    gitInfo: gitInfoFromDb(entry),
    originalGitBranch:
      entry.original_git_branch ?? entry.git_branch ?? entry.git_info_branch ?? undefined,
    parentSessionId: entry.parent_session_id ?? undefined,
    preferredModel: entry.preferred_model ?? undefined,
    modelOptions,
    configDir: entry.config_dir ?? undefined,
    runtimeMode: entry.runtime_mode as ProviderRuntimeMode,
    spaceId: inferredSpaceId ?? undefined,
    projectId: entry.project_id ?? undefined,
    sessionContext,
    review,
    reviewInstanceId,
  };
  return {
    info,
    providerBinding: {
      provider: entry.provider_name as ProviderKind,
      providerSessionId: resumeSessionId,
      resumeCursor,
      runtimePayload,
      transcriptPath,
      runtimeMode: entry.runtime_mode as ProviderRuntimeMode,
    },
    actualCwd: worktreePath ? workingDirectory : undefined,
    taskContextInjected: hasSessionBootstrapBlock(sessionContext, TASK_CONTEXT_BLOCK_KIND),
    customInstructionsInjected: hasSessionBootstrapBlock(
      sessionContext,
      CUSTOM_INSTRUCTIONS_BLOCK_KIND,
    ),
  };
}
