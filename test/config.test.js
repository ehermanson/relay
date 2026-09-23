// Isolate worktrees/git env even when this file is run directly with `node --test`.
import "./test-env.js";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveConfig } from "../dist/server/config.js";

describe("resolveConfig", () => {
  it("requires password", () => {
    const config = resolveConfig({ password: "secret" });
    assert.equal(config.password, "secret");
  });

  it("applies all defaults", () => {
    const config = resolveConfig({ password: "s" });
    assert.equal(config.port, 7777);
    assert.equal(config.sessionMaxAge, 7 * 24 * 60 * 60 * 1000);
    assert.equal(config.defaultRuntimeMode, "full-access");
    assert.equal(config.processTimeout, 30 * 60 * 1000);
    assert.equal(config.serveUI, true);
    assert.equal(config.rateLimitMax, 5);
    assert.equal(config.rateLimitWindow, 60_000);
    assert.equal(config.maxProcesses, 15);
    assert.equal(config.sessionFile, join(homedir(), ".relay", "sessions.json"));
    assert.equal(config.dbPath, join(homedir(), ".relay", "sessions.db"));
  });

  it("overrides defaults with user options", () => {
    const config = resolveConfig({
      password: "p",
      port: 9999,
      maxProcesses: 3,
      defaultRuntimeMode: "approval-required",
      serveUI: false,
    });
    assert.equal(config.port, 9999);
    assert.equal(config.maxProcesses, 3);
    assert.equal(config.defaultRuntimeMode, "approval-required");
    assert.equal(config.serveUI, false);
  });

  it("supports defaultWorkingDirectory alias", () => {
    const config = resolveConfig({
      password: "p",
      defaultWorkingDirectory: "/tmp/test",
    });
    assert.equal(config.workingDirectory, "/tmp/test");
  });

  it("workingDirectory takes precedence over alias", () => {
    const config = resolveConfig({
      password: "p",
      workingDirectory: "/a",
      defaultWorkingDirectory: "/b",
    });
    assert.equal(config.workingDirectory, "/a");
  });
});
