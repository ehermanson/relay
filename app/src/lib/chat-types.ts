/**
 * Shared type definitions for chat message components.
 *
 * Named types for each row variant (instead of inline unions), plus
 * shared enums/literals used across multiple components.
 */

import type { ActivityMessage } from "@shared/types";
import type { LargeUserRenderMode } from "@/lib/message-rendering";

// ── Activity types ──────────────────────────────────────────────────

export type ActivityKind = "tool_use" | "tool_result" | "thinking" | "task_list" | "file_list";
export type Resolution = "approved" | "dismissed" | "feedback";
export type ResultStatus = "success" | "error";

/**
 * Client-side enriched activity: a tool_use with its tool_result merged in.
 * Created by the reducer so that each tool call is a single entry with
 * both input and result data, matching the shape:
 *   { toolType, input, result }
 */
export interface MergedActivity extends ActivityMessage {
  /** Result detail text from the paired tool_result */
  mergedResultDetail?: string;
  /** Result status from the paired tool_result */
  mergedResultStatus?: ResultStatus;
}

/** Payload for restoring an edited queued message into the composer. */
export interface QueuedRestore {
  /** Monotonic key so consecutive restores are distinguishable. */
  key: number;
  text: string;
  files: File[];
}

// ── ChatItem variants (source data from use-instance-messages) ──────

export interface UserChatItem {
  kind: "user";
  text: string;
  timestamp?: number;
  queued?: boolean;
  /** Stable id for a queued message so it can be removed/edited before dispatch. */
  queuedId?: string;
  /** Raw text as typed (no attachment markers) — used to restore into the composer on edit. */
  queuedSourceText?: string;
  /** Uploaded attachment paths carried by a queued message (for edit restore). */
  queuedImages?: string[];
  queuedAttachments?: string[];
  renderMode?: LargeUserRenderMode;
}

export interface AssistantChatItem {
  kind: "assistant";
  text: string;
  timestamp?: number;
  /** True when the turn was cut short by a user interrupt before completion. */
  aborted?: boolean;
}

export interface SystemChatItem {
  kind: "system";
  text: string;
  isError?: boolean;
}

export interface CompactBoundaryChatItem {
  kind: "compact-boundary";
  timestamp?: number;
}

export interface ModelSwitchChatItem {
  kind: "model-switch";
  fromModel?: string;
  toModel?: string;
  fromModelLabel?: string;
  toModelLabel?: string;
  timestamp?: number;
}

export interface ThinkingBlockChatItem {
  kind: "thinking-block";
  text: string;
}

export interface ActivityGroupChatItem {
  kind: "activity-group";
  activities: MergedActivity[];
}

/**
 * Inserted card for a delegated agent whose origin tool_use is unknown (no
 * `originToolUseId`, or none found in the stream at first sighting). Anchored
 * agents render in place of their tool_use instead and never get this item.
 * Inserted once per agent — updates mutate `State.agents`, not this item.
 */
export interface AgentCardChatItem {
  kind: "agent-card";
  agentId: string;
  timestamp?: number;
}

/**
 * Inbound agent-to-agent message (`UserMessage.author.kind === "agent"`).
 * Rendered as a left-aligned note, never as a human bubble.
 */
export interface AgentNoteChatItem {
  kind: "agent-note";
  text: string;
  /** Sender display name as reported by the provider. */
  name?: string;
  /** Relay agent key of the sender when it is a known agent of this chat. */
  agentId?: string;
  timestamp?: number;
}

export type ChatItem =
  | UserChatItem
  | AssistantChatItem
  | SystemChatItem
  | CompactBoundaryChatItem
  | ModelSwitchChatItem
  | ThinkingBlockChatItem
  | ActivityGroupChatItem
  | AgentCardChatItem
  | AgentNoteChatItem;

// ── RenderRow variants (processed for the virtualizer) ──────────────

export interface UserRow {
  id: string;
  kind: "user";
  text: string;
  timestamp?: number;
  queued?: boolean;
  queuedId?: string;
  queuedSourceText?: string;
  queuedImages?: string[];
  queuedAttachments?: string[];
  renderMode?: LargeUserRenderMode;
}

export interface AssistantRow {
  id: string;
  kind: "assistant";
  text: string;
  timestamp?: number;
  isLast: boolean;
  /** True when the turn was cut short by a user interrupt before completion. */
  aborted?: boolean;
}

export interface SystemRow {
  id: string;
  kind: "system";
  text: string;
  isError?: boolean;
}

export interface CompactBoundaryRow {
  id: string;
  kind: "compact-boundary";
  timestamp?: number;
}

export interface ModelSwitchRow {
  id: string;
  kind: "model-switch";
  fromModel?: string;
  toModel?: string;
  fromModelLabel?: string;
  toModelLabel?: string;
  timestamp?: number;
}

export interface ThinkingBlockRow {
  id: string;
  kind: "thinking-block";
  text: string;
}

export interface AgentCardRow {
  id: string;
  kind: "agent-card";
  agentId: string;
  timestamp?: number;
}

export interface AgentNoteRow {
  id: string;
  kind: "agent-note";
  text: string;
  name?: string;
  agentId?: string;
  timestamp?: number;
}

export interface ResponseDividerRow {
  id: string;
  kind: "response-divider";
  durationLabel: string;
}

export interface ToolGroupData {
  activities: MergedActivity[];
  originalIndex: number;
  isLastActivityGroup: boolean;
  trailingResolution?: Resolution;
  skipLeadingResult?: boolean;
}

export interface ToolContainerRow {
  id: string;
  kind: "tool-container";
  groups: ToolGroupData[];
  allActivities: MergedActivity[];
}

export type RenderRow =
  | UserRow
  | AssistantRow
  | SystemRow
  | CompactBoundaryRow
  | ModelSwitchRow
  | ThinkingBlockRow
  | AgentCardRow
  | AgentNoteRow
  | ResponseDividerRow
  | ToolContainerRow;

// ── Live activity (for status strip) ────────────────────────────────

export type LiveActivityPhase =
  | "starting"
  | "thinking"
  | "responding"
  | "task_list"
  | "file_list"
  | "tool";

export interface LiveActivity {
  /** Structured phase so the strip can decide between generic and detailed text. */
  phase: LiveActivityPhase;
  /** Whether the strip should show the detailed label or fall back to generic copy. */
  presentation: "generic" | "detailed";
  /** Human-readable description of what's happening */
  description: string;
  /** Tool name if applicable */
  tool?: string;
  /** When this specific activity started */
  startedAt: number;
}
