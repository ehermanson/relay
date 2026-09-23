// Isolate worktrees/git env even when this file is run directly with `node --test`.
import "./test-env.js";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildUpdateCommand,
  buildUpdateInvocation,
  classifyInstallMethod,
  compareSemver,
  executeUpdateCommand,
  PROVIDER_PACKAGE_METADATA,
} from "../dist/server/core/provider-versions.js";

describe("compareSemver", () => {
  it("orders standard semver", () => {
    assert.equal(compareSemver("1.0.0", "1.0.1"), -1);
    assert.equal(compareSemver("1.0.1", "1.0.0"), 1);
    assert.equal(compareSemver("1.0.0", "1.0.0"), 0);
    assert.equal(compareSemver("1.10.0", "1.9.9"), 1);
    assert.equal(compareSemver("2.0.0", "1.99.99"), 1);
  });

  it("tolerates a leading v prefix", () => {
    assert.equal(compareSemver("v1.2.3", "1.2.3"), 0);
    assert.equal(compareSemver("v1.2.3", "v1.2.4"), -1);
  });

  it("ignores build metadata", () => {
    assert.equal(compareSemver("1.2.3+sha.abc", "1.2.3"), 0);
    assert.equal(compareSemver("1.2.3+a", "1.2.3+b"), 0);
  });

  it("ranks a prerelease below the matching stable release", () => {
    assert.equal(compareSemver("1.2.3-beta", "1.2.3"), -1);
    assert.equal(compareSemver("1.2.3", "1.2.3-beta"), 1);
    assert.equal(compareSemver("1.2.3-alpha", "1.2.3-beta"), -1);
  });

  it("compares prerelease identifiers per semver spec", () => {
    // Numeric < alphanumeric
    assert.equal(compareSemver("1.0.0-1", "1.0.0-alpha"), -1);
    // Numeric identifiers compare numerically
    assert.equal(compareSemver("1.0.0-alpha.2", "1.0.0-alpha.10"), -1);
    // Shorter list ranks lower when all shared identifiers match
    assert.equal(compareSemver("1.0.0-alpha", "1.0.0-alpha.1"), -1);
  });

  it("treats higher main triple as greater regardless of prerelease", () => {
    assert.equal(compareSemver("1.2.3-beta", "1.2.4-alpha"), -1);
    assert.equal(compareSemver("2.0.0-rc.1", "1.99.99"), 1);
  });

  it("pads missing segments with zero", () => {
    assert.equal(compareSemver("1.2", "1.2.0"), 0);
    assert.equal(compareSemver("1", "1.0.1"), -1);
  });

  it("returns 0 for unparseable input rather than throwing", () => {
    assert.equal(compareSemver("", "1.0.0"), 0);
    assert.equal(compareSemver("not-a-version", "1.0.0"), 0);
  });
});

describe("classifyInstallMethod", () => {
  const claudeMeta = PROVIDER_PACKAGE_METADATA.claude;
  assert.ok(claudeMeta, "expected claude package metadata to be defined");

  it("identifies npm global installs", () => {
    assert.equal(
      classifyInstallMethod("/usr/local/lib/node_modules/@anthropic-ai/claude-code/bin/claude"),
      "npm",
    );
    assert.equal(
      classifyInstallMethod(
        "/Users/someone/.nvm/versions/node/v20.0.0/lib/node_modules/.bin/claude",
      ),
      "npm",
    );
  });

  it("identifies pnpm global installs", () => {
    assert.equal(
      classifyInstallMethod("/Users/someone/Library/pnpm/global/5/node_modules/.bin/claude"),
      "pnpm",
    );
    assert.equal(
      classifyInstallMethod("/home/dev/.local/share/pnpm/global/5/node_modules/.bin/claude"),
      "pnpm",
    );
  });

  it("identifies bun global installs", () => {
    assert.equal(classifyInstallMethod("/Users/someone/.bun/bin/claude"), "bun");
  });

  it("identifies homebrew installs via Cellar paths", () => {
    assert.equal(
      classifyInstallMethod("/opt/homebrew/Cellar/claude-code/1.2.3/bin/claude"),
      "brew",
    );
    assert.equal(classifyInstallMethod("/usr/local/Cellar/claude-code/1.2.3/bin/claude"), "brew");
  });

  it("identifies Claude's native install via the matcher", () => {
    assert.equal(classifyInstallMethod("/Users/someone/.local/bin/claude", claudeMeta), "native");
    assert.equal(
      classifyInstallMethod("/Users/someone/.local/share/claude/claude", claudeMeta),
      "native",
    );
  });

  it("falls back to manual when the path is unrecognized", () => {
    assert.equal(classifyInstallMethod("/some/weird/place/claude"), "manual");
  });
});

describe("buildUpdateCommand", () => {
  const claudeMeta = PROVIDER_PACKAGE_METADATA.claude;
  const codexMeta = PROVIDER_PACKAGE_METADATA.codex;
  assert.ok(claudeMeta && codexMeta);

  it("returns the npm command for npm installs", () => {
    assert.equal(
      buildUpdateCommand("npm", claudeMeta),
      "npm install -g @anthropic-ai/claude-code@latest",
    );
  });

  it("returns the bun command for bun installs", () => {
    assert.equal(
      buildUpdateCommand("bun", claudeMeta),
      "bun i -g @anthropic-ai/claude-code@latest",
    );
  });

  it("returns the pnpm command for pnpm installs", () => {
    assert.equal(
      buildUpdateCommand("pnpm", claudeMeta),
      "pnpm add -g @anthropic-ai/claude-code@latest",
    );
  });

  it("returns the brew command when a formula exists", () => {
    assert.equal(buildUpdateCommand("brew", claudeMeta), "brew upgrade claude-code");
    assert.equal(buildUpdateCommand("brew", codexMeta), "brew upgrade codex");
  });

  it("returns the native command for providers that support it", () => {
    assert.equal(buildUpdateCommand("native", claudeMeta), "claude update");
  });

  it("returns null for native on providers without a native updater", () => {
    assert.equal(buildUpdateCommand("native", codexMeta), null);
  });

  it("recommends the npm command for manual installs", () => {
    assert.equal(
      buildUpdateCommand("manual", claudeMeta),
      "npm install -g @anthropic-ai/claude-code@latest",
    );
  });
});

describe("buildUpdateInvocation", () => {
  it("uses argv tokenization for package-manager commands", () => {
    assert.deepEqual(buildUpdateInvocation("npm install -g @openai/codex@latest", "npm"), {
      binary: "npm",
      args: ["install", "-g", "@openai/codex@latest"],
    });
  });

  it("uses the discovered provider binary for native updates", () => {
    assert.deepEqual(
      buildUpdateInvocation("claude update", "native", {
        providerBinaryPath: "/Users/me/.local/bin/claude",
      }),
      { binary: "/Users/me/.local/bin/claude", args: ["update"] },
    );
  });

  it("rejects native updates without a discovered provider binary", () => {
    assert.equal(buildUpdateInvocation("claude update", "native"), null);
  });
});

describe("executeUpdateCommand", () => {
  it("resolves ok with captured output on success", async () => {
    const result = await executeUpdateCommand("echo updated", "manual");
    assert.equal(result.ok, true);
    assert.equal(result.output, "updated");
  });

  it("resolves ok:false on nonzero exit without throwing", async () => {
    const result = await executeUpdateCommand("false", "manual");
    assert.equal(result.ok, false);
  });

  it("resolves ok:false for a missing binary", async () => {
    const result = await executeUpdateCommand(
      "definitely-not-a-real-binary-xyz --upgrade",
      "manual",
    );
    assert.equal(result.ok, false);
  });

  it("rejects an empty command", async () => {
    const result = await executeUpdateCommand("   ", "manual");
    assert.equal(result.ok, false);
  });

  it("rejects native commands without a discovered provider binary", async () => {
    const result = await executeUpdateCommand("claude update", "native");
    assert.equal(result.ok, false);
  });
});
