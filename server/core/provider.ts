/**
 * Provider Session Interface
 *
 * Abstracts managed session lifecycle so InstanceManager doesn't need to know
 * whether the backing implementation is the Agent SDK, the CLI, or Codex.
 *
 * Both ClaudeSdkSession and ClaudeProcess (CLI fallback) implement this interface.
 */

import { EventEmitter } from "events";
import type {
  OutputMessage,
  ExitMessage,
  ActivityMessage,
  SessionStats,
  SystemEventMessage,
  ProviderKind,
  ProviderRuntimeMode,
  ProviderSessionBootstrap,
  ProviderModelOptions,
  ProviderRequest,
  ProviderRequestResponse,
  ProviderRuntimeBinding,
  AgentUpdateMessage,
  UserMessage,
} from "#core/types.js";

// =============================================================================
// Events
// =============================================================================

export interface ProviderSessionEvents {
  output: [OutputMessage];
  exit: [ExitMessage];
  activity: [ActivityMessage];
  systemEvent: [SystemEventMessage];
  stats: [SessionStats];
  /** Emitted when the provider needs a user decision outside normal chat input. */
  permissionRequest: [ProviderRequest];
  /** Emitted when the provider encounters a non-fatal error that should be surfaced to the user. */
  providerError: [string];
  /** Emitted when the provider generates a title for the session (e.g. Codex thread/name/updated). */
  titleUpdate: [string];
  /**
   * Sparse upsert of one delegated agent (spawn, model, progress, result).
   * Replayable — InstanceManager pushes it into history and broadcasts it
   * like `activity`.
   */
  agentUpdate: [AgentUpdateMessage];
  /**
   * A user-role message the provider surfaced that Relay did not send itself —
   * an agent-to-agent note (`author.kind === "agent"`) or a child agent's own
   * user-role frame (`agentId` set). Never used for the human's own sends.
   */
  userMessage: [UserMessage];
}

// =============================================================================
// Interface
// =============================================================================

export interface ProviderSession extends EventEmitter {
  on<E extends keyof ProviderSessionEvents>(
    event: E,
    listener: (...args: ProviderSessionEvents[E]) => void,
  ): this;
  emit<E extends keyof ProviderSessionEvents>(event: E, ...args: ProviderSessionEvents[E]): boolean;
  off<E extends keyof ProviderSessionEvents>(
    event: E,
    listener: (...args: ProviderSessionEvents[E]) => void,
  ): this;

  /** Send a user message. */
  send(message: string): void;

  /** Interrupt the current turn (SIGINT for CLI, query.interrupt() for SDK). */
  interrupt(): void;

  /** Kill/close the session and release all resources. */
  close(): void | Promise<void>;

  /** Whether a turn is currently active. */
  readonly isProcessing: boolean;

  /** Provider kind implemented by this session. */
  readonly provider: ProviderKind;

  /** PID of the underlying process, if any. Used for discovery exclusion. */
  readonly pid: number | undefined;

  /** Change the model for subsequent turns. Pass null to clear. */
  setModel(model: string | null): void;

  /** Structured bootstrap context delivered once when the session is created. */
  readonly bootstrapContext?: ProviderSessionBootstrap;

  /**
   * Set the runtime mode for subsequent turns. Providers should treat unknown
   * modes (e.g. one not declared in their capabilities.runtimeModes) as a
   * no-op rather than throwing.
   */
  setRuntimeMode(mode: ProviderRuntimeMode): void;

  /** Add a tool to the auto-allowed list (CLI: --allowedTools, SDK: updatedPermissions). */
  addAllowedTool(tool: string): void;

  /** Update canonical model options (effort, fast mode, etc.) at runtime. */
  setModelOptions?(modelOptions: ProviderModelOptions): void;

  /** Trigger provider-native compaction when supported. */
  compactThread?(): void;

  /** Set the provider session ID (CLI provider discovers it post-hoc from transcripts). */
  setSessionId?(sessionId: string): void;

  /** Current accumulated token/cost stats. */
  readonly stats: SessionStats;

  /** Provider-owned runtime state used to restore a managed session. */
  getRuntimeBinding(): ProviderRuntimeBinding;

  /**
   * Resolve a pending provider request (SDK only for now).
   * Returns true if the request was found and handled.
   */
  respondToRequest?(
    requestId: string,
    decision: "accept" | "decline",
    response?: ProviderRequestResponse,
  ): boolean;
}
