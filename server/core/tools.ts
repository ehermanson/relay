/**
 * Shared tool description helpers
 *
 * Used by both ClaudeProcess (live streaming) and InstanceManager (JSONL replay)
 * to generate human-readable descriptions of Claude tool usage.
 */

import type { ActivityMessage, TaskItem } from "#core/types.js";

// =============================================================================
// Shared tool sets
// =============================================================================

/** Safety cap for activity detail strings to prevent unbounded memory growth. */
export const MAX_DETAIL_LENGTH = 50_000;

/** Cap a detail string to MAX_DETAIL_LENGTH, appending a truncation indicator. */
export function capDetail(text: string): string {
  if (text.length <= MAX_DETAIL_LENGTH) return text;
  return text.slice(0, MAX_DETAIL_LENGTH) + "\n\u2026 (truncated)";
}

/** Tools that manage tasks/todos — intercepted for sidecar task tracking. */
export const TASK_TOOLS = new Set(["TaskCreate", "TaskUpdate", "TaskList", "TaskGet", "TodoWrite"]);

/**
 * Claude tools that delegate work to a subagent. `Agent` is the current name,
 * `Task` the legacy one. Deliberately excludes the TaskCreate/TaskUpdate family
 * (those are todo bookkeeping, see TASK_TOOLS).
 */
export const AGENT_DELEGATION_TOOLS = new Set(["Agent", "Task"]);

export function isAgentDelegationTool(toolName: string | undefined): boolean {
  return !!toolName && AGENT_DELEGATION_TOOLS.has(toolName);
}

/** Tools that write files — intercepted for sidecar file tracking. */
export const FILE_WRITE_TOOLS = new Set(["Edit", "Write", "NotebookEdit"]);

/** File-write tools grouped for permission approval (approving one approves all). */
export const FILE_WRITE_GROUP = ["Edit", "Write", "NotebookEdit"];

/** Known context window sizes by model prefix (includes SDK aliases). */
const CONTEXT_WINDOWS: { prefix: string; tokens: number }[] = [
  { prefix: "claude-opus-4", tokens: 1_000_000 },
  { prefix: "claude-sonnet-4", tokens: 1_000_000 },
  { prefix: "claude-haiku-4", tokens: 1_000_000 },
  // SDK may report aliases instead of full model IDs
  { prefix: "opus", tokens: 1_000_000 },
  { prefix: "sonnet", tokens: 1_000_000 },
  { prefix: "haiku", tokens: 1_000_000 },
];

/**
 * Look up the context window size for a model. Returns undefined if unknown.
 */
export function getContextWindow(model: string): number | undefined {
  return CONTEXT_WINDOWS.find((p) => model.startsWith(p.prefix))?.tokens;
}

/**
 * Tools that pause the CLI and wait for terminal user interaction.
 * All other tools execute automatically and should not trigger
 * "waiting for your response" indicators.
 */
export const INTERACTIVE_TOOLS = new Set(["AskUserQuestion", "ExitPlanMode", "EnterPlanMode"]);

/**
 * Check if a tool_result error message is a permission denial.
 * Returns true for known denial formats, false otherwise.
 *
 * Known formats:
 * - "Claude requested permissions to Bash(npm install), but you haven't granted it yet."
 * - "Claude requested permissions to write to /path/file.md, but you haven't granted it yet."
 * - "This command requires approval"
 *
 * The tool name is NOT extracted here — callers should use the preceding tool_use
 * event's tool name, which is always available.
 */
export function isPermissionDenial(content: string): boolean {
  return content.includes("haven't granted it yet") || content.includes("requires approval");
}

/**
 * Classify the resolution of an interactive tool result.
 * Returns null for non-interactive tools or permission denials (handle normally).
 * For interactive tools, returns the resolution type based on content:
 *   - "approved": non-error result (user approved plan / answered question)
 *   - "feedback": error with user feedback ("the user said: ...")
 *   - "dismissed": error without feedback (user cleared context / rejected)
 */
export function classifyInteractiveResult(
  isError: boolean | undefined,
  toolName: string | undefined,
  content: string,
): "approved" | "dismissed" | "feedback" | null {
  if (!INTERACTIVE_TOOLS.has(toolName || "")) return null;
  if (isError && isPermissionDenial(content)) return null;
  if (!isError) return "approved";
  if (content.includes("the user said:")) return "feedback";
  return "dismissed";
}

/** Extract the question texts from an AskUserQuestion tool input. */
export function extractAskQuestionTexts(input: unknown): string[] {
  const questions = (input as { questions?: unknown } | undefined)?.questions;
  if (!Array.isArray(questions)) return [];
  return questions
    .map((q) => (q && typeof q === "object" ? (q as { question?: unknown }).question : undefined))
    .filter((q): q is string => typeof q === "string" && q.trim().length > 0);
}

const ASK_ANSWER_MARKER = "Your questions have been answered:";
const ASK_ANSWER_TAIL = '". You can now';

/**
 * Reconstruct the answer text from an AskUserQuestion tool_result on JSONL replay.
 *
 * The Claude harness records answers only in the tool_result content as an English
 * sentence — `Your questions have been answered: "Q1"="A1", "Q2"="A2". You can now
 * continue with these answers in mind.` — keyed by question TEXT. We anchor on the
 * known question texts (from the tool_use input) to extract each answer robustly, and
 * format the result to match the live `buildUserInputReply` output (`> Q\n\nA` blocks)
 * so the answer renders identically whether streamed live or rebuilt from transcript.
 */
export function parseAskUserQuestionAnswerText(
  content: string,
  questions: string[],
): string | null {
  if (!content.includes(ASK_ANSWER_MARKER) || questions.length === 0) return null;
  const blocks: string[] = [];
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    const startToken = `"${q}"="`;
    const startPos = content.indexOf(startToken);
    if (startPos === -1) continue;
    const answerStart = startPos + startToken.length;
    let endPos = content.length;
    for (let j = 0; j < questions.length; j++) {
      if (j === i) continue;
      const p = content.indexOf(`", "${questions[j]}"="`, answerStart);
      if (p !== -1 && p < endPos) endPos = p;
    }
    const tail = content.indexOf(ASK_ANSWER_TAIL, answerStart);
    if (tail !== -1 && tail < endPos) endPos = tail;
    let answer = content.slice(answerStart, endPos);
    if (answer.endsWith('"')) answer = answer.slice(0, -1);
    answer = answer.trim();
    if (answer) blocks.push(`> ${q}\n\n${answer}`);
  }
  return blocks.length > 0 ? blocks.join("\n\n") : null;
}

/**
 * Build an ActivityMessage for a tool_result event.
 * Shared by ClaudeProcess (live streaming, two code paths) and InstanceManager (JSONL replay).
 */
export function buildToolResultActivity(
  isError: boolean | undefined,
  toolName: string | undefined,
  content: string,
  toolResultMeta?: { nonExecutionKind?: string; userFeedback?: string },
  toolUseId?: string,
): ActivityMessage {
  const denied = isError && isPermissionDenial(content);
  const deniedTool = denied ? toolName || "Unknown" : undefined;
  const resolution = classifyInteractiveResult(isError, toolName, content);

  return {
    type: "activity",
    activity: "tool_result",
    toolUseId,
    description: deniedTool
      ? "Permission denied"
      : resolution
        ? "Tool completed"
        : isError
          ? "Tool error"
          : "Tool completed",
    tool: deniedTool,
    detail: resolution ? undefined : content ? capDetail(content) : undefined,
    permissionDenied: deniedTool,
    resolution: resolution ?? undefined,
    ...(toolResultMeta ? { toolResultMeta } : {}),
  };
}

/**
 * Extract text from a tool_result content field.
 * Content can be a plain string or an array of content blocks
 * (e.g. [{type: "text", text: "..."}, ...]).
 */
export function extractToolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b: Record<string, unknown>) => b.type === "text" && typeof b.text === "string")
      .map((b: Record<string, unknown>) => b.text)
      .join("\n");
  }
  return "";
}

interface ParsedPlanUpdate {
  explanation?: string;
  tasks: TaskItem[];
}

function normalizePlanTaskStatus(status: unknown): TaskItem["status"] | undefined {
  switch (status) {
    case "pending":
      return "pending";
    case "in_progress":
    case "inProgress":
      return "in_progress";
    case "completed":
      return "completed";
    default:
      return undefined;
  }
}

export function parsePlanUpdate(raw: unknown): ParsedPlanUpdate | undefined {
  let value = raw;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      return undefined;
    }
  }

  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.plan)) return undefined;

  const tasks: TaskItem[] = [];
  for (const item of record.plan) {
    if (!item || typeof item !== "object") continue;
    const step = typeof item.step === "string" ? item.step.trim() : "";
    const status = normalizePlanTaskStatus((item as Record<string, unknown>).status);
    if (!step || !status) continue;
    tasks.push({
      id: `plan-${tasks.length}`,
      subject: step,
      status,
    });
  }

  const explanation =
    typeof record.explanation === "string" && record.explanation.trim()
      ? record.explanation.trim()
      : undefined;

  return { explanation, tasks };
}

export function buildTaskListActivityFromPlan(
  raw: unknown,
  fallbackDescription = "Tasks",
): ActivityMessage | undefined {
  const parsed = parsePlanUpdate(raw);
  if (!parsed) return undefined;
  return {
    type: "activity",
    activity: "task_list",
    description: parsed.explanation || fallbackDescription,
    tasks: parsed.tasks,
  };
}

export function extractInputDescription(
  tool: string,
  input?: Record<string, unknown>,
): string | undefined {
  if (!input) return undefined;
  switch (tool) {
    case "Bash":
      return input.description as string | undefined;
    case "Agent":
    case "Task":
      return input.description as string | undefined;
    default:
      return undefined;
  }
}

export function describeToolUse(tool: string, input?: Record<string, unknown>): string {
  if (!input) return `Using ${tool}`;

  switch (tool) {
    case "Read":
      return "Reading file";
    case "Edit":
      return "Editing file";
    case "Write":
      return "Writing file";
    case "Bash":
      return "Running command";
    case "Glob":
      return "Searching files";
    case "Grep":
      return "Searching content";
    case "WebFetch":
      return "Fetching URL";
    case "WebSearch":
      return "Searching web";
    case "Task":
      if (input?.team_name) return "Spawning agent";
      return "Running subtask";
    case "EnterPlanMode":
      return "Entering plan mode";
    case "ExitPlanMode":
      return "Plan ready";
    case "AskUserQuestion":
      return "Question";
    case "TaskCreate":
      return "Creating task";
    case "TaskUpdate":
      return "Updating task";
    case "TaskList":
      return "Listing tasks";
    case "TaskGet":
      return "Reading task";
    case "TodoWrite":
      return "Updating checklist";
    case "NotebookEdit":
      return "Editing notebook";
    case "Agent":
      return "Spawning agent";
    case "SendMessage":
      return "Sending message";
    case "TeamCreate":
      return "Creating team";
    case "TeamDelete":
      return "Deleting team";
    default:
      return `Using ${tool}`;
  }
}

export function describeToolDetail(
  tool: string,
  input?: Record<string, unknown>,
): string | undefined {
  if (!input) return undefined;

  switch (tool) {
    case "Read":
    case "Edit":
    case "Write":
      return (input.file_path as string) || (input.path as string);
    case "Bash": {
      const cmd = input.command as string;
      return cmd ? (cmd.length > 100 ? cmd.slice(0, 100) + "..." : cmd) : undefined;
    }
    case "Glob":
    case "Grep":
      return input.pattern as string;
    case "WebFetch":
      return input.url as string;
    case "WebSearch":
      return input.query as string;
    case "ExitPlanMode": {
      const plan = input.plan as string;
      if (!plan) return undefined;
      const firstLine = plan.split("\n").find((l: string) => l.trim());
      return firstLine?.replace(/^#+\s*/, "").trim();
    }
    case "AskUserQuestion": {
      const questions = input.questions as Array<{ question?: string }> | undefined;
      if (questions?.[0]?.question) return questions[0].question;
      return undefined;
    }
    case "TaskCreate":
      return input.subject as string;
    case "TaskUpdate":
      return input.status as string;
    case "TodoWrite": {
      const todos = input.todos as Array<{ content?: string }> | undefined;
      if (Array.isArray(todos)) return `${todos.length} items`;
      return undefined;
    }
    case "NotebookEdit":
      return input.notebook_path as string;
    case "SendMessage":
      return (input.summary as string) || (input.recipient as string);
    case "Agent": {
      const desc = input.description as string | undefined;
      if (input.name && input.subagent_type) return `${input.name} (${input.subagent_type})`;
      if (input.name) return input.name as string;
      return desc;
    }
    case "Task":
      if (input.team_name && input.name) return `${input.name} (${input.subagent_type || "agent"})`;
      return input.description as string | undefined;
    case "TeamCreate":
      return input.team_name as string;
    case "TeamDelete":
      return undefined;
    default:
      return undefined;
  }
}
