import { createHash } from "node:crypto";
import { parseDocument, stringify } from "yaml";
import type { Task, TaskComment, TaskStatus, TaskType } from "#core/types.js";

export type TaskErrorCode =
  | "not_found"
  | "conflict"
  | "validation"
  | "legacy_requires_migration"
  | "ambiguous_sources"
  | "lock_timeout";

export class TaskError extends Error {
  readonly code: TaskErrorCode;

  constructor(code: TaskErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "TaskError";
    this.code = code;
  }
}

/** Legacy stores contain both eight-hex IDs and safe lowercase slugs. */
export const TASK_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$/;
export const STORED_TASK_STATUSES = ["open", "in_progress", "done", "cancelled"] as const;
export const TASK_TYPES = ["epic", "task", "bug"] as const;

const TASK_KEYS = [
  "version",
  "id",
  "title",
  "status",
  "priority",
  "type",
  "tags",
  "parent",
  "blockedBy",
  "createdAt",
  "updatedAt",
  "closedAt",
] as const;

const COMMENT_KEYS = ["version", "id", "taskId", "author", "replyTo", "createdAt"] as const;

interface ParsedMarkdown {
  attributes: Record<string, unknown>;
  body: string;
}

export interface ParsedTaskFile {
  task: Task;
  content: string;
}

export interface ParsedCommentFile {
  comment: TaskComment;
  content: string;
}

export function isTaskId(value: unknown): value is string {
  return typeof value === "string" && TASK_ID_PATTERN.test(value);
}

export function isStoredTaskStatus(value: unknown): value is Exclude<TaskStatus, "blocked"> {
  return (STORED_TASK_STATUSES as readonly unknown[]).includes(value);
}

export function isTaskType(value: unknown): value is TaskType {
  return (TASK_TYPES as readonly unknown[]).includes(value);
}

export function revisionFor(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function fail(source: string, message: string): never {
  throw new TaskError("validation", `${source}: ${message}`);
}

function parseMarkdown(content: string, source: string): ParsedMarkdown {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(content);
  if (!match) fail(source, "expected YAML front matter delimited by ---");

  const document = parseDocument(match[1], {
    schema: "core",
    uniqueKeys: true,
    strict: true,
  });
  if (document.errors.length > 0) {
    fail(source, `invalid YAML: ${document.errors.map((error) => error.message).join("; ")}`);
  }
  let attributes: unknown;
  try {
    attributes = document.toJS({ maxAliasCount: 0 }) as unknown;
  } catch (error) {
    throw new TaskError("validation", `${source}: unsafe or invalid YAML`, { cause: error });
  }
  if (!attributes || typeof attributes !== "object" || Array.isArray(attributes)) {
    fail(source, "front matter must be a mapping");
  }

  const rawBody = match[2];
  return {
    attributes: attributes as Record<string, unknown>,
    body: rawBody.endsWith("\n") ? rawBody.slice(0, -1) : rawBody,
  };
}

function validateKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  source: string,
): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0)
    fail(source, `unknown field${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}`);
  const missing = allowed.filter((key) => !(key in value));
  if (missing.length > 0)
    fail(source, `missing field${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}`);
}

function requiredString(value: unknown, field: string, source: string, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value.trim().length === 0)) {
    fail(source, `${field} must be ${allowEmpty ? "a string" : "a non-empty string"}`);
  }
  return value;
}

function nullableString(value: unknown, field: string, source: string): string | null {
  if (value === null) return null;
  return requiredString(value, field, source);
}

function timestamp(value: unknown, field: string, source: string): string {
  const result = requiredString(value, field, source);
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(result) ||
    !Number.isFinite(Date.parse(result))
  ) {
    fail(source, `${field} must be an ISO 8601 timestamp with a timezone`);
  }
  return result;
}

function nullableTimestamp(value: unknown, field: string, source: string): string | null {
  if (value === null) return null;
  return timestamp(value, field, source);
}

function stringArray(value: unknown, field: string, source: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    fail(source, `${field} must be an array of strings`);
  }
  const result = value as string[];
  if (new Set(result).size !== result.length) fail(source, `${field} contains duplicates`);
  return [...result];
}

function idArray(value: unknown, field: string, source: string): string[] {
  const result = stringArray(value, field, source);
  const invalid = result.find((item) => !isTaskId(item));
  if (invalid) fail(source, `${field} contains invalid task id ${invalid}`);
  return result;
}

function yaml(attributes: Record<string, unknown>): string {
  return stringify(attributes, {
    defaultKeyType: "PLAIN",
    defaultStringType: "QUOTE_DOUBLE",
    doubleQuotedAsJSON: true,
    lineWidth: 0,
    simpleKeys: true,
  });
}

export function parseTaskFile(content: string, source: string, archived: boolean): ParsedTaskFile {
  const { attributes, body } = parseMarkdown(content, source);
  validateKeys(attributes, TASK_KEYS, source);
  if (attributes.version !== 2) fail(source, "version must be 2");
  if (!isTaskId(attributes.id)) fail(source, "id must be a lowercase task slug or UUID");
  if (!isStoredTaskStatus(attributes.status))
    fail(source, "status must be open, in_progress, done, or cancelled");
  if (
    !Number.isInteger(attributes.priority) ||
    (attributes.priority as number) < 0 ||
    (attributes.priority as number) > 4
  ) {
    fail(source, "priority must be an integer from 0 through 4");
  }
  if (!isTaskType(attributes.type)) fail(source, "type must be epic, task, or bug");

  const parent = nullableString(attributes.parent, "parent", source);
  if (parent !== null && !isTaskId(parent)) fail(source, "parent must be null or a task id");
  const closedAt = nullableTimestamp(attributes.closedAt, "closedAt", source);
  const status = attributes.status;
  if ((status === "open" || status === "in_progress") && closedAt !== null) {
    fail(source, "closedAt must be null for an unfinished task");
  }

  const task: Task = {
    id: attributes.id,
    title: requiredString(attributes.title, "title", source),
    description: body,
    status,
    priority: attributes.priority as number,
    type: attributes.type,
    tags: stringArray(attributes.tags, "tags", source),
    parent,
    blockedBy: idArray(attributes.blockedBy, "blockedBy", source),
    createdAt: timestamp(attributes.createdAt, "createdAt", source),
    updatedAt: timestamp(attributes.updatedAt, "updatedAt", source),
    closedAt,
    revision: revisionFor(content),
    archived,
  };
  if (task.parent === task.id) fail(source, "a task cannot be its own parent");
  if (task.blockedBy.includes(task.id)) fail(source, "a task cannot block itself");
  return { task, content };
}

export function serializeTask(task: Omit<Task, "revision" | "archived">): string {
  const attributes: Record<string, unknown> = {
    version: 2,
    id: task.id,
    title: task.title,
    status: task.status === "blocked" ? "open" : task.status,
    priority: task.priority,
    type: task.type,
    tags: task.tags,
    parent: task.parent,
    blockedBy: task.blockedBy,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    closedAt: task.closedAt,
  };
  return `---\n${yaml(attributes)}---\n${task.description}${task.description ? "\n" : ""}`;
}

export function parseCommentFile(content: string, source: string): ParsedCommentFile {
  const { attributes, body } = parseMarkdown(content, source);
  validateKeys(attributes, COMMENT_KEYS, source);
  if (attributes.version !== 2) fail(source, "version must be 2");
  if (!isTaskId(attributes.id)) fail(source, "id must be a lowercase task slug or UUID");
  if (!isTaskId(attributes.taskId)) fail(source, "taskId must be a task id");
  const replyTo = nullableString(attributes.replyTo, "replyTo", source);
  if (replyTo !== null && !isTaskId(replyTo)) fail(source, "replyTo must be null or a comment id");
  const comment: TaskComment = {
    id: attributes.id,
    taskId: attributes.taskId,
    body: requiredString(body, "body", source),
    author: nullableString(attributes.author, "author", source),
    replyTo,
    createdAt: timestamp(attributes.createdAt, "createdAt", source),
  };
  return { comment, content };
}

export function serializeComment(comment: TaskComment): string {
  const attributes: Record<string, unknown> = {
    version: 2,
    id: comment.id,
    taskId: comment.taskId,
    author: comment.author,
    replyTo: comment.replyTo,
    createdAt: comment.createdAt,
  };
  return `---\n${yaml(attributes)}---\n${comment.body}\n`;
}
