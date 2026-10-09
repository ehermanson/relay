import "./test-env.js";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, writeFile, stat, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTunnelSupervisor } from "../dist/server/tunnel.js";
import {
  readTunnelSettings,
  saveTunnelSettings,
  normalizeTunnelUrl,
} from "../dist/server/tunnel-settings.js";
import { runTunnelCommand } from "../dist/cli/tunnel.js";

async function withHome(fn) {
  const home = await mkdtemp(join(tmpdir(), "relay-tunnel-test-"));
  try {
    await fn(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

function harness(named) {
  const processes = [];
  const calls = [];
  const pending = [];
  const urls = [];
  const logs = [];
  const deps = {
    spawn(binary, args, options) {
      calls.push({ binary, args, options });
      const child = new EventEmitter();
      child.stderr = new EventEmitter();
      child.killed = false;
      child.kill = () => {
        child.killed = true;
      };
      processes.push(child);
      return child;
    },
    setTimeout(fn, delay) {
      const timer = { fn, delay, cancelled: false, unref() {} };
      pending.push(timer);
      return timer;
    },
    clearTimeout(timer) {
      timer.cancelled = true;
    },
    log(text) {
      logs.push(text);
    },
    warn(text) {
      logs.push(text);
    },
  };
  const supervisor = createTunnelSupervisor(7777, { named, onUrl: (url) => urls.push(url) }, deps);
  return { supervisor, processes, calls, pending, urls, logs };
}

const named = { publicUrl: "https://relay.example.com", tokenFile: "/private/tunnel-token" };

describe("Cloudflare connector lifecycle", () => {
  it("starts named connectors with a token file, never a token in argv", () => {
    const h = harness(named);
    assert.deepEqual(h.calls[0].args, [
      "tunnel",
      "--no-autoupdate",
      "run",
      "--token-file",
      named.tokenFile,
    ]);
    assert.deepEqual(h.urls, [named.publicUrl]);
    h.processes[0].stderr.emit("data", Buffer.from("secret-output Registered tunnel connection"));
    assert.ok(h.logs.some((log) => log.includes("Permanent URL")));
    assert.ok(h.logs.every((log) => !log.includes("secret-output")));
    h.supervisor.stop();
    assert.ok(h.processes[0].killed);
    assert.equal(h.urls.at(-1), null);
  });

  it("does not let an inherited token override the saved named connector", () => {
    const oldToken = process.env.TUNNEL_TOKEN;
    const oldFile = process.env.TUNNEL_TOKEN_FILE;
    try {
      process.env.TUNNEL_TOKEN = "unrelated_shell_token";
      process.env.TUNNEL_TOKEN_FILE = "/unrelated/shell-token";
      const h = harness(named);
      assert.equal(h.calls[0].options.env.TUNNEL_TOKEN, undefined);
      assert.equal(h.calls[0].options.env.TUNNEL_TOKEN_FILE, undefined);
      assert.ok(h.logs.every((log) => !log.includes("unrelated_shell_token")));
      h.supervisor.stop();
    } finally {
      if (oldToken === undefined) delete process.env.TUNNEL_TOKEN;
      else process.env.TUNNEL_TOKEN = oldToken;
      if (oldFile === undefined) delete process.env.TUNNEL_TOKEN_FILE;
      else process.env.TUNNEL_TOKEN_FILE = oldFile;
    }
  });

  it("retries crashed connectors with capped backoff and cancels retries on stop", () => {
    const h = harness(named);
    for (let i = 0; i < 7; i++) {
      h.processes[i].emit("close", 1);
      assert.equal(h.pending[i].delay, Math.min(1000 * 2 ** i, 30000));
      if (i < 6) h.pending[i].fn();
    }
    h.supervisor.stop();
    assert.ok(h.pending[6].cancelled);
    // A callback already dispatched while stopping must not start another process.
    h.pending[6].fn();
    assert.equal(h.processes.length, 7);
  });

  it("does not resurrect an intentionally stopped connector or retry a missing binary", () => {
    const h = harness(named);
    h.supervisor.stop();
    h.processes[0].emit("close", null);
    assert.equal(h.pending.length, 0);
    const missing = harness(named);
    missing.processes[0].emit("error", Object.assign(new Error("missing"), { code: "ENOENT" }));
    missing.processes[0].emit("close", -2);
    assert.equal(missing.pending.length, 0);
    missing.supervisor.stop();
  });

  it("discovers split quick-tunnel output, clears the old link, and publishes the replacement", () => {
    const h = harness();
    assert.deepEqual(h.calls[0].args, ["tunnel", "--url", "http://localhost:7777"]);
    h.processes[0].stderr.emit("data", Buffer.from("https://first-link.trycloud"));
    h.processes[0].stderr.emit("data", Buffer.from("flare.com"));
    assert.equal(h.urls.at(-1), "https://first-link.trycloudflare.com");
    h.processes[0].emit("close", 1);
    assert.equal(h.urls.at(-1), null);
    h.pending[0].fn();
    h.processes[1].stderr.emit("data", Buffer.from("https://next-link.trycloudflare.com"));
    assert.equal(h.urls.at(-1), "https://next-link.trycloudflare.com");
    // A late event from the old process must not erase the replacement.
    h.processes[0].stderr.emit("data", Buffer.from("https://old-link.trycloudflare.com"));
    assert.equal(h.urls.at(-1), "https://next-link.trycloudflare.com");
    h.supervisor.stop();
  });

  it("resets crash backoff after the named connector registers", () => {
    const h = harness(named);
    h.processes[0].emit("close", 1);
    h.pending[0].fn();
    h.processes[1].stderr.emit("data", Buffer.from("Registered tunnel connection"));
    h.processes[1].emit("close", 1);
    assert.equal(h.pending[1].delay, 1000);
    h.supervisor.stop();
  });
});

describe("saved named tunnels", () => {
  it("imports private credentials, persists the origin, and removes replaced credentials", async () => {
    await withHome(async (home) => {
      const tokenFile = join(home, "input-token");
      await writeFile(tokenFile, "example_connector_token\n");
      const saved = await saveTunnelSettings("https://RELAY.example.com/", tokenFile, home);
      assert.equal(saved.publicUrl, "https://relay.example.com");
      assert.deepEqual(await readTunnelSettings(home), saved);
      assert.equal((await stat(saved.tokenFile)).mode & 0o777, 0o600);
      assert.equal((await stat(join(home, "tunnel.json"))).mode & 0o777, 0o600);
      assert.ok(
        !(await readFile(join(home, "tunnel.json"), "utf8")).includes("example_connector_token"),
      );
      const replaced = await saveTunnelSettings("https://new.example.com", tokenFile, home);
      assert.notEqual(replaced.tokenFile, saved.tokenFile);
      await assert.rejects(access(saved.tokenFile), { code: "ENOENT" });
    });
  });

  it("rejects unsafe origins and empty tokens without replacing saved configuration", async () => {
    for (const url of [
      "http://relay.example.com",
      "https://user:password@relay.example.com",
      "https://relay.example.com/path",
      "https://relay.example.com?token=secret",
      "https://relay.example.com:7777",
      "https://localhost",
      "https://127.0.0.1",
    ]) {
      assert.throws(() => normalizeTunnelUrl(url));
    }
    await withHome(async (home) => {
      const tokenFile = join(home, "input-token");
      await writeFile(tokenFile, "valid_token");
      const saved = await saveTunnelSettings(named.publicUrl, tokenFile, home);
      await writeFile(tokenFile, "\n");
      await assert.rejects(saveTunnelSettings("https://new.example.com", tokenFile, home));
      assert.deepEqual(await readTunnelSettings(home), saved);
    });
  });

  it("fails closed on malformed configuration and traversal outside the Relay home", async () => {
    await withHome(async (home) => {
      assert.equal(await readTunnelSettings(home), null);
      await writeFile(join(home, "tunnel.json"), "invalid-json");
      await assert.rejects(readTunnelSettings(home));
      await writeFile(
        join(home, "tunnel.json"),
        JSON.stringify({ publicUrl: named.publicUrl, tokenFile: "../token" }),
      );
      await assert.rejects(readTunnelSettings(home), /Invalid tunnel/);
    });
  });

  it("CLI configure/status/disable roundtrip never prints a credential", async () => {
    await withHome(async (home) => {
      const source = join(home, "input-token");
      const output = [];
      const options = {
        home,
        stdout: (text) => output.push(text),
        stderr: (text) => output.push(text),
      };
      await writeFile(source, "private_connector_token");
      assert.equal(
        await runTunnelCommand(
          ["configure", "--url", named.publicUrl, "--token-file", source],
          options,
        ),
        0,
      );
      const saved = await readTunnelSettings(home);
      assert.equal(await runTunnelCommand(["status"], options), 0);
      assert.ok(output.some((text) => text.includes(named.publicUrl)));
      assert.ok(output.every((text) => !text.includes("private_connector_token")));
      assert.equal(
        await runTunnelCommand(
          ["configure", "--url", "http://invalid", "--token-file", source],
          options,
        ),
        1,
      );
      assert.deepEqual(await readTunnelSettings(home), saved);
      assert.equal(await runTunnelCommand(["disable"], options), 0);
      assert.equal(await readTunnelSettings(home), null);
      await assert.rejects(access(saved.tokenFile), { code: "ENOENT" });
      assert.equal(await runTunnelCommand(["disable"], options), 0);
      assert.equal(await runTunnelCommand(["configure", "--url", named.publicUrl], options), 1);
    });
  });
});
