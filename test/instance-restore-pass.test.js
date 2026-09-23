// Isolate worktrees/git env even when this file is run directly with `node --test`.
import "./test-env.js";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { restorePersistedRows } from "../dist/server/core/instance-restore-pass.js";

describe("instance-restore-pass helpers", () => {
  it("skips managed shadow externals and counts restored rows", () => {
    const restoredExternalIds = [];
    const restoredManagedIds = [];

    const restored = restorePersistedRows({
      externalRows: [
        { session_id: "shadow-session", instance_id: "external-shadow" },
        { session_id: "real-session", instance_id: "external-real" },
      ],
      managedRows: [{ instance_id: "managed-1" }],
      managedKeys: {
        providerSessionIds: new Set(["shadow-session"]),
        transcriptPaths: new Set(),
      },
      isManagedShadowSessionRow: (row, keys) => keys.providerSessionIds.has(row.session_id),
      restoreExternalRow: (row) => {
        restoredExternalIds.push(row.instance_id);
        return true;
      },
      restoreManagedRow: (row) => {
        restoredManagedIds.push(row.instance_id);
        return true;
      },
    });

    assert.equal(restored, 2);
    assert.deepEqual(restoredExternalIds, ["external-real"]);
    assert.deepEqual(restoredManagedIds, ["managed-1"]);
  });

  it("restores external rows before managed rows", () => {
    const order = [];

    restorePersistedRows({
      externalRows: [{ session_id: "external-1", instance_id: "external-1" }],
      managedRows: [{ instance_id: "managed-1" }],
      managedKeys: {
        providerSessionIds: new Set(),
        transcriptPaths: new Set(),
      },
      isManagedShadowSessionRow: () => false,
      restoreExternalRow: (row) => {
        order.push(`external:${row.instance_id}`);
        return true;
      },
      restoreManagedRow: (row) => {
        order.push(`managed:${row.instance_id}`);
        return true;
      },
    });

    assert.deepEqual(order, ["external:external-1", "managed:managed-1"]);
  });
});
