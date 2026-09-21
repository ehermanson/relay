import { describeCodexCommand } from "#core/providers/codex-command-label.js";
import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";
import type {
  ActivityMessage,
  AgentInfo,
  AgentUpdateMessage,
  EditToolInput,
  FileChange,
  HistoryEntry,
  OutputMessage,
  SessionStats,
  TaskItem,
  UserMessage,
} from "#core/types.js";
import { isInternalInjectedUserText, stripInjectedWrapper } from "#core/internal-user-messages.js";
import { extFromPath } from "#core/paths.js";
import { convertProposedPlanText } from "#core/proposed-plan.js";
import { buildTaskListActivityFromPlan } from "#core/tools.js";
import { isPathWithinWorkspace } from "#core/workspace-paths.js";

import {
  buildCodexGenericToolUse,
  extractCodexToolOutput,
} from "#core/providers/codex-tool-activity.js";
import {
  buildCodexCollabAgentUpdates,
  buildCodexCollabToolResult,
  buildCodexCollabToolUse,
  buildCodexCollabToolUseFromCall,
  buildCodexSubAgentUpdate,
  codexAgentNameFromPath,
  codexAgentUpdateProvenance,
  isCodexCollabFunctionName,
  normalizeCodexCollabToolCall,
  normalizeCodexCollabToolName,
  normalizeCodexSubAgentActivity,
  parseCodexAgentReport,
  sanitizeCodexCollabArguments,
} from "#core/providers/codex-agent-activity.js";
import { isSubagentSessionMeta } from "#core/providers/codex-discovery.js";

const MAX_HISTORY = 1000;
const TOOL_OUTPUT_MARKER = "\nOutput:\n";

interface CodexPendingCall {
  name: string;
  arguments?: string;
  requestId?: string;
}

interface CodexReplayContext {
  pendingCalls: Map<string, CodexPendingCall>;
  /** Deduplicate native command events against direct exec_command calls in this turn. */
  commandIds?: Set<string>;
  /** Collaboration call ids whose tool_use was already emitted (function_call vs typed item). */
  collabIds?: Set<string>;
  /** Collaboration call ids whose tool_result was already emitted (function_call_output vs typed item). */
  collabResultIds?: Set<string>;
  /** Agent path (`/root/<name>`) → child thread id, from SubAgentActivity / CollabAgentToolCall. */
  agentPaths?: Map<string, string>;
  /**
   * True when `session_meta` marks this rollout as a sub-agent's. Only then is
   * the first non-injected user-role `response_item` read (as the assignment).
   */
  isSubagent?: boolean;
  /** First real (non-injected) user-role `response_item` message — a sub-agent's assignment. */
  firstUserPrompt?: string;
  tasks: Map<string, TaskItem>;
  files: Map<string, FileChange>;
  stats: SessionStats;
  cwd?: string;
}

interface CodexTranscriptParseResult {
  cwd: string;
  /** Session start from `session_meta`, when present. */
  createdAt?: number;
  /** Raw `session_meta.payload`, when present (sub-agent spawn metadata lives here). */
  sessionMeta?: Record<string, unknown>;
  /** First non-injected user-role `response_item` message (see CodexReplayContext). */
  firstUserPrompt?: string;
  tasks: Map<string, TaskItem>;
  files: Map<string, FileChange>;
  history: HistoryEntry[];
  stats: SessionStats;
}

/**
 * Codex front-loads its own user-role injections before the first real turn.
 * Anything starting with one of these is context, never the assignment. The
 * list is deliberately conservative: an unrecognized injection is shown as the
 * assignment rather than a real assignment being hidden — but only inside
 * sub-agent rollouts (see `CodexReplayContext.isSubagent`).
 */
const CODEX_INJECTED_USER_PREFIXES = [
  "<recommended_plugins>",
  "# AGENTS.md",
  "<environment_context>",
  "<user_instructions>",
  "<space-context>",
  "<permissions instructions>",
  "<collaboration_mode>",
  "<turn_aborted>",
  "<skill",
];

function isCodexInjectedUserText(text: string): boolean {
  const trimmed = text.trimStart();
  if (!trimmed) return true;
  if (CODEX_INJECTED_USER_PREFIXES.some((prefix) => trimmed.startsWith(prefix))) return true;
  return isInternalInjectedUserText(trimmed);
}

function agentUpdateEntry(timestamp: number, agent: AgentInfo, raw?: unknown): HistoryEntry {
  return {
    timestamp,
    message: { type: "agent_update", agent, ...(raw !== undefined ? { raw } : {}) } as AgentUpdateMessage,
  };
}

function createZeroStats(): SessionStats {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
  };
}

function parseTimestamp(timestamp: unknown): number {
  if (typeof timestamp !== "string") return Date.now();
  const parsed = new Date(timestamp).getTime();
  return Number.isNaN(parsed) ? Date.now() : parsed;
}

function parseArguments(raw: unknown): Record<string, unknown> | undefined {
  if (typeof raw !== "string" || !raw.trim()) return undefined;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return typeof parsed === "object" && parsed !== null ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function normalizeToolOutput(output: unknown): string {
  const text = extractCodexToolOutput(output);
  const markerIndex = text.indexOf(TOOL_OUTPUT_MARKER);
  const normalized = markerIndex >= 0 ? text.slice(markerIndex + TOOL_OUTPUT_MARKER.length) : text;
  return normalized.trim();
}

function trackFileChange(
  files: Map<string, FileChange>,
  cwd: string | undefined,
  path: string,
  type: "added" | "edited",
) {
  if (cwd && !isPathWithinWorkspace(cwd, path)) return;
  const existing = files.get(path);
  if (existing) {
    existing.editCount++;
    if (existing.type !== "added") existing.type = type;
    return;
  }
  files.set(path, { path, editCount: 1, type });
}

function countPatchLines(patch: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("+++")) continue;
    if (line.startsWith("---")) continue;
    if (line.startsWith("+")) additions++;
    else if (line.startsWith("-")) deletions++;
  }
  return { additions, deletions };
}

type ApplyPatchChange =
  | {
      path: string;
      type: "added";
      content: string;
      additions: number;
      deletions: number;
    }
  | {
      path: string;
      type: "edited";
      diff: string;
      additions: number;
      deletions: number;
      movePath?: string;
    };

function parseApplyPatchChanges(patch: string): ApplyPatchChange[] {
  const lines = patch.split("\n");
  const changes: ApplyPatchChange[] = [];

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith("*** Add File: ")) {
      const path = line.slice("*** Add File: ".length).trim();
      i += 1;
      const contentLines: string[] = [];
      let additions = 0;
      while (i < lines.length) {
        const current = lines[i];
        if (current.startsWith("*** ") && !current.startsWith("*** End of File")) break;
        if (current.startsWith("+")) {
          additions++;
          contentLines.push(current.slice(1));
        }
        i += 1;
      }
      changes.push({
        path,
        type: "added",
        content: contentLines.join("\n"),
        additions,
        deletions: 0,
      });
      continue;
    }

    if (line.startsWith("*** Update File: ") || line.startsWith("*** Delete File: ")) {
      const isDelete = line.startsWith("*** Delete File: ");
      const marker = isDelete ? "*** Delete File: " : "*** Update File: ";
      const path = line.slice(marker.length).trim();
      i += 1;
      const diffLines: string[] = [];
      let movePath: string | undefined;
      while (i < lines.length) {
        const current = lines[i];
        if (
          (current.startsWith("*** Add File: ") ||
            current.startsWith("*** Update File: ") ||
            current.startsWith("*** Delete File: ") ||
            current.startsWith("*** End Patch")) &&
          !current.startsWith("*** End of File")
        ) {
          break;
        }
        if (current.startsWith("*** Move to: ")) {
          movePath = current.slice("*** Move to: ".length).trim();
        } else {
          diffLines.push(current);
        }
        i += 1;
      }
      const diff = diffLines.join("\n").trim();
      const { additions, deletions } = countPatchLines(diff);
      changes.push({
        path,
        type: "edited",
        diff,
        additions,
        deletions,
        ...(movePath ? { movePath } : {}),
      });
      continue;
    }

    i += 1;
  }

  return changes;
}

function normalizeToolName(name: string): string {
  if (name === "exec_command") return "Bash";
  if (name === "request_user_input") return "AskUserQuestion";
  if (name === "view_image") return "ViewImage";
  return name;
}

function extractQuestionPrompt(input?: Record<string, unknown>): string | undefined {
  const questions = input?.questions as Array<{ question?: string }> | undefined;
  return questions?.[0]?.question;
}

function parseUserInputResult(rawOutput: unknown): {
  answers: Record<string, { answers?: string[] }>;
  hasAnswers: boolean;
} | null {
  if (typeof rawOutput !== "string" || !rawOutput.trim()) return null;
  try {
    const parsed = JSON.parse(rawOutput) as {
      answers?: Record<string, { answers?: string[] }>;
    };
    const answers = parsed.answers ?? {};
    const hasAnswers = Object.values(answers).some(
      (answer) => Array.isArray(answer?.answers) && answer.answers.length > 0,
    );
    return { answers, hasAnswers };
  } catch {
    return null;
  }
}

function buildToolUseActivity(
  name: string,
  rawArguments: unknown,
  requestId?: string,
): ActivityMessage {
  const parsedArgs = parseArguments(rawArguments);
  if (name === "exec_command") {
    const command = typeof parsedArgs?.cmd === "string" ? parsedArgs.cmd : undefined;
    return {
      type: "activity",
      activity: "tool_use",
      tool: "Bash",
      description: command ? "Running command" : "Running command",
      detail: command,
      input: command ? { command } : undefined,
      inputDescription: command ? describeCodexCommand(command) : "Run shell command",
    };
  }

  if (name === "request_user_input") {
    return {
      type: "activity",
      activity: "tool_use",
      tool: "AskUserQuestion",
      description: "Question",
      input: {
        ...parsedArgs,
        ...(requestId ? { requestId } : {}),
      },
      inputDescription: extractQuestionPrompt(parsedArgs),
    };
  }

  if (name === "view_image") {
    const path = typeof parsedArgs?.path === "string" ? parsedArgs.path : undefined;
    const fileName = path ? path.split("/").pop() || path : undefined;
    return {
      type: "activity",
      activity: "tool_use",
      tool: "ViewImage",
      description: "Viewing image",
      detail: path,
      input: path ? { ...parsedArgs, file_path: path } : parsedArgs,
      inputDescription: fileName,
    };
  }

  return buildCodexGenericToolUse(normalizeToolName(name), rawArguments);
}

function buildToolResultActivity(
  call: CodexPendingCall | undefined,
  rawOutput: unknown,
): ActivityMessage {
  const detail = normalizeToolOutput(rawOutput);
  const parsedArgs = parseArguments(call?.arguments);

  if (call?.name === "exec_command") {
    const command = typeof parsedArgs?.cmd === "string" ? parsedArgs.cmd : undefined;
    const exitMatch =
      typeof rawOutput === "string" ? rawOutput.match(/Process exited with code (\d+)/) : null;
    const exitCode = exitMatch ? Number.parseInt(exitMatch[1], 10) : undefined;
    const succeeded = exitCode == null || exitCode === 0;
    return {
      type: "activity",
      activity: "tool_result",
      tool: "Bash",
      description: succeeded ? "Command completed" : "Command failed",
      detail: detail || command,
      input: command ? { command, exitCode } : exitCode != null ? { exitCode } : undefined,
      inputDescription: command ? describeCodexCommand(command) : "Run shell command",
    };
  }

  if (call?.name === "request_user_input") {
    const parsedOutput = parseUserInputResult(rawOutput);
    return {
      type: "activity",
      activity: "tool_result",
      tool: "AskUserQuestion",
      description: "Tool completed",
      resolution: parsedOutput?.hasAnswers ? "approved" : "dismissed",
      input: {
        ...parsedArgs,
        ...(call.requestId ? { requestId: call.requestId } : {}),
      },
    };
  }

  if (call?.name === "view_image") {
    const path = typeof parsedArgs?.path === "string" ? parsedArgs.path : undefined;
    return {
      type: "activity",
      activity: "tool_result",
      tool: "ViewImage",
      description: "Image loaded",
      detail: path,
      input: path ? { ...parsedArgs, file_path: path } : parsedArgs,
    };
  }

  return {
    type: "activity",
    activity: "tool_result",
    tool: call?.name ? normalizeToolName(call.name) : undefined,
    description: "Tool completed",
    detail: detail || undefined,
    input: parsedArgs,
  };
}

/** A user or assistant turn extracted from a rollout entry, format-agnostic. */
export interface CodexConversationMessage {
  role: "user" | "assistant";
  text: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

/**
 * Join the text parts of a content array: v2 thread items (`[{type:"Text"|"text", text}]`)
 * and `response_item` messages (`[{type:"input_text"|"output_text", text}]`) alike —
 * any part with a string `text` counts; image/audio parts contribute nothing.
 */
function joinItemContentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      const record = asRecord(part);
      return record && typeof record.text === "string" ? record.text : "";
    })
    .filter((text) => text.length > 0)
    .join("\n");
}

/**
 * Extract the user-facing conversation turn (if any) from a rollout entry.
 *
 * Codex has shipped two rollout formats for the same thing:
 * - CLI ≤ 0.152 records `event_msg` `user_message` / `agent_message`.
 * - CLI ≥ 0.153 records `event_msg` `item_completed` with a typed v2 thread item
 *   (`UserMessage` / `AgentMessage`). The legacy events are gone from those files.
 *
 * Both are the *filtered* UI stream — unlike `response_item` messages, they never
 * carry Codex's own user-role injections (`<recommended_plugins>`,
 * `<environment_context>`, …). A given file contains one format or the other, so
 * handling both here is additive, not duplicating. Shared by transcript replay,
 * scan-time titling, and last-message previews so they cannot drift.
 */
export function extractCodexConversationMessage(
  entry: Record<string, unknown>,
): CodexConversationMessage | null {
  if (entry.type !== "event_msg") return null;
  const payload = asRecord(entry.payload);
  if (!payload) return null;

  if (payload.type === "user_message") {
    return typeof payload.message === "string" && payload.message.trim()
      ? { role: "user", text: payload.message }
      : null;
  }
  if (payload.type === "agent_message") {
    return typeof payload.message === "string" && payload.message.trim()
      ? { role: "assistant", text: payload.message }
      : null;
  }
  if (payload.type === "item_completed") {
    const item = asRecord(payload.item);
    if (!item) return null;
    if (item.type === "UserMessage" || item.type === "AgentMessage") {
      const text = joinItemContentText(item.content);
      if (!text.trim()) return null;
      return { role: item.type === "UserMessage" ? "user" : "assistant", text };
    }
  }
  return null;
}

/** Reasoning summary text from either rollout format, or null when absent. */
function extractCodexReasoningText(payload: Record<string, unknown>): string | null {
  if (payload.type === "agent_reasoning") {
    return typeof payload.text === "string" && payload.text.trim() ? payload.text : null;
  }
  if (payload.type === "item_completed") {
    const item = asRecord(payload.item);
    if (item?.type !== "Reasoning") return null;
    const summary = Array.isArray(item.summary_text)
      ? item.summary_text.filter((part): part is string => typeof part === "string")
      : [];
    const text = summary.join("\n\n").trim();
    return text ? text : null;
  }
  return null;
}

export function convertCodexTranscriptEntry(
  entry: Record<string, unknown>,
  ctx: CodexReplayContext,
): HistoryEntry[] {
  const timestamp = parseTimestamp(entry.timestamp);
  const results: HistoryEntry[] = [];

  if (entry.type === "response_item") {
    const payload =
      typeof entry.payload === "object" && entry.payload !== null
        ? (entry.payload as Record<string, unknown>)
        : null;
    if (!payload) return results;

    // User-role `response_item` messages are never turns (they include Codex's
    // own injections; the filtered event_msg stream is the source of visible
    // user turns). The single exception: in a sub-agent rollout the first one
    // that isn't a known injection is the child's assignment, which exists
    // nowhere else in plaintext. Recorded only, never emitted here.
    if (payload.type === "message" && payload.role === "user") {
      if (ctx.isSubagent && ctx.firstUserPrompt === undefined) {
        const text = stripInjectedWrapper(joinItemContentText(payload.content));
        if (text.trim() && !isCodexInjectedUserText(text)) ctx.firstUserPrompt = text;
      }
      return results;
    }

    // Child ↔ parent reports. FINAL_ANSWER carries the child's result in
    // plaintext; MESSAGE / NEW_TASK bodies are usually encrypted, and
    // ciphertext is never shown — only the fact that a message was sent.
    if (payload.type === "agent_message") {
      const report = parseCodexAgentReport(payload);
      if (!report) return results;
      const agentId = ctx.agentPaths?.get(report.author);
      const name = codexAgentNameFromPath(report.author);
      // No `raw` on these entries: the payload carries encrypted_content.
      if (report.messageType === "FINAL_ANSWER") {
        if (!agentId) return results;
        const agent: AgentInfo = { agentId, status: "completed", endedAt: timestamp };
        if (report.payload) agent.result = report.payload;
        results.push(agentUpdateEntry(timestamp, agent));
        return results;
      }
      if (report.payload) {
        results.push({
          timestamp,
          message: {
            type: "user",
            text: report.payload,
            author: { kind: "agent", ...(name ? { name } : {}), ...(agentId ? { agentId } : {}) },
          } as UserMessage,
        });
      } else if (agentId) {
        results.push(agentUpdateEntry(timestamp, { agentId, lastActivity: "Sent a message" }));
      }
      return results;
    }

    if (
      (payload.type === "function_call" || payload.type === "custom_tool_call") &&
      typeof payload.name === "string"
    ) {
      const rawArguments =
        typeof payload.arguments === "string" ? payload.arguments : payload.input;

      // Collaboration tools (spawn_agent, send_message, wait_agent, …). The
      // `message` argument is encrypted in 0.154 rollouts, so the input is
      // sanitized down to plaintext fields (task_name, target, timeout_ms).
      if (
        payload.namespace === "collaboration" ||
        (typeof payload.namespace !== "string" && isCodexCollabFunctionName(payload.name))
      ) {
        const callId = typeof payload.call_id === "string" ? payload.call_id : undefined;
        const tool = normalizeCodexCollabToolName(payload.name);
        if (callId) {
          ctx.pendingCalls.set(callId, { name: tool });
          if (ctx.collabIds?.has(callId)) return results;
          (ctx.collabIds ??= new Set()).add(callId);
        }
        // No `raw`: the function_call arguments carry the encrypted message.
        results.push({
          timestamp,
          message: buildCodexCollabToolUse(
            tool,
            callId ?? `codex-collab-${timestamp}`,
            sanitizeCodexCollabArguments(rawArguments),
          ),
        });
        return results;
      }
      if (payload.name === "exec_command" && typeof payload.call_id === "string") {
        (ctx.commandIds ??= new Set()).add(payload.call_id);
      }
      if (typeof payload.call_id === "string") {
        ctx.pendingCalls.set(payload.call_id, {
          name: payload.name,
          arguments:
            typeof payload.arguments === "string"
              ? payload.arguments
              : typeof payload.input === "string"
                ? payload.input
                : undefined,
          requestId:
            payload.name === "request_user_input" ? `codex-input-${payload.call_id}` : undefined,
        });
      }
      const taskListActivity =
        payload.name === "update_plan" ? buildTaskListActivityFromPlan(rawArguments) : undefined;
      if (taskListActivity) {
        ctx.tasks.clear();
        for (const task of taskListActivity.tasks ?? []) {
          ctx.tasks.set(task.id, { ...task });
        }
        results.push({ timestamp, message: taskListActivity });
      } else if (payload.name === "apply_patch" && typeof payload.input === "string") {
        const changes = parseApplyPatchChanges(payload.input);
        for (const change of changes) {
          trackFileChange(ctx.files, ctx.cwd, change.path, change.type);
          if (ctx.cwd && !isPathWithinWorkspace(ctx.cwd, change.path)) continue;
          const fileName = change.path.split("/").pop() || change.path;
          if (change.type === "added") {
            results.push({
              timestamp,
              message: {
                type: "activity",
                activity: "tool_use",
                tool: "Write",
                description: "Writing file",
                detail: change.path,
                input: {
                  file_path: change.path,
                  extension: extFromPath(change.path),
                  kind: "add",
                  content: change.content,
                  additions: change.additions,
                  deletions: change.deletions,
                },
                inputDescription: fileName,
              } as ActivityMessage,
            });
          } else {
            results.push({
              timestamp,
              message: {
                type: "activity",
                activity: "tool_use",
                tool: "Edit",
                description: "Editing file",
                detail: change.path,
                input: {
                  file_path: change.path,
                  extension: extFromPath(change.path),
                  kind: change.movePath ? "move" : "update",
                  movePath: change.movePath,
                  diff: change.diff,
                  additions: change.additions,
                  deletions: change.deletions,
                } satisfies EditToolInput,
                inputDescription: fileName,
              } as ActivityMessage,
            });
          }
        }
        if (ctx.files.size > 0) {
          results.push({
            timestamp,
            message: {
              type: "activity",
              activity: "file_list",
              description: "Files changed",
              files: Array.from(ctx.files.values()).map((file) => ({ ...file })),
            } as ActivityMessage,
          });
        }
      } else {
        results.push({
          timestamp,
          message: {
            toolUseId: typeof payload.call_id === "string" ? payload.call_id : undefined,
            ...buildToolUseActivity(
              payload.name,
              rawArguments,
              typeof payload.call_id === "string" && payload.name === "request_user_input"
                ? `codex-input-${payload.call_id}`
                : undefined,
            ),
          },
        });
      }
    } else if (
      payload.type === "function_call_output" ||
      payload.type === "custom_tool_call_output"
    ) {
      const callId = typeof payload.call_id === "string" ? payload.call_id : undefined;
      const call = callId ? ctx.pendingCalls.get(callId) : undefined;
      if (callId) ctx.pendingCalls.delete(callId);
      if (call?.name === "update_plan") return results;
      // A collaboration call's result may also be synthesized from its typed
      // `CollabAgentToolCall` item (either order); emit exactly one per call id.
      if (callId && ctx.collabIds?.has(callId)) {
        if (ctx.collabResultIds?.has(callId)) return results;
        (ctx.collabResultIds ??= new Set()).add(callId);
      }
      results.push({
        timestamp,
        message: { ...buildToolResultActivity(call, payload.output), toolUseId: callId },
      });
    }

    return results;
  }

  if (entry.type === "event_msg") {
    const payload =
      typeof entry.payload === "object" && entry.payload !== null
        ? (entry.payload as Record<string, unknown>)
        : null;
    if (!payload || typeof payload.type !== "string") return results;

    if (payload.type === "task_started") ctx.commandIds?.clear();

    // Code-mode batches record the actual shell executions as native items even
    // when no standalone exec_command response item exists. Preserve those rows
    // and their parsed metadata; the outer ExecuteCode row remains inspectable.
    if (payload.type === "item_completed") {
      const item = asRecord(payload.item);

      // Multi-agent items → the same tool_use + agent_update sequence as live.
      // Ids coincide with the collaboration function_call ids (spawn_agent's
      // call_id is SubAgentActivity(started).id), so dedupe the tool_use.
      const collabCall = normalizeCodexCollabToolCall(item);
      if (collabCall) {
        for (const state of Object.values(collabCall.agentsStates)) {
          if (state.agentPath && state.agentThreadId) {
            (ctx.agentPaths ??= new Map()).set(state.agentPath, state.agentThreadId);
          }
        }
        // No `raw` on collab entries: `prompt` may be encrypted.
        if (!ctx.collabIds?.has(collabCall.id)) {
          (ctx.collabIds ??= new Set()).add(collabCall.id);
          results.push({ timestamp, message: buildCodexCollabToolUseFromCall(collabCall) });
        }
        const provenance = codexAgentUpdateProvenance(item);
        for (const update of buildCodexCollabAgentUpdates(collabCall, timestamp)) {
          results.push(agentUpdateEntry(timestamp, update, provenance));
        }
        // Exactly one tool_result per call id. A pending function_call means its
        // function_call_output (richer: carries the output) will produce it;
        // otherwise synthesize one here unless the output already did.
        if (!ctx.pendingCalls.has(collabCall.id) && !ctx.collabResultIds?.has(collabCall.id)) {
          (ctx.collabResultIds ??= new Set()).add(collabCall.id);
          results.push({ timestamp, message: buildCodexCollabToolResult(collabCall) });
        }
        return results;
      }
      const subAgent = normalizeCodexSubAgentActivity(item);
      if (subAgent) {
        if (subAgent.agentPath) {
          (ctx.agentPaths ??= new Map()).set(subAgent.agentPath, subAgent.agentThreadId);
        }
        results.push(
          agentUpdateEntry(
            timestamp,
            buildCodexSubAgentUpdate(subAgent, timestamp),
            codexAgentUpdateProvenance(item),
          ),
        );
        return results;
      }

      if (item?.type === "CommandExecution" && typeof item.id === "string") {
        const rawCommand = item.command;
        const command =
          typeof rawCommand === "string"
            ? rawCommand
            : Array.isArray(rawCommand) && rawCommand.every((arg) => typeof arg === "string")
              ? rawCommand
                  .map((arg) =>
                    /^[\w./:-]+$/.test(arg) ? arg : "'" + arg.replace(/'/g, "'\"'\"'") + "'",
                  )
                  .join(" ")
              : undefined;
        if (!command || ctx.commandIds?.has(item.id)) return results;
        (ctx.commandIds ??= new Set()).add(item.id);
        const failed =
          item.status === "failed" ||
          item.status === "declined" ||
          (typeof item.exit_code === "number" && item.exit_code !== 0);
        results.push(
          {
            timestamp,
            message: {
              type: "activity",
              activity: "tool_use",
              tool: "Bash",
              toolUseId: item.id,
              description: "Running command",
              detail: command,
              input: { command },
              inputDescription: describeCodexCommand(command, item.parsed_cmd),
            },
          },
          {
            timestamp,
            message: {
              type: "activity",
              activity: "tool_result",
              tool: "Bash",
              toolUseId: item.id,
              description: failed ? "Tool error" : "Command completed",
              detail:
                extractCodexToolOutput(item.aggregated_output ?? item.formatted_output) ||
                undefined,
            },
          },
        );
        return results;
      }
    }

    // Conversation turns + reasoning come in two rollout formats (legacy events
    // vs. 0.153+ `item_completed` items) — see extractCodexConversationMessage.
    const conversation = extractCodexConversationMessage(entry);
    if (conversation?.role === "user") {
      const userText = stripInjectedWrapper(conversation.text);
      results.push({
        timestamp,
        message: {
          type: "user",
          text: userText,
          internal: isInternalInjectedUserText(userText) || undefined,
        } as UserMessage,
      });
      return results;
    }
    if (conversation?.role === "assistant") {
      for (const message of convertProposedPlanText(conversation.text, { raw: payload })) {
        results.push({ timestamp, message });
      }
      return results;
    }
    const reasoning = extractCodexReasoningText(payload);
    if (reasoning) {
      results.push({
        timestamp,
        message: {
          type: "activity",
          activity: "thinking",
          description: "Reasoning...",
          detail: reasoning,
        } as ActivityMessage,
      });
      return results;
    }

    switch (payload.type) {
      case "image_generation_end": {
        // Codex saves generated images to `~/.codex/generated_images/<session>/<call_id>.png`
        // and records the path here. Surface it as a GenerateImage tool activity (rendered
        // as its own card with a thumbnail), served from disk via /api/file.
        const savedPath = typeof payload.saved_path === "string" ? payload.saved_path.trim() : "";
        if (savedPath) {
          const fileName = savedPath.split("/").pop() || savedPath;
          results.push({
            timestamp,
            message: {
              type: "activity",
              activity: "tool_use",
              tool: "GenerateImage",
              description: "Generated image",
              detail: savedPath,
              input: { file_path: savedPath },
              inputDescription: fileName,
            } as ActivityMessage,
          });
        }
        break;
      }

      case "plan_update": {
        const activity = buildTaskListActivityFromPlan(payload);
        if (activity) {
          ctx.tasks.clear();
          for (const task of activity.tasks ?? []) {
            ctx.tasks.set(task.id, { ...task });
          }
          results.push({
            timestamp,
            message: activity,
          });
        }
        break;
      }

      case "task_complete":
        results.push({
          timestamp,
          message: {
            type: "output",
            text: "",
            isWaiting: true,
          } as OutputMessage,
        });
        break;

      case "token_count": {
        const info =
          typeof payload.info === "object" && payload.info !== null
            ? (payload.info as Record<string, unknown>)
            : null;
        const total =
          info && typeof info.total_token_usage === "object" && info.total_token_usage !== null
            ? (info.total_token_usage as Record<string, unknown>)
            : null;
        const last =
          info && typeof info.last_token_usage === "object" && info.last_token_usage !== null
            ? (info.last_token_usage as Record<string, unknown>)
            : null;

        if (total) {
          ctx.stats.inputTokens =
            typeof total.input_tokens === "number" ? total.input_tokens : ctx.stats.inputTokens;
          ctx.stats.cacheReadTokens =
            typeof total.cached_input_tokens === "number"
              ? total.cached_input_tokens
              : ctx.stats.cacheReadTokens;
          ctx.stats.outputTokens =
            typeof total.output_tokens === "number" ? total.output_tokens : ctx.stats.outputTokens;
          if (typeof total.reasoning_output_tokens === "number") {
            ctx.stats.reasoningTokens = total.reasoning_output_tokens;
          }
        }

        if (last) {
          if (typeof last.total_tokens === "number") {
            ctx.stats.contextTokens = last.total_tokens;
          } else {
            const inputTokens = typeof last.input_tokens === "number" ? last.input_tokens : 0;
            const cachedInputTokens =
              typeof last.cached_input_tokens === "number" ? last.cached_input_tokens : 0;
            ctx.stats.contextTokens = inputTokens + cachedInputTokens;
          }
        }
        if (info && typeof info.model_context_window === "number") {
          ctx.stats.contextWindow = info.model_context_window;
        }
        break;
      }

      case "turn_context":
        if (typeof payload.model === "string" && payload.model.trim()) {
          ctx.stats.model = payload.model;
        }
        break;

      default:
        break;
    }
  }

  if (entry.type === "turn_context") {
    const payload =
      typeof entry.payload === "object" && entry.payload !== null
        ? (entry.payload as Record<string, unknown>)
        : null;
    if (payload && typeof payload.model === "string" && payload.model.trim()) {
      ctx.stats.model = payload.model;
    }
  }

  return results;
}

function fileMatchesSessionId(filePath: string, sessionId: string): boolean {
  try {
    const firstLine = readFileSync(filePath, "utf-8").split("\n", 1)[0];
    if (!firstLine) return false;
    const parsed = JSON.parse(firstLine) as {
      type?: string;
      payload?: { id?: string };
    };
    return parsed.type === "session_meta" && parsed.payload?.id === sessionId;
  } catch {
    return false;
  }
}

export function findCodexTranscriptPath(codexDir: string, sessionId: string): string | undefined {
  const sessionsDir = join(codexDir, "sessions");
  if (!existsSync(sessionsDir)) return undefined;

  const stack = [sessionsDir];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (!dir) continue;

    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }

    for (const entryName of entries) {
      const fullPath = join(dir, entryName);
      if (entryName === ".DS_Store") continue;

      try {
        if (statSync(fullPath).isDirectory()) {
          stack.push(fullPath);
          continue;
        }
      } catch {
        continue;
      }

      if (!entryName.endsWith(".jsonl") || !entryName.includes(sessionId)) continue;
      if (fileMatchesSessionId(fullPath, sessionId)) return fullPath;
    }
  }

  return undefined;
}

export function parseCodexTranscript(filePath: string): CodexTranscriptParseResult {
  let content: string;
  try {
    content = readFileSync(filePath, "utf-8");
  } catch {
    return {
      cwd: "",
      tasks: new Map(),
      files: new Map(),
      history: [],
      stats: createZeroStats(),
    };
  }

  let cwd = "";
  let createdAt: number | undefined;
  let sessionMeta: Record<string, unknown> | undefined;
  const history: HistoryEntry[] = [];
  const ctx: CodexReplayContext = {
    pendingCalls: new Map(),
    tasks: new Map(),
    files: new Map(),
    stats: createZeroStats(),
  };

  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as Record<string, unknown>;
      if (!cwd && entry.type === "session_meta") {
        const payload = asRecord(entry.payload);
        if (payload && !sessionMeta) {
          sessionMeta = payload;
          ctx.isSubagent = isSubagentSessionMeta(payload);
        }
        if (payload && typeof payload.cwd === "string") {
          cwd = payload.cwd;
          ctx.cwd = cwd;
        }
        const started = new Date(
          typeof payload?.timestamp === "string" ? payload.timestamp : (entry.timestamp as string),
        ).getTime();
        if (!Number.isNaN(started)) createdAt = started;
      }

      const converted = convertCodexTranscriptEntry(entry, ctx);
      history.push(...converted);
    } catch {
      // Skip malformed lines.
    }
  }

  if (history.length > MAX_HISTORY) {
    history.splice(0, history.length - MAX_HISTORY);
  }

  return {
    cwd,
    createdAt,
    sessionMeta,
    firstUserPrompt: ctx.firstUserPrompt,
    tasks: ctx.tasks,
    files: ctx.files,
    history,
    stats: ctx.stats,
  };
}

// =============================================================================
// Sub-agent history (file-based, read-only)
// =============================================================================

/** Sub-agent spawn metadata from a child rollout's `session_meta.payload`. */
export interface CodexSubagentMeta {
  threadId: string;
  parentThreadId?: string;
  /** Thread id the rollout was recorded under (`session_id`) — the root for depth-1 children. */
  sessionThreadId?: string;
  depth?: number;
  agentPath?: string;
  agentNickname?: string;
  agentRole?: string;
  model?: string;
}

export function extractCodexSubagentMeta(
  payload: Record<string, unknown> | undefined,
): CodexSubagentMeta | null {
  if (!payload || typeof payload.id !== "string") return null;
  const spawn = asRecord(asRecord(asRecord(payload.source)?.subagent)?.thread_spawn);
  const str = (value: unknown) => (typeof value === "string" && value ? value : undefined);
  return {
    threadId: payload.id,
    parentThreadId: str(spawn?.parent_thread_id) ?? str(payload.parent_thread_id),
    sessionThreadId: str(payload.session_id),
    depth: typeof spawn?.depth === "number" ? spawn.depth : undefined,
    agentPath: str(spawn?.agent_path) ?? str(payload.agent_path),
    agentNickname: str(spawn?.agent_nickname) ?? str(payload.agent_nickname),
    agentRole: str(spawn?.agent_role) ?? str(payload.agent_role),
    model: str(payload.model),
  };
}

// Locating a rollout walks all of `~/.codex/sessions`; parsing one can mean
// tens of MB. Both are cached: thread id → path (validated with existsSync on
// every hit, dropped on a miss) and path → parsed history keyed by mtime+size,
// so a child still being written is re-read only when the file changes.
const agentRolloutPathCache = new Map<string, string>();
const agentHistoryCache = new Map<
  string,
  { mtimeMs: number; size: number; history: HistoryEntry[] }
>();
const AGENT_HISTORY_CACHE_MAX = 64;

export function resolveCodexAgentRolloutPath(codexDir: string, threadId: string): string | undefined {
  const key = `${codexDir}\0${threadId}`;
  const cached = agentRolloutPathCache.get(key);
  if (cached) {
    if (existsSync(cached)) return cached;
    agentRolloutPathCache.delete(key);
  }
  const found = findCodexTranscriptPath(codexDir, threadId);
  if (found) agentRolloutPathCache.set(key, found);
  return found;
}

/** Test hook: forget cached rollout paths and parsed histories. */
export function clearCodexAgentHistoryCache(): void {
  agentRolloutPathCache.clear();
  agentHistoryCache.clear();
}

/**
 * Detailed history of one Codex sub-agent, read from its own rollout file
 * (`rollout-*-<threadId>.jsonl`). Never touches the app-server: no
 * `thread/read`, no resume, no boot. Returns null when no rollout exists.
 *
 * Every message is attributed with `agentId: threadId`; the first entry is an
 * `agent_update` built from `session_meta` (name from the orchestrator's task
 * name, role, model when recorded) followed by the child's assignment as an
 * agent-authored user message. Grandchildren spawned by this agent surface as
 * their own `agent_update`s with `parentAgentId = threadId`.
 */
export async function readCodexAgentHistory(
  codexDir: string,
  threadId: string,
  options?: { rootThreadId?: string },
): Promise<HistoryEntry[] | null> {
  const filePath = resolveCodexAgentRolloutPath(codexDir, threadId);
  if (!filePath) return null;

  let stat: { mtimeMs: number; size: number };
  try {
    stat = statSync(filePath);
  } catch {
    agentRolloutPathCache.delete(`${codexDir}\0${threadId}`);
    return null;
  }
  const cacheKey = `${filePath}\0${options?.rootThreadId ?? ""}`;
  const cached = agentHistoryCache.get(cacheKey);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return cached.history;
  }

  const history = buildCodexAgentHistory(filePath, threadId, options?.rootThreadId);
  if (agentHistoryCache.size >= AGENT_HISTORY_CACHE_MAX) {
    const oldest = agentHistoryCache.keys().next().value;
    if (oldest !== undefined) agentHistoryCache.delete(oldest);
  }
  agentHistoryCache.set(cacheKey, { mtimeMs: stat.mtimeMs, size: stat.size, history });
  return history;
}

function buildCodexAgentHistory(
  filePath: string,
  threadId: string,
  rootThreadIdOption: string | undefined,
): HistoryEntry[] {
  const parsed = parseCodexTranscript(filePath);
  const meta = extractCodexSubagentMeta(parsed.sessionMeta);
  const parentThreadId = meta?.parentThreadId;
  const rootThreadId = rootThreadIdOption ?? meta?.sessionThreadId;
  const startedAt = parsed.createdAt ?? parsed.history[0]?.timestamp ?? Date.now();

  const self: AgentInfo = {
    agentId: threadId,
    providerAgentId: threadId,
    relation: "child",
  };
  const name = codexAgentNameFromPath(meta?.agentPath) ?? meta?.agentNickname;
  if (name) self.name = name;
  if (meta?.agentRole) self.role = meta.agentRole;
  const model = meta?.model ?? parsed.stats.model;
  if (model) self.model = model;
  if (parentThreadId && rootThreadId && parentThreadId !== rootThreadId) {
    self.parentAgentId = parentThreadId;
  }
  if (parsed.firstUserPrompt) self.assignment = parsed.firstUserPrompt;

  // Provenance only — the full session_meta carries instructions/context text.
  const history: HistoryEntry[] = [
    agentUpdateEntry(startedAt, self, { type: "session_meta", id: threadId }),
  ];
  if (parsed.firstUserPrompt) {
    history.push({
      timestamp: startedAt,
      message: {
        type: "user",
        text: parsed.firstUserPrompt,
        agentId: threadId,
        author: { kind: "agent" },
      } as UserMessage,
    });
  }

  const isAncestor = (id: string | undefined) =>
    !!id && (id === parentThreadId || id === rootThreadId);

  for (const entry of parsed.history) {
    const message = entry.message;
    if (message.type === "agent_update") {
      // The child's own file records interactions with its parent as
      // SubAgentActivity(agent_path: "/root"); those are not agents of this
      // transcript. Anything else is a grandchild → nest it under this agent.
      if (isAncestor(message.agent.agentId)) continue;
      history.push({
        ...entry,
        message: { ...message, agent: { parentAgentId: threadId, ...message.agent } },
      });
      continue;
    }
    if (message.type === "user") {
      const author = message.author;
      const cleanAuthor =
        author && isAncestor(author.agentId) ? { ...author, agentId: undefined } : author;
      history.push({
        ...entry,
        message: { ...message, agentId: threadId, ...(cleanAuthor ? { author: cleanAuthor } : {}) },
      });
      continue;
    }
    if (message.type === "output" || message.type === "activity") {
      history.push({ ...entry, message: { ...message, agentId: threadId } });
      continue;
    }
    history.push(entry);
  }

  return history;
}
