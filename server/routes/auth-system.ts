import fs from "node:fs";
import path from "node:path";
import { networkInterfaces } from "node:os";
import type { Hono } from "hono";
import type { AppEnv, HttpDeps } from "#server/route-types.js";
import { getSession, readJsonBody, type AppContext } from "#server/hono-utils.js";

function isTailscaleAddress(address: string): boolean {
  const match = /^100\.(\d+)\./.exec(address);
  if (!match) return false;
  const second = Number(match[1]);
  return Number.isInteger(second) && second >= 64 && second <= 127;
}

function getConnectEndpoints(
  port: number,
  tunnelUrl?: string | null,
): Array<{
  id: string;
  label: string;
  url: string;
  kind: "tailscale" | "lan" | "localhost" | "tunnel";
}> {
  const endpoints: Array<{
    id: string;
    label: string;
    url: string;
    kind: "tailscale" | "lan" | "localhost" | "tunnel";
  }> = [];
  const seen = new Set<string>();

  const addEndpoint = (
    url: string,
    label: string,
    kind: "tailscale" | "lan" | "localhost" | "tunnel",
    id: string,
  ) => {
    if (seen.has(url)) return;
    seen.add(url);
    endpoints.push({ id, label, url, kind });
  };

  if (tunnelUrl) {
    addEndpoint(tunnelUrl, `Remote URL (${new URL(tunnelUrl).host})`, "tunnel", "tunnel");
  }

  addEndpoint(`http://localhost:${port}`, "This machine only", "localhost", "localhost");

  for (const [name, addresses] of Object.entries(networkInterfaces())) {
    if (!addresses) continue;
    for (const address of addresses) {
      if (address.internal || address.family !== "IPv4") continue;
      if (isTailscaleAddress(address.address) || name.startsWith("tailscale")) {
        addEndpoint(
          `http://${address.address}:${port}`,
          `Tailscale (${address.address})`,
          "tailscale",
          `tailscale:${address.address}`,
        );
        continue;
      }

      addEndpoint(
        `http://${address.address}:${port}`,
        `LAN (${address.address})`,
        "lan",
        `lan:${address.address}`,
      );
    }
  }

  return endpoints.sort((a, b) => {
    const rank = { tunnel: 0, tailscale: 1, lan: 2, localhost: 3 };
    return rank[a.kind] - rank[b.kind] || a.label.localeCompare(b.label);
  });
}

export function registerPublicSystemRoutes(app: Hono<AppEnv>, deps: HttpDeps): void {
  const { auth, config, instanceManager, packageVersion, selfGitInfo, startedAt } = deps;

  function getRequestIp(c: AppContext): string {
    const forwarded = c.req.header("x-forwarded-for");
    const rawIp =
      (typeof forwarded === "string" ? forwarded.split(",")[0].trim() : null) ||
      c.env.incoming.socket.remoteAddress ||
      "unknown";
    return rawIp.startsWith("::ffff:") ? rawIp.slice(7) : rawIp;
  }

  // Resolve space name once (won't change for this server's lifetime)
  let resolvedGit: { branch: string; isWorktree: boolean; spaceName?: string } | null | undefined;
  function getGitInfo() {
    if (resolvedGit !== undefined) return resolvedGit;
    if (!selfGitInfo) {
      resolvedGit = null;
      return null;
    }
    if (!selfGitInfo.isWorktree || !selfGitInfo.worktreePath) {
      resolvedGit = { branch: selfGitInfo.branch, isWorktree: selfGitInfo.isWorktree };
      return resolvedGit;
    }
    try {
      const space = instanceManager
        .getSpaceManager()
        .getSpaceByWorktreePath(selfGitInfo.worktreePath);
      resolvedGit = {
        branch: selfGitInfo.branch,
        isWorktree: true,
        ...(space?.name ? { spaceName: space.name } : {}),
      };
    } catch {
      // DB not ready on first call — leave uncached so next call retries
      return { branch: selfGitInfo.branch, isWorktree: true };
    }
    return resolvedGit;
  }

  app.get("/health", (c) => {
    const uptimeSeconds = Math.floor((Date.now() - startedAt) / 1000);
    return c.json({
      status: "ok",
      uptime: uptimeSeconds,
      instances: instanceManager.listInstances().length,
      version: packageVersion,
      authRequired: auth.authRequired,
      git: getGitInfo(),
    });
  });

  app.post("/auth", async (c) => {
    // Open mode — no password needed, auto-succeed
    if (!auth.authRequired) {
      return c.json({ success: true }, 200);
    }

    const ip = getRequestIp(c);

    if (!auth.checkRateLimit(ip)) {
      config.logger.warn(`Rate limit exceeded for ${ip}`);
      return c.json({ error: "Too many attempts. Try again later." }, 429);
    }

    let body: { password?: string };
    try {
      body = await readJsonBody<{ password?: string }>(c);
    } catch {
      return c.json({ error: "Invalid JSON" }, 400);
    }

    if (auth.verifyPassword(body.password)) {
      const session = auth.createSession();
      c.header("Set-Cookie", auth.serializeSessionCookie(session.id));
      return c.json({ success: true }, 200);
    }

    return c.json({ error: "Wrong password" }, 401);
  });

  app.post("/auth/pair", async (c) => {
    if (!auth.authRequired) {
      return c.json({ error: "Pairing is unavailable when auth is disabled" }, 400);
    }

    const ip = getRequestIp(c);
    if (!auth.checkRateLimit(ip)) {
      config.logger.warn(`Pairing rate limit exceeded for ${ip}`);
      return c.json({ error: "Too many attempts. Try again later." }, 429);
    }

    let body: { code?: string };
    try {
      body = await readJsonBody<{ code?: string }>(c);
    } catch {
      return c.json({ error: "Invalid JSON" }, 400);
    }

    const session = auth.consumePairingCode(body.code);
    if (!session) {
      return c.json({ error: "Invalid or expired pairing code" }, 401);
    }

    c.header("Set-Cookie", auth.serializeSessionCookie(session.id));
    return c.json({ success: true }, 200);
  });

  app.get("/logout", (c) => {
    const session = getSession(c);
    if (session) {
      auth.deleteSession(session.id);
    }
    c.header("Set-Cookie", auth.clearSessionCookie());
    return c.redirect("/login", 302);
  });
}

export function registerProtectedSystemRoutes(api: Hono<AppEnv>, deps: HttpDeps): void {
  const { auth, instanceManager, startedAt } = deps;

  api.get("/api/stats", (c) => {
    const allInstances = instanceManager.listInstances();
    const uptimeSeconds = Math.floor((Date.now() - startedAt) / 1000);

    let active = 0;
    let idle = 0;
    let external = 0;
    let stopped = 0;
    let currentTokens = 0;

    for (const inst of allInstances) {
      if (inst.status === "processing") active++;
      else if (inst.status === "idle") idle++;
      else if (inst.status === "stopped") stopped++;
      if (inst.external) external++;
      if (inst.stats) {
        currentTokens += inst.stats.inputTokens + inst.stats.outputTokens;
      }
    }

    const allTime = instanceManager.getGlobalStats();
    return c.json({
      instances: {
        total: allInstances.length,
        active,
        idle,
        stopped,
        external,
      },
      currentSessions: {
        tokens: currentTokens,
      },
      allTime: {
        sessionCount: allTime.sessionCount,
        inputTokens: allTime.inputTokens,
        outputTokens: allTime.outputTokens,
        cacheCreationTokens: allTime.cacheCreationTokens,
        cacheReadTokens: allTime.cacheReadTokens,
        tokens: allTime.inputTokens + allTime.outputTokens,
      },
      uptime: uptimeSeconds,
      connections: deps.getConnectionCount ? deps.getConnectionCount() : 0,
    });
  });

  api.get("/api/beads-projects", (c) => {
    return c.json(
      instanceManager
        .getKnownDirectories()
        .filter((entry) => fs.existsSync(path.join(entry.path, ".beads"))),
    );
  });

  api.post("/api/pairing", (c) => {
    if (!auth.authRequired) {
      return c.json({ error: "Pairing is unavailable when auth is disabled" }, 400);
    }

    const pairingCode = auth.createPairingCode();
    return c.json({
      code: pairingCode.code,
      createdAt: pairingCode.createdAt,
      expiresAt: pairingCode.expiresAt,
    });
  });

  api.get("/api/connect-endpoints", (c) => {
    return c.json({
      endpoints: getConnectEndpoints(deps.config.port, deps.getTunnelUrl?.()),
    });
  });
}
