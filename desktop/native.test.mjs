import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, symlink, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  validatePreferences,
  restoreBounds,
  deepLinkPath,
  authorizedPath,
  safeOpenPath,
} from "./native.mjs";
test("desktop links carry only internal navigation", () => {
  assert.equal(
    deepLinkPath("relay://open?path=%2Fprojects%2Fp%2Fchats%2Fc"),
    "/projects/p/chats/c",
  );
  for (const link of [
    "relay://open?path=https://evil.test",
    "relay://open?path=//evil.test",
    "relay://open?path=/api/file",
    "https://evil.test",
    "relay://user:pass@open",
  ])
    assert.equal(deepLinkPath(link), null);
});
test("window position recovers from disconnected displays", () => {
  const displays = [{ workArea: { x: 0, y: 0, width: 1440, height: 900 } }];
  const bounds = restoreBounds({ x: 4000, y: 4000, width: 2000, height: 1400 }, displays);
  assert.deepEqual(bounds, { x: 0, y: 0, width: 1440, height: 900 });
  assert.throws(() => validatePreferences({ globalShortcut: "yes" }));
});
test("native file actions reject outside paths, symlink escapes and executables", async () => {
  const root = await mkdtemp(join(tmpdir(), "relay-native-project-"));
  const outside = await mkdtemp(join(tmpdir(), "relay-native-outside-"));
  try {
    await writeFile(join(root, "doc.md"), "text");
    await writeFile(join(root, "run.js"), "");
    await writeFile(join(outside, "secret.md"), "");
    await symlink(join(outside, "secret.md"), join(root, "link.md"));
    assert.equal(
      await safeOpenPath(join(root, "doc.md"), [root]),
      await realpath(join(root, "doc.md")),
    );
    await assert.rejects(authorizedPath(join(root, "link.md"), [root]));
    await assert.rejects(safeOpenPath(join(root, "run.js"), [root]));
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("deep links normalize path traversal before permitting a route", () => {
  assert.equal(deepLinkPath("relay://open?path=%2Fprojects%2F..%2Fapi%2Ffile"), null);
});
