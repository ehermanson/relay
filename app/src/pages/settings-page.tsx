import { useState, useRef, useCallback, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { toast } from "sonner";
import { FileText } from "lucide-react";
import {
  fetchProject,
  updateProject,
  fetchProviderModels,
  fetchProjectWorkspaceEntries,
  fetchGlobalSettings,
  addProviderMcpServer,
  fetchProjectMcpServers,
} from "../lib/api";
import { useProjectContext } from "../context/project-context";
import { Input, Select } from "../components/ui/input";
import { McpServerFormFields } from "@/components/settings/mcp-server-form-fields";
import { getProjectMcpProviders } from "@/lib/mcp-management";
import { MarkdownEditor } from "../components/ui/markdown-editor";
import { RadioGroup, RadioGroupField } from "@/components/ui/radio-group";
import {
  SettingsSection,
  SettingRow,
  SettingsSectionBoundary,
} from "@/components/settings/settings-shared";
import { SuggestionSettings } from "@/components/settings/suggestion-settings";
import { ProviderLogo } from "@/components/ui/provider-logo";
import { PageShell } from "@/components/ui/page-shell";
import { useProviderRuntimeStore } from "@/stores/provider-runtime-store";
import { useActiveAccount } from "@/hooks/use-active-account";
import { useAvailableProviders } from "@/hooks/use-available-providers";
import { accountLoginSummary } from "@/lib/account-identity";
import { getProviderDisplayName } from "@shared/provider-catalog";
import { projectAccountIds, stateKeyFor } from "@/lib/account-scope";
import { Checkbox } from "@/components/ui/checkbox";
import type { Project, GlobalSettings, ProviderDescriptor, ProviderKind } from "@shared/types";

// ─── Hooks ──────────────────────────────────────────────────────────────────

function useProjectAutoSave(project: Project) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (patch: Partial<Project>) => updateProject(project.id, patch),
    onMutate: async (patch) => {
      await queryClient.cancelQueries({ queryKey: ["project", project.id] });
      const previous = queryClient.getQueryData<Project>(["project", project.id]);
      if (previous) {
        queryClient.setQueryData<Project>(["project", project.id], { ...previous, ...patch });
      }
      return { previous };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["project", project.id] });
      queryClient.invalidateQueries({ queryKey: ["project-suggestions", project.id] });
      toast.success("Settings saved");
    },
    onError: (err, _patch, context) => {
      if (context?.previous) {
        queryClient.setQueryData(["project", project.id], context.previous);
      }
      toast.error(err instanceof Error ? err.message : "Failed to save settings");
    },
  });
}

// ─── Settings Page (data loader) ────────────────────────────────────────────

export function SettingsPage() {
  const { artifacts } = useProjectContext();
  const projectId = artifacts.projectId;

  const { data: project, isLoading } = useQuery({
    queryKey: ["project", projectId],
    queryFn: () => fetchProject(projectId),
  });

  const { data: globalSettings, isLoading: isLoadingGlobal } = useQuery({
    queryKey: ["global-settings"],
    queryFn: fetchGlobalSettings,
    staleTime: 60_000,
  });

  // Only providers the active account has a login for (all of them below two accounts).
  const { providers, isLoading: isLoadingProviders } = useAvailableProviders();

  if (isLoading || isLoadingGlobal || isLoadingProviders || !project || !globalSettings) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <span className="text-sm text-muted">Loading settings...</span>
      </div>
    );
  }

  return (
    <SettingsForm
      key={project.id}
      project={project}
      globalSettings={globalSettings}
      providers={providers}
    />
  );
}

// ─── Settings Form ──────────────────────────────────────────────────────────

function SettingsForm({
  project,
  globalSettings,
  providers,
}: {
  project: Project;
  globalSettings: GlobalSettings;
  providers: ProviderDescriptor[];
}) {
  const save = useProjectAutoSave(project);

  return (
    <PageShell maxWidth="narrow">
      <div className="space-y-10">
        <SettingsSectionBoundary name="Instructions">
          <InstructionsSection
            key={`instructions-${project.customInstructions ?? ""}`}
            project={project}
            save={save}
          />
        </SettingsSectionBoundary>
        <SettingsSectionBoundary name="Git">
          <GitSection
            key={`git-${project.defaultSpaceBranch ?? ""}`}
            project={project}
            globalSettings={globalSettings}
            save={save}
          />
        </SettingsSectionBoundary>
        <SettingsSectionBoundary name="Providers">
          <ProvidersSection project={project} globalSettings={globalSettings} save={save} />
        </SettingsSectionBoundary>
        <SettingsSectionBoundary name="MCP Servers">
          <ProjectMcpSection project={project} providers={providers} />
        </SettingsSectionBoundary>
        <SettingsSectionBoundary name="Suggestions">
          <SuggestionSettings
            config={project.suggestions}
            onChange={(suggestions) => save.mutate({ suggestions })}
            title="Suggestions"
            description="Customize prompt suggestions for new chats in this project. Layers on top of global defaults."
            globalConfig={globalSettings.suggestions}
          />
        </SettingsSectionBoundary>
      </div>
    </PageShell>
  );
}

function ProjectMcpSection({
  project,
  providers,
}: {
  project: Project;
  providers: ProviderDescriptor[];
}) {
  const eligibleProviders = getProjectMcpProviders(providers);
  if (!eligibleProviders.length) return null;

  return (
    <SettingsSection
      title="MCP Availability"
      description="MCP servers available to Chats in this Project, grouped by Provider."
    >
      <div className="space-y-6">
        {eligibleProviders.map((provider) => (
          <ProjectProviderMcpGroup key={provider.provider} project={project} provider={provider} />
        ))}
      </div>
    </SettingsSection>
  );
}

function ProjectProviderMcpGroup({
  project,
  provider,
}: {
  project: Project;
  provider: ProviderDescriptor;
}) {
  const queryClient = useQueryClient();
  // MCP configuration is per login: read/list/add under the active account.
  const { accountIdParam: mcpAccountId, loginDirFor } = useActiveAccount();
  const mcpConfigDir = loginDirFor(provider.provider);
  const globalServers = useProviderRuntimeStore(
    (state) =>
      state.providerGlobalState[stateKeyFor(provider.provider, mcpConfigDir)]?.mcpServers ?? [],
  );
  const transports = provider.capabilities.mcp?.management?.transports ?? [];
  const [name, setName] = useState("");
  const [transport, setTransport] = useState<"http" | "sse" | "stdio">(transports[0] ?? "http");
  const [target, setTarget] = useState("");
  const [args, setArgs] = useState("");
  const [tokenEnvVar, setTokenEnvVar] = useState("");
  const { data: projectServers = [] } = useQuery({
    queryKey: ["project-mcp-servers", project.id, provider.provider, mcpAccountId ?? null],
    queryFn: () => fetchProjectMcpServers(provider.provider, project.id, mcpAccountId),
  });
  const servers = [
    ...new Map(
      [
        ...globalServers.map((server) => ({
          name: server.name,
          transport: "unknown" as const,
          scope: "global" as const,
          connectionState: server.connectionState,
          target: undefined,
        })),
        ...projectServers.map((server) => ({ ...server, connectionState: undefined })),
      ].map((server) => [server.name, server] as const),
    ).values(),
  ];
  const canAddProject = Boolean(provider.capabilities.mcp?.management?.scopes.includes("project"));
  const refresh = () =>
    queryClient.invalidateQueries({
      queryKey: ["project-mcp-servers", project.id, provider.provider, mcpAccountId ?? null],
    });
  const add = useMutation({
    mutationFn: () =>
      addProviderMcpServer(provider.provider, {
        name: name.trim(),
        transport,
        scope: "project",
        projectId: project.id,
        accountId: mcpAccountId,
        url: transport === "stdio" ? undefined : target.trim(),
        command: transport === "stdio" ? target.trim() : undefined,
        args:
          transport === "stdio"
            ? args
                .split("\n")
                .map((value) => value.trim())
                .filter(Boolean)
            : undefined,
        bearerTokenEnvVar:
          transport === "http" && provider.capabilities.mcp?.management?.bearerTokenEnvVar
            ? tokenEnvVar.trim() || undefined
            : undefined,
      }),
    onSuccess: () => {
      setName("");
      setTarget("");
      setArgs("");
      setTokenEnvVar("");
      refresh();
      toast.success("Project MCP server added");
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "Failed to add MCP server"),
  });

  return (
    <section className="rounded-lg border border-border/40 bg-surface/40 p-3.5">
      <div className="mb-3 flex items-center gap-2">
        <ProviderLogo provider={provider.provider} className="h-4 w-4" />
        <h3 className="text-[0.8125rem] font-medium text-text-bright">{provider.label}</h3>
      </div>
      {canAddProject ? (
        <McpServerFormFields
          name={name}
          onNameChange={setName}
          transport={transport}
          transports={transports}
          onTransportChange={setTransport}
          target={target}
          onTargetChange={setTarget}
          args={args}
          onArgsChange={setArgs}
          tokenEnvVar={tokenEnvVar}
          onTokenEnvVarChange={setTokenEnvVar}
          tokenProviderLabels={
            provider.capabilities.mcp?.management?.bearerTokenEnvVar ? provider.label : undefined
          }
          pending={add.isPending}
          onSubmit={() => add.mutate()}
        />
      ) : (
        <div className="text-[0.75rem] text-muted">
          Global MCP configuration applies to every Project. Add or configure servers in{" "}
          <Link to="/settings/providers" className="text-accent hover:underline">
            Global Settings
          </Link>
          .
        </div>
      )}
      <div className="mt-3 space-y-1">
        {servers.map((server) => (
          <div
            key={server.name}
            className="flex items-center justify-between rounded-md bg-surface-inset/60 px-2.5 py-2"
          >
            <div>
              <div className="text-[0.75rem] text-text-bright">{server.name}</div>
              <div className="text-[0.6875rem] text-muted">
                {server.transport === "unknown"
                  ? "Transport not reported"
                  : server.transport.toUpperCase()}
                {server.target ? ` · ${server.target}` : ""}
                {` · ${server.scope === "local" ? "Local Project" : server.scope === "project" ? "Shared Project" : "Global"}`}
                {server.connectionState ? ` · ${server.connectionState.replace("_", " ")}` : ""}
              </div>
            </div>
          </div>
        ))}
        {!servers.length ? (
          <div className="text-[0.75rem] text-muted">
            No MCP servers reported for this Provider and Project.
          </div>
        ) : null}
        {servers.length ? (
          <div className="pt-1 text-[0.6875rem] text-muted">
            Remove servers with the {provider.label} CLI.
          </div>
        ) : null}
      </div>
    </section>
  );
}

// ─── Instructions Section ───────────────────────────────────────────────────

function InstructionsSection({
  project,
  save,
}: {
  project: Project;
  save: ReturnType<typeof useProjectAutoSave>;
}) {
  const handleBlur = useCallback(
    (markdown: string) => {
      const trimmed = markdown.trim() || null;
      if (trimmed !== (project.customInstructions ?? null)) {
        save.mutate({ customInstructions: trimmed });
      }
    },
    [save, project.customInstructions],
  );

  return (
    <SettingsSection
      title="Instructions"
      description="Injected into every session for this project. Appended after global instructions."
    >
      <div className="pt-2">
        <div className="overflow-hidden rounded-lg border border-border bg-bg shadow-sm shadow-black/5 transition-all duration-150 focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/15">
          <MarkdownEditor
            defaultValue={project.customInstructions ?? ""}
            onBlur={handleBlur}
            ariaLabel="Project instructions"
            placeholder="e.g. Always use TypeScript strict mode. Prefer functional components with hooks..."
            className="min-h-[120px] max-h-[420px] overflow-y-auto text-[0.8125rem] leading-relaxed"
            searchFiles={async (query) =>
              (await fetchProjectWorkspaceEntries(project.id, query)).entries
            }
          />
        </div>
        <div className="mt-2 flex items-center gap-2 text-[0.6875rem] text-muted">
          <FileText size={12} />
          <span>
            You can also add a{" "}
            <code className="rounded bg-surface px-1 py-0.5">.relay/instructions.md</code> file to
            your project root. Both sources are combined.
          </span>
        </div>
      </div>
    </SettingsSection>
  );
}

// ─── Git Section ────────────────────────────────────────────────────────────

function GitSection({
  project,
  globalSettings,
  save,
}: {
  project: Project;
  globalSettings: GlobalSettings;
  save: ReturnType<typeof useProjectAutoSave>;
}) {
  const [branchValue, setBranchValue] = useState(project.defaultSpaceBranch ?? "");
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Clear pending debounce on unmount
  useEffect(() => () => clearTimeout(debounceRef.current), []);

  const cancelPendingDebounce = useCallback(() => {
    clearTimeout(debounceRef.current);
    debounceRef.current = undefined;
  }, []);

  const handleBranchChange = useCallback(
    (value: string) => {
      setBranchValue(value);
      clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        save.mutate({ defaultSpaceBranch: value.trim() || null });
      }, 600);
    },
    [save],
  );

  const handleBranchSourceChange = (value: string) => {
    save.mutate({ spaceBranchSource: value as "local" | "remote" });
  };

  const globalBranch = globalSettings.defaultSpaceBranch ?? "main";
  const globalBranchSource = globalSettings.spaceBranchSource ?? "local";

  return (
    <SettingsSection title="Git" description="Branch settings for new spaces in this project.">
      <SettingRow
        label="Default Space Branch"
        description="Base branch for new spaces. Falls back to global default if unset."
        overrideInfo={{
          isOverridden:
            project.defaultSpaceBranch != null && project.defaultSpaceBranch !== globalBranch,
          globalLabel: globalBranch,
          onReset: () => {
            cancelPendingDebounce();
            save.mutate({ defaultSpaceBranch: null });
          },
        }}
      >
        <Input
          value={branchValue}
          onChange={(e) => handleBranchChange(e.target.value)}
          placeholder={globalBranch}
          className="w-48"
        />
      </SettingRow>

      <SettingRow
        label="Branch Source"
        description="Whether to branch from local or remote tracking branches."
        overrideInfo={{
          isOverridden:
            project.spaceBranchSource != null && project.spaceBranchSource !== globalBranchSource,
          globalLabel: globalBranchSource === "remote" ? "Remote" : "Local",
          onReset: () => save.mutate({ spaceBranchSource: null }),
        }}
      >
        <RadioGroup
          value={project.spaceBranchSource ?? globalBranchSource}
          onValueChange={handleBranchSourceChange}
          className="flex items-center gap-4"
          name="p-space-branch-source"
        >
          <RadioGroupField value="local" label="Local" />
          <RadioGroupField value="remote" label="Remote" />
        </RadioGroup>
      </SettingRow>
    </SettingsSection>
  );
}

// ─── Providers Section ──────────────────────────────────────────────────────

function ProvidersSection({
  project,
  globalSettings,
  save,
}: {
  project: Project;
  globalSettings: GlobalSettings;
  save: ReturnType<typeof useProjectAutoSave>;
}) {
  const { providers } = useAvailableProviders();

  // Resolve the effective provider: explicit global > first available provider
  // With several accounts a saved default the active account has no login for
  // is not offered: fall through to the first provider the account can run.
  const account = useActiveAccount();
  const usable = (provider: string | null | undefined) =>
    provider &&
    (!account.isMulti || providers.length === 0 || providers.some((p) => p.provider === provider))
      ? provider
      : undefined;
  const effectiveGlobalProvider =
    usable(globalSettings.defaultProvider) ?? providers[0]?.provider ?? "";
  const effectiveProvider = usable(project.defaultProvider) ?? effectiveGlobalProvider;

  // Model discovery is per login: key by the active account.
  const modelsAccountId = account.accountIdParam;
  const { data: providerModels } = useQuery({
    queryKey: ["provider-models", effectiveProvider, modelsAccountId ?? null],
    queryFn: () => fetchProviderModels(effectiveProvider as ProviderKind, modelsAccountId),
    enabled: !!effectiveProvider,
    staleTime: 60_000,
  });
  const models = providerModels?.models ?? [];

  // Resolve effective labels for the override indicator
  const globalProviderLabel =
    providers.find((p) => p.provider === effectiveGlobalProvider)?.label ??
    providers[0]?.label ??
    "System default";

  // Resolve the effective inherited model using the same priority as the backend:
  // project.defaultModel > providerDefaults[provider].model > provider's built-in default
  // Key: use effectiveProvider (which accounts for project-level provider override),
  // not effectiveGlobalProvider, since models are provider-specific.
  const providerDefaults = globalSettings.providerDefaults ?? {};
  const perProviderModel = providerDefaults[effectiveProvider]?.model ?? null;
  const builtInDefault = models.find((m) => m.isDefault);

  const effectiveGlobalModelId = perProviderModel ?? builtInDefault?.id ?? null;
  const effectiveGlobalModelLabel = (() => {
    if (perProviderModel) {
      const m = models.find((mod) => mod.id === perProviderModel);
      return m?.label ?? perProviderModel;
    }
    return builtInDefault?.label ?? "Provider default";
  })();

  // Account membership: which accounts this project shows under. Only rendered
  // with two or more accounts.
  const memberIds = projectAccountIds(project);
  // The list names every account's providers, including ones the active
  // account hides, so labels come from the catalog rather than `providers`.
  const providerLabel = (provider: ProviderKind) =>
    providers.find((p) => p.provider === provider)?.label ?? getProviderDisplayName(provider);
  const setMembership = (id: string, checked: boolean) => {
    const next = checked ? [...new Set([...memberIds, id])] : memberIds.filter((m) => m !== id);
    // At least one account must remain: the last checkbox is disabled below.
    if (next.length === 0) return;
    save.mutate({ accountIds: next });
  };

  const handleProviderChange = (value: string) => {
    // When changing provider, also clear the model since it may not be valid
    save.mutate({ defaultProvider: value || null, defaultModel: null });
  };

  const handleModelChange = (value: string) => {
    save.mutate({ defaultModel: value || null });
  };

  return (
    <SettingsSection
      title="Providers"
      description="Default provider and model for sessions in this project."
    >
      {/* Default provider — only useful if there are multiple */}
      {providers.length > 1 && (
        <SettingRow
          label="Default Provider"
          description="Preferred provider for new sessions in this project."
          overrideInfo={{
            isOverridden:
              project.defaultProvider != null &&
              project.defaultProvider !== effectiveGlobalProvider,
            globalLabel: globalProviderLabel,
            onReset: () => save.mutate({ defaultProvider: null, defaultModel: null }),
          }}
        >
          <Select
            inputSize="md"
            value={project.defaultProvider ?? ""}
            onChange={(e) => handleProviderChange(e.target.value)}
            className="w-44"
          >
            <option value="">Inherit global ({globalProviderLabel})</option>
            {providers.map((p) => (
              <option key={p.provider} value={p.provider}>
                {p.label}
              </option>
            ))}
          </Select>
        </SettingRow>
      )}

      {/* Default model */}
      <SettingRow
        label="Default Model"
        description="Preferred model for new sessions. Can be overridden per session."
        overrideInfo={{
          isOverridden:
            project.defaultModel != null && project.defaultModel !== effectiveGlobalModelId,
          globalLabel: effectiveGlobalModelLabel,
          onReset: () => save.mutate({ defaultModel: null }),
        }}
      >
        <Select
          inputSize="md"
          value={project.defaultModel ?? ""}
          onChange={(e) => handleModelChange(e.target.value)}
          disabled={!effectiveProvider}
          className="w-52"
        >
          <option value="">Inherit global ({effectiveGlobalModelLabel})</option>
          {models
            .filter((m) => !m.hidden)
            .map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
        </Select>
      </SettingRow>

      {/* Accounts membership — only with two or more accounts registered. A
          project shows under each checked account; at least one stays checked. */}
      {account.isMulti ? (
        <SettingRow
          label="Accounts"
          description="Which accounts this project appears under. Chats in it run under the account that is active when they start."
          vertical
        >
          <div className="flex flex-col divide-y divide-border/30 rounded-md border border-border/50">
            {account.accounts.map((row) => {
              const checked = memberIds.includes(row.id);
              const isLastChecked = checked && memberIds.length === 1;
              const id = `project-account-${row.id}`;
              return (
                <label
                  key={row.id}
                  htmlFor={id}
                  className={`flex min-h-10 cursor-pointer items-center gap-3 px-3 py-2 ${
                    isLastChecked ? "cursor-default" : ""
                  }`}
                >
                  <Checkbox
                    id={id}
                    checked={checked}
                    disabled={isLastChecked || save.isPending}
                    onCheckedChange={(next) => setMembership(row.id, next)}
                  />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="flex items-center gap-2 text-[0.8125rem] font-medium text-text-bright">
                      {row.label}
                      {row.id === account.activeId ? (
                        <span className="text-[0.6875rem] font-normal text-accent">active</span>
                      ) : null}
                    </span>
                    <span className="truncate text-[0.75rem] text-muted">
                      {accountLoginSummary(row, providerLabel)}
                    </span>
                  </span>
                </label>
              );
            })}
          </div>
        </SettingRow>
      ) : null}

      {/* Per-provider defaults display (read-only summary) */}
      {providers.length > 0 && (
        <PerProviderSummary providers={providers} globalSettings={globalSettings} />
      )}
    </SettingsSection>
  );
}

// ─── Per-Provider Summary (shows global defaults, directs to global settings) ─

function PerProviderSummary({
  providers,
  globalSettings,
}: {
  providers: { provider: ProviderKind; label: string }[];
  globalSettings: GlobalSettings;
}) {
  const providerDefaults = globalSettings.providerDefaults ?? {};
  const hasAnyDefaults = Object.keys(providerDefaults).some((key) => {
    const d = providerDefaults[key];
    return d && (d.model || d.reasoningEffort || d.runtimeMode || d.fastMode != null);
  });

  if (!hasAnyDefaults) return null;

  return (
    <div className="py-5">
      <div className="text-[0.8125rem] font-medium text-text-bright">Per-Provider Defaults</div>
      <div className="mt-0.5 text-[0.75rem] text-muted">
        These are set globally and apply to all projects.{" "}
        <Link to="/settings/providers" className="text-accent hover:underline">
          Edit in global settings
        </Link>
      </div>
      <div className="mt-3 space-y-2 pl-1">
        {providers.map((p) => {
          const d = providerDefaults[p.provider];
          if (!d) return null;
          const parts: string[] = [];
          if (d.model) parts.push(`Model: ${d.model}`);
          if (d.reasoningEffort) parts.push(`Reasoning: ${d.reasoningEffort}`);
          if (d.runtimeMode) parts.push(`Permissions: ${d.runtimeMode}`);
          if (d.fastMode != null) parts.push(`Fast mode: ${d.fastMode ? "on" : "off"}`);
          if (parts.length === 0) return null;
          return (
            <div key={p.provider} className="flex items-start gap-2 text-[0.75rem]">
              <ProviderLogo provider={p.provider} className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <div>
                <span className="font-medium text-text">{p.label}</span>
                <span className="text-muted"> — {parts.join(", ")}</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
