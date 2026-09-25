import "./test-env.js";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  buildClaudeSpawnEnv,
  resolveClaudeConfigDir,
  resolveClaudeGlobalConfigPath,
} from "../dist/server/core/providers/claude-cli.js";

const DEFAULT_DIR = join(homedir(), ".claude");

describe("resolveClaudeConfigDir", () => {
  it("defaults to ~/.claude", () => {
    assert.equal(resolveClaudeConfigDir({}), DEFAULT_DIR);
  });

  it("follows CLAUDE_CONFIG_DIR so discovery and spawns share the CLI's dir", () => {
    assert.equal(
      resolveClaudeConfigDir({ CLAUDE_CONFIG_DIR: "/tmp/claude-work" }),
      "/tmp/claude-work",
    );
  });

  it("lets CLAUDE_DIR override CLAUDE_CONFIG_DIR and expands ~", () => {
    assert.equal(
      resolveClaudeConfigDir({ CLAUDE_DIR: "~/.claude-personal", CLAUDE_CONFIG_DIR: "/tmp/work" }),
      join(homedir(), ".claude-personal"),
    );
  });
});

describe("buildClaudeSpawnEnv", () => {
  it("returns the base env untouched when it already targets the config dir", () => {
    const base = { CLAUDE_CONFIG_DIR: "/tmp/claude-work", HOME: "/x" };
    assert.equal(buildClaudeSpawnEnv("/tmp/claude-work", base), base);
    const plain = { HOME: "/x" };
    assert.equal(buildClaudeSpawnEnv(DEFAULT_DIR, plain), plain);
  });

  it("pins CLAUDE_CONFIG_DIR when the inherited env points at another account", () => {
    const base = { CLAUDE_CONFIG_DIR: "/tmp/claude-personal", HOME: "/x" };
    const env = buildClaudeSpawnEnv("/tmp/claude-work", base);
    assert.equal(env.CLAUDE_CONFIG_DIR, "/tmp/claude-work");
    assert.equal(base.CLAUDE_CONFIG_DIR, "/tmp/claude-personal");
    assert.equal(env.HOME, "/x");
  });

  it("removes an inherited CLAUDE_CONFIG_DIR instead of setting it to the default", () => {
    const env = buildClaudeSpawnEnv(DEFAULT_DIR, { CLAUDE_CONFIG_DIR: "/tmp/claude-work" });
    assert.equal("CLAUDE_CONFIG_DIR" in env, false);
  });
});

describe("resolveClaudeGlobalConfigPath", () => {
  it("keeps ~/.claude.json for the default dir and nests it otherwise", () => {
    assert.equal(resolveClaudeGlobalConfigPath(DEFAULT_DIR), join(homedir(), ".claude.json"));
    assert.equal(
      resolveClaudeGlobalConfigPath("/tmp/claude-work"),
      "/tmp/claude-work/.claude.json",
    );
  });
});
