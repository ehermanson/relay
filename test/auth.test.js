// Isolate worktrees/git env even when this file is run directly with `node --test`.
import "./test-env.js";
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AuthManager } from "../dist/server/auth.js";
import { resolveConfig } from "../dist/server/config.js";

describe("AuthManager", () => {
  let auth;
  let tempDir;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "relay-test-"));
    const config = resolveConfig({
      password: "test",
      rateLimitMax: 3,
      rateLimitWindow: 60_000,
      sessionMaxAge: 60_000,
      sessionFile: join(tempDir, "sessions.json"),
    });
    auth = new AuthManager(config);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("createSession / validateSession", () => {
    it("creates a valid session", () => {
      const session = auth.createSession();
      assert.ok(session.id);
      assert.ok(session.id.length === 64); // 32 bytes hex
      assert.ok(session.createdAt > 0);
      assert.ok(session.expiresAt > session.createdAt);
    });

    it("validates an existing session", () => {
      const session = auth.createSession();
      const found = auth.validateSession(session.id);
      assert.deepEqual(found, session);
    });

    it("returns null for unknown session", () => {
      assert.equal(auth.validateSession("nonexistent"), null);
    });

    it("returns null for undefined", () => {
      assert.equal(auth.validateSession(undefined), null);
    });
  });

  describe("pairing codes", () => {
    it("creates and consumes a pairing code once", () => {
      const pairing = auth.createPairingCode();
      assert.equal(pairing.code.length, 8);

      const session = auth.consumePairingCode(pairing.code);
      assert.ok(session);
      assert.ok(auth.validateSession(session.id));
      assert.equal(auth.consumePairingCode(pairing.code), null);
    });

    it("rejects expired pairing codes", () => {
      const pairing = auth.createPairingCode(1);

      const start = Date.now();
      while (Date.now() - start < 5) {
        // busy-wait a few ms
      }

      assert.equal(auth.consumePairingCode(pairing.code), null);
    });
  });

  describe("deleteSession", () => {
    it("removes a session", () => {
      const session = auth.createSession();
      auth.deleteSession(session.id);
      assert.equal(auth.validateSession(session.id), null);
    });
  });

  describe("getSessionFromCookies", () => {
    it("extracts session from cookie header", () => {
      const session = auth.createSession();
      const found = auth.getSessionFromCookies(`session=${session.id}`);
      assert.deepEqual(found, session);
    });

    it("returns null for missing cookie", () => {
      assert.equal(auth.getSessionFromCookies(undefined), null);
    });

    it("returns null for wrong cookie name", () => {
      const session = auth.createSession();
      assert.equal(auth.getSessionFromCookies(`other=${session.id}`), null);
    });
  });

  describe("serializeSessionCookie", () => {
    it("produces a valid set-cookie string", () => {
      const session = auth.createSession();
      const cookie = auth.serializeSessionCookie(session.id);
      assert.ok(cookie.includes(`session=${session.id}`));
      assert.ok(cookie.includes("HttpOnly"));
      assert.ok(cookie.includes("Path=/"));
    });
  });

  describe("clearSessionCookie", () => {
    it("produces a cookie with Max-Age=0", () => {
      const cookie = auth.clearSessionCookie();
      assert.ok(cookie.includes("session="));
      assert.ok(cookie.includes("Max-Age=0"));
    });
  });

  describe("checkRateLimit", () => {
    it("allows requests under the limit", () => {
      assert.equal(auth.checkRateLimit("1.2.3.4"), true);
      assert.equal(auth.checkRateLimit("1.2.3.4"), true);
      assert.equal(auth.checkRateLimit("1.2.3.4"), true);
    });

    it("blocks after exceeding limit", () => {
      auth.checkRateLimit("1.2.3.4"); // 1
      auth.checkRateLimit("1.2.3.4"); // 2
      auth.checkRateLimit("1.2.3.4"); // 3
      assert.equal(auth.checkRateLimit("1.2.3.4"), false); // 4 > max of 3
    });

    it("tracks IPs independently", () => {
      auth.checkRateLimit("1.1.1.1");
      auth.checkRateLimit("1.1.1.1");
      auth.checkRateLimit("1.1.1.1");
      assert.equal(auth.checkRateLimit("1.1.1.1"), false);
      assert.equal(auth.checkRateLimit("2.2.2.2"), true); // different IP
    });
  });

  describe("verifyPassword", () => {
    it("returns true for the correct password", () => {
      assert.equal(auth.verifyPassword("test"), true);
    });

    it("returns false for a wrong password of the same length", () => {
      assert.equal(auth.verifyPassword("tset"), false);
    });

    it("returns false for a wrong password of a different length", () => {
      assert.equal(auth.verifyPassword("a-much-longer-password"), false);
      assert.equal(auth.verifyPassword(""), false);
    });

    it("returns false for an undefined candidate", () => {
      assert.equal(auth.verifyPassword(undefined), false);
    });

    it("returns false when no password is configured", () => {
      const noPwConfig = resolveConfig({
        password: "",
        rateLimitMax: 3,
        rateLimitWindow: 60_000,
        sessionMaxAge: 60_000,
        sessionFile: join(tempDir, "sessions-nopw.json"),
      });
      const noPwAuth = new AuthManager(noPwConfig);
      assert.equal(noPwAuth.verifyPassword("anything"), false);
      assert.equal(noPwAuth.verifyPassword(""), false);
    });
  });

  describe("session persistence", () => {
    it("survives a restart by loading from file", () => {
      const session = auth.createSession();

      // Create a new AuthManager with the same session file (simulates restart)
      const config2 = resolveConfig({
        password: "test",
        rateLimitMax: 3,
        rateLimitWindow: 60_000,
        sessionMaxAge: 60_000,
        sessionFile: join(tempDir, "sessions.json"),
      });
      const auth2 = new AuthManager(config2);

      const restored = auth2.validateSession(session.id);
      assert.ok(restored, "session should be restored after restart");
      assert.equal(restored.id, session.id);
      assert.equal(restored.createdAt, session.createdAt);
      assert.equal(restored.expiresAt, session.expiresAt);
    });

    it("does not restore expired sessions", () => {
      // Create a config with a very short session lifetime
      const config = resolveConfig({
        password: "test",
        rateLimitMax: 3,
        rateLimitWindow: 60_000,
        sessionMaxAge: 1, // 1ms — will expire immediately
        sessionFile: join(tempDir, "sessions.json"),
      });
      const shortAuth = new AuthManager(config);
      const session = shortAuth.createSession();

      // Wait a tick so the session expires
      const start = Date.now();
      while (Date.now() - start < 5) {
        // busy-wait a few ms
      }

      // New instance should not load the expired session
      const config2 = resolveConfig({
        password: "test",
        rateLimitMax: 3,
        rateLimitWindow: 60_000,
        sessionMaxAge: 60_000,
        sessionFile: join(tempDir, "sessions.json"),
      });
      const auth2 = new AuthManager(config2);
      assert.equal(auth2.validateSession(session.id), null);
    });

    it("persists deletion across restarts", () => {
      const session = auth.createSession();
      auth.deleteSession(session.id);

      const config2 = resolveConfig({
        password: "test",
        rateLimitMax: 3,
        rateLimitWindow: 60_000,
        sessionMaxAge: 60_000,
        sessionFile: join(tempDir, "sessions.json"),
      });
      const auth2 = new AuthManager(config2);
      assert.equal(auth2.validateSession(session.id), null);
    });
  });
});
