/**
 * Relay — Core Library
 *
 * Process management, instance orchestration, and types.
 * No server dependencies (HTTP, WebSocket, auth).
 *
 * @example
 * ```ts
 * import { InstanceManager, resolveCoreConfig } from "claude-relay";
 *
 * const config = resolveCoreConfig({ workingDirectory: "/my/project" });
 * const manager = new InstanceManager(config);
 * const instance = manager.createInstance({ name: "My Session" });
 * ```
 */

export type { ProviderSession, ProviderSessionEvents } from "#core/provider.js";

export { createSdkSession, createSdkSessionSync, resolveQueryFn } from "#core/providers/index.js";
export type {
  ClaudeSdkSession,
  ClaudeSdkSessionOptions,
  CodexAppServerSessionOptions,
  DiscoverCodexModelsOptions,
} from "#core/providers/index.js";
export {
  CodexAppServerSession,
  discoverCodexModels,
  findCodexBinary,
  isCodexInstalled,
} from "#core/providers/index.js";
export {
  BUILTIN_PROVIDER_MODELS,
  DEFAULT_PROVIDER_CAPABILITIES,
  PROVIDER_DISPLAY_NAMES,
  getDefaultProviderCapabilities,
  findProviderModelLabel,
  getBuiltinProviderModels,
  getProviderDisplayName,
  mergeCapabilities,
  resolveProviderDefaultModelOption,
} from "#core/provider-catalog.js";
export {
  buildEffectiveProviderCapabilities,
  getCachedVersionAdvisory,
  getProviderCapabilities,
  getProviderDriver,
  getRegisteredProviders,
  inferClaudeModelIdFromSdkInfo,
  isClaudeAutoModeAvailable,
  isProviderAvailable,
  listAvailableProviders,
  refreshProviderVersionAdvisories,
} from "#core/provider-registry.js";
export { buildProviderSwitchHandoffPrompt } from "#core/session-handoff.js";
export { mcpServerId, normalizeMcpConnectionState, resolveMcpServersForChat } from "#core/mcp.js";

export { ClaudeProcess } from "#core/claude-process.js";
export type { ClaudeProcessEvents } from "#core/claude-process.js";

export { InstanceManager } from "#core/instance-manager.js";
export type { InstanceManagerEvents } from "#core/instance-manager.js";

export { SpaceManager } from "#core/space-manager.js";

export { TerminalManager } from "#core/terminal-manager.js";
export type { TerminalManagerEvents } from "#core/terminal-manager.js";

export type { PtyProcess, PtyAdapterFactory, PtySpawnOptions } from "#core/pty-adapter.js";
export { BasePtyProcess } from "#core/pty-adapter.js";
export { createNodePtyFactory } from "#core/pty-adapters/node-pty.js";

export type { CoreConfig, CoreOptions } from "#core/config.js";
export { resolveCoreConfig } from "#core/config.js";

export type { Logger } from "#core/logger.js";
export { defaultLogger, noopLogger } from "#core/logger.js";

export type { SessionRow, ProjectRow } from "#core/db.js";

export { ProjectManager } from "#core/project-manager.js";
export type { ProjectManagerEvents } from "#core/project-manager.js";

export {
  describeToolUse,
  describeToolDetail,
  extractToolResultText,
  isPermissionDenial,
  INTERACTIVE_TOOLS,
  classifyInteractiveResult,
  buildToolResultActivity,
} from "#core/tools.js";

export {
  isGitRepo,
  getRepoRoot,
  getCurrentBranch,
  createWorktree,
  removeWorktree,
  isRelayWorktreePath,
  resolveWorktreeOrigin,
  enrichDiffStats,
  getFullDiff,
  getFileDiff,
  getDefaultBranch,
  getWorktreeDiff,
} from "#core/git.js";

export { discoverSkills } from "#core/skills.js";

export type {
  SpaceStatus,
  SpaceInfo,
  MergeMethod,
  SkillInfo,
  SessionStats,
  ProviderKind,
  ProviderRequest,
  ProviderCapabilities,
  ProviderDescriptor,
  ProviderModelsResponse,
  ProviderRuntimeBinding,
  ProviderRuntimeMode,
  ProviderModelOption,
  InstanceStatus,
  LastMessagePreview,
  InstanceInfo,
  HistoryEntry,
  MessagePayload,
  CancelPayload,
  ListInstancesPayload,
  CreateInstancePayload,
  RemoveInstancePayload,
  SubscribePayload,
  UnsubscribePayload,
  InstanceMessagePayload,
  InstanceCancelPayload,
  RespondToRequestPayload,
  ClientMessage,
  ConnectedMessage,
  OutputMessage,
  UserMessage,
  ExitMessage,
  ErrorMessage,
  ActivityMessage,
  InstanceListMessage,
  InstanceCreatedMessage,
  InstanceRemovedMessage,
  InstanceStatusMessage,
  InstanceHistoryMessage,
  ServerMessage,
  Session,
  TaskItem,
  FileChange,
  SetRuntimeModePayload,
  CreateSpacePayload,
  CompleteSpacePayload,
  DeleteSpacePayload,
  Project,
  SpaceCreatedMessage,
  SpaceCompletedMessage,
  SpaceRemovedMessage,
  SpaceListMessage,
  ProjectsChangedMessage,
  TerminalInfo,
  TerminalScope,
  TerminalCreatePayload,
  TerminalInputPayload,
  TerminalResizePayload,
  TerminalClosePayload,
  TerminalSubscribePayload,
  TerminalUnsubscribePayload,
  TerminalListPayload,
  TerminalCreatedMessage,
  TerminalOutputMessage,
  TerminalExitMessage,
  TerminalRemovedMessage,
  TerminalScrollbackMessage,
  TerminalListResponse,
  TerminalScopeSummary,
  TerminalScopesMessage,
  ProjectPlan,
  ProjectStats,
  ModelUsageStats,
  ProjectArtifacts,
  Task,
  TaskComment,
  TaskStatus,
  TaskType,
  TasksChangedMessage,
  SuggestionIcon,
  SuggestionCondition,
  SuggestionPatch,
  CustomSuggestion,
  SuggestionsConfig,
  BuiltInSuggestion,
  ResolvedSuggestion,
} from "#core/types.js";

export {
  TaskError,
  loadTasks,
  getTask,
  createTask,
  updateTask,
  deleteTask,
  hasTasks,
  initTasks,
  listTaskComments,
  addTaskComment,
  validateTasks,
  archiveTasks,
  migrateTasks,
  formatTasks,
} from "#core/task-manager.js";
export type {
  TaskErrorCode,
  LoadTasksOptions,
  CreateTaskInput,
  UpdateTaskInput,
  AddTaskCommentInput,
  TaskValidationResult,
  ArchiveTasksResult,
  FormatTasksResult,
  MigrateTasksResult,
} from "#core/task-manager.js";

export {
  BUILT_IN_SUGGESTIONS,
  MAX_SUGGESTIONS,
  resolveSuggestions,
  type SuggestionContext,
} from "#core/actions.js";
export * from "#core/account-profiles.js";
