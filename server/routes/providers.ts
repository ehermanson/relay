import type { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import {
  DEFAULT_ACCOUNT_PROFILE_ID,
  type ProviderAccountProfile,
  type ProviderAccountProfileStatus,
  type ProviderDefaults,
  type ProviderKind,
  type ProviderModelsResponse,
} from "#core/types.js";
import {
  listAccountProfiles,
  normalizeConfigDir,
  validateAccountProfileInput,
} from "#core/account-profiles.js";
import { mergeCapabilities, resolveProviderDefaultModelOption } from "#core/provider-catalog.js";
import {
  getProviderAccountIdentitySnapshot,
  getRegisteredProviders,
  probeProviderAccountIdentity,
  refreshProviderVersionAdvisories,
  runProviderUpdate,
} from "#core/provider-registry.js";
import { addMcpServer, listClaudeProjectMcpServers } from "#core/mcp-management.js";
import { readJsonBody } from "#server/hono-utils.js";
import type { AppEnv, HttpDeps } from "#server/route-types.js";
import type { SessionDB } from "#core/db.js";

/** Stored (non-default) profiles from global settings; a corrupt column reads as empty. */
function readStoredProfiles(db: SessionDB): ProviderAccountProfile[] {
  const raw = db.getGlobalSettings().provider_profiles_json;
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as ProviderAccountProfile[]) : [];
  } catch {
    return [];
  }
}

function writeStoredProfiles(db: SessionDB, profiles: ProviderAccountProfile[]): void {
  db.updateGlobalSettings({ provider_profiles_json: JSON.stringify(profiles) });
}

/** Expand a leading `~` and make the path absolute. */
function expandConfigDir(dir: string): string {
  const expanded =
    dir === "~" ? homedir() : dir.startsWith("~/") ? resolve(homedir(), dir.slice(2)) : dir;
  return normalizeConfigDir(resolve(expanded));
}

function toProfileStatus(
  provider: ProviderKind,
  profile: ProviderAccountProfile,
): ProviderAccountProfileStatus {
  return {
    ...profile,
    isDefault: profile.id === DEFAULT_ACCOUNT_PROFILE_ID,
    ...getProviderAccountIdentitySnapshot(provider, profile.configDir),
  };
}

export function registerProviderRoutes(app: Hono<AppEnv>, deps: HttpDeps): void {
  app.get("/api/provider-models", async (c) => {
    const providerParam = c.req.query("provider");
    const provider = deps
      .getAvailableProviders()
      .find((entry) => entry.provider === providerParam)?.provider;
    if (!provider) {
      return c.json({ error: "Invalid provider" }, 400);
    }
    try {
      const capabilities = deps.getProviderCapabilities(provider);
      const models = (await deps.getProviderModels(provider)).map((model) => ({
        ...model,
        resolvedCapabilities: mergeCapabilities(capabilities, model.capabilities),
      }));
      const defaultModel = resolveProviderDefaultModelOption(provider, models);
      const response: ProviderModelsResponse = {
        provider,
        models,
        capabilities,
        defaultModel,
      };
      return c.json(response);
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : "Failed to load provider models" },
        500,
      );
    }
  });

  app.get("/api/providers", (c) => {
    return c.json({ providers: deps.getAvailableProviders() });
  });

  // Force-refresh provider version advisories, bypassing the 1h npm registry
  // cache. Used by the "Re-check" button in settings. Optional `provider`
  // query param scopes the refresh to one provider; absent = refresh all.
  app.post("/api/providers/recheck-version", async (c) => {
    const providerParam = c.req.query("provider");
    const known = deps.getAvailableProviders().map((p) => p.provider);
    if (providerParam && !known.includes(providerParam as ProviderKind)) {
      return c.json({ error: "Invalid provider" }, 400);
    }
    try {
      await refreshProviderVersionAdvisories({
        provider: providerParam ? (providerParam as ProviderKind) : undefined,
        force: true,
      });
      return c.json({ providers: deps.getAvailableProviders() });
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : "Failed to recheck provider version" },
        500,
      );
    }
  });

  // Run the provider's update command server-side (e.g. `brew upgrade codex`).
  // The command is derived from the cached version advisory — the client only
  // names the provider. Responds after the update finishes and the advisory
  // has been re-probed; concurrent requests for the same provider share one
  // run. Used by the "Update now" button in settings.
  app.post("/api/providers/update", async (c) => {
    const providerParam = c.req.query("provider");
    const known = deps.getAvailableProviders().map((p) => p.provider);
    if (!providerParam || !known.includes(providerParam as ProviderKind)) {
      return c.json({ error: "Invalid provider" }, 400);
    }
    const result = await runProviderUpdate(providerParam as ProviderKind);
    // Completed attempts include diagnostics even when the command failed or did nothing.
    return c.json({ result, providers: deps.getAvailableProviders() });
  });

  app.post("/api/providers/:provider/mcp-servers", async (c) => {
    const provider = c.req.param("provider") as ProviderKind;
    if (!deps.getAvailableProviders().some((entry) => entry.provider === provider)) {
      return c.json({ error: "Invalid provider" }, 400);
    }
    const capabilities = deps.getProviderCapabilities(provider);
    const body = await readJsonBody<{
      name?: string;
      url?: string;
      transport?: "http" | "sse" | "stdio";
      command?: string;
      args?: string[];
      bearerTokenEnvVar?: string;
      scope?: "global" | "project";
      projectId?: string;
    }>(c);
    if (!body?.name) return c.json({ error: "Name is required" }, 400);
    const transport = body.transport ?? "http";
    if (!capabilities.mcp?.management?.transports.includes(transport)) {
      return c.json({ error: `Provider does not support ${transport} MCP servers` }, 400);
    }
    try {
      const project =
        body.scope === "project" && body.projectId
          ? deps.instanceManager.projectManager.getProject(body.projectId)
          : undefined;
      if (
        body.scope === "project" &&
        (!project || !capabilities.mcp.management?.scopes.includes("project"))
      ) {
        return c.json({ error: "Project-scoped MCP configuration is unavailable" }, 400);
      }
      await addMcpServer({
        provider,
        name: body.name,
        url: body.url,
        transport,
        command: body.command,
        args: body.args,
        scope: body.scope ?? "global",
        projectDirectory: project?.directory,
        bearerTokenEnvVar: body.bearerTokenEnvVar,
      });
      if (body.scope !== "project") {
        await deps.instanceManager.ensureProviderGlobalState(provider, true);
        deps.instanceManager.recordManagedMcpConfiguration(provider, body.name.trim());
      }
      return c.json({ ok: true });
    } catch (error) {
      return c.json(
        { error: error instanceof Error ? error.message : "Failed to add MCP server" },
        400,
      );
    }
  });

  app.get("/api/providers/:provider/mcp-servers", async (c) => {
    const provider = c.req.param("provider") as ProviderKind;
    const projectId = c.req.query("projectId");
    if (provider !== "claude" || !projectId) return c.json({ servers: [] });
    const project = deps.instanceManager.projectManager.getProject(projectId);
    if (!project) return c.json({ error: "Project not found" }, 404);
    return c.json({ servers: await listClaudeProjectMcpServers(project.directory) });
  });

  // ---------------------------------------------------------------------------
  // Account profiles — one provider login per config dir. The server's own
  // resolved dir is the implicit default (never stored, never removable);
  // user-added dirs live in global_settings.provider_profiles_json. Identity is
  // probed through the provider driver and cached per dir; profiles are only
  // mutated here (PATCH /api/settings ignores `providerProfiles`).
  // ---------------------------------------------------------------------------

  const { instanceManager, config } = deps;

  const resolveProfileProvider = (
    raw: string,
  ): { provider: ProviderKind; supported: boolean } | null => {
    const provider = raw as ProviderKind;
    if (!getRegisteredProviders().includes(provider)) return null;
    const supported = deps.getProviderCapabilities(provider)?.supportsAccountProfiles === true;
    return { provider, supported };
  };

  const profilesFor = (provider: ProviderKind): ProviderAccountProfile[] =>
    listAccountProfiles(
      readStoredProfiles(instanceManager.sessionDb),
      provider,
      instanceManager.getProviderDirs()[provider],
    );

  // Fire-and-forget: the driver dedupes in-flight probes and honours its own
  // TTL, so calling this on every list is a cache hit in the common case.
  const kickProbe = (provider: ProviderKind, profile: ProviderAccountProfile, force: boolean) => {
    void probeProviderAccountIdentity(provider, profile.configDir, config.logger, { force }).catch(
      () => {},
    );
  };

  app.get("/api/providers/:provider/profiles", (c) => {
    const resolved = resolveProfileProvider(c.req.param("provider"));
    if (!resolved) return c.json({ error: "Unknown provider" }, 404);
    if (!resolved.supported) return c.json([]);
    const force = c.req.query("probe") === "1";
    const profiles = profilesFor(resolved.provider);
    const rows = profiles.map((profile) => toProfileStatus(resolved.provider, profile));
    // Unknown or expired snapshots get a background probe; fresh ones are a
    // no-op inside the driver's TTL. `?probe=1` bypasses the TTL for all.
    for (const profile of profiles) kickProbe(resolved.provider, profile, force);
    return c.json(rows);
  });

  app.post("/api/providers/:provider/profiles", async (c) => {
    const resolved = resolveProfileProvider(c.req.param("provider"));
    if (!resolved) return c.json({ error: "Unknown provider" }, 404);
    if (!resolved.supported)
      return c.json({ error: "Provider does not support account profiles" }, 400);
    const { provider } = resolved;
    let body: { label?: unknown; configDir?: unknown } | null;
    try {
      body = await readJsonBody(c);
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    if (!body) return c.json({ error: "Invalid JSON body" }, 400);

    const existing = profilesFor(provider);
    let validated: { label: string; configDir: string };
    try {
      validated = validateAccountProfileInput(body, existing);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "Invalid profile" }, 400);
    }

    const configDir = expandConfigDir(validated.configDir);
    if (!existsSync(configDir)) {
      return c.json({ error: `Config directory does not exist: ${configDir}` }, 400);
    }
    if (!statSync(configDir).isDirectory()) {
      return c.json({ error: `Config directory is not a directory: ${configDir}` }, 400);
    }
    const defaultDir = normalizeConfigDir(instanceManager.getProviderDirs()[provider]);
    if (configDir === defaultDir) {
      return c.json({ error: "That is already the default account's config directory" }, 400);
    }
    // `~` expansion can collide with a stored absolute path the shape check missed.
    const clash = existing.find((p) => normalizeConfigDir(p.configDir) === configDir);
    if (clash) {
      return c.json({ error: `"${clash.label}" already uses that config directory` }, 400);
    }

    const profile: ProviderAccountProfile = {
      id: randomUUID(),
      provider,
      label: validated.label,
      configDir,
    };
    writeStoredProfiles(instanceManager.sessionDb, [
      ...readStoredProfiles(instanceManager.sessionDb),
      profile,
    ]);
    instanceManager.refreshAccountProfileRoots();
    kickProbe(provider, profile, true);
    return c.json(toProfileStatus(provider, profile), 201);
  });

  app.patch("/api/providers/:provider/profiles/:id", async (c) => {
    const resolved = resolveProfileProvider(c.req.param("provider"));
    if (!resolved) return c.json({ error: "Unknown provider" }, 404);
    const { provider } = resolved;
    const id = c.req.param("id");
    if (id === DEFAULT_ACCOUNT_PROFILE_ID) {
      return c.json({ error: "The default account cannot be renamed" }, 400);
    }
    let body: { label?: unknown } | null;
    try {
      body = await readJsonBody(c);
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    if (!body) return c.json({ error: "Invalid JSON body" }, 400);

    const stored = readStoredProfiles(instanceManager.sessionDb);
    const target = stored.find((p) => p.id === id && p.provider === provider);
    if (!target) return c.json({ error: "Profile not found" }, 404);

    let validated: { label: string };
    try {
      validated = validateAccountProfileInput(
        { label: body.label, configDir: target.configDir },
        profilesFor(provider),
        { excludeId: id },
      );
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "Invalid profile" }, 400);
    }

    const updated: ProviderAccountProfile = { ...target, label: validated.label };
    writeStoredProfiles(
      instanceManager.sessionDb,
      stored.map((p) => (p.id === id ? updated : p)),
    );
    // Roots can't change on rename; the call is memoized on the stored JSON
    // and keeps every profile mutation on the same refresh path.
    instanceManager.refreshAccountProfileRoots();
    return c.json(toProfileStatus(provider, updated));
  });

  app.delete("/api/providers/:provider/profiles/:id", (c) => {
    const resolved = resolveProfileProvider(c.req.param("provider"));
    if (!resolved) return c.json({ error: "Unknown provider" }, 404);
    const { provider } = resolved;
    const id = c.req.param("id");
    if (id === DEFAULT_ACCOUNT_PROFILE_ID) {
      return c.json({ error: "The default account cannot be removed" }, 400);
    }
    const db = instanceManager.sessionDb;
    const stored = readStoredProfiles(db);
    if (!stored.some((p) => p.id === id && p.provider === provider)) {
      return c.json({ error: "Profile not found" }, 404);
    }
    writeStoredProfiles(
      db,
      stored.filter((p) => p.id !== id),
    );

    // Clear dangling references. Chats already bound to this dir keep their
    // `managed_sessions.config_dir` — they still work, they just aren't a
    // named profile any more.
    const settings = db.getGlobalSettings();
    if (settings.provider_defaults_json) {
      let defaults: Record<string, ProviderDefaults> = {};
      try {
        defaults = JSON.parse(settings.provider_defaults_json);
      } catch {}
      if (defaults[provider]?.profileId === id) {
        defaults = { ...defaults, [provider]: { ...defaults[provider], profileId: null } };
        db.updateGlobalSettings({ provider_defaults_json: JSON.stringify(defaults) });
      }
    }
    const clearedProjects = db.clearProjectDefaultProfile(id);
    instanceManager.refreshAccountProfileRoots();
    return c.json({ ok: true, clearedProjects });
  });

  app.post("/api/providers/:provider/profiles/:id/probe", async (c) => {
    const resolved = resolveProfileProvider(c.req.param("provider"));
    if (!resolved) return c.json({ error: "Unknown provider" }, 404);
    if (!resolved.supported)
      return c.json({ error: "Provider does not support account profiles" }, 400);
    const { provider } = resolved;
    const id = c.req.param("id");
    const profile = profilesFor(provider).find((p) => p.id === id);
    if (!profile) return c.json({ error: "Profile not found" }, 404);
    // Awaited: a forced probe spawns a provider process (30s worst case).
    await probeProviderAccountIdentity(provider, profile.configDir, config.logger, { force: true });
    return c.json(toProfileStatus(provider, profile));
  });
}
