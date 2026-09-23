// Isolate worktrees/git env even when this file is run directly with `node --test`.
import "./test-env.js";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractSpaceContextForInjection } from "../dist/server/core/session-context.js";

describe("extractSpaceContextForInjection", () => {
  it("returns null for empty/missing input", () => {
    assert.equal(extractSpaceContextForInjection(null), null);
    assert.equal(extractSpaceContextForInjection(undefined), null);
    assert.equal(extractSpaceContextForInjection(""), null);
    assert.equal(extractSpaceContextForInjection("   \n\t  "), null);
  });

  it("returns null for a pristine seed template (headers + comment placeholders only)", () => {
    const seed = [
      "# My Space\n",
      "## Goal\n\n<!-- Describe what this space is for -->\n",
      "## Decisions\n\n<!-- Record key decisions and their rationale -->\n",
      "## Status\n\n<!-- Track current status of work streams -->\n",
      "## Interfaces\n\n<!-- Document APIs, contracts, or interfaces other chats depend on -->\n",
    ].join("\n");
    assert.equal(extractSpaceContextForInjection(seed), null);
  });

  it("returns the full trimmed brief when real content exists", () => {
    const brief = "## Status\nSibling chat is updating the API contract.\n";
    const result = extractSpaceContextForInjection(brief);
    assert.ok(result);
    // Full text preserved (headers kept for structure), trimmed at the edges.
    assert.ok(result.includes("## Status"));
    assert.ok(result.includes("Sibling chat is updating the API contract."));
    assert.equal(result, brief.trim());
  });

  it("treats a description-filled Goal section as meaningful content", () => {
    const brief = "# My Space\n\n## Goal\n\nShip the new auth flow.\n";
    const result = extractSpaceContextForInjection(brief);
    assert.ok(result);
    assert.ok(result.includes("Ship the new auth flow."));
  });
});
