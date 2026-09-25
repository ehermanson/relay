import type { Hono } from "hono";
import { readJsonBody } from "#server/hono-utils.js";
import type { AppEnv, HttpDeps } from "#server/route-types.js";
import type { GlobalSettings, ProviderAccountProfile, SuggestionsConfig } from "#core/types.js";

function parseJson<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function rowToSettings(row: {
  theme: string;
  default_open_target: string | null;
  default_provider: string | null;
  default_model: string | null;
  default_space_branch: string | null;
  space_branch_source: string;
  provider_defaults_json: string | null;
  custom_instructions: string | null;
  project_order_json: string | null;
  suggestions_json: string | null;
  max_processes: number | null;
  sidebar_layout: string | null;
  provider_profiles_json?: string | null;
}): GlobalSettings {
  let providerDefaults: Record<string, unknown> = {};
  if (row.provider_defaults_json) {
    try {
      providerDefaults = JSON.parse(row.provider_defaults_json);
    } catch {}
  }
  let projectOrder: string[] | null = null;
  if (row.project_order_json) {
    try {
      projectOrder = JSON.parse(row.project_order_json) as string[];
    } catch {}
  }
  return {
    theme: row.theme === "light" ? "light" : row.theme === "system" ? "system" : "dark",
    defaultOpenTarget: row.default_open_target,
    defaultProvider: row.default_provider,
    defaultModel: row.default_model,
    defaultSpaceBranch: row.default_space_branch,
    spaceBranchSource: (row.space_branch_source as "local" | "remote") ?? "local",
    providerDefaults: providerDefaults as GlobalSettings["providerDefaults"],
    customInstructions: row.custom_instructions,
    projectOrder,
    providerProfiles: parseJson<ProviderAccountProfile[]>(row.provider_profiles_json ?? null) ?? [],
    suggestions: parseJson<SuggestionsConfig>(row.suggestions_json),
    maxProcesses:
      typeof row.max_processes === "number" && row.max_processes > 0 ? row.max_processes : null,
    // Inbox is the default: only an explicit "projects" choice opts out, so an
    // unset (null) value — new installs and users who never toggled — is inbox.
    sidebarLayout: row.sidebar_layout === "projects" ? "projects" : "inbox",
  };
}

/** Hard ceiling on the configurable cap — a guardrail against absurd values. */
const MAX_PROCESSES_CEILING = 100;

export function registerSettingsRoutes(app: Hono<AppEnv>, deps: HttpDeps): void {
  const { instanceManager } = deps;

  app.get("/api/settings", (c) => {
    const row = instanceManager.sessionDb.getGlobalSettings();
    return c.json(rowToSettings(row));
  });

  app.patch("/api/settings", async (c) => {
    const body = await readJsonBody<Partial<GlobalSettings>>(c);
    if (!body) return c.json({ error: "Invalid JSON body" }, 400);

    const dbPatch: Record<string, unknown> = {};
    if (body.theme !== undefined) dbPatch.theme = body.theme;
    if (body.defaultOpenTarget !== undefined) dbPatch.default_open_target = body.defaultOpenTarget;
    if (body.defaultProvider !== undefined) dbPatch.default_provider = body.defaultProvider;
    if (body.defaultModel !== undefined) dbPatch.default_model = body.defaultModel;
    if (body.defaultSpaceBranch !== undefined)
      dbPatch.default_space_branch = body.defaultSpaceBranch;
    if (body.spaceBranchSource !== undefined) dbPatch.space_branch_source = body.spaceBranchSource;
    if (body.customInstructions !== undefined)
      dbPatch.custom_instructions = body.customInstructions;
    if (body.sidebarLayout !== undefined)
      dbPatch.sidebar_layout = body.sidebarLayout === "projects" ? "projects" : "inbox";

    if (body.maxProcesses !== undefined) {
      if (body.maxProcesses === null) {
        dbPatch.max_processes = null;
      } else {
        const n = Math.floor(Number(body.maxProcesses));
        if (!Number.isFinite(n) || n < 1) {
          return c.json({ error: "maxProcesses must be a positive integer" }, 400);
        }
        dbPatch.max_processes = Math.min(n, MAX_PROCESSES_CEILING);
      }
    }

    if (body.projectOrder !== undefined)
      dbPatch.project_order_json =
        body.projectOrder !== null ? JSON.stringify(body.projectOrder) : null;

    // `providerProfiles` is deliberately ignored here: profiles are mutated only
    // through /api/providers/:provider/profiles (fs validation + root refresh).
    if (body.providerDefaults !== undefined) {
      const existing = instanceManager.sessionDb.getGlobalSettings();
      let current: Record<string, unknown> = {};
      if (existing.provider_defaults_json) {
        try {
          current = JSON.parse(existing.provider_defaults_json);
        } catch {}
      }
      const merged = { ...current, ...body.providerDefaults };
      dbPatch.provider_defaults_json = JSON.stringify(merged);
    }

    if ("suggestions" in body) {
      dbPatch.suggestions_json = body.suggestions ? JSON.stringify(body.suggestions) : null;
    }

    const updated = instanceManager.sessionDb.updateGlobalSettings(dbPatch);
    return c.json(rowToSettings(updated));
  });
}
