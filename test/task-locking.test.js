import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initTasks, loadTasks } from "../dist/server/core/task-manager.js";

const taskManagerUrl = new URL("../dist/server/core/task-manager.js", import.meta.url).href;

function runChild(script, ...args) {
  const child = spawn(process.execPath, ["--input-type=module", "-e", script, ...args], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  return {
    child,
    result: new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve({ code, signal, stderr }));
    }),
  };
}

describe("task-manager mutation lock", () => {
  let projectDir;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), "relay-task-lock-"));
    initTasks(projectDir);
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  it("does not reclaim an aged primary lock owned by a live process", async () => {
    const lock = join(projectDir, ".relay", ".tasks.lock");
    mkdirSync(lock);
    writeFileSync(
      join(lock, "owner.json"),
      `${JSON.stringify({ pid: process.pid, token: "live-owner", createdAt: new Date().toISOString() })}\n`,
    );
    const old = new Date(Date.now() - 120_000);
    utimesSync(lock, old, old);

    const { child, result } = runChild(
      `import { loadTasks } from ${JSON.stringify(taskManagerUrl)}; loadTasks(process.argv[1]);`,
      projectDir,
    );
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(child.exitCode, null, "reader should still be waiting for the live owner");
    child.kill("SIGTERM");
    await result;
  });

  it("fails closed while an abandoned lock gate exists", async () => {
    const gate = join(projectDir, ".relay", ".tasks.lock-gate");
    mkdirSync(gate);
    writeFileSync(join(gate, "owner"), "abandoned-gate");

    const { child, result } = runChild(
      `import { createTask } from ${JSON.stringify(taskManagerUrl)}; createTask(process.argv[1], { title: "Must wait" });`,
      projectDir,
    );
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(child.exitCode, null, "writer should not bypass an unowned gate");
    child.kill("SIGTERM");
    await result;
    assert.deepEqual(loadTasks(projectDir), []);
  });

  it("preserves every task from concurrent subprocess writers", async () => {
    const script = `import { createTask } from ${JSON.stringify(taskManagerUrl)}; createTask(process.argv[1], { title: process.argv[2] });`;
    const children = Array.from({ length: 8 }, (_, index) =>
      runChild(script, projectDir, `Concurrent ${index}`),
    );
    const results = await Promise.all(children.map(({ result }) => result));
    assert.deepEqual(
      results.map(({ code }) => code),
      Array(8).fill(0),
      results.map(({ stderr }) => stderr).join("\n"),
    );
    assert.deepEqual(
      loadTasks(projectDir)
        .map((task) => task.title)
        .sort(),
      Array.from({ length: 8 }, (_, index) => `Concurrent ${index}`).sort(),
    );
  });
});
