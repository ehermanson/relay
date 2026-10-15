import "./test-env.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { acquireServerStateLock } from "../dist/server/state-lock.js";
import { createRelay } from "../dist/server/index.js";

test("independent in-memory databases need no shared process lease", () => {
  const first = acquireServerStateLock(":memory:");
  const second = acquireServerStateLock(":memory:");
  first();
  second();
});

test("CLI and desktop processes cannot concurrently own the same server database", () => {
  const directory = mkdtempSync(join(tmpdir(), "relay-server-lock-"));
  const database = join(directory, "sessions.db");
  const release = acquireServerStateLock(database);
  try {
    const moduleURL = new URL("../dist/server/state-lock.js", import.meta.url).href;
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const child = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import {acquireServerStateLock} from ${JSON.stringify(moduleURL)}; try {acquireServerStateLock(process.argv[1]);process.exitCode=1;} catch(error) {console.log(error.message);}`,
        database,
      ],
      { encoding: "utf8", env, timeout: 5000 },
    );
    assert.equal(child.status, 0);
    assert.match(child.stdout, /already owns/);
  } finally {
    release();
  }
  const next = acquireServerStateLock(database);
  next();
  rmSync(directory, { recursive: true, force: true });
});

test("a failed Relay constructor releases state ownership", () => {
  const directory = mkdtempSync(join(tmpdir(), "relay-server-lock-"));
  const database = join(directory, "sessions.db");
  try {
    assert.throws(() =>
      createRelay({
        dbPath: database,
        sessionFile: join(directory, "auth.json"),
        providerDirs: { claude: 42, codex: join(directory, "codex") },
        logger: { info() {}, warn() {}, error() {}, debug() {} },
      }),
    );
    const release = acquireServerStateLock(database);
    release();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a crashed backend releases its OS state lock without stale-owner recovery", async () => {
  const directory = mkdtempSync(join(tmpdir(), "relay-server-lock-"));
  const database = join(directory, "sessions.db");
  const moduleURL = new URL("../dist/server/state-lock.js", import.meta.url).href;
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import {acquireServerStateLock} from ${JSON.stringify(moduleURL)}; acquireServerStateLock(process.argv[1]);console.log('locked');setInterval(()=>{},1000);`,
      database,
    ],
    { env, stdio: ["ignore", "pipe", "ignore"] },
  );
  try {
    await once(child.stdout, "data", { signal: AbortSignal.timeout(5000) });
    assert.throws(() => acquireServerStateLock(database), /already owns/);
    const exited = once(child, "exit");
    child.kill("SIGKILL");
    await exited;
    const release = acquireServerStateLock(database);
    release();
  } finally {
    child.kill("SIGKILL");
    rmSync(directory, { recursive: true, force: true });
  }
});
