// Isolate worktrees/git env even when this file is run directly with `node --test`.
import "./test-env.js";
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { registerUploadRoutes } from "../dist/server/routes/uploads.js";

const app = new Hono();
registerUploadRoutes(app, {});
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-video-test-"));
const uploaded = [];
after(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  uploaded.forEach((file) => fs.rmSync(file, { force: true }));
});

describe("video attachments", () => {
  it("uploads and serves video bytes with the correct content type", async () => {
    for (const mime of ["video/mp4", "video/quicktime", "video/webm"]) {
      const response = await app.request("/api/upload", {
        method: "POST",
        headers: { "Content-Type": mime },
        body: "video bytes",
      });
      assert.equal(response.status, 200);
      const { path: file } = await response.json();
      uploaded.push(file);
      const download = await app.request(`/api/file?path=${encodeURIComponent(file)}`);
      assert.equal(download.headers.get("content-type"), mime);
      assert.equal(await download.text(), "video bytes");
    }
  });

  it("serves seek ranges and rejects unsatisfiable ranges", async () => {
    const file = path.join(dir, "clip.mp4");
    fs.writeFileSync(file, "0123456789");
    const url = `/api/file?path=${encodeURIComponent(file)}`;
    for (const [range, expected, contentRange] of [
      ["bytes=2-5", "2345", "bytes 2-5/10"],
      ["bytes=7-", "789", "bytes 7-9/10"],
      ["bytes=-3", "789", "bytes 7-9/10"],
    ]) {
      const response = await app.request(url, { headers: { Range: range } });
      assert.equal(response.status, 206);
      assert.equal(response.headers.get("content-range"), contentRange);
      assert.equal(await response.text(), expected);
    }
    for (const range of ["bytes=10-", "bytes=8-2", "bytes=-0", "invalid"]) {
      const response = await app.request(url, { headers: { Range: range } });
      assert.equal(response.status, 416);
    }
  });

  it("allows videos above 10 MB while enforcing the 100 MB cap", async () => {
    const response = await app.request("/api/upload", {
      method: "POST",
      headers: { "Content-Type": "video/mp4" },
      body: new Uint8Array(11 * 1024 * 1024),
    });
    assert.equal(response.status, 200);
    const { path: file } = await response.json();
    uploaded.push(file);
    const download = await app.request(`/api/file?path=${encodeURIComponent(file)}`);
    assert.equal(download.status, 200);
    assert.equal((await download.arrayBuffer()).byteLength, 11 * 1024 * 1024);
    for (const [mime, size] of [
      ["video/mp4", 101],
      ["image/png", 11],
    ]) {
      const rejected = await app.request("/api/upload", {
        method: "POST",
        headers: { "Content-Type": mime, "Content-Length": String(size * 1024 * 1024) },
        body: "x",
      });
      assert.equal(rejected.status, 413);
    }
  });
});
