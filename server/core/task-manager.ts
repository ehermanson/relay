/**
 * Worktree-local task storage.
 *
 * Schema v2 stores one Markdown file per task under `.relay/tasks/`. The legacy
 * `.relay/tasks.json` snapshot remains readable, but must be migrated explicitly
 * before any mutation.
 */

import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";
import type { Task, TaskComment, TaskStatus, TaskType } from "#core/types.js";
import {
  TaskError,
  isStoredTaskStatus,
  isTaskId,
  isTaskType,
  parseCommentFile,
  parseTaskFile,
  revisionFor,
  serializeComment,
  serializeTask,
  type TaskErrorCode,
} from "#core/task-files.js";

const RELAY_DIR = ".relay";
const TASKS_DIR = "tasks";
const ARCHIVE_DIR = "archive";
const DISCUSSION_DIR = "task-discussion";
const LEGACY_TASKS_FILE = "tasks.json";
const EMPTY_MARKER = ".gitkeep";
const LOCK_DIR = ".tasks.lock";
const TEMP_DIR = ".tasks-tmp";
const LOCK_TIMEOUT_MS = 5_000;
const STALE_LOCK_MS = 30_000;
const MALFORMED_STALE_LOCK_MS = 5 * 60_000;
const DEFAULT_ARCHIVE_DAYS = 30;

interface LegacyTaskSnapshot {
  version: number;
  tasks: unknown[];
}

interface StoredTaskRecord {
  task: Task;
  path: string;
  content: string;
}

export interface LoadTasksOptions {
  includeArchived?: boolean;
}

export interface CreateTaskInput {
  title: string;
  description?: string;
  priority?: number;
  type?: TaskType;
  tags?: string[];
  parent?: string | null;
  blockedBy?: string[];
}

export interface UpdateTaskInput {
  title?: string;
  description?: string;
  status?: TaskStatus;
  priority?: number;
  type?: TaskType;
  tags?: string[];
  parent?: string | null;
  blockedBy?: string[];
  expectedRevision?: string;
}

export interface AddTaskCommentInput {
  body: string;
  author?: string;
  replyTo?: string;
}

export interface TaskValidationResult {
  valid: boolean;
  errors: string[];
  taskCount: number;
  commentCount: number;
}

export interface ArchiveTasksResult {
  archived: Task[];
}

export interface FormatTasksResult {
  changed: string[];
}

export interface MigrateTasksResult {
  dryRun: boolean;
  alreadyMigrated: boolean;
  taskCount: number;
  currentCount: number;
  archivedCount: number;
}

export type { TaskErrorCode };
export { TaskError };

function relayPath(dir: string): string {
  return join(dir, RELAY_DIR);
}

function tasksPath(dir: string): string {
  return join(relayPath(dir), TASKS_DIR);
}

function archivePath(dir: string): string {
  return join(tasksPath(dir), ARCHIVE_DIR);
}

function legacyPath(dir: string): string {
  return join(relayPath(dir), LEGACY_TASKS_FILE);
}

function discussionPath(dir: string): string {
  return join(relayPath(dir), DISCUSSION_DIR);
}

function lockPath(dir: string): string {
  return join(relayPath(dir), LOCK_DIR);
}

function ensureRelayDir(dir: string): string {
  const path = relayPath(dir);
  mkdirSync(path, { recursive: true });
  return path;
}

function sleep(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

interface LockOwner {
  pid: number;
  token: string;
  createdAt: string;
}

function parseLockOwner(content: string): LockOwner | undefined {
  try {
    const value = JSON.parse(content) as Partial<LockOwner>;
    if (
      Number.isInteger(value.pid) &&
      (value.pid ?? 0) > 0 &&
      typeof value.token === "string" &&
      value.token.length > 0 &&
      typeof value.createdAt === "string"
    ) {
      return value as LockOwner;
    }
  } catch {
    // A writer may be between mkdir and owner-file creation. Age protects it.
  }
  return undefined;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function tryAcquireGate(path: string): string | undefined {
  const token = randomUUID();
  try {
    mkdirSync(path);
    writeFileSync(join(path, "owner"), token, { flag: "wx" });
    return token;
  } catch {
    try {
      if (existsSync(path) && readFileSync(join(path, "owner"), "utf8") === token) {
        rmSync(path, { recursive: true, force: true });
      }
    } catch {
      // Fail closed when gate ownership cannot be proven.
    }
    return undefined;
  }
}

function releaseGate(path: string, token: string): void {
  try {
    if (readFileSync(join(path, "owner"), "utf8") === token) {
      rmSync(path, { recursive: true, force: true });
    }
  } catch {
    // Fail closed when gate ownership cannot be proven.
  }
}

function removeStaleLock(path: string): boolean {
  const gatePath = `${path}-gate`;
  const gateToken = tryAcquireGate(gatePath);
  if (!gateToken) return false;
  try {
    if (!existsSync(path)) return true;
    const age = Date.now() - statSync(path).mtimeMs;
    const ownerPath = join(path, "owner.json");
    const ownerContent = existsSync(ownerPath) ? readFileSync(ownerPath, "utf8") : "";
    const owner = parseLockOwner(ownerContent);
    if (
      owner ? age <= STALE_LOCK_MS || isProcessAlive(owner.pid) : age <= MALFORMED_STALE_LOCK_MS
    ) {
      return false;
    }

    const tombstone = `${path}.stale.${process.pid}.${randomUUID()}`;
    renameSync(path, tombstone);
    rmSync(tombstone, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  } finally {
    releaseGate(gatePath, gateToken);
  }
}

function releaseOwnedLock(path: string, token: string): void {
  try {
    const owner = parseLockOwner(readFileSync(join(path, "owner.json"), "utf8"));
    if (owner?.token === token) rmSync(path, { recursive: true, force: true });
  } catch {
    // Never remove a lock whose ownership cannot be proven.
  }
}

function waitForUnlocked(dir: string): void {
  const path = lockPath(dir);
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  while (existsSync(path)) {
    if (removeStaleLock(path)) continue;
    if (Date.now() >= deadline) {
      throw new TaskError("lock_timeout", `Timed out waiting for task lock ${path}`);
    }
    sleep(20);
  }
}

function withTaskLock<T>(dir: string, operation: () => T): T {
  ensureRelayDir(dir);
  const path = lockPath(dir);
  const token = randomUUID();
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  while (true) {
    const gatePath = `${path}-gate`;
    const gateToken = tryAcquireGate(gatePath);
    if (!gateToken) {
      if (Date.now() >= deadline) {
        throw new TaskError("lock_timeout", `Timed out acquiring task lock gate ${gatePath}`);
      }
      sleep(20);
      continue;
    }
    try {
      mkdirSync(path);
      try {
        writeFileSync(
          join(path, "owner.json"),
          `${JSON.stringify({ pid: process.pid, token, createdAt: new Date().toISOString() })}\n`,
          { flag: "wx" },
        );
      } catch (error) {
        rmSync(path, { recursive: true, force: true });
        throw error;
      }
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;
      if (Date.now() >= deadline) {
        throw new TaskError("lock_timeout", `Timed out acquiring task lock ${path}`);
      }
      sleep(20);
    } finally {
      releaseGate(gatePath, gateToken);
    }
    if (removeStaleLock(path)) continue;
  }

  try {
    return operation();
  } finally {
    releaseOwnedLock(path, token);
  }
}

function fsyncDirectory(path: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    fsyncSync(fd);
  } catch (error) {
    if (
      !["EINVAL", "ENOTSUP", "EBADF", "EISDIR", "EPERM"].includes(
        (error as NodeJS.ErrnoException).code ?? "",
      )
    ) {
      throw error;
    }
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function atomicWrite(dir: string, target: string, content: string): void {
  const tempDir = join(relayPath(dir), TEMP_DIR);
  mkdirSync(tempDir, { recursive: true });
  mkdirSync(dirname(target), { recursive: true });
  const temporary = join(tempDir, `${basename(target)}.${process.pid}.${randomUUID()}.tmp`);
  let fd: number | undefined;
  try {
    fd = openSync(temporary, "wx", 0o600);
    writeFileSync(fd, content, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, target);
    fsyncDirectory(dirname(target));
  } finally {
    if (fd !== undefined) closeSync(fd);
    rmSync(temporary, { force: true });
  }
}

function writeExclusiveDurable(path: string, content: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(path, "wx", 0o600);
    writeFileSync(fd, content, "utf8");
    fsyncSync(fd);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function storeState(dir: string): { v2: boolean; legacy: boolean } {
  return { v2: existsSync(tasksPath(dir)), legacy: existsSync(legacyPath(dir)) };
}

function assertUnambiguous(dir: string): { v2: boolean; legacy: boolean } {
  const state = storeState(dir);
  if (state.v2 && state.legacy) {
    throw new TaskError(
      "ambiguous_sources",
      `Both ${tasksPath(dir)} and ${legacyPath(dir)} exist; run \`relay tasks migrate --apply\` to verify and finish an interrupted migration`,
    );
  }
  return state;
}

function ensureWritableV2(dir: string): void {
  const state = storeState(dir);
  if (state.v2 && state.legacy) {
    throw new TaskError(
      "ambiguous_sources",
      "Cannot mutate tasks while both v1 and v2 task sources exist",
    );
  }
  if (state.legacy) {
    throw new TaskError(
      "legacy_requires_migration",
      "Legacy .relay/tasks.json is read-only; run `relay tasks migrate --dry-run`, then `relay tasks migrate --apply`",
    );
  }
  if (!state.v2) initializeV2(dir);
}

function initializeV2(dir: string): void {
  mkdirSync(tasksPath(dir), { recursive: true });
  atomicWrite(dir, join(tasksPath(dir), EMPTY_MARKER), "");
}

function cloneTask(task: Task): Task {
  return { ...task, tags: [...task.tags], blockedBy: [...task.blockedBy] };
}

function taskSort(a: Task, b: Task): number {
  return a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
}

function markdownFiles(path: string, sourceLabel: string): string[] {
  if (!existsSync(path)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (entry.name === EMPTY_MARKER || entry.name === ARCHIVE_DIR || entry.name.startsWith(".")) {
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(".md")) {
      throw new TaskError("validation", `${sourceLabel}: unexpected entry ${entry.name}`);
    }
    const id = entry.name.slice(0, -3);
    if (!isTaskId(id)) {
      throw new TaskError("validation", `${sourceLabel}: invalid task filename ${entry.name}`);
    }
    files.push(join(path, entry.name));
  }
  return files.sort();
}

function readTaskRecord(path: string, archived: boolean): StoredTaskRecord {
  const content = readFileSync(path, "utf8");
  const { task } = parseTaskFile(content, path, archived);
  const filenameId = basename(path, ".md");
  if (task.id !== filenameId) {
    throw new TaskError(
      "validation",
      `${path}: filename id does not match front matter id ${task.id}`,
    );
  }
  if (archived && task.status !== "done" && task.status !== "cancelled") {
    throw new TaskError(
      "validation",
      `${path}: archived tasks must have status done or cancelled; reopen through the task API`,
    );
  }
  return { task, path, content };
}

function readCurrentRecords(dir: string): StoredTaskRecord[] {
  return markdownFiles(tasksPath(dir), tasksPath(dir)).map((path) => readTaskRecord(path, false));
}

function readArchiveRecords(dir: string): StoredTaskRecord[] {
  return markdownFiles(archivePath(dir), archivePath(dir)).map((path) =>
    readTaskRecord(path, true),
  );
}

function readAllV2Records(dir: string): StoredTaskRecord[] {
  return [...readCurrentRecords(dir), ...readArchiveRecords(dir)];
}

function exactArchivedRecord(dir: string, id: string): StoredTaskRecord | undefined {
  const path = join(archivePath(dir), `${id}.md`);
  return existsSync(path) ? readTaskRecord(path, true) : undefined;
}

function exactV2Record(dir: string, id: string): StoredTaskRecord | undefined {
  const current = join(tasksPath(dir), `${id}.md`);
  const archived = join(archivePath(dir), `${id}.md`);
  if (existsSync(current) && existsSync(archived)) {
    throw new TaskError("validation", `Duplicate task id ${id}`);
  }
  if (existsSync(current)) return readTaskRecord(current, false);
  if (existsSync(archived)) return readTaskRecord(archived, true);
  return undefined;
}

function resolveRecordClosure(dir: string, root: StoredTaskRecord): StoredTaskRecord[] {
  const records = new Map([[root.task.id, root]]);
  const queue = [root.task.parent, ...root.task.blockedBy].filter(isTaskId);
  while (queue.length > 0) {
    const id = queue.pop()!;
    if (records.has(id)) continue;
    const record = exactV2Record(dir, id);
    if (!record)
      throw new TaskError("validation", `Task ${root.task.id} references missing task ${id}`);
    records.set(id, record);
    queue.push(...[record.task.parent, ...record.task.blockedBy].filter(isTaskId));
  }
  const result = [...records.values()];
  validateTaskGraph(result.map(({ task }) => task));
  return result;
}

function validateTaskGraph(tasks: Task[]): void {
  const byId = new Map<string, Task>();
  for (const task of tasks) {
    if (byId.has(task.id)) throw new TaskError("validation", `Duplicate task id ${task.id}`);
    byId.set(task.id, task);
  }

  for (const task of tasks) {
    if (task.parent !== null && !byId.has(task.parent)) {
      throw new TaskError("validation", `Task ${task.id} references missing parent ${task.parent}`);
    }
    for (const blocker of task.blockedBy) {
      if (!byId.has(blocker)) {
        throw new TaskError("validation", `Task ${task.id} references missing blocker ${blocker}`);
      }
    }
    if (task.status === "done") {
      const openChildren = tasks.filter(
        (child) =>
          child.parent === task.id && child.status !== "done" && child.status !== "cancelled",
      );
      if (openChildren.length > 0) {
        throw new TaskError(
          "validation",
          `Done task ${task.id} has open children: ${openChildren.map((child) => child.id).join(", ")}`,
        );
      }
    }
  }

  assertAcyclic(tasks, "parent", (task) => (task.parent === null ? [] : [task.parent]));
  assertAcyclic(tasks, "blocker", (task) => task.blockedBy);
}

function assertAcyclic(tasks: Task[], label: string, edges: (task: Task) => string[]): void {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string, path: string[]): void => {
    if (visiting.has(id)) {
      const start = path.indexOf(id);
      throw new TaskError(
        "validation",
        `${label} cycle: ${[...path.slice(start), id].join(" -> ")}`,
      );
    }
    if (visited.has(id)) return;
    const task = byId.get(id);
    if (!task) return;
    visiting.add(id);
    for (const next of edges(task)) visit(next, [...path, id]);
    visiting.delete(id);
    visited.add(id);
  };
  for (const task of tasks) visit(task.id, []);
}

function deriveBlocked(tasks: Task[], referenceTasks: Task[] = tasks): Task[] {
  const byId = new Map(referenceTasks.map((task) => [task.id, task]));
  return tasks.map((original) => {
    const task = cloneTask(original);
    if (task.status === "done" || task.status === "cancelled") return task;
    if (task.blockedBy.some((id) => byId.get(id)?.status !== "done")) task.status = "blocked";
    return task;
  });
}

function readV2ForList(dir: string, includeArchived: boolean): Task[] {
  if (includeArchived) {
    const records = readAllV2Records(dir);
    validateTaskGraph(records.map(({ task }) => task));
    return deriveBlocked(records.map(({ task }) => task)).sort(taskSort);
  }

  const current = readCurrentRecords(dir);
  const records = new Map(current.map((record) => [record.task.id, record]));
  for (const record of current) {
    if (existsSync(join(archivePath(dir), `${record.task.id}.md`))) {
      throw new TaskError(
        "validation",
        `Duplicate task id ${record.task.id} across current and archive`,
      );
    }
  }
  const queue = current.flatMap(({ task }) => [task.parent, ...task.blockedBy]).filter(isTaskId);
  while (queue.length > 0) {
    const id = queue.pop()!;
    if (records.has(id)) continue;
    const dependency = exactArchivedRecord(dir, id);
    if (!dependency) {
      throw new TaskError("validation", `Current tasks reference missing task ${id}`);
    }
    records.set(id, dependency);
    queue.push(...[dependency.task.parent, ...dependency.task.blockedBy].filter(isTaskId));
  }
  validateTaskGraph([...records.values()].map(({ task }) => task));
  return deriveBlocked(
    current.map(({ task }) => task),
    [...records.values()].map(({ task }) => task),
  ).sort(taskSort);
}

function legacyTask(raw: unknown, index: number, source: string): Task {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new TaskError("validation", `${source}: task ${index} must be an object`);
  }
  const value = raw as Record<string, unknown>;
  const required = [
    "id",
    "title",
    "description",
    "status",
    "priority",
    "type",
    "tags",
    "parent",
    "blockedBy",
    "createdAt",
    "updatedAt",
  ];
  const unknown = Object.keys(value).filter((key) => !required.includes(key));
  const missing = required.filter((key) => !(key in value));
  if (unknown.length > 0 || missing.length > 0) {
    throw new TaskError(
      "validation",
      `${source}: task ${index} has ${
        unknown.length
          ? `unknown fields ${unknown.join(", ")}`
          : `missing fields ${missing.join(", ")}`
      }`,
    );
  }
  if (!isTaskId(value.id)) {
    throw new TaskError("validation", `${source}: task ${index} has invalid id`);
  }
  if (typeof value.title !== "string" || value.title.trim() === "") {
    throw new TaskError("validation", `${source}: task ${value.id} has invalid title`);
  }
  if (typeof value.description !== "string") {
    throw new TaskError("validation", `${source}: task ${value.id} has invalid description`);
  }
  if (!isStoredTaskStatus(value.status)) {
    throw new TaskError("validation", `${source}: task ${value.id} has invalid status`);
  }
  if (
    !Number.isInteger(value.priority) ||
    (value.priority as number) < 0 ||
    (value.priority as number) > 4
  ) {
    throw new TaskError("validation", `${source}: task ${value.id} has invalid priority`);
  }
  if (!isTaskType(value.type)) {
    throw new TaskError("validation", `${source}: task ${value.id} has invalid type`);
  }
  if (!Array.isArray(value.tags) || value.tags.some((tag) => typeof tag !== "string")) {
    throw new TaskError("validation", `${source}: task ${value.id} has invalid tags`);
  }
  if (new Set(value.tags).size !== value.tags.length) {
    throw new TaskError("validation", `${source}: task ${value.id} has duplicate tags`);
  }
  if (value.parent !== null && !isTaskId(value.parent)) {
    throw new TaskError("validation", `${source}: task ${value.id} has invalid parent`);
  }
  if (!Array.isArray(value.blockedBy) || value.blockedBy.some((id) => !isTaskId(id))) {
    throw new TaskError("validation", `${source}: task ${value.id} has invalid blockedBy`);
  }
  if (new Set(value.blockedBy).size !== value.blockedBy.length) {
    throw new TaskError("validation", `${source}: task ${value.id} has duplicate blockers`);
  }
  if (typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt))) {
    throw new TaskError("validation", `${source}: task ${value.id} has invalid createdAt`);
  }
  if (typeof value.updatedAt !== "string" || !Number.isFinite(Date.parse(value.updatedAt))) {
    throw new TaskError("validation", `${source}: task ${value.id} has invalid updatedAt`);
  }
  return {
    id: value.id,
    title: value.title,
    description: value.description,
    status: value.status,
    priority: value.priority as number,
    type: value.type,
    tags: [...(value.tags as string[])],
    parent: value.parent as string | null,
    blockedBy: [...(value.blockedBy as string[])],
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    closedAt: null,
    revision: revisionFor(JSON.stringify(value)),
    archived: false,
  };
}

function readLegacyTasks(dir: string, deriveStatus = true): Task[] {
  const source = legacyPath(dir);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(source, "utf8"));
  } catch (error) {
    throw new TaskError("validation", `${source}: invalid JSON`, { cause: error });
  }
  let values: unknown[];
  if (Array.isArray(parsed)) {
    values = parsed;
  } else if (parsed && typeof parsed === "object") {
    const snapshot = parsed as Partial<LegacyTaskSnapshot>;
    if (snapshot.version !== 1 || !Array.isArray(snapshot.tasks)) {
      throw new TaskError("validation", `${source}: expected version 1 task snapshot`);
    }
    values = snapshot.tasks;
  } else {
    throw new TaskError("validation", `${source}: expected a task array or version 1 snapshot`);
  }
  const tasks = values.map((value, index) => legacyTask(value, index, source));
  validateTaskGraph(tasks);
  return (deriveStatus ? deriveBlocked(tasks) : tasks).sort(taskSort);
}

function storedTask(task: Task): Omit<Task, "revision" | "archived"> {
  const { revision: _revision, archived: _archived, ...stored } = task;
  return stored;
}

function writeTask(dir: string, task: Task, archived: boolean): StoredTaskRecord {
  const path = join(archived ? archivePath(dir) : tasksPath(dir), `${task.id}.md`);
  const content = serializeTask(storedTask(task));
  atomicWrite(dir, path, content);
  return {
    task: { ...cloneTask(task), revision: revisionFor(content), archived },
    path,
    content,
  };
}

function findRecord(records: StoredTaskRecord[], id: string): StoredTaskRecord | undefined {
  return records.find(({ task }) => task.id === id);
}

function assertExpectedRevision(record: StoredTaskRecord, expectedRevision?: string): void {
  if (expectedRevision !== undefined && record.task.revision !== expectedRevision) {
    throw new TaskError(
      "conflict",
      `Task ${record.task.id} changed (expected revision ${expectedRevision}, found ${record.task.revision})`,
    );
  }
}

function validateProspectiveTasks(tasks: Task[]): void {
  for (const task of tasks) {
    const content = serializeTask(storedTask(task));
    parseTaskFile(content, `task ${task.id}`, task.archived);
  }
  validateTaskGraph(tasks);
}

function assertStringArray(value: unknown, field: string): asserts value is string[] {
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== "string") ||
    new Set(value).size !== value.length
  ) {
    throw new TaskError("validation", `${field} must be an array of unique strings`);
  }
}

function assertTaskReference(value: unknown, field: string, nullable: boolean): void {
  if (nullable && value === null) return;
  if (!isTaskId(value)) throw new TaskError("validation", `${field} must be a valid task id`);
}

function validateCreateInput(input: CreateTaskInput): void {
  if (typeof input.title !== "string" || input.title.trim() === "") {
    throw new TaskError("validation", "title must be a non-empty string");
  }
  if (input.description !== undefined && typeof input.description !== "string") {
    throw new TaskError("validation", "description must be a string");
  }
  if (
    input.priority !== undefined &&
    (!Number.isInteger(input.priority) || input.priority < 0 || input.priority > 4)
  ) {
    throw new TaskError("validation", "priority must be an integer from 0 through 4");
  }
  if (input.type !== undefined && !isTaskType(input.type)) {
    throw new TaskError("validation", "type must be epic, task, or bug");
  }
  if (input.tags !== undefined) assertStringArray(input.tags, "tags");
  if (input.parent !== undefined) assertTaskReference(input.parent, "parent", true);
  if (input.blockedBy !== undefined) {
    assertStringArray(input.blockedBy, "blockedBy");
    for (const id of input.blockedBy) assertTaskReference(id, "blockedBy entry", false);
  }
}

function validateUpdateInput(patch: UpdateTaskInput): void {
  if (patch.title !== undefined && (typeof patch.title !== "string" || patch.title.trim() === "")) {
    throw new TaskError("validation", "title must be a non-empty string");
  }
  if (patch.description !== undefined && typeof patch.description !== "string") {
    throw new TaskError("validation", "description must be a string");
  }
  if (
    patch.status !== undefined &&
    patch.status !== "blocked" &&
    !isStoredTaskStatus(patch.status)
  ) {
    throw new TaskError("validation", "status must be open, in_progress, done, or cancelled");
  }
  if (
    patch.priority !== undefined &&
    (!Number.isInteger(patch.priority) || patch.priority < 0 || patch.priority > 4)
  ) {
    throw new TaskError("validation", "priority must be an integer from 0 through 4");
  }
  if (patch.type !== undefined && !isTaskType(patch.type)) {
    throw new TaskError("validation", "type must be epic, task, or bug");
  }
  if (patch.tags !== undefined) assertStringArray(patch.tags, "tags");
  if (patch.parent !== undefined) assertTaskReference(patch.parent, "parent", true);
  if (patch.blockedBy !== undefined) {
    assertStringArray(patch.blockedBy, "blockedBy");
    for (const id of patch.blockedBy) assertTaskReference(id, "blockedBy entry", false);
  }
  if (patch.expectedRevision !== undefined && typeof patch.expectedRevision !== "string") {
    throw new TaskError("validation", "expectedRevision must be a string");
  }
}

function uniqueUuid(taken: ReadonlySet<string>): string {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const id = randomUUID();
    if (!taken.has(id)) return id;
  }
  throw new TaskError("conflict", "Could not allocate a unique task identifier");
}

export function hasTasks(dir: string): boolean {
  const state = storeState(dir);
  return state.v2 || state.legacy;
}

export function initTasks(dir: string): void {
  withTaskLock(dir, () => {
    const state = storeState(dir);
    if (state.v2 && state.legacy) {
      throw new TaskError("ambiguous_sources", "Both v1 and v2 task stores exist");
    }
    if (state.legacy || state.v2) return;
    initializeV2(dir);
  });
}

export function loadTasks(dir: string, options: LoadTasksOptions = {}): Task[] {
  waitForUnlocked(dir);
  const state = assertUnambiguous(dir);
  if (state.v2) return readV2ForList(dir, options.includeArchived ?? false);
  if (state.legacy) return readLegacyTasks(dir);
  return [];
}

export function getTask(dir: string, id: string): Task | undefined {
  if (!isTaskId(id)) throw new TaskError("validation", `Invalid task id ${id}`);
  waitForUnlocked(dir);
  const state = assertUnambiguous(dir);
  if (state.legacy) return readLegacyTasks(dir).find((task) => task.id === id);
  if (!state.v2) return undefined;
  const record = exactV2Record(dir, id);
  if (!record) return undefined;
  const closure = resolveRecordClosure(dir, record);
  return deriveBlocked(
    [record.task],
    closure.map(({ task }) => task),
  )[0];
}

export function createTask(dir: string, input: CreateTaskInput): Task {
  validateCreateInput(input);
  return withTaskLock(dir, () => {
    ensureWritableV2(dir);
    const records = readAllV2Records(dir);
    const now = new Date().toISOString();
    const task: Task = {
      id: uniqueUuid(new Set(records.map(({ task: existing }) => existing.id))),
      title: input.title,
      description: input.description ?? "",
      status: "open",
      priority: input.priority ?? 2,
      type: input.type ?? "task",
      tags: input.tags ? [...input.tags] : [],
      parent: input.parent ?? null,
      blockedBy: input.blockedBy ? [...input.blockedBy] : [],
      createdAt: now,
      updatedAt: now,
      closedAt: null,
      revision: "",
      archived: false,
    };
    validateProspectiveTasks([...records.map(({ task: existing }) => existing), task]);
    return deriveBlocked(
      [writeTask(dir, task, false).task],
      [...records.map(({ task: existing }) => existing), task],
    )[0]!;
  });
}

export function updateTask(dir: string, taskId: string, patch: UpdateTaskInput): Task {
  if (!isTaskId(taskId)) throw new TaskError("validation", `Invalid task id ${taskId}`);
  validateUpdateInput(patch);
  return withTaskLock(dir, () => {
    ensureWritableV2(dir);
    const records = readAllV2Records(dir);
    const record = findRecord(records, taskId);
    if (!record) throw new TaskError("not_found", `Task ${taskId} not found`);
    assertExpectedRevision(record, patch.expectedRevision);
    if (patch.status === "blocked") {
      throw new TaskError("validation", "blocked is a derived status and cannot be stored");
    }

    const previous = record.task;
    const nextStatus = patch.status ?? (previous.status === "blocked" ? "open" : previous.status);
    if (nextStatus === "done") {
      const openChildren = records
        .map(({ task }) => task)
        .filter(
          (task) => task.parent === taskId && task.status !== "done" && task.status !== "cancelled",
        );
      if (openChildren.length > 0) {
        const names = openChildren.map((child) => `${child.id} ("${child.title}")`).join(", ");
        throw new TaskError(
          "validation",
          `Cannot complete task ${taskId}: open children must be addressed first: ${names}`,
        );
      }
    }

    const wasTerminal = previous.status === "done" || previous.status === "cancelled";
    const isTerminal = nextStatus === "done" || nextStatus === "cancelled";
    const now = new Date().toISOString();
    const next: Task = {
      ...cloneTask(previous),
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.description !== undefined ? { description: patch.description } : {}),
      status: nextStatus,
      ...(patch.priority !== undefined ? { priority: patch.priority } : {}),
      ...(patch.type !== undefined ? { type: patch.type } : {}),
      ...(patch.tags !== undefined ? { tags: [...patch.tags] } : {}),
      ...(patch.parent !== undefined ? { parent: patch.parent } : {}),
      ...(patch.blockedBy !== undefined ? { blockedBy: [...patch.blockedBy] } : {}),
      updatedAt: now,
      closedAt: isTerminal ? (wasTerminal ? previous.closedAt : now) : null,
      archived: previous.archived && isTerminal,
    };
    const prospective = records.map(({ task }) => (task.id === taskId ? next : task));
    validateProspectiveTasks(prospective);

    const written = writeTask(dir, next, next.archived);
    if (record.path !== written.path) {
      unlinkSync(record.path);
      fsyncDirectory(dirname(record.path));
    }
    return deriveBlocked([written.task], prospective)[0]!;
  });
}

export function deleteTask(dir: string, taskId: string, expectedRevision?: string): void {
  if (!isTaskId(taskId)) throw new TaskError("validation", `Invalid task id ${taskId}`);
  withTaskLock(dir, () => {
    ensureWritableV2(dir);
    const records = readAllV2Records(dir);
    const record = findRecord(records, taskId);
    if (!record) throw new TaskError("not_found", `Task ${taskId} not found`);
    assertExpectedRevision(record, expectedRevision);
    const incoming = records.filter(
      ({ task }) => task.parent === taskId || task.blockedBy.includes(taskId),
    );
    if (incoming.length > 0) {
      throw new TaskError(
        "validation",
        `Cannot delete task ${taskId}: referenced by ${incoming.map(({ task }) => task.id).join(", ")}`,
      );
    }
    const commentsDir = join(discussionPath(dir), taskId);
    if (existsSync(commentsDir) && markdownFiles(commentsDir, commentsDir).length > 0) {
      throw new TaskError(
        "validation",
        `Cannot delete task ${taskId}: task has discussion comments`,
      );
    }
    unlinkSync(record.path);
    fsyncDirectory(dirname(record.path));
  });
}

function readComments(dir: string, taskId: string): TaskComment[] {
  const path = join(discussionPath(dir), taskId);
  if (!existsSync(path)) return [];
  const comments = markdownFiles(path, path).map((file) => {
    const content = readFileSync(file, "utf8");
    const { comment } = parseCommentFile(content, file);
    if (basename(file, ".md") !== comment.id) {
      throw new TaskError("validation", `${file}: filename does not match comment id`);
    }
    if (comment.taskId !== taskId) {
      throw new TaskError("validation", `${file}: taskId does not match discussion directory`);
    }
    return comment;
  });
  const byId = new Set<string>();
  for (const comment of comments) {
    if (byId.has(comment.id)) {
      throw new TaskError("validation", `Duplicate comment id ${comment.id}`);
    }
    byId.add(comment.id);
  }
  for (const comment of comments) {
    if (comment.replyTo !== null && !byId.has(comment.replyTo)) {
      throw new TaskError(
        "validation",
        `Comment ${comment.id} replies to missing comment ${comment.replyTo}`,
      );
    }
  }
  return comments.sort(
    (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
  );
}

export function listTaskComments(dir: string, taskId: string): TaskComment[] {
  if (!isTaskId(taskId)) throw new TaskError("validation", `Invalid task id ${taskId}`);
  waitForUnlocked(dir);
  assertUnambiguous(dir);
  if (!getTask(dir, taskId)) throw new TaskError("not_found", `Task ${taskId} not found`);
  return readComments(dir, taskId);
}

export function addTaskComment(
  dir: string,
  taskId: string,
  input: AddTaskCommentInput,
): TaskComment {
  if (!isTaskId(taskId)) throw new TaskError("validation", `Invalid task id ${taskId}`);
  return withTaskLock(dir, () => {
    ensureWritableV2(dir);
    const records = readAllV2Records(dir);
    if (!findRecord(records, taskId)) {
      throw new TaskError("not_found", `Task ${taskId} not found`);
    }
    if (typeof input.body !== "string" || input.body.trim() === "") {
      throw new TaskError("validation", "Comment body is required");
    }
    const comments = readComments(dir, taskId);
    if (input.replyTo !== undefined && !comments.some((comment) => comment.id === input.replyTo)) {
      throw new TaskError(
        "validation",
        `Reply target ${input.replyTo} not found on task ${taskId}`,
      );
    }
    const comment: TaskComment = {
      id: uniqueUuid(new Set(comments.map((comment) => comment.id))),
      taskId,
      body: input.body,
      author: input.author?.trim() || null,
      replyTo: input.replyTo ?? null,
      createdAt: new Date().toISOString(),
    };
    const path = join(discussionPath(dir), taskId, `${comment.id}.md`);
    atomicWrite(dir, path, serializeComment(comment));
    return comment;
  });
}

function validateComments(dir: string, taskIds: Set<string>): number {
  const root = discussionPath(dir);
  if (!existsSync(root)) return 0;
  let count = 0;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.name === EMPTY_MARKER || entry.name.startsWith(".")) continue;
    if (!entry.isDirectory() || !isTaskId(entry.name)) {
      throw new TaskError("validation", `${root}: invalid discussion entry ${entry.name}`);
    }
    if (!taskIds.has(entry.name)) {
      throw new TaskError("validation", `${root}: comments reference missing task ${entry.name}`);
    }
    count += readComments(dir, entry.name).length;
  }
  return count;
}

export function validateTasks(dir: string): TaskValidationResult {
  try {
    waitForUnlocked(dir);
    const state = assertUnambiguous(dir);
    const tasks = state.v2
      ? readAllV2Records(dir).map(({ task }) => task)
      : state.legacy
        ? readLegacyTasks(dir)
        : [];
    validateTaskGraph(tasks);
    const commentCount = state.v2
      ? validateComments(dir, new Set(tasks.map((task) => task.id)))
      : 0;
    return { valid: true, errors: [], taskCount: tasks.length, commentCount };
  } catch (error) {
    return {
      valid: false,
      errors: [error instanceof Error ? error.message : String(error)],
      taskCount: 0,
      commentCount: 0,
    };
  }
}

export function archiveTasks(dir: string, options: { days?: number } = {}): ArchiveTasksResult {
  return withTaskLock(dir, () => {
    ensureWritableV2(dir);
    const days = options.days ?? DEFAULT_ARCHIVE_DAYS;
    if (!Number.isFinite(days) || days < 0) {
      throw new TaskError("validation", "Archive days must be a non-negative number");
    }
    const records = readAllV2Records(dir);
    validateTaskGraph(records.map(({ task }) => task));
    const cutoff = Date.now() - days * 86_400_000;
    const moved: Task[] = [];
    for (const record of records) {
      const task = record.task;
      if (task.archived || (task.status !== "done" && task.status !== "cancelled")) continue;
      const terminalAt = task.closedAt ?? task.updatedAt;
      if (Date.parse(terminalAt) > cutoff) continue;
      mkdirSync(archivePath(dir), { recursive: true });
      const target = join(archivePath(dir), `${task.id}.md`);
      if (existsSync(target)) {
        throw new TaskError("validation", `Archive already contains task ${task.id}`);
      }
      renameSync(record.path, target);
      moved.push({ ...cloneTask(task), archived: true });
    }
    if (moved.length > 0) {
      fsyncDirectory(tasksPath(dir));
      fsyncDirectory(archivePath(dir));
    }
    return { archived: moved.sort(taskSort) };
  });
}

function canonicalComment(content: string, path: string): string {
  return serializeComment(parseCommentFile(content, path).comment);
}

export function formatTasks(dir: string, options: { check?: boolean } = {}): FormatTasksResult {
  return withTaskLock(dir, () => {
    const state = storeState(dir);
    if (state.v2 && state.legacy) {
      throw new TaskError("ambiguous_sources", "Cannot format ambiguous task sources");
    }
    if (state.legacy) {
      throw new TaskError("legacy_requires_migration", "Migrate legacy tasks before formatting");
    }
    if (!state.v2) return { changed: [] };
    const records = readAllV2Records(dir);
    validateTaskGraph(records.map(({ task }) => task));
    validateComments(dir, new Set(records.map(({ task }) => task.id)));
    const changes: Array<{ path: string; content: string }> = [];
    for (const record of records) {
      const canonical = serializeTask(storedTask(record.task));
      if (canonical !== record.content) changes.push({ path: record.path, content: canonical });
    }
    const discussionRoot = discussionPath(dir);
    if (existsSync(discussionRoot)) {
      for (const taskEntry of readdirSync(discussionRoot, { withFileTypes: true })) {
        if (!taskEntry.isDirectory() || !isTaskId(taskEntry.name)) continue;
        const taskDiscussion = join(discussionRoot, taskEntry.name);
        for (const path of markdownFiles(taskDiscussion, taskDiscussion)) {
          const content = readFileSync(path, "utf8");
          const canonical = canonicalComment(content, path);
          if (canonical !== content) changes.push({ path, content: canonical });
        }
      }
    }
    if (!options.check) {
      for (const change of changes) atomicWrite(dir, change.path, change.content);
    }
    return { changed: changes.map((change) => change.path) };
  });
}

function migratedTask(task: Task): Task {
  return {
    ...cloneTask(task),
    archived: task.status === "done" || task.status === "cancelled",
  };
}

function comparableTask(value: Task): Omit<Task, "revision"> {
  const { revision: _revision, ...rest } = value;
  return rest;
}

function sameMigratedTasks(legacy: Task[], v2: Task[]): boolean {
  if (legacy.length !== v2.length) return false;
  const expected = new Map(legacy.map((task) => [task.id, migratedTask(task)]));
  return v2.every((task) => {
    const match = expected.get(task.id);
    return (
      match !== undefined &&
      JSON.stringify(comparableTask(task)) === JSON.stringify(comparableTask(match))
    );
  });
}

export function migrateTasks(dir: string, options: { dryRun?: boolean } = {}): MigrateTasksResult {
  return withTaskLock(dir, () => {
    const dryRun = options.dryRun ?? false;
    const state = storeState(dir);
    if (!state.legacy) {
      if (!state.v2) {
        throw new TaskError("not_found", "No legacy .relay/tasks.json exists to migrate");
      }
      const tasks = readAllV2Records(dir).map(({ task }) => task);
      validateTaskGraph(tasks);
      return {
        dryRun,
        alreadyMigrated: true,
        taskCount: tasks.length,
        currentCount: tasks.filter((task) => !task.archived).length,
        archivedCount: tasks.filter((task) => task.archived).length,
      };
    }

    const sourcePath = legacyPath(dir);
    const sourceContent = readFileSync(sourcePath, "utf8");
    const legacy = readLegacyTasks(dir, false);
    const migrated = legacy.map(migratedTask);
    if (state.v2) {
      const existing = readAllV2Records(dir).map(({ task }) => task);
      validateTaskGraph(existing);
      if (!sameMigratedTasks(legacy, existing)) {
        throw new TaskError(
          "ambiguous_sources",
          "Existing v2 task files do not match the legacy snapshot; resolve or remove one source manually",
        );
      }
      if (!dryRun) {
        if (readFileSync(sourcePath, "utf8") !== sourceContent) {
          throw new TaskError("conflict", "Legacy task snapshot changed during migration");
        }
        unlinkSync(sourcePath);
        fsyncDirectory(relayPath(dir));
      }
      return {
        dryRun,
        alreadyMigrated: false,
        taskCount: migrated.length,
        currentCount: migrated.filter((task) => !task.archived).length,
        archivedCount: migrated.filter((task) => task.archived).length,
      };
    }

    for (const task of migrated) {
      const content = serializeTask(storedTask(task));
      const roundTrip = parseTaskFile(content, `migrated task ${task.id}`, task.archived).task;
      if (!sameMigratedTasks([task], [roundTrip])) {
        throw new TaskError("validation", `Migration round-trip failed for task ${task.id}`);
      }
    }
    const result: MigrateTasksResult = {
      dryRun,
      alreadyMigrated: false,
      taskCount: migrated.length,
      currentCount: migrated.filter((task) => !task.archived).length,
      archivedCount: migrated.filter((task) => task.archived).length,
    };
    if (dryRun) return result;

    const staging = join(relayPath(dir), `.tasks-migrate-${randomUUID()}`);
    try {
      mkdirSync(join(staging, ARCHIVE_DIR), { recursive: true });
      writeExclusiveDurable(join(staging, EMPTY_MARKER), "");
      for (const task of migrated) {
        const target = join(task.archived ? join(staging, ARCHIVE_DIR) : staging, `${task.id}.md`);
        writeExclusiveDurable(target, serializeTask(storedTask(task)));
      }
      fsyncDirectory(join(staging, ARCHIVE_DIR));
      fsyncDirectory(staging);
      const staged = [
        ...markdownFiles(staging, staging).map((path) => readTaskRecord(path, false).task),
        ...markdownFiles(join(staging, ARCHIVE_DIR), join(staging, ARCHIVE_DIR)).map(
          (path) => readTaskRecord(path, true).task,
        ),
      ];
      validateTaskGraph(staged);
      if (!sameMigratedTasks(legacy, staged)) {
        throw new TaskError("validation", "Staged migration does not match legacy task data");
      }
      if (readFileSync(sourcePath, "utf8") !== sourceContent) {
        throw new TaskError("conflict", "Legacy task snapshot changed during migration");
      }
      renameSync(staging, tasksPath(dir));
      fsyncDirectory(relayPath(dir));
      unlinkSync(sourcePath);
      fsyncDirectory(relayPath(dir));
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
    return result;
  });
}

export const TASKS_CLAUDE_MD_SNIPPET = `## Tasks

Tasks are stored as tracked Markdown files under \`.relay/tasks/\` in the current worktree. Use \`relay tasks list --ready\` to find available work and the offline \`relay tasks\` commands to read or update it. Do not create a task for every request. Create a task only when explicitly asked, pick up an existing task when explicitly asked or when the request clearly matches one, and otherwise just do the work without creating a new task. If unsure whether a request should map to a task, ask.`;
