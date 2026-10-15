import "./test-env.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { registerUiRoutes } from "../dist/server/routes/ui.js";

test("self-hosted fonts return binary assets rather than the SPA fallback", async () => {
  const directory = await mkdtemp(join(tmpdir(), "relay-fonts-"));
  try {
    await mkdir(join(directory, "fonts"));
    const bytes = Buffer.from("wOF2test");
    await writeFile(join(directory, "fonts", "outfit.woff2"), bytes);
    await writeFile(join(directory, "index.html"), "<html>Relay</html>");
    const app = new Hono();
    registerUiRoutes(app, {
      config: { serveUI: true },
      uiDistDir: directory,
      indexHtmlPath: join(directory, "index.html"),
    });
    const font = await app.request("/fonts/outfit.woff2");
    assert.equal(font.status, 200);
    assert.equal(font.headers.get("content-type"), "font/woff2");
    assert.equal(font.headers.get("cache-control"), "public, max-age=86400, must-revalidate");
    assert.deepEqual(Buffer.from(await font.arrayBuffer()), bytes);
    assert.equal((await app.request("/fonts/missing.woff2")).status, 404);
    assert.equal(await (await app.request("/projects/example")).text(), "<html>Relay</html>");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
