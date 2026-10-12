import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { createBackendSupervisor, attachedServerURL } from "./runtime.mjs";

class Child extends EventEmitter {
  messages = [];
  postMessage(message) {
    this.messages.push(message);
    if (message.type === "stop") queueMicrotask(() => this.emit("exit", 0));
  }
  kill() {
    this.emit("exit", 1);
  }
}
function fixture(options = {}) {
  const children = [];
  const supervisor = createBackendSupervisor({
    spawn() {
      const child = new Child();
      children.push(child);
      return child;
    },
    retryDelays: [1, 1],
    ...options,
  });
  return { children, supervisor };
}
const bootstrap = { home: "/test/home", password: "private" };

test("unexpected exit refreshes readiness/auth, rejects stale requests, and restarts with bounded retries", async () => {
  const ready = [];
  const failures = [];
  const { supervisor, children } = fixture({
    onReady: (message) => ready.push(message.cookie),
    onFailure: (error) => failures.push(error),
  });
  const initial = supervisor.start(bootstrap);
  children[0].emit("message", { type: "ready", url: "http://127.0.0.1:1", cookie: "first" });
  await initial;
  const pending = supervisor.request("status");
  const rejected = assert.rejects(pending, /restarted/);
  children[0].emit("exit", 1);
  await rejected;
  await delay(10);
  assert.equal(children.length, 2);
  assert.deepEqual(children[1].messages[0], { ...bootstrap, type: "start" });
  children[1].emit("message", { type: "ready", url: "http://127.0.0.1:1", cookie: "second" });
  await delay(0);
  assert.deepEqual(ready, ["first", "second"]);
  children[1].emit("exit", 1);
  await delay(10);
  children[2].emit("exit", 1);
  await delay(10);
  assert.equal(children.length, 3);
  assert.equal(failures.length, 1);
  await supervisor.stop();
});

test("IPC requests match IDs and intentional shutdown never restarts", async () => {
  const { supervisor, children } = fixture();
  const initial = supervisor.start(bootstrap);
  children[0].emit("message", { type: "ready", cookie: "auth" });
  await initial;
  const request = supervisor.request("status");
  const sent = children[0].messages.at(-1);
  children[0].emit("message", { type: "response", requestId: "wrong", result: "wrong" });
  children[0].emit("message", {
    type: "response",
    requestId: sent.requestId,
    result: { activeCount: 2 },
  });
  assert.deepEqual(await request, { activeCount: 2 });
  await supervisor.stop();
  await delay(10);
  assert.equal(children.length, 1);
  await assert.rejects(supervisor.request("status"), /unavailable/);
});

test("shutdown during restart backoff cancels the next child", async () => {
  const { supervisor, children } = fixture({ retryDelays: [50] });
  const initial = supervisor.start(bootstrap);
  children[0].emit("message", { type: "ready" });
  await initial;
  children[0].emit("exit", 1);
  await supervisor.stop();
  await delay(70);
  assert.equal(children.length, 1);
});

test("explicit attachment accepts secure origins and rejects credentials or non-loopback HTTP", () => {
  assert.equal(attachedServerURL("https://relay.example"), "https://relay.example");
  assert.equal(attachedServerURL("http://127.0.0.1:7777"), "http://127.0.0.1:7777");
  for (const url of [
    "http://192.168.1.2:7777",
    "https://user:password@relay.example",
    "https://relay.example/path",
    "https://relay.example?token=secret",
    "file:///tmp/test",
  ])
    assert.throws(() => attachedServerURL(url));
});
