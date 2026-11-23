/**
 * Antigravity tool calls → Relay activities.
 *
 * `agy` names its tools natively (`read_file`, `edit_file`, `run_command`, …)
 * with PascalCase arguments, and the same name + arguments appear both on live
 * ACP `tool_call` updates (`name`/`args`, alongside the standard
 * `rawInput`) and in the on-disk transcript (`tool_calls[].name`/`args`). This
 * module is the one mapping for both, so live chats and replay render the
 * same cards: Relay's shared tool names (Read, Edit, Write, Bash, Grep, Glob,
 * Agent, WebSearch, WebFetch) with the input shapes the UI already renders.
 *
 * Argument names have changed across `agy` releases, so every reader accepts
 * the known spellings and unknown tools pass through with their native name.
 */

import { closeSync, openSync, readSync, realpathSync, statSync } from "fs";
import { isAbsolute, join, relative } from "path";
import { isPathWithinWorkspace } from "#core/workspace-paths.js";
import { mcpServerId } from "#core/mcp.js";
import { RELAY_MCP_SERVER_NAME, RELAY_TOOL_NAMES } from "#core/orchestration/instructions.js";
import type { ActivityMessage, FileChange, TaskItem } from "#core/types.js";

export interface AntigravityToolView {
  /** Relay tool name (Read, Edit, …) or the native name for unmapped tools. */
  tool: string;
  /** Short verb shown before the label ("Read", "Run command"). */
  description: string;
  /** Collapsed-row label (file name, command, query). */
  inputDescription?: string;
  input: Record<string, unknown>;
  /** File the call writes, for the chat's changed-files list. */
  changedFile?: { path: string; kind: FileChange["type"] };
  /** A delegated subagent launch. */
  subagent?: { role?: string; typeName?: string; prompt?: string };
  /** A plan artifact written for user review (plan mode). */
  plan?: string;
  /**
   * A write to the conversation's own artifact folder (todo list, notes,
   * walkthrough) rather than the project: the new content (writes) or the
   * replacements (edits). A checklist artifact is the agent's task list.
   */
  artifact?: {
    path: string;
    content?: string;
    edits?: Array<{ oldText: string; newText: string }>;
  };
  /** An MCP tool call (`mcp_<server>_<tool>`). */
  mcp?: { serverName: string; toolName: string };
}

/**
 * agy names MCP tools `mcp_<server>_<tool>`. The split is ambiguous when a
 * server name has underscores, so a known server name wins; otherwise the
 * server is the first segment.
 */
export function splitAntigravityMcpToolName(
  name: string,
  knownServers: readonly string[] = [RELAY_MCP_SERVER_NAME],
): { serverName: string; toolName: string } | undefined {
  if (!name.startsWith("mcp_")) return undefined;
  const rest = name.slice("mcp_".length);
  for (const server of [...knownServers].sort((a, b) => b.length - a.length)) {
    if (rest.startsWith(`${server}_`) && rest.length > server.length + 1) {
      return { serverName: server, toolName: rest.slice(server.length + 1) };
    }
  }
  const index = rest.indexOf("_");
  if (index <= 0 || index === rest.length - 1) return undefined;
  return { serverName: rest.slice(0, index), toolName: rest.slice(index + 1) };
}

/**
 * The Relay tool a permission request asks to run, when it is one: agy 1.5.8+
 * names the server and tool in `rawInput`, older versions only in the call's
 * name or title (`Run mcp_relay_<tool>`). A request that also carries a shell
 * command is never a Relay call.
 */
export function antigravityRelayToolRequest(toolCall: Record<string, unknown>): string | undefined {
  const raw =
    toolCall.rawInput && typeof toolCall.rawInput === "object"
      ? (toolCall.rawInput as Record<string, unknown>)
      : {};
  if (raw.CommandLine !== undefined || raw.commandLine !== undefined) return undefined;
  const known = (tool: unknown): string | undefined =>
    typeof tool === "string" && (RELAY_TOOL_NAMES as readonly string[]).includes(tool)
      ? tool
      : undefined;
  if (typeof raw.ServerName === "string" || typeof raw.ToolName === "string") {
    return raw.ServerName === RELAY_MCP_SERVER_NAME ? known(raw.ToolName) : undefined;
  }
  for (const candidate of [toolCall.name, toolCall.title]) {
    if (typeof candidate !== "string") continue;
    const name = candidate.trim().replace(/^Run(?:ning)?\s+|\?$/g, "");
    const mcp = splitAntigravityMcpToolName(name);
    if (mcp) return mcp.serverName === RELAY_MCP_SERVER_NAME ? known(mcp.toolName) : undefined;
  }
  return undefined;
}

type Args = Record<string, unknown>;

/** Transcript `transcript.jsonl` encodes each argument as a JSON string; `_full` doesn't. */
export function decodeAntigravityArgs(args: unknown): Args {
  // Some transcripts and updates carry the whole argument object as JSON text.
  if (typeof args === "string" && args.trim().startsWith("{")) {
    try {
      return decodeAntigravityArgs(JSON.parse(args));
    } catch {
      return {};
    }
  }
  if (!args || typeof args !== "object" || Array.isArray(args)) return {};
  const decoded: Args = {};
  for (const [key, value] of Object.entries(args as Args)) {
    if (typeof value === "string" && /^[[{"]/.test(value)) {
      try {
        decoded[key] = JSON.parse(value);
        continue;
      } catch {
        // keep the raw string
      }
    }
    decoded[key] = value;
  }
  return decoded;
}

function pick(args: Args, ...keys: string[]): unknown {
  for (const key of keys) {
    if (args[key] !== undefined && args[key] !== null && args[key] !== "") return args[key];
  }
  return undefined;
}

function pickString(args: Args, ...keys: string[]): string | undefined {
  const value = pick(args, ...keys);
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}

function pickNumber(args: Args, ...keys: string[]): number | undefined {
  const value = pick(args, ...keys);
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  return undefined;
}

function stripFileUri(path: string): string {
  if (!path.startsWith("file://")) return path;
  try {
    return decodeURIComponent(new URL(path).pathname);
  } catch {
    return path.slice("file://".length);
  }
}

function resolvePath(path: string | undefined, cwd: string | undefined): string | undefined {
  if (!path) return undefined;
  const plain = stripFileUri(path);
  if (isAbsolute(plain) || !cwd) return plain;
  return join(cwd, plain);
}

function baseName(path: string): string {
  return path.split("/").filter(Boolean).pop() ?? path;
}

const FILE_KEYS = ["Path", "AbsolutePath", "TargetFile", "FilePath", "File", "file_path", "path"];

function chunkPairs(value: unknown): Array<{ oldText: string; newText: string }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((chunk) => {
    if (!chunk || typeof chunk !== "object") return [];
    const record = chunk as Args;
    const oldText = pickString(record, "TargetContent", "target_content", "Target", "old_string");
    const newText = pickString(
      record,
      "ReplacementContent",
      "replacement_content",
      "Replacement",
      "new_string",
    );
    return oldText !== undefined && newText !== undefined ? [{ oldText, newText }] : [];
  });
}

/** A unified-diff body built from snippet pairs (no real line numbers: agy sends snippets). */
export function buildSnippetDiff(pairs: Array<{ oldText: string; newText: string }>): string {
  return pairs
    .map(({ oldText, newText }) => {
      const oldLines = oldText.split("\n");
      const newLines = newText.split("\n");
      return [
        `@@ -1,${oldLines.length} +1,${newLines.length} @@`,
        ...oldLines.map((line) => `-${line}`),
        ...newLines.map((line) => `+${line}`),
      ].join("\n");
    })
    .join("\n");
}

const SUBAGENT_TOOLS = new Set([
  "invoke_subagent",
  "start_subagent",
  "spawn_subagent",
  "run_subagent",
  "browser_subagent",
]);

/**
 * Map one native tool call. `brainDir` is the conversation's artifact folder
 * (`<data>/brain/<id>`): plan-mode plans are files written there with
 * `ArtifactMetadata.RequestFeedback`.
 */
export function describeAntigravityTool(
  name: string,
  rawArgs: unknown,
  context: { cwd?: string; brainDir?: string } = {},
): AntigravityToolView {
  const args = decodeAntigravityArgs(rawArgs);
  const cwd = pickString(args, "Cwd", "WorkingDirectory", "working_dir", "cwd") ?? context.cwd;
  const filePath = resolvePath(pickString(args, ...FILE_KEYS), context.cwd);
  const summary = pickString(args, "toolSummary", "ToolSummary", "Description", "description");

  switch (name) {
    case "read_file":
    case "view_file":
    case "client_view_file":
    case "view_file_outline":
    case "view_code_item": {
      const offset = pickNumber(args, "StartLine", "start_line", "Offset", "offset");
      const end = pickNumber(args, "EndLine", "end_line");
      const limit =
        pickNumber(args, "Limit", "limit") ??
        (offset !== undefined && end !== undefined ? end - offset + 1 : undefined);
      return {
        tool: "Read",
        description: "Read",
        inputDescription: filePath ? baseName(filePath) : summary,
        input: {
          ...(filePath ? { file_path: filePath } : {}),
          ...(offset !== undefined ? { offset } : {}),
          ...(limit !== undefined ? { limit } : {}),
        },
      };
    }

    case "edit_file":
    case "replace_file_content":
    case "multi_replace_file_content":
    case "multi_edit_file": {
      const chunks = chunkPairs(pick(args, "ReplacementChunks", "replacement_chunks", "Edits"));
      const single = (() => {
        const oldText = pickString(args, "Target", "TargetContent", "target_content", "old_string");
        const newText = pickString(
          args,
          "Replacement",
          "ReplacementContent",
          "replacement_content",
          "new_string",
        );
        return oldText !== undefined && newText !== undefined ? [{ oldText, newText }] : [];
      })();
      const pairs = chunks.length > 0 ? chunks : single;
      const isArtifact = !!filePath && !!context.brainDir && filePath.startsWith(context.brainDir);
      const input: Args = filePath ? { file_path: filePath } : {};
      // Marks a scratch file, so plan mode never takes it for the plan.
      if (isArtifact) input.artifact = true;
      if (pairs.length === 1) {
        input.old_string = pairs[0].oldText;
        input.new_string = pairs[0].newText;
      } else if (pairs.length > 1) {
        input.diff = buildSnippetDiff(pairs);
      }
      return {
        tool: "Edit",
        description: "Edit",
        inputDescription: filePath ? baseName(filePath) : summary,
        input,
        // The conversation's own artifacts (todo list, notes) are not project files.
        ...(filePath && !isArtifact
          ? { changedFile: { path: filePath, kind: "edited" as const } }
          : {}),
        ...(filePath && isArtifact ? { artifact: { path: filePath, edits: pairs } } : {}),
      };
    }

    case "write_file":
    case "write_to_file":
    case "create_file": {
      const content = pickString(args, "Content", "CodeContent", "content", "code_content");
      const metadata = pick(args, "ArtifactMetadata") as Args | undefined;
      const isReviewArtifact =
        !!metadata &&
        metadata.RequestFeedback === true &&
        !!filePath &&
        !!context.brainDir &&
        filePath.startsWith(context.brainDir);
      if (isReviewArtifact && content) {
        return {
          tool: "ExitPlanMode",
          description: "Plan ready for review",
          inputDescription: pickString(metadata, "Summary") ?? baseName(filePath!),
          input: { plan: content, file_path: filePath },
          plan: content,
        };
      }
      const overwrite = pick(args, "Overwrite", "overwrite") === true;
      const isArtifact = !!filePath && !!context.brainDir && filePath.startsWith(context.brainDir);
      return {
        tool: "Write",
        description: "Write",
        inputDescription: filePath ? baseName(filePath) : summary,
        input: {
          ...(filePath ? { file_path: filePath } : {}),
          ...(content !== undefined ? { content } : {}),
          ...(isArtifact ? { artifact: true } : {}),
        },
        // The conversation's own artifacts (notes, plans) are not project files.
        ...(filePath && !isArtifact
          ? { changedFile: { path: filePath, kind: overwrite ? "edited" : "added" } }
          : {}),
        ...(filePath && isArtifact ? { artifact: { path: filePath, content } } : {}),
      };
    }

    case "run_command":
    case "execute_command":
    case "run_shell_command": {
      const command = pickString(args, "CommandLine", "command_line", "commandLine", "command");
      return {
        tool: "Bash",
        description: "Run command",
        inputDescription: summary ?? command,
        input: {
          ...(command ? { command } : {}),
          ...(summary ? { description: summary } : {}),
          ...(cwd ? { cwd } : {}),
        },
      };
    }

    case "list_dir":
    case "list_directory": {
      const dir = resolvePath(
        pickString(args, "DirectoryPath", "Directory", "Path", "path"),
        context.cwd,
      );
      return {
        tool: "Glob",
        description: "List",
        inputDescription: dir ? baseName(dir) : summary,
        input: { pattern: "*", ...(dir ? { path: dir } : {}) },
      };
    }

    case "find_by_name":
    case "find_files":
    case "glob": {
      const pattern = pickString(args, "Pattern", "pattern", "Glob");
      const dir = resolvePath(
        pickString(args, "SearchDirectory", "SearchPath", "Directory", "path"),
        context.cwd,
      );
      return {
        tool: "Glob",
        description: "Find",
        inputDescription: pattern ?? summary,
        input: { ...(pattern ? { pattern } : {}), ...(dir ? { path: dir } : {}) },
      };
    }

    case "grep_search":
    case "search_files":
    case "grep": {
      const pattern = pickString(args, "Query", "Pattern", "query", "pattern");
      const dir = resolvePath(
        pickString(args, "SearchPath", "SearchDirectory", "Path", "path"),
        context.cwd,
      );
      const includes = pick(args, "Includes", "includes", "Glob");
      const glob = Array.isArray(includes) ? includes.join(",") : pickString(args, "Includes");
      return {
        tool: "Grep",
        description: "Search",
        inputDescription: pattern ?? summary,
        input: {
          ...(pattern ? { pattern } : {}),
          ...(dir ? { path: dir } : {}),
          ...(glob ? { glob } : {}),
        },
      };
    }

    case "search_web":
    case "web_search": {
      const query = pickString(args, "query", "Query");
      return {
        tool: "WebSearch",
        description: "Search the web",
        inputDescription: query ?? summary,
        input: query ? { query } : {},
      };
    }

    case "read_url_content":
    case "fetch_url":
    case "read_url": {
      const url = pickString(args, "Url", "url", "URL");
      return {
        tool: "WebFetch",
        description: "Fetch",
        inputDescription: url ?? summary,
        input: url ? { url } : {},
      };
    }

    case "generate_image": {
      return {
        tool: "GenerateImage",
        description: "Generate image",
        inputDescription: summary,
        input: filePath ? { file_path: filePath } : {},
      };
    }

    default:
      break;
  }

  if (SUBAGENT_TOOLS.has(name) || name.endsWith("_subagent")) {
    const subagents = pick(args, "Subagents", "subagents");
    const first =
      Array.isArray(subagents) && subagents[0] && typeof subagents[0] === "object"
        ? (subagents[0] as Args)
        : args;
    const role = pickString(first, "Role", "role", "Name", "name");
    const typeName = pickString(first, "TypeName", "type_name", "Type", "type");
    const prompt = pickString(first, "Prompt", "prompt", "Task", "task");
    return {
      tool: "Agent",
      description: "Delegate",
      inputDescription: role ?? typeName ?? summary,
      input: {
        ...(prompt ? { prompt } : {}),
        ...(role ? { description: role } : {}),
        ...(typeName ? { subagent_type: typeName } : {}),
      },
      subagent: { role, typeName, prompt },
    };
  }

  const mcp = splitAntigravityMcpToolName(name);
  if (mcp) {
    const { toolSummary: _summary, ...input } = args;
    return {
      tool: mcp.toolName,
      description: `Using ${mcp.serverName}/${mcp.toolName}`,
      inputDescription: summary,
      input,
      mcp,
    };
  }

  return {
    tool: name,
    description: summary ?? name.replace(/_/g, " "),
    inputDescription: summary,
    input: args,
  };
}

/** Strip agy's "Created At / Completed At" preamble from tool output. */
export function cleanAntigravityToolOutput(text: string): string {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let index = 0;
  while (index < lines.length && /^(Created|Completed) At: /.test(lines[index])) index++;
  const rest = lines.slice(index).join("\n");
  // run_command: "Command exited with code N.\n\nCommand output:\n<output>" —
  // the exit code is reported separately, so keep only the output.
  const command = /^Command exited with code -?\d+\.?[ \t]*(?:\n+Command output:[ \t]*\n?)?/.exec(
    rest.replace(/^\n+/, ""),
  );
  const body = command ? rest.replace(/^\n+/, "").slice(command[0].length) : rest;
  return body.replace(/^\n+/, "").trimEnd();
}

const READ_PREVIEW_MAX_BYTES = 64 * 1024;
const READ_PREVIEW_MAX_LINES = 400;

/**
 * Preview of a file the agent just read, in agy's own transcript format
 * (`Showing lines a-b of n` + numbered lines). agy reports a read's content
 * only in its transcript, not over ACP, so the live result is read from disk
 * at completion. Bounded; undefined when the file can't be read as text.
 */
export function antigravityReadPreview(
  filePath: string,
  offset?: number,
  limit?: number,
): string | undefined {
  let text: string;
  try {
    const stat = statSync(filePath);
    if (!stat.isFile()) return undefined;
    const fd = openSync(filePath, "r");
    try {
      const buffer = Buffer.alloc(Math.min(stat.size, READ_PREVIEW_MAX_BYTES));
      const length = readSync(fd, buffer, 0, buffer.length, 0);
      if (buffer.subarray(0, length).includes(0)) return undefined; // binary
      text = buffer.toString("utf8", 0, length);
    } finally {
      closeSync(fd);
    }
  } catch {
    return undefined;
  }
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (lines.length > 1 && lines.at(-1) === "") lines.pop();
  const start = Math.max(1, offset ?? 1);
  const end = Math.min(
    lines.length,
    start - 1 + Math.min(limit ?? READ_PREVIEW_MAX_LINES, READ_PREVIEW_MAX_LINES),
  );
  if (start > end) return undefined;
  const numbered = lines.slice(start - 1, end).map((line, index) => `${start + index}: ${line}`);
  return [`Showing lines ${start}-${end} of ${lines.length}`, ...numbered].join("\n");
}

/** Exit code from a run_command result ("Command exited with code N."), when present. */
export function antigravityExitCode(text: string | undefined): number | undefined {
  const match = /Command exited with code (-?\d+)/.exec(text ?? "");
  return match ? Number(match[1]) : undefined;
}

/** Build the shared `tool_use` activity for a mapped call. */
export function antigravityToolUseActivity(
  view: AntigravityToolView,
  toolUseId: string | undefined,
  raw?: unknown,
): ActivityMessage {
  return {
    type: "activity",
    activity: "tool_use",
    ...(toolUseId ? { toolUseId } : {}),
    tool: view.tool,
    description: view.description,
    ...(view.inputDescription ? { inputDescription: view.inputDescription } : {}),
    input: view.input,
    ...(view.mcp
      ? {
          mcp: {
            serverId: mcpServerId("antigravity", view.mcp.serverName),
            serverName: view.mcp.serverName,
            toolName: view.mcp.toolName,
            ...(toolUseId ? { callId: toolUseId } : {}),
          },
        }
      : {}),
    ...(raw !== undefined ? { raw } : {}),
  };
}

const realCwdCache = new Map<string, string>();

/**
 * A file path the agent reported, spelled under the chat's cwd, or undefined
 * when it lies outside it. agy reports real paths (`/private/var/…` on macOS)
 * while the chat's cwd may go through a symlink, so a path under the cwd's
 * real path is rewritten to the cwd's own spelling.
 */
export function antigravityWorkspacePath(cwd: string, path: string): string | undefined {
  if (isPathWithinWorkspace(cwd, path)) return path;
  let real = realCwdCache.get(cwd);
  if (real === undefined) {
    try {
      real = realpathSync(cwd);
    } catch {
      real = cwd;
    }
    realCwdCache.set(cwd, real);
  }
  if (real === cwd || !isPathWithinWorkspace(real, path)) return undefined;
  const rest = relative(real, path);
  return rest ? join(cwd, rest) : cwd;
}

/**
 * The agent's task list from a checklist artifact (`todo.md`):
 * `- [ ]` pending, `- [/]` in progress, `- [x]` done. Empty when the text has
 * no checklist items.
 */
export function parseAntigravityChecklist(markdown: string): TaskItem[] {
  const tasks: TaskItem[] = [];
  for (const line of markdown.split("\n")) {
    const match = /^\s*[-*+]\s+\[([ xX/~-])\]\s+(.+?)\s*$/.exec(line);
    if (!match) continue;
    const mark = match[1];
    const subject = match[2].replace(/^\d+[.)]\s+/, "");
    tasks.push({
      id: String(tasks.length + 1),
      subject,
      status: mark === "x" || mark === "X" ? "completed" : mark === " " ? "pending" : "in_progress",
    });
  }
  return tasks;
}

/** Apply an artifact edit's replacements to its previous text (first occurrence each). */
export function applyAntigravityArtifactEdits(
  text: string,
  edits: Array<{ oldText: string; newText: string }>,
): string {
  let next = text;
  for (const edit of edits) {
    const index = next.indexOf(edit.oldText);
    if (index >= 0)
      next = next.slice(0, index) + edit.newText + next.slice(index + edit.oldText.length);
  }
  return next;
}
