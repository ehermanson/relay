import "../test/test-env.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile, rm, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  selectDeveloperIdentity,
  updateMetadata,
  feedHandler,
  extractSignedTestPayload,
} from "./signed-update-test.mjs";

test(
  "signed test extraction preserves unpacked native helper executability",
  { skip: process.platform === "win32" },
  async () => {
    const require = createRequire(import.meta.url);
    const builderRequire = createRequire(require.resolve("electron-builder"));
    const asar = builderRequire("@electron/asar");
    const root = await mkdtemp(join(tmpdir(), "relay-asar-mode-test-"));
    try {
      const source = join(root, "source");
      await mkdir(source);
      await writeFile(join(source, "spawn-helper"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      const archive = join(root, "app.asar");
      await asar.createPackageWithOptions(source, archive, { unpack: "spawn-helper" });
      const destination = join(root, "extracted");
      await extractSignedTestPayload(asar, archive, destination);
      assert.equal((await stat(join(destination, "spawn-helper"))).mode & 0o777, 0o755);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("signed test selects only a valid Developer ID identity", () => {
  const hash = "A".repeat(40);
  assert.deepEqual(
    selectDeveloperIdentity(
      `1) ${"B".repeat(40)} "Apple Development: Example"\n2) ${hash} "Developer ID Application: Example (TEAM)"`,
    ),
    { hash, name: "Developer ID Application: Example (TEAM)" },
  );
  assert.throws(() => selectDeveloperIdentity("0 valid identities found"), /Developer ID/);
});

test("local update metadata checksums the exact signed ZIP", () => {
  const bytes = Buffer.from("signed fixture bytes");
  const text = updateMetadata("3.0.1", "Relay.zip", bytes);
  assert.ok(text.includes(`sha512: ${createHash("sha512").update(bytes).digest("base64")}`));
  assert.ok(text.includes(`size: ${bytes.length}`));
  assert.throws(() => updateMetadata("3.0.1", "../Relay.zip", bytes));
});

test("loopback feed serves only explicitly mapped release files", async () => {
  const root = await mkdtemp(join(tmpdir(), "relay-feed-test-"));
  const file = join(root, "latest-mac.yml");
  await writeFile(file, "version: 3.0.1\n");
  const server = createServer(feedHandler(new Map([["/latest-mac.yml", file]])));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    const response = await fetch(`${url}/latest-mac.yml`);
    assert.equal(await response.text(), "version: 3.0.1\n");
    assert.equal((await fetch(`${url}/package.json`)).status, 404);
    assert.equal((await fetch(`${url}/latest-mac.yml`, { method: "POST" })).status, 404);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});
