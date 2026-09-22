import process from "node:process";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import {
  addTaskComment,
  archiveTasks,
  createTask,
  deleteTask,
  formatTasks,
  getTask,
  loadTasks,
  migrateTasks,
  TaskError,
  updateTask,
  validateTasks,
} from "#core/task-manager.js";
import type { CreateTaskInput, UpdateTaskInput } from "#core/task-manager.js";
import type { Task, TaskStatus, TaskType } from "#core/types.js";

export interface TaskCliOptions {
  cwd?: string;
  stdout?: (message: string) => void;
  stderr?: (message: string) => void;
}

interface ParsedArgs {
  positionals: string[];
  flags: Map<string, string | true>;
}

const TASK_STATUSES = new Set<TaskStatus>(["open", "in_progress", "blocked", "done", "cancelled"]);
const TASK_TYPES = new Set<TaskType>(["epic", "task", "bug"]);
const BOOLEAN_FLAGS = new Set([
  "--help",
  "--json",
  "--ready",
  "--include-archived",
  "--check",
  "--dry-run",
  "--apply",
]);
const VALUE_FLAGS = new Set([
  "--dir",
  "--title",
  "--description",
  "--priority",
  "--type",
  "--tags",
  "--parent",
  "--blocked-by",
  "--status",
  "--revision",
  "--body",
  "--author",
  "--reply-to",
  "--days",
]);

function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags = new Map<string, string | true>();
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index]!;
    if (!value.startsWith("--")) {
      positionals.push(value);
      continue;
    }
    const equals = value.indexOf("=");
    if (equals !== -1) {
      const name = value.slice(0, equals);
      if (!VALUE_FLAGS.has(name)) throw new Error(`Unknown option: ${name}`);
      flags.set(name, value.slice(equals + 1));
      continue;
    }
    if (BOOLEAN_FLAGS.has(value)) {
      flags.set(value, true);
      continue;
    }
    if (!VALUE_FLAGS.has(value)) throw new Error(`Unknown option: ${value}`);
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags.set(value, next);
      index++;
    } else {
      flags.set(value, true);
    }
  }
  return { positionals, flags };
}

function stringFlag(parsed: ParsedArgs, name: string): string | undefined {
  const value = parsed.flags.get(name);
  if (value === undefined) return undefined;
  if (value === true) throw new Error(`${name} requires a value`);
  return value;
}

function booleanFlag(parsed: ParsedArgs, name: string): boolean {
  return parsed.flags.get(name) === true;
}

function assertInvocation(
  parsed: ParsedArgs,
  positionalCount: number,
  allowedFlags: readonly string[],
): void {
  if (parsed.positionals.length !== positionalCount) {
    throw new Error(`Expected ${positionalCount - 1} argument(s) after ${parsed.positionals[0]}`);
  }
  const allowed = new Set(["--dir", "--help", ...allowedFlags]);
  for (const flag of parsed.flags.keys()) {
    if (!allowed.has(flag)) throw new Error(`${flag} is not valid for ${parsed.positionals[0]}`);
  }
}

function resolveTaskDirectory(explicitDirectory: string | undefined, cwd: string): string {
  const start = resolve(cwd);
  if (explicitDirectory) return resolve(start, explicitDirectory);
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: start,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return start;
  }
}

function integerFlag(parsed: ParsedArgs, name: string): number | undefined {
  const value = stringFlag(parsed, name);
  if (value === undefined) return undefined;
  const parsedValue = Number(value);
  if (!Number.isInteger(parsedValue)) throw new Error(`${name} must be an integer`);
  return parsedValue;
}

function listFlag(parsed: ParsedArgs, name: string): string[] | undefined {
  const value = stringFlag(parsed, name);
  if (value === undefined) return undefined;
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function taskJson(task: Task): string {
  return JSON.stringify(task, null, 2);
}

function printTask(task: Task, out: (message: string) => void): void {
  out(`${task.id}  P${task.priority}  ${task.status}  ${task.title}`);
  out(`Type: ${task.type}`);
  out(`Tags: ${task.tags.join(", ") || "—"}`);
  out(`Parent: ${task.parent ?? "—"}`);
  out(`Blocked by: ${task.blockedBy.join(", ") || "—"}`);
  out(`Created: ${task.createdAt}`);
  out(`Updated: ${task.updatedAt}`);
  out(`Closed: ${task.closedAt ?? "—"}`);
  out(`Archived: ${task.archived ? "yes" : "no"}`);
  out(`Revision: ${task.revision}`);
  if (task.description) out(`\n${task.description}`);
}

export function taskCliUsage(): string {
  return `Usage:
  relay tasks [--dir <path>] list [--ready] [--include-archived] [--json]
  relay tasks [--dir <path>] show <id> [--json]
  relay tasks [--dir <path>] create --title <text> [--description <markdown>] [--priority <0-4>] [--type <epic|task|bug>] [--tags <a,b>] [--parent <id>] [--blocked-by <id,id>] [--json]
  relay tasks [--dir <path>] update <id> [--title <text>] [--description <markdown>] [--status <open|in_progress|done|cancelled>] [--priority <0-4>] [--type <epic|task|bug>] [--tags <a,b>] [--parent <id|none>] [--blocked-by <id,id>] [--revision <hash>] [--json]
  relay tasks [--dir <path>] delete <id> [--revision <hash>]
  relay tasks [--dir <path>] comment <id> --body <markdown> [--author <name>] [--reply-to <comment-id>] [--json]
  relay tasks [--dir <path>] validate [--json]
  relay tasks [--dir <path>] format [--check] [--json]
  relay tasks [--dir <path>] archive [--days <number>] [--json]
  relay tasks [--dir <path>] migrate [--dry-run | --apply] [--json]

Task files are read and written in the selected worktree. --dir defaults to the current directory.
Migration is a dry run unless --apply is provided.`;
}

export function runTasksCommand(argv: string[], options: TaskCliOptions = {}): number {
  const out = options.stdout ?? console.log;
  const errorOut = options.stderr ?? console.error;

  try {
    if (argv.includes("-h")) {
      out(taskCliUsage());
      return 0;
    }
    const parsed = parseArgs(argv);
    if (booleanFlag(parsed, "--help") || booleanFlag(parsed, "-h")) {
      out(taskCliUsage());
      return 0;
    }
    const command = parsed.positionals[0];
    const directory = resolveTaskDirectory(
      stringFlag(parsed, "--dir"),
      options.cwd ?? process.cwd(),
    );
    const json = booleanFlag(parsed, "--json");

    if (!command) {
      out(taskCliUsage());
      return 0;
    }

    if (command === "list") {
      assertInvocation(parsed, 1, ["--ready", "--include-archived", "--json"]);
      let tasks = loadTasks(directory, {
        includeArchived: booleanFlag(parsed, "--include-archived"),
      });
      if (booleanFlag(parsed, "--ready")) {
        tasks = tasks
          .filter((task) => task.status === "open")
          .sort(
            (a, b) =>
              a.priority - b.priority ||
              a.createdAt.localeCompare(b.createdAt) ||
              a.id.localeCompare(b.id),
          );
      }
      if (json && booleanFlag(parsed, "--ready")) {
        out(
          JSON.stringify(
            tasks.map(({ id, title, status, priority, parent, blockedBy, revision }) => ({
              id,
              title,
              status,
              priority,
              parent,
              blockedBy,
              revision,
            })),
            null,
            2,
          ),
        );
      } else if (json) out(JSON.stringify(tasks, null, 2));
      else if (tasks.length === 0)
        out(booleanFlag(parsed, "--ready") ? "No ready tasks." : "No tasks.");
      else
        for (const task of tasks)
          out(`${task.id}  P${task.priority}  ${task.status}  ${task.title}`);
      return 0;
    }

    const taskId = parsed.positionals[1];
    if (command === "show") {
      assertInvocation(parsed, 2, ["--json"]);
      if (!taskId) throw new Error("show requires a task id");
      const task = getTask(directory, taskId);
      if (!task) throw new TaskError("not_found", `Task ${taskId} not found`);
      if (json) out(taskJson(task));
      else printTask(task, out);
      return 0;
    }

    if (command === "create") {
      assertInvocation(parsed, 1, [
        "--title",
        "--description",
        "--priority",
        "--type",
        "--tags",
        "--parent",
        "--blocked-by",
        "--json",
      ]);
      const title = stringFlag(parsed, "--title");
      if (!title) throw new Error("create requires --title");
      const type = stringFlag(parsed, "--type");
      if (type !== undefined && !TASK_TYPES.has(type as TaskType)) {
        throw new Error("--type must be epic, task, or bug");
      }
      const input: CreateTaskInput = {
        title,
        description: stringFlag(parsed, "--description"),
        priority: integerFlag(parsed, "--priority"),
        type: type as TaskType | undefined,
        tags: listFlag(parsed, "--tags"),
        parent: stringFlag(parsed, "--parent"),
        blockedBy: listFlag(parsed, "--blocked-by"),
      };
      const task = createTask(directory, input);
      if (json) out(taskJson(task));
      else out(`Created ${task.id}: ${task.title}`);
      return 0;
    }

    if (command === "update") {
      assertInvocation(parsed, 2, [
        "--title",
        "--description",
        "--status",
        "--priority",
        "--type",
        "--tags",
        "--parent",
        "--blocked-by",
        "--revision",
        "--json",
      ]);
      if (!taskId) throw new Error("update requires a task id");
      const status = stringFlag(parsed, "--status");
      if (status !== undefined && !TASK_STATUSES.has(status as TaskStatus)) {
        throw new Error("--status must be open, in_progress, done, or cancelled");
      }
      if (status === "blocked") throw new Error("blocked is derived and cannot be stored");
      const type = stringFlag(parsed, "--type");
      if (type !== undefined && !TASK_TYPES.has(type as TaskType)) {
        throw new Error("--type must be epic, task, or bug");
      }
      const parent = stringFlag(parsed, "--parent");
      const patch: UpdateTaskInput = {
        title: stringFlag(parsed, "--title"),
        description: stringFlag(parsed, "--description"),
        status: status as TaskStatus | undefined,
        priority: integerFlag(parsed, "--priority"),
        type: type as TaskType | undefined,
        tags: listFlag(parsed, "--tags"),
        parent: parent === "none" ? null : parent,
        blockedBy: listFlag(parsed, "--blocked-by"),
        expectedRevision: stringFlag(parsed, "--revision"),
      };
      const task = updateTask(directory, taskId, patch);
      if (json) out(taskJson(task));
      else out(`Updated ${task.id}: ${task.title} (${task.status})`);
      return 0;
    }

    if (command === "delete") {
      assertInvocation(parsed, 2, ["--revision"]);
      if (!taskId) throw new Error("delete requires a task id");
      deleteTask(directory, taskId, stringFlag(parsed, "--revision"));
      out(`Deleted ${taskId}.`);
      return 0;
    }

    if (command === "comment") {
      assertInvocation(parsed, 2, ["--body", "--author", "--reply-to", "--json"]);
      if (!taskId) throw new Error("comment requires a task id");
      const body = stringFlag(parsed, "--body");
      if (!body) throw new Error("comment requires --body");
      const comment = addTaskComment(directory, taskId, {
        body,
        author: stringFlag(parsed, "--author"),
        replyTo: stringFlag(parsed, "--reply-to"),
      });
      if (json) out(JSON.stringify(comment, null, 2));
      else out(`Added comment ${comment.id} to ${taskId}.`);
      return 0;
    }

    if (command === "validate") {
      assertInvocation(parsed, 1, ["--json"]);
      const result = validateTasks(directory);
      if (json) out(JSON.stringify(result, null, 2));
      else if (result.valid)
        out(`Valid: ${result.taskCount} task(s), ${result.commentCount} comment(s).`);
      else for (const message of result.errors) errorOut(message);
      return result.valid ? 0 : 1;
    }

    if (command === "format") {
      assertInvocation(parsed, 1, ["--check", "--json"]);
      const check = booleanFlag(parsed, "--check");
      const result = formatTasks(directory, { check });
      if (json) out(JSON.stringify(result, null, 2));
      else if (result.changed.length === 0) out("Task files are formatted.");
      else if (check) for (const path of result.changed) out(path);
      else out(`Formatted ${result.changed.length} file(s).`);
      return check && result.changed.length > 0 ? 1 : 0;
    }

    if (command === "archive") {
      assertInvocation(parsed, 1, ["--days", "--json"]);
      const result = archiveTasks(directory, { days: integerFlag(parsed, "--days") });
      if (json) out(JSON.stringify(result, null, 2));
      else out(`Archived ${result.archived.length} task(s).`);
      return 0;
    }

    if (command === "migrate") {
      assertInvocation(parsed, 1, ["--dry-run", "--apply", "--json"]);
      if (booleanFlag(parsed, "--apply") && booleanFlag(parsed, "--dry-run")) {
        throw new Error("Use only one of --dry-run or --apply");
      }
      const result = migrateTasks(directory, { dryRun: !booleanFlag(parsed, "--apply") });
      if (json) out(JSON.stringify(result, null, 2));
      else {
        const action = result.dryRun ? "Migration preview" : "Migration complete";
        out(
          `${action}: ${result.taskCount} task(s), ${result.currentCount} current, ${result.archivedCount} archived.`,
        );
      }
      return 0;
    }

    throw new Error(`Unknown tasks command: ${command}`);
  } catch (error) {
    if (error instanceof TaskError) errorOut(`${error.code}: ${error.message}`);
    else errorOut(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
