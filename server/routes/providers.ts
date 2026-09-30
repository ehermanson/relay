import type { Hono } from "hono";
import { DEFAULT_ACCOUNT_ID, type ProviderKind, type ProviderModelsResponse } from "#core/types.js";
import { mergeCapabilities, resolveProviderDefaultModelOption } from "#core/provider-catalog.js";
import { refreshProviderVersionAdvisories, runProviderUpdate } from "#core/provider-registry.js";
import { addMcpServer, listClaudeProjectMcpServers } from "#core/mcp-management.js";
import { resolveAccountConfigDir } from "#core/account-scope.js";
import { resolveClaudeGlobalConfigPath } from "#core/providers/claude-cli.js";
import { readJsonBody } from "#server/hono-utils.js";
import type { AppEnv, HttpDeps } from "#server/route-types.js";

export function registerProviderRoutes(app: Hono<AppEnv>, deps: HttpDeps): void {
  /**
   * `accountId` → the account's config dir for the provider, or undefined for
   * the default account (absent, `default`, unknown, or no login for the
   * provider) so every scoped route falls back to exactly its pre-accounts
   * behaviour.
   */
  const scopedConfigDir = (provider: ProviderKind, accountId: string | undefined) =>
    resolveAccountConfigDir(deps.instanceManager, provider, accountId, deps.config.logger);

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
      // The default account keeps the shared 60s route cache; another
      // account's list comes straight from the manager, whose per-dir SDK
      // discovery cache (30-min TTL) already makes repeat calls cheap.
      const configDir = scopedConfigDir(provider, c.req.query("accountId"));
      const rawModels = configDir
        ? await deps.instanceManager.getProviderModels(provider, configDir)
        : await deps.getProviderModels(provider);
      const models = rawModels.map((model) => ({
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

  // `?accountId=` lists only the providers that account has a login for — a
  // provider with no login there is unavailable, never a fallback to another
  // account's. Absent, `default`, or an unknown id returns the full list.
  app.get("/api/providers", (c) => {
    const providers = deps.getAvailableProviders();
    const accountId = c.req.query("accountId")?.trim();
    const account =
      accountId && accountId !== DEFAULT_ACCOUNT_ID
        ? deps.instanceManager.accounts.get(accountId)
        : undefined;
    if (!account) return c.json({ providers });
    return c.json({ providers: providers.filter((entry) => account.logins[entry.provider]) });
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
      accountId?: string;
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
      // The client sends the account in the JSON body; the query form is kept
      // for parity with the GET.
      const bodyAccountId = typeof body.accountId === "string" ? body.accountId : undefined;
      const configDir = scopedConfigDir(provider, bodyAccountId ?? c.req.query("accountId"));
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
        configDir,
      });
      if (body.scope !== "project") {
        await deps.instanceManager.ensureProviderGlobalState(provider, true, configDir);
        deps.instanceManager.recordManagedMcpConfiguration(provider, body.name.trim(), configDir);
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
    // Local-scope project servers live in the account's `.claude.json`; the
    // default account reads the server's own (today's path, untouched).
    const configDir = scopedConfigDir(provider, c.req.query("accountId"));
    const servers = configDir
      ? await listClaudeProjectMcpServers(
          project.directory,
          resolveClaudeGlobalConfigPath(configDir),
        )
      : await listClaudeProjectMcpServers(project.directory);
    return c.json({ servers });
  });
}
