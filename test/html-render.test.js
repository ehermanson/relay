import "./test-env.js";
/**
 * Inline HTML pages (`html_render`): page preparation, the tool's validation,
 * storage and history on the manager, and the sandboxed route.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Hono } from "hono";
import {
  findViewportHeightUnit,
  HTML_RENDER_CONTENT_SECURITY_POLICY,
  HTML_RENDER_EVENT,
  HTML_RENDER_MAX_BYTES,
  injectHtmlRenderBootstrap,
  readHtmlRenderReference,
} from "../dist/server/core/html-render.js";
import { HtmlRenderImageError, inlineLocalImages } from "../dist/server/core/html-render-images.js";
import { handleMcpPayload } from "../dist/server/core/orchestration/mcp-protocol.js";
import { createRelayMcpServer } from "../dist/server/core/orchestration/tools.js";
import { InstanceManager } from "../dist/server/core/instance-manager.js";
import { resolveConfig } from "../dist/server/config.js";
import { noopLogger } from "../dist/server/core/logger.js";
import { registerInstanceRoutes } from "../dist/server/routes/instances.js";

const RENDER_ID = "0f3a2c1e-1111-4222-8333-444455556666";
// A 1x1 transparent PNG.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);
const PNG_URI = `data:image/png;base64,${PNG.toString("base64")}`;

describe("html render pages", () => {
  it("injects the theme and bootstrap at the top of head", () => {
    const page = injectHtmlRenderBootstrap(
      '<!doctype html><html><head><meta charset="utf-8"><title>T</title></head><body>x</body></html>',
    );
    const head = page.indexOf("<head>") + "<head>".length;
    assert.equal(page.indexOf('<meta name="viewport"'), head, "bootstrap opens the head");
    assert.equal(page.match(/charset/g).length, 1, "an existing charset is kept, not repeated");
    const script = /<script>([\s\S]*?)<\/script>/.exec(page)[1];
    assert.doesNotThrow(() => new Function(script), "the bootstrap is valid browser JavaScript");
  });

  it("wraps a fragment and never injects into comments or scripts", () => {
    const fragment = injectHtmlRenderBootstrap("<div>chart</div>");
    assert.match(fragment, /^<!doctype html><html><head>.*<\/head><body><div>chart<\/div>/s);

    const tricky = injectHtmlRenderBootstrap(
      '<!-- <head> --><script>const s = "<head>";</script><html><head></head><body></body></html>',
    );
    assert.ok(tricky.startsWith('<!-- <head> --><script>const s = "<head>";</script>'));
    assert.ok(tricky.indexOf("relay-html-render-theme") > tricky.indexOf("<html><head>"));
  });

  it("finds viewport heights in CSS only", () => {
    assert.equal(findViewportHeightUnit("<style>.a{min-height:50dvh}</style>"), "50dvh");
    assert.equal(findViewportHeightUnit('<div style="height: 100vh">'), "100vh");
    assert.equal(findViewportHeightUnit("<p>Use 100vh sparingly</p>"), undefined);
    assert.equal(findViewportHeightUnit('<img src="data:image/png;base64,AA1vhB">'), undefined);
    assert.equal(findViewportHeightUnit("<!-- <style>a{height:1vh}</style> -->"), undefined);
  });

  it("reads only well-formed references", () => {
    assert.deepEqual(readHtmlRenderReference({ id: RENDER_ID, title: " Chart ", height: 5000 }), {
      id: RENDER_ID,
      title: "Chart",
      height: 2000,
    });
    assert.equal(
      readHtmlRenderReference({ id: "../etc/passwd", title: "x", height: 100 }),
      undefined,
    );
    assert.equal(readHtmlRenderReference(null), undefined);
    assert.equal(readHtmlRenderReference({ id: RENDER_ID }).height, 360);
  });
});

describe("html render local images", () => {
  const dir = mkdtempSync(join(tmpdir(), "relay-html-images-"));
  const png = join(dir, "shot.png");
  const svg = join(dir, "logo.svg");
  writeFileSync(png, PNG);
  writeFileSync(svg, '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"/>');

  it("inlines absolute paths in attributes, CSS, scripts, and file:// URLs", async () => {
    const html = [
      `<img src="${png}">`,
      `<div style="background:url(${png})"></div>`,
      `<script>const logo = '${svg}';</script>`,
      `<img src="file://${png}">`,
      `<img srcset="${png} 1x, ${png} 2x">`,
      `<img srcset="${png}, https://example.com/c.png 3x">`,
    ].join("");
    const out = await inlineLocalImages(html);
    assert.equal(out.split(PNG_URI).length - 1, 6);
    assert.ok(out.includes(`srcset="${PNG_URI} 1x, ${PNG_URI} 2x"`));
    assert.ok(out.includes("https://example.com/c.png 3x"));
    assert.match(out, /const logo = 'data:image\/svg\+xml;base64,/);
    assert.doesNotMatch(out, new RegExp(dir));
  });

  it("leaves pages without local images, and remote URLs, untouched", async () => {
    const html = '<img src="https://example.com/a.png"><img src="//cdn.example.com/b.png">';
    assert.equal(await inlineLocalImages(html), html);
  });

  it("refuses missing images and files that only look like images", async () => {
    const fake = join(dir, "secret.png");
    writeFileSync(fake, "AWS_SECRET=abc");
    const link = join(dir, "link.png");
    symlinkSync(join(dir, "nope.txt"), link);
    await assert.rejects(
      inlineLocalImages(`<img src="${fake}">`),
      (error) => error instanceof HtmlRenderImageError && /Not image files/.test(error.message),
    );
    await assert.rejects(
      inlineLocalImages(`<img src="${join(dir, "missing.png")}"><img src="${link}">`),
      (error) =>
        error instanceof HtmlRenderImageError &&
        error.message.includes("missing.png") &&
        error.message.includes("link.png"),
    );
  });

  it("reports an unreadable image as unreadable, not missing", async (t) => {
    if (process.getuid?.() === 0) return t.skip("root reads everything");
    const locked = join(dir, "locked.png");
    writeFileSync(locked, PNG);
    chmodSync(locked, 0o000);
    await assert.rejects(
      inlineLocalImages(`<img src="${locked}">`),
      (error) =>
        error instanceof HtmlRenderImageError &&
        /Can't read: .*locked\.png/.test(error.message) &&
        !/not found/.test(error.message),
    );
  });
});

describe("html_render tool", () => {
  const server = createRelayMcpServer("test");
  const published = [];
  const host = {
    getChat: (id) => (id === "caller" ? { id: "caller", name: "Caller" } : undefined),
    publishHtmlRender: (callerId, page) => {
      published.push({ callerId, ...page });
      return { id: RENDER_ID, title: page.title, height: page.height };
    },
  };
  const call = async (args) => {
    const response = await handleMcpPayload(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "html_render", arguments: args },
      },
      server,
      { host, callerId: "caller" },
    );
    return response.result;
  };

  it("publishes a valid page into the caller's chat", async () => {
    const result = await call({ html: "<p>hi</p>", title: "Hello", height: 20 });
    assert.equal(result.isError, undefined);
    assert.equal(result.structuredContent.shown, true);
    assert.deepEqual(published.at(-1), {
      callerId: "caller",
      html: "<p>hi</p>",
      title: "Hello",
      height: 80,
    });
    await call({ html: "<p>hi</p>", title: "Default height" });
    assert.equal(published.at(-1).height, 360);
  });

  it("refuses empty, oversized, and viewport-height pages", async () => {
    const before = published.length;
    for (const args of [
      { html: "  ", title: "Empty" },
      { html: "<p>no title</p>" },
      { html: "x".repeat(HTML_RENDER_MAX_BYTES + 1), title: "Big" },
      { html: "<style>body{height:100vh}</style>", title: "Viewport" },
    ]) {
      const result = await call(args);
      assert.equal(result.isError, true, JSON.stringify(args).slice(0, 60));
      assert.equal(result.structuredContent.error.code, "invalid_request");
    }
    assert.equal(published.length, before, "nothing was published");
  });
});

describe("html render storage and route", () => {
  it("stores the page, records it in the chat, and serves it sandboxed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "relay-html-render-"));
    const manager = new InstanceManager(
      resolveConfig({
        logger: noopLogger,
        dbPath: join(dir, "sessions.db"),
        providerDirs: { claude: join(dir, ".claude"), codex: join(dir, ".codex") },
        workingDirectory: dir,
      }),
    );
    const events = [];
    manager.on("instance:system_event", (id, message) => events.push({ id, message }));
    try {
      const info = manager.createInstance({ workingDirectory: dir });
      const shot = join(dir, "shot.png");
      writeFileSync(shot, PNG);
      await assert.rejects(
        manager.publishHtmlRender(info.id, {
          html: `<img src="${join(dir, "gone.png")}">`,
          title: "Broken",
          height: 100,
        }),
        (error) => error.code === "invalid_request" && /gone\.png/.test(error.message),
        "an image that can't be inlined is the agent's error to fix",
      );
      const render = await manager.publishHtmlRender(info.id, {
        html: `<h1>Chart</h1><img src="${shot}">`,
        title: "Chart",
        height: 240,
      });

      const path = manager.getHtmlRenderPath(info.id, render.id);
      assert.ok(path?.startsWith(dir), "pages live next to the DB");
      const stored = readFileSync(path, "utf8");
      assert.match(stored, /relay-html-render-theme/);
      assert.match(stored, /<h1>Chart<\/h1>/);
      assert.ok(stored.includes(PNG_URI), "local images are inlined");

      const entry = manager.instances.get(info.id).history.at(-1).message;
      assert.equal(entry.type, "system_event");
      assert.equal(entry.event, HTML_RENDER_EVENT);
      assert.deepEqual(entry.payload, render);
      assert.equal(events.length, 1);
      const rows = manager.db.getSessionEvents(info.id);
      assert.deepEqual(
        rows.map((row) => [row.event, JSON.parse(row.payload_json)]),
        [[HTML_RENDER_EVENT, render]],
        "persisted so it replays",
      );

      assert.equal(manager.getHtmlRenderPath(info.id, "../../sessions.db"), null);
      assert.equal(manager.getHtmlRenderPath("../x", render.id), null);
      assert.equal(manager.getHtmlRenderPath(info.id, RENDER_ID), null, "unknown page");

      const hono = new Hono();
      registerInstanceRoutes(hono, { instanceManager: manager });
      const ok = await hono.request(`/api/html-renders/${info.id}/${render.id}`);
      assert.equal(ok.status, 200);
      assert.equal(ok.headers.get("content-security-policy"), HTML_RENDER_CONTENT_SECURITY_POLICY);
      assert.match(ok.headers.get("content-security-policy"), /^sandbox /);
      assert.doesNotMatch(ok.headers.get("content-security-policy"), /allow-same-origin/);
      assert.equal(ok.headers.get("x-content-type-options"), "nosniff");
      assert.match(await ok.text(), /<h1>Chart<\/h1>/);
      assert.equal((await hono.request(`/api/html-renders/${info.id}/${RENDER_ID}`)).status, 404);

      manager.removeInstance(info.id, { purge: true });
      assert.equal(existsSync(path), false, "purging a chat deletes its pages");
    } finally {
      manager.stopAll();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
