// Isolate worktrees/git env even when this file is run directly with `node --test`.
import "./test-env.js";
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import webpush from "web-push";
import { PushNotifications, resolvePushContact } from "../dist/server/push-notifications.js";

const tempDirs = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "relay-push-test-"));
  tempDirs.push(dir);
  const manager = new EventEmitter();
  const instance = {
    id: "chat-1",
    provider: "codex",
    name: "Fix parser",
    workingDirectory: "/tmp/parser",
    projectSlug: "parser",
    status: "idle",
    lastActivityAt: 1,
  };
  manager.getInstance = () => instance;
  let valid = true;
  const auth = {
    authRequired: true,
    validateSession: (id) => (valid && id === "session-1" ? { id } : null),
  };
  const push = new PushNotifications(auth, manager, { dbPath: join(dir, "sessions.db") });
  return {
    manager,
    instance,
    auth,
    push,
    setValid: (next) => {
      valid = next;
    },
    dir,
  };
}

const subscription = {
  endpoint: "https://web.push.apple.com/test-endpoint",
  keys: { p256dh: "test-key", auth: "test-auth" },
};

describe("background notifications", () => {
  it("rejects local push endpoints and persists per-session subscriptions", () => {
    const { push, manager, auth, dir } = fixture();
    assert.throws(() =>
      push.subscribe("session-1", { ...subscription, endpoint: "https://127.0.0.1/private" }),
    );
    push.subscribe("session-1", subscription);
    assert.equal(push.has("session-1", subscription.endpoint), true);
    const reopened = new PushNotifications(auth, manager, { dbPath: join(dir, "sessions.db") });
    assert.equal(reopened.publicKey, push.publicKey);
    assert.equal(reopened.has("session-1", subscription.endpoint), true);
    reopened.unsubscribe("session-1", subscription.endpoint);
    assert.equal(reopened.has("session-1", subscription.endpoint), false);
  });

  it("pushes turn completion only in background and drops revoked sessions", async () => {
    const { push, manager, instance, setValid } = fixture();
    push.subscribe("session-1", subscription);
    const original = webpush.sendNotification;
    const delivered = [];
    webpush.sendNotification = async (_target, payload) => {
      delivered.push(JSON.parse(payload));
      return {};
    };
    try {
      const finish = async () => {
        manager.emit("instance:user", instance.id, { type: "user", text: "go" });
        manager.emit("instance:status", instance.id, { ...instance, status: "processing" });
        manager.emit("instance:status", instance.id, { ...instance, status: "idle" });
        await new Promise((resolve) => setImmediate(resolve));
      };
      push.setPresence("session-1", subscription.endpoint, "*");
      await finish();
      assert.equal(delivered.length, 0);
      push.setPresence("session-1", subscription.endpoint, null);
      await finish();
      assert.equal(delivered.length, 1);
      assert.equal(delivered[0].url, "/projects/parser/chats/chat-1");
      setValid(false);
      await finish();
      assert.equal(delivered.length, 1);
      assert.equal(push.has("session-1", subscription.endpoint), false);
    } finally {
      webpush.sendNotification = original;
    }
  });
});

describe("resolvePushContact", () => {
  it("defaults to the repo URL and accepts only mailto/https overrides", () => {
    assert.equal(resolvePushContact(undefined), "https://github.com/ehermanson/relay");
    assert.equal(resolvePushContact("  "), "https://github.com/ehermanson/relay");
    assert.equal(resolvePushContact("mailto:me@example.org"), "mailto:me@example.org");
    assert.equal(resolvePushContact("https://relay.example.org"), "https://relay.example.org");
    assert.equal(resolvePushContact("me@example.org"), "https://github.com/ehermanson/relay");
  });
});
