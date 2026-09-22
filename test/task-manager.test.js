import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  TaskError,
  addTaskComment,
  archiveTasks,
  createTask,
  deleteTask,
  formatTasks,
  getTask,
  hasTasks,
  initTasks,
  listTaskComments,
  loadTasks,
  migrateTasks,
  updateTask,
  validateTasks,
} from "../dist/server/core/task-manager.js";
import { parseTaskFile, serializeTask } from "../dist/server/core/task-files.js";

const LEGACY_ID = "a1b2c3d4";
const ISO = "2026-01-02T03:04:05.000Z";

function legacyTask(overrides = {}) {
  return {
    id: LEGACY_ID,
    title: "Legacy task",
    description: "Keep this description exactly.",
    status: "open",
    priority: 2,
    type: "task",
    tags: ["storage"],
    parent: null,
    blockedBy: [],
    createdAt: ISO,
    updatedAt: ISO,
    ...overrides,
  };
}

function writeLegacy(dir, tasks) {
  mkdirSync(join(dir, ".relay"), { recursive: true });
  writeFileSync(join(dir, ".relay", "tasks.json"), `${JSON.stringify({ version: 1, tasks })}\n`);
}

function expectTaskError(code) {
  return (error) => error instanceof TaskError && error.code === code;
}

describe("task-manager Markdown storage", () => {
  let projectDir;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), "relay-task-manager-"));
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  it("initializes an empty task directory and creates UUID task files", () => {
    assert.equal(hasTasks(projectDir), false);
    initTasks(projectDir);
    assert.equal(hasTasks(projectDir), true);
    assert.deepEqual(loadTasks(projectDir), []);
    assert.equal(existsSync(join(projectDir, ".relay", "tasks", ".gitkeep")), true);

    const task = createTask(projectDir, {
      title: "Write files",
      description: "First paragraph.\n\nSecond paragraph.",
      priority: 0,
      tags: ["core"],
    });
    assert.match(task.id, /^[a-f0-9-]{36}$/);
    assert.equal(task.archived, false);
    assert.match(task.revision, /^[a-f0-9]{64}$/);
    const path = join(projectDir, ".relay", "tasks", `${task.id}.md`);
    const content = readFileSync(path, "utf8");
    assert.match(content, /^---\nversion: 2\nid: "/);
    assert.match(content, /---\nFirst paragraph\.\n\nSecond paragraph\.\n$/);
    assert.deepEqual(parseTaskFile(content, path, false).task, task);
    assert.deepEqual(formatTasks(projectDir, { check: true }), { changed: [] });
  });

  it("reads strict legacy snapshots but rejects writes before explicit migration", () => {
    writeLegacy(projectDir, [legacyTask()]);
    const [task] = loadTasks(projectDir);
    assert.equal(task.id, LEGACY_ID);
    assert.equal(task.closedAt, null);
    assert.equal(task.archived, false);
    assert.match(task.revision, /^[a-f0-9]{64}$/);
    assert.throws(
      () => createTask(projectDir, { title: "No" }),
      expectTaskError("legacy_requires_migration"),
    );
    assert.throws(
      () => updateTask(projectDir, LEGACY_ID, { title: "No" }),
      expectTaskError("legacy_requires_migration"),
    );
  });

  it("migrates without changing IDs or fields, archives terminal records, and is idempotent", () => {
    const done = legacyTask({
      id: "deadbeef",
      title: "Finished",
      status: "done",
      priority: 0,
      type: "bug",
      tags: ["one", "two"],
      parent: LEGACY_ID,
    });
    writeLegacy(projectDir, [legacyTask(), done]);
    assert.deepEqual(migrateTasks(projectDir, { dryRun: true }), {
      dryRun: true,
      alreadyMigrated: false,
      taskCount: 2,
      currentCount: 1,
      archivedCount: 1,
    });
    assert.equal(existsSync(join(projectDir, ".relay", "tasks.json")), true);

    const result = migrateTasks(projectDir);
    assert.equal(result.taskCount, 2);
    assert.equal(existsSync(join(projectDir, ".relay", "tasks.json")), false);
    assert.equal(existsSync(join(projectDir, ".relay", "tasks", `${LEGACY_ID}.md`)), true);
    assert.equal(existsSync(join(projectDir, ".relay", "tasks", "archive", "deadbeef.md")), true);
    const migrated = loadTasks(projectDir, { includeArchived: true });
    const migratedDone = migrated.find((task) => task.id === "deadbeef");
    assert.equal(migratedDone.archived, true);
    assert.equal(migratedDone.closedAt, null);
    assert.equal(migratedDone.title, done.title);
    assert.deepEqual(migratedDone.tags, done.tags);
    assert.deepEqual(migrateTasks(projectDir), {
      dryRun: false,
      alreadyMigrated: true,
      taskCount: 2,
      currentCount: 1,
      archivedCount: 1,
    });
  });

  it("refuses a mismatched dual-source migration", () => {
    writeLegacy(projectDir, [legacyTask()]);
    mkdirSync(join(projectDir, ".relay", "tasks"), { recursive: true });
    const other = {
      ...legacyTask({ title: "Different" }),
      closedAt: null,
      revision: "",
      archived: false,
    };
    writeFileSync(join(projectDir, ".relay", "tasks", `${LEGACY_ID}.md`), serializeTask(other));
    assert.throws(() => loadTasks(projectDir), expectTaskError("ambiguous_sources"));
    assert.throws(() => migrateTasks(projectDir), expectTaskError("ambiguous_sources"));
    assert.equal(existsSync(join(projectDir, ".relay", "tasks.json")), true);
  });

  it("derives blocked status and keeps cancelled or missing work from becoming ready", () => {
    const blocker = createTask(projectDir, { title: "Blocker" });
    const dependent = createTask(projectDir, { title: "Dependent", blockedBy: [blocker.id] });
    assert.equal(getTask(projectDir, dependent.id).status, "blocked");
    assert.equal(loadTasks(projectDir).find((task) => task.id === dependent.id).status, "blocked");

    updateTask(projectDir, blocker.id, { status: "cancelled" });
    assert.equal(loadTasks(projectDir).find((task) => task.id === dependent.id).status, "blocked");
    updateTask(projectDir, blocker.id, { status: "done" });
    assert.equal(loadTasks(projectDir).find((task) => task.id === dependent.id).status, "open");

    const path = join(projectDir, ".relay", "tasks", `${dependent.id}.md`);
    const content = readFileSync(path, "utf8").replace(blocker.id, "feedface");
    writeFileSync(path, content);
    assert.equal(validateTasks(projectDir).valid, false);
    assert.throws(() => loadTasks(projectDir), /missing task feedface/);
  });

  it("detects duplicate IDs, dangling references, parent cycles, and blocker cycles", () => {
    const first = createTask(projectDir, { title: "First" });
    const second = createTask(projectDir, { title: "Second", parent: first.id });
    assert.throws(() => updateTask(projectDir, first.id, { parent: second.id }), /parent cycle/);
    updateTask(projectDir, second.id, { blockedBy: [first.id] });
    assert.throws(
      () => updateTask(projectDir, first.id, { blockedBy: [second.id] }),
      /blocker cycle/,
    );

    mkdirSync(join(projectDir, ".relay", "tasks", "archive"), { recursive: true });
    writeFileSync(
      join(projectDir, ".relay", "tasks", "archive", `${first.id}.md`),
      readFileSync(join(projectDir, ".relay", "tasks", `${first.id}.md`), "utf8"),
    );
    assert.equal(validateTasks(projectDir).valid, false);
    assert.throws(() => loadTasks(projectDir), /Duplicate task id/);
  });

  it("preserves corrupt input and refuses to overwrite it", () => {
    const task = createTask(projectDir, { title: "Original" });
    const path = join(projectDir, ".relay", "tasks", `${task.id}.md`);
    const corrupt = readFileSync(path, "utf8").replace("version: 2", "version: nope");
    writeFileSync(path, corrupt);
    assert.throws(
      () => updateTask(projectDir, task.id, { title: "Changed" }),
      expectTaskError("validation"),
    );
    assert.equal(readFileSync(path, "utf8"), corrupt);
  });

  it("enforces optimistic revisions and preserves description text on state updates", () => {
    const task = createTask(projectDir, { title: "Concurrent", description: "A\n\n- B" });
    const updated = updateTask(projectDir, task.id, {
      priority: 1,
      expectedRevision: task.revision,
    });
    assert.notEqual(updated.revision, task.revision);
    assert.equal(updated.description, task.description);
    assert.throws(
      () => updateTask(projectDir, task.id, { title: "Stale", expectedRevision: task.revision }),
      expectTaskError("conflict"),
    );
    assert.equal(getTask(projectDir, task.id).title, "Concurrent");
  });

  it("keeps the open-child completion guard and rejects deletion with incoming references", () => {
    const parent = createTask(projectDir, { title: "Parent" });
    const child = createTask(projectDir, { title: "Child", parent: parent.id });
    assert.throws(() => updateTask(projectDir, parent.id, { status: "done" }), /open children/);
    assert.throws(() => deleteTask(projectDir, parent.id), /referenced by/);
    updateTask(projectDir, child.id, { status: "cancelled" });
    assert.equal(updateTask(projectDir, parent.id, { status: "done" }).status, "done");
    deleteTask(projectDir, child.id);
    assert.equal(getTask(projectDir, child.id), undefined);
  });

  it("archives terminal tasks and reopens them into the current directory", () => {
    const task = createTask(projectDir, { title: "Archive me" });
    const done = updateTask(projectDir, task.id, { status: "done" });
    assert.ok(done.closedAt);
    const archived = archiveTasks(projectDir, { days: 0 }).archived;
    assert.deepEqual(
      archived.map((item) => item.id),
      [task.id],
    );
    assert.deepEqual(loadTasks(projectDir), []);
    assert.equal(getTask(projectDir, task.id).archived, true);

    const reopened = updateTask(projectDir, task.id, {
      status: "in_progress",
      expectedRevision: getTask(projectDir, task.id).revision,
    });
    assert.equal(reopened.archived, false);
    assert.equal(reopened.closedAt, null);
    assert.equal(existsSync(join(projectDir, ".relay", "tasks", `${task.id}.md`)), true);
    assert.equal(
      existsSync(join(projectDir, ".relay", "tasks", "archive", `${task.id}.md`)),
      false,
    );
  });

  it("stores immutable comments, validates replies, and protects discussed tasks", () => {
    const task = createTask(projectDir, { title: "Discuss" });
    const first = addTaskComment(projectDir, task.id, { body: "First", author: "Ada" });
    const second = addTaskComment(projectDir, task.id, { body: "Reply", replyTo: first.id });
    assert.equal(first.author, "Ada");
    assert.equal(second.replyTo, first.id);
    assert.deepEqual(
      listTaskComments(projectDir, task.id).map((comment) => comment.body),
      ["First", "Reply"],
    );
    assert.throws(
      () => addTaskComment(projectDir, task.id, { body: "Bad", replyTo: "feedface" }),
      /Reply target/,
    );
    assert.throws(() => deleteTask(projectDir, task.id), /discussion comments/);
    assert.deepEqual(validateTasks(projectDir), {
      valid: true,
      errors: [],
      taskCount: 1,
      commentCount: 2,
    });
  });

  it("does not scan unrelated archived files for the default list", () => {
    const task = createTask(projectDir, { title: "Current" });
    const archive = join(projectDir, ".relay", "tasks", "archive");
    mkdirSync(archive, { recursive: true });
    writeFileSync(join(archive, "feedface.md"), "broken\n");
    assert.deepEqual(
      loadTasks(projectDir).map((item) => item.id),
      [task.id],
    );
    assert.throws(
      () => loadTasks(projectDir, { includeArchived: true }),
      expectTaskError("validation"),
    );
    assert.equal(validateTasks(projectDir).valid, false);
  });

  it("reports non-canonical files and formats them only when requested", () => {
    const task = createTask(projectDir, { title: "Format" });
    const path = join(projectDir, ".relay", "tasks", `${task.id}.md`);
    const canonical = readFileSync(path, "utf8");
    writeFileSync(path, canonical.replace('title: "Format"', "title: Format"));
    assert.deepEqual(formatTasks(projectDir, { check: true }).changed, [path]);
    assert.notEqual(readFileSync(path, "utf8"), canonical);
    assert.deepEqual(formatTasks(projectDir).changed, [path]);
    assert.equal(readFileSync(path, "utf8"), canonical);
  });

  it("rejects malformed legacy records without changing the source", () => {
    writeLegacy(projectDir, [legacyTask({ priority: 99 })]);
    const before = readFileSync(join(projectDir, ".relay", "tasks.json"), "utf8");
    assert.equal(validateTasks(projectDir).valid, false);
    assert.throws(() => migrateTasks(projectDir), expectTaskError("validation"));
    assert.equal(readFileSync(join(projectDir, ".relay", "tasks.json"), "utf8"), before);
  });
});
