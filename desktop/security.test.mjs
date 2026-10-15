import test from "node:test";
import assert from "node:assert/strict";
import { isLocalURL, externalURL, chatPath } from "./security.mjs";
test("desktop trust requires exact loopback origin", () => {
  assert.equal(isLocalURL("http://127.0.0.1:7777/projects/a", "http://127.0.0.1:7777"), true);
  for (const url of ["http://127.0.0.1:7778/", "https://evil.test/", "garbage"])
    assert.equal(isLocalURL(url, "http://127.0.0.1:7777"), false);
});
test("external links reject executable protocols and credentials", () => {
  for (const url of ["file:///tmp/secret", "javascript:alert(1)", "https://user:pass@example.com"])
    assert.equal(externalURL(url), null);
  assert.equal(externalURL("https://example.com/a"), "https://example.com/a");
});
test("notification activation cannot leave application origin", () => {
  for (const path of ["//evil.test", "/\\evil.test", "https://evil.test", "/\nfoo"])
    assert.equal(chatPath(path), "/");
  assert.equal(chatPath("/projects/a/chats/b"), "/projects/a/chats/b");
});

test("native windows cannot load file HTML through direct loads or dot paths", async () => {
  const { applicationPath } = await import("./security.mjs");
  for (const path of [
    "/api/file?path=/tmp/evil.html",
    "/projects/../api/file",
    "/projects/%2e%2e/api/file",
    "//evil.test",
    "/assets/evil.html",
  ])
    assert.equal(applicationPath(path), null);
  assert.equal(applicationPath("/projects/p/chats/c"), "/projects/p/chats/c");
});

test("the trusted renderer can copy text but cannot read clipboard or request media", async () => {
  const { allowedPermission } = await import("./security.mjs");
  const origin = "http://127.0.0.1:7777";
  assert.equal(allowedPermission("clipboard-sanitized-write", origin, origin), true);
  for (const permission of ["clipboard-read", "media", "notifications", "geolocation"])
    assert.equal(allowedPermission(permission, origin, origin), false);
  assert.equal(allowedPermission("clipboard-sanitized-write", "https://evil.test", origin), false);
});
