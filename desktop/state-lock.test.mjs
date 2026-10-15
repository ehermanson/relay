import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireStateLock, lockOwnerAlive } from "./state-lock.mjs";

test("one backend owns a desktop home and release permits the next writer", async () => {
  const home = await mkdtemp(join(tmpdir(), "relay-lock-test-"));
  try {
    const release = await acquireStateLock(home);
    await assert.rejects(acquireStateLock(home), /already using/);
    await release();
    const next = await acquireStateLock(home);
    await next();
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("a lock owner the probe cannot signal still counts as alive", () => {
  const raise = (code) => () => {
    const error = new Error(code);
    error.code = code;
    throw error;
  };
  assert.equal(
    lockOwnerAlive(1234, () => {}),
    true,
  );
  assert.equal(lockOwnerAlive(1234, raise("EPERM")), true);
  assert.equal(lockOwnerAlive(1234, raise("ESRCH")), false);
  assert.throws(() => lockOwnerAlive(1234, raise("EINVAL")), /EINVAL/);
});

test("dead owners are recovered; unfinished lock creation is treated conservatively", async () => {
  const home = await mkdtemp(join(tmpdir(), "relay-lock-test-"));
  const directory = join(home, "desktop-backend.lock");
  try {
    await mkdir(directory);
    await assert.rejects(acquireStateLock(home), /initializing/);
    // Outside the PID range on supported desktop operating systems.
    await writeFile(
      join(directory, "owner.json"),
      JSON.stringify({ pid: 2147483647, token: "dead" }),
    );
    const release = await acquireStateLock(home);
    await release();
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
