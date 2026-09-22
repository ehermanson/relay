import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runTasksCommand } from "../dist/cli/tasks.js";

function run(argv, cwd) {
  const stdout = [];
  const stderr = [];
  const code = runTasksCommand(argv, {
    cwd,
    stdout: (message) => stdout.push(message),
    stderr: (message) => stderr.push(message),
  });
  return { code, stdout, stderr };
}

describe("relay tasks CLI", () => {
  it("manages task files offline from the selected worktree", () => {
    const dir = mkdtempSync(join(tmpdir(), "relay-cli-tasks-"));
    try {
      const createdResult = run(
        [
          "--dir",
          dir,
          "create",
          "--title",
          "Ship CLI",
          "--priority",
          "0",
          "--tags",
          "cli,tasks",
          "--json",
        ],
        "/",
      );
      assert.equal(createdResult.code, 0);
      const created = JSON.parse(createdResult.stdout.join("\n"));
      assert.equal(created.title, "Ship CLI");
      assert.equal(created.priority, 0);
      assert.deepEqual(created.tags, ["cli", "tasks"]);

      const later = JSON.parse(
        run(["create", "--title", "Later task", "--priority", "2", "--json"], dir).stdout.join(
          "\n",
        ),
      );

      const ready = run(["list", "--ready", "--json"], dir);
      assert.equal(ready.code, 0);
      const readyTasks = JSON.parse(ready.stdout.join("\n"));
      assert.deepEqual(
        readyTasks.map((task) => task.id),
        [created.id, later.id],
      );
      assert.equal("description" in readyTasks[0], false);
      assert.deepEqual(Object.keys(readyTasks[0]), [
        "id",
        "title",
        "status",
        "priority",
        "parent",
        "blockedBy",
        "revision",
      ]);

      const comment = run(
        ["comment", created.id, "--body", "Validated offline", "--author", "Test", "--json"],
        dir,
      );
      assert.equal(comment.code, 0);
      assert.equal(JSON.parse(comment.stdout.join("\n")).taskId, created.id);

      const updated = run(
        ["update", created.id, "--status", "done", "--revision", created.revision, "--json"],
        dir,
      );
      assert.equal(updated.code, 0);
      assert.equal(JSON.parse(updated.stdout.join("\n")).status, "done");

      const archived = run(["archive", "--days", "0", "--json"], dir);
      assert.equal(archived.code, 0);
      assert.equal(JSON.parse(archived.stdout.join("\n")).archived.length, 1);

      const shown = run(["show", created.id, "--json"], dir);
      assert.equal(shown.code, 0);
      assert.equal(JSON.parse(shown.stdout.join("\n")).archived, true);
      assert.equal(run(["validate", "--json"], dir).code, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("previews legacy migration by default and applies only with --apply", () => {
    const dir = mkdtempSync(join(tmpdir(), "relay-cli-migrate-"));
    try {
      mkdirSync(join(dir, ".relay"), { recursive: true });
      const legacyPath = join(dir, ".relay", "tasks.json");
      writeFileSync(
        legacyPath,
        JSON.stringify({
          version: 1,
          tasks: [
            {
              id: "517e8e5b",
              title: "Legacy",
              description: "Move me",
              status: "open",
              priority: 2,
              type: "task",
              tags: [],
              parent: null,
              blockedBy: [],
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
            },
          ],
        }),
      );

      const preview = run(["migrate", "--json"], dir);
      assert.equal(preview.code, 0);
      assert.equal(JSON.parse(preview.stdout.join("\n")).dryRun, true);
      assert.equal(existsSync(legacyPath), true);

      const applied = run(["migrate", "--apply", "--json"], dir);
      assert.equal(applied.code, 0);
      assert.equal(JSON.parse(applied.stdout.join("\n")).dryRun, false);
      assert.equal(existsSync(legacyPath), false);
      assert.equal(existsSync(join(dir, ".relay", "tasks", "517e8e5b.md")), true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("dispatches the tasks command from the installed CLI entry point", () => {
    const dir = mkdtempSync(join(tmpdir(), "relay-cli-entry-"));
    try {
      const result = spawnSync(
        process.execPath,
        [
          join(import.meta.dirname, "..", "dist", "cli", "bin.js"),
          "tasks",
          "--dir",
          dir,
          "create",
          "--title",
          "Entry point",
          "--json",
        ],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            RELAY_CLI_CHILD_MODE: "1",
            RELAY_PACKAGE_JSON: '{"version":"0.0.0"}',
          },
        },
      );
      assert.equal(result.status, 0, result.stderr);
      assert.equal(JSON.parse(result.stdout).title, "Entry point");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses the Git worktree root when invoked from a nested directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "relay-cli-root-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd: dir });
      const nested = join(dir, "packages", "app");
      mkdirSync(nested, { recursive: true });
      const created = run(["create", "--title", "Root task", "--json"], nested);
      assert.equal(created.code, 0);
      assert.equal(existsSync(join(dir, ".relay", "tasks")), true);
      assert.equal(existsSync(join(nested, ".relay")), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects command flags that could otherwise make a mutation look like a dry run", () => {
    const dir = mkdtempSync(join(tmpdir(), "relay-cli-flags-"));
    try {
      const created = JSON.parse(
        run(["create", "--title", "Keep me", "--json"], dir).stdout.join("\n"),
      );
      const rejected = run(["delete", created.id, "--dry-run"], dir);
      assert.equal(rejected.code, 1);
      assert.match(rejected.stderr.join("\n"), /not valid for delete/);
      assert.equal(run(["show", created.id, "--json"], dir).code, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
