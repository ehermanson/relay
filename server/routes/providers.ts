import type { Hono } from "hono";
import type { ProviderKind, ProviderModelsResponse } from "#core/types.js";
import { mergeCapabilities, resolveProviderDefaultModelOption } from "#core/provider-catalog.js";
import { refreshProviderVersionAdvisories, runProviderUpdate } from "#core/provider-registry.js";
import { addMcpServer, listClaudeProjectMcpServers } from "#core/mcp-management.js";
import { readJsonBody } from "#server/hono-utils.js";
import type { AppEnv, HttpDeps } from "#server/route-types.js";

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
}
