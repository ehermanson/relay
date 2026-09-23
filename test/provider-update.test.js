// Isolate worktrees/git env even when this file is run directly with `node --test`.
import "./test-env.js";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  hasInstallableProviderUpdate,
  describeProviderUpdateResult,
} from "../dist/server/core/provider-update.js";
import { fetchHomebrewLatest } from "../dist/server/core/provider-versions.js";

const advisory = {
  status: "behind_latest",
  currentVersion: "0.155.1",
  latestVersion: "0.156.0",
  availableVersion: "0.155.1",
  installMethod: "brew",
  updateCommand: "brew upgrade codex",
};

describe("provider update verification", () => {
  it("does not offer the npm release while Homebrew is behind or unreachable", () => {
    assert.equal(hasInstallableProviderUpdate(advisory), false);
    assert.equal(hasInstallableProviderUpdate({ ...advisory, availableVersion: null }), false);
    assert.equal(hasInstallableProviderUpdate({ ...advisory, availableVersion: undefined }), false);
    assert.equal(hasInstallableProviderUpdate({ ...advisory, availableVersion: "0.156.0" }), true);
    assert.equal(
      hasInstallableProviderUpdate({
        ...advisory,
        installMethod: "npm",
        availableVersion: undefined,
      }),
      true,
    );
  });

  it("reports a successful no-op as unchanged and preserves its diagnostics", () => {
    const output = "Warning: Not upgrading codex, the latest version is already installed";
    const result = describeProviderUpdateResult(advisory, advisory, { ok: true, output });
    assert.equal(result.status, "unchanged");
    assert.equal(result.output, output);
    assert.equal(result.command, "brew upgrade codex");
    assert.match(result.message, /0.155.1/);
  });

  it("verifies an actual upgrade even when the channel still trails npm", () => {
    const result = describeProviderUpdateResult(
      { ...advisory, currentVersion: "0.154.0" },
      advisory,
      { ok: true, output: "done" },
    );
    assert.equal(result.status, "updated");
    assert.match(result.message, /0.154.0.*0.155.1/);
  });

  it("does not claim success for failed commands, missing probes, or downgrades", () => {
    assert.equal(
      describeProviderUpdateResult(advisory, advisory, { ok: false, output: "permission denied" })
        .status,
      "failed",
    );
    assert.equal(
      describeProviderUpdateResult(advisory, undefined, { ok: true, output: "done" }).status,
      "unverified",
    );
    assert.equal(
      describeProviderUpdateResult(
        advisory,
        { ...advisory, currentVersion: null },
        { ok: true, output: "done" },
      ).status,
      "unverified",
    );
    assert.equal(
      describeProviderUpdateResult(
        advisory,
        { ...advisory, currentVersion: "0.154.0" },
        { ok: true, output: "done" },
      ).status,
      "unchanged",
    );
  });
});

describe("Homebrew distribution lookup", () => {
  it("reads cask/formula versions, caches, and bypasses cache on recheck", async (t) => {
    const urls = [];
    t.mock.method(globalThis, "fetch", async (url) => {
      urls.push(url);
      return Response.json(
        url.includes("/cask/") ? { version: "0.155.1" } : { versions: { stable: "0.156.0" } },
      );
    });
    assert.equal(await fetchHomebrewLatest("codex", "cask", { force: true }), "0.155.1");
    assert.equal(await fetchHomebrewLatest("codex", "cask"), "0.155.1");
    assert.equal(urls.length, 1);
    await fetchHomebrewLatest("codex", "cask", { force: true });
    assert.equal(urls.length, 2);
    assert.equal(await fetchHomebrewLatest("codex", "formula", { force: true }), "0.156.0");
    assert.equal(urls[2], "https://formulae.brew.sh/api/formula/codex.json");
  });

  it("fails soft on bad data, unavailable packages, and network errors", async (t) => {
    for (const response of [
      Response.json({ version: "latest" }),
      new Response("", { status: 404 }),
    ]) {
      t.mock.method(globalThis, "fetch", async () => response);
      assert.equal(await fetchHomebrewLatest("codex", "cask", { force: true }), null);
      t.mock.restoreAll();
    }
    t.mock.method(globalThis, "fetch", async () => {
      throw new Error("offline");
    });
    assert.equal(await fetchHomebrewLatest("codex", "cask", { force: true }), null);
  });
});
