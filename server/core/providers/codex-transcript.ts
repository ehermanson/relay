import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";
import type {
  ActivityMessage,
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

const MAX_HISTORY = 1000;
const TOOL_OUTPUT_MARKER = "\nOutput:\n";

interface CodexPendingCall {
  name: string;
  arguments?: string;
  requestId?: string;
}

interface CodexReplayContext {
  pendingCalls: Map<string, CodexPendingCall>;
  tasks: Map<string, TaskItem>;
  files: Map<string, FileChange>;
  stats: SessionStats;
  cwd?: string;
}

interface CodexTranscriptParseResult {
  cwd: string;
  /** Session start from `session_meta`, when present. */
  createdAt?: number;
  tasks: Map<string, TaskItem>;
  files: Map<string, FileChange>;
  history: HistoryEntry[];
  stats: SessionStats;
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
  if (typeof output !== "string") return "";
  const markerIndex = output.lastIndexOf(TOOL_OUTPUT_MARKER);
  const normalized =
    markerIndex >= 0 ? output.slice(markerIndex + TOOL_OUTPUT_MARKER.length) : output;
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
      inputDescription: command,
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

  return {
    type: "activity",
    activity: "tool_use",
    tool: normalizeToolName(name),
    description: `Using ${normalizeToolName(name)}`,
    detail: typeof rawArguments === "string" && rawArguments.length > 0 ? rawArguments : undefined,
    input: parsedArgs,
  };
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
      inputDescription: command,
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

/** Join the text parts of a v2 thread-item `content` array (`[{type:"Text"|"text", text}]`). */
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

    if (
      (payload.type === "function_call" || payload.type === "custom_tool_call") &&
      typeof payload.name === "string"
    ) {
      const rawArguments =
        typeof payload.arguments === "string" ? payload.arguments : payload.input;
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
          message: buildToolUseActivity(
            payload.name,
            rawArguments,
            typeof payload.call_id === "string" && payload.name === "request_user_input"
              ? `codex-input-${payload.call_id}`
              : undefined,
          ),
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
      results.push({
        timestamp,
        message: buildToolResultActivity(call, payload.output),
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
    tasks: ctx.tasks,
    files: ctx.files,
    history,
    stats: ctx.stats,
  };
}
