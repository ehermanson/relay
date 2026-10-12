import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sourceRelaunchExecutable } from "./source-relaunch.mjs";
test("source updates relaunch the newly installed Electron and reject escaping binary paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "relay-relaunch-"));
  try {
    const dir = join(root, "node_modules/electron");
    await mkdir(join(dir, "dist"), { recursive: true });
    await writeFile(join(dir, "dist/electron"), "binary");
    await writeFile(join(dir, "path.txt"), "electron\n");
    assert.equal(await sourceRelaunchExecutable(root), join(dir, "dist/electron"));
    await writeFile(join(dir, "path.txt"), "../../elsewhere");
    await assert.rejects(sourceRelaunchExecutable(root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
