import { hasInstallableProviderUpdate } from "@shared/provider-update";
import { useRef, useCallback, useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { QRCodeSVG } from "qrcode.react";
import { toast } from "sonner";
import {
  AlertCircle,
  CheckCircle2,
  DownloadCloud,
  FolderTree,
  Inbox,
  Loader2,
  Monitor,
  Moon,
  RefreshCw,
  Sun,
} from "lucide-react";
import { Tooltip } from "@/components/ui/tooltip";
import {
  createPairingCode,
  fetchConnectEndpoints,
  fetchHealth,
  updateGlobalSettings,
  fetchProviders,
  fetchProviderModels,
  recheckProviderVersions,
  runProviderUpdate,
  addProviderMcpServer,
} from "../lib/api";
import { useGlobalSettings } from "@/hooks/use-global-settings";
import { useSystemUpdate, describeUpdateStage } from "@/hooks/use-system-update";
import {
  INSTALL_METHOD_LABEL,
  formatVersion,
} from "@/components/provider-update-notification.logic";

import { Button } from "@/components/ui/button";
import { CheckboxField } from "@/components/ui/checkbox";
import { Dialog } from "@/components/ui/dialog";
import { Input, Select } from "../components/ui/input";
import { MarkdownEditor } from "../components/ui/markdown-editor";
import { RadioGroup, RadioGroupField } from "@/components/ui/radio-group";
import { ProviderLogo } from "@/components/ui/provider-logo";
import { RateLimitBar, flattenRateLimitWindows } from "@/components/ui/rate-limit-bar";
import { SettingsSection, SettingRow } from "@/components/settings/settings-shared";
import { McpServerFormFields } from "@/components/settings/mcp-server-form-fields";
import { SuggestionSettings } from "@/components/settings/suggestion-settings";
import { endpointHint, isLocalhostUrl, resolveEndpointSelection } from "@/lib/remote-access";
import { getCompatibleMcpProviders } from "@/lib/mcp-management";
import { useThemeStore, type ThemePreference } from "@/stores/theme-store";
import { useProviderRuntimeStore } from "@/stores/provider-runtime-store";
import type {
  GlobalSettings,
  ProviderDefaults,
  ProviderDescriptor,
  ProviderGlobalState,
  ProviderKind,
  ProviderMcpServerStatus,
  ProviderVersionAdvisory,
  SidebarLayout,
  UpdateSnapshot,
} from "@shared/types";

// ─── Helpers ───────────────────────────────────────────────────────────────

// ─── Defaults & hooks ──────────────────────────────────────────────────────

/** Server fallback when no explicit cap is set (mirrors the backend default). */
const DEFAULT_MAX_PROCESSES = 15;

const REMOTE_ACCESS_ENDPOINT_KEY = "relay.remoteAccess.endpoint";

function useAutoSave() {
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: (patch: Partial<GlobalSettings>) => updateGlobalSettings(patch),
    onMutate: async (patch) => {
      // Cancel outgoing refetches so they don't overwrite our optimistic update
      await queryClient.cancelQueries({ queryKey: ["global-settings"] });
      const previous = queryClient.getQueryData<GlobalSettings>(["global-settings"]);
      // Optimistically merge the patch into cached settings
      if (previous) {
        queryClient.setQueryData<GlobalSettings>(["global-settings"], {
          ...previous,
          ...patch,
          // Deep-merge providerDefaults if present
          providerDefaults: patch.providerDefaults
            ? { ...previous.providerDefaults, ...patch.providerDefaults }
            : previous.providerDefaults,
        });
      }
      return { previous };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["global-settings"] });
      queryClient.invalidateQueries({ queryKey: ["project-suggestions"] });
      toast.success("Settings saved");
    },
    onError: (err, _patch, context) => {
      // Roll back to previous value on failure
      if (context?.previous) {
        queryClient.setQueryData(["global-settings"], context.previous);
      }
      toast.error(err instanceof Error ? err.message : "Failed to save settings");
    },
  });
  return mutation;
}

// ─── General Section ───────────────────────────────────────────────────────

export function GeneralSettingsSection() {
  const themeStore = useThemeStore();
  const save = useAutoSave();

  const handleThemeChange = (newTheme: ThemePreference) => {
    themeStore.setTheme(newTheme);
    save.mutate({ theme: newTheme });
  };

  return (
    <SettingsSection title="General" description="Manage appearance and default behaviors.">
      <SettingRow label="Theme" description="Choose between light, dark, or system appearance.">
        <ThemeToggle value={themeStore.preference} onChange={handleThemeChange} />
      </SettingRow>
      <SidebarLayoutSettingsRow />
      <MaxProcessesSettingsRow />
      <UpdateSettingsRow />
      <RemoteAccessSettingsRow />
    </SettingsSection>
  );
}

function MaxProcessesSettingsRow() {
  const { data: settings } = useGlobalSettings();
  const save = useAutoSave();

  const commit = (raw: string) => {
    const trimmed = raw.trim();
    // Empty resets to the server default.
    if (trimmed === "") {
      if (settings?.maxProcesses != null) save.mutate({ maxProcesses: null });
      return;
    }
    const n = Math.floor(Number(trimmed));
    if (!Number.isFinite(n) || n < 1) {
      toast.error("Enter a whole number of 1 or more");
      return;
    }
    const clamped = Math.min(n, 100);
    if (clamped !== (settings?.maxProcesses ?? null)) {
      save.mutate({ maxProcesses: clamped });
    }
  };

  return (
    <SettingRow
      label="Max Concurrent Sessions"
      description="Upper limit on running agent sessions at once. A resource guardrail — high values can strain your machine and hit provider rate limits. Leave blank for the default."
    >
      <Input
        type="number"
        min={1}
        max={100}
        key={`max-processes-${settings?.maxProcesses ?? "default"}`}
        defaultValue={settings?.maxProcesses ?? ""}
        placeholder={`${DEFAULT_MAX_PROCESSES} (default)`}
        onBlur={(e) => commit(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
        }}
        className="w-32"
      />
    </SettingRow>
  );
}

function formatShortCommit(commit: string | null | undefined): string | null {
  return commit ? commit.slice(0, 7) : null;
}

function formatCheckedAt(checkedAt: number | null | undefined): string | null {
  if (!checkedAt) return null;
  const diffMs = Date.now() - checkedAt;
  if (diffMs < 0) return "just now";
  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 45) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

type UpdateStatusTone = "neutral" | "info" | "success" | "warn" | "error";

interface UpdateStatusDescriptor {
  title: string;
  tone: UpdateStatusTone;
  icon: typeof CheckCircle2;
  spin?: boolean;
}

function getUpdateStatus(snapshot: UpdateSnapshot | undefined): UpdateStatusDescriptor {
  if (!snapshot) {
    return { title: "Checking availability…", tone: "neutral", icon: Loader2, spin: true };
  }
  if (!snapshot.enabled) {
    return {
      title: snapshot.error ?? "Updates are unavailable for this checkout",
      tone: "neutral",
      icon: AlertCircle,
    };
  }
  switch (snapshot.status) {
    case "checking":
      return { title: "Checking for updates…", tone: "info", icon: Loader2, spin: true };
    case "updating":
      return {
        title: describeUpdateStage(snapshot.status, snapshot.stage) ?? "Installing update…",
        tone: "info",
        icon: Loader2,
        spin: true,
      };
    case "restart_pending":
      return { title: "Restarting Relay…", tone: "info", icon: Loader2, spin: true };
    case "available":
      return { title: "Update available", tone: "warn", icon: DownloadCloud };
    case "up_to_date":
      return { title: "Relay is up to date", tone: "success", icon: CheckCircle2 };
    case "error":
      return { title: snapshot.error ?? "Update check failed", tone: "error", icon: AlertCircle };
    default:
      return { title: "Not checked yet", tone: "neutral", icon: RefreshCw };
  }
}

const STATUS_TONE_STYLES: Record<UpdateStatusTone, { icon: string; bg: string }> = {
  neutral: { icon: "text-muted", bg: "bg-surface/70" },
  info: { icon: "text-accent", bg: "bg-accent/10" },
  success: { icon: "text-emerald-400", bg: "bg-emerald-500/10" },
  warn: { icon: "text-amber-400", bg: "bg-amber-500/10" },
  error: { icon: "text-error", bg: "bg-error/10" },
};

function UpdateSettingsRow() {
  const [restartRequested, setRestartRequested] = useState(false);

  const {
    snapshot,
    isLoading,
    isBusy,
    isInstalling,
    canInstall,
    install,
    check,
    installPending,
    checkPending,
  } = useSystemUpdate();

  useEffect(() => {
    if (installPending) {
      setRestartRequested(true);
    }
  }, [installPending]);

  useEffect(() => {
    if (!restartRequested || !snapshot) return;
    if (
      snapshot.status !== "restart_pending" &&
      snapshot.status !== "updating" &&
      !snapshot.updateAvailable
    ) {
      setRestartRequested(false);
    }
  }, [restartRequested, snapshot]);

  const currentCommit = formatShortCommit(snapshot?.currentCommit);
  const latestCommit = formatShortCommit(snapshot?.latestCommit);
  const status =
    restartRequested && snapshot?.status !== "restart_pending" && snapshot?.status !== "updating"
      ? {
          title: "Waiting for Relay to restart…",
          tone: "info" as const,
          icon: Loader2,
          spin: true,
        }
      : getUpdateStatus(snapshot);
  const tone = STATUS_TONE_STYLES[status.tone];
  const StatusIcon = status.icon;
  const checkedLabel = formatCheckedAt(snapshot?.checkedAt);
  const showCommitDiff = snapshot?.updateAvailable && latestCommit && currentCommit;
  const isUnavailable = Boolean(!isLoading && snapshot && !snapshot.enabled);
  const installButtonLabel = isInstalling
    ? (describeUpdateStage(snapshot?.status, snapshot?.stage) ?? "Installing…")
    : "Update and Restart";
  // The status icon is clickable to re-check when idle and enabled.
  const iconIsClickable = Boolean(snapshot?.enabled && !isBusy && !status.spin);

  return (
    <SettingRow
      label="Relay Updates"
      description="Check whether this Relay checkout is behind GitHub and update it in place."
      vertical
    >
      <div className="overflow-hidden rounded-xl border border-border/70 bg-surface/30">
        <div className="flex items-start gap-3 p-4">
          {iconIsClickable ? (
            <Tooltip content="Check for updates" side="right">
              <button
                type="button"
                onClick={() => check(true)}
                className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg transition-opacity ${tone.bg} cursor-pointer hover:opacity-75 active:opacity-60`}
              >
                <StatusIcon size={18} className={tone.icon} />
              </button>
            </Tooltip>
          ) : (
            <div
              className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${tone.bg}`}
            >
              <StatusIcon
                size={18}
                className={`${tone.icon} ${status.spin ? "animate-spin" : ""}`}
              />
            </div>
          )}

          <div className="min-w-0 flex-1">
            <div className="text-[0.8125rem] font-medium text-text-bright">{status.title}</div>
            <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[0.75rem] text-muted">
              {showCommitDiff ? (
                <>
                  <span className="font-mono text-muted">{currentCommit}</span>
                  <span className="text-border">→</span>
                  <span className="font-mono text-text">{latestCommit}</span>
                </>
              ) : currentCommit ? (
                <span className="font-mono">{currentCommit}</span>
              ) : null}
              {checkedLabel && snapshot?.enabled && (
                <>
                  {currentCommit && <span className="text-border">·</span>}
                  <span>Checked {checkedLabel}</span>
                </>
              )}
            </div>
          </div>
        </div>

        <div className="flex flex-col gap-2 border-t border-border/60 bg-surface/40 px-4 py-3">
          {isUnavailable && (
            <div className="text-[0.75rem] text-muted">
              Available only in installed production builds. Dev/source checkouts don&apos;t
              self-update.
            </div>
          )}
          <div className="flex items-center justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => check(true)}
              disabled={isBusy || !snapshot?.enabled || isLoading}
            >
              <RefreshCw
                size={12}
                className={checkPending || snapshot?.status === "checking" ? "animate-spin" : ""}
              />
              Check
            </Button>
            <Button
              type="button"
              variant="primary"
              size="sm"
              onClick={() => install()}
              disabled={!canInstall}
            >
              {isInstalling ? (
                <Loader2 size={13} className="animate-spin" />
              ) : (
                <DownloadCloud size={13} />
              )}
              {installButtonLabel}
            </Button>
          </div>
        </div>
      </div>
    </SettingRow>
  );
}

function RemoteAccessSettingsRow() {
  const [pairing, setPairing] = useState<{
    code: string;
    createdAt: number;
    expiresAt: number;
  } | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [selectedEndpointId, setSelectedEndpointId] = useState("");

  const { data: health } = useQuery({
    queryKey: ["health"],
    queryFn: fetchHealth,
    staleTime: 60_000,
  });

  const { data: connectData } = useQuery({
    queryKey: ["connect-endpoints"],
    queryFn: fetchConnectEndpoints,
    staleTime: 60_000,
  });

  const browserEndpoint =
    typeof window !== "undefined"
      ? {
          id: "browser",
          label: `Current Browser URL (${window.location.host})`,
          url: window.location.origin,
          kind: "browser" as const,
        }
      : null;

  const endpointOptions = [
    ...(browserEndpoint ? [browserEndpoint] : []),
    ...(connectData?.endpoints ?? []),
  ].filter(
    (endpoint, index, all) => all.findIndex((entry) => entry.url === endpoint.url) === index,
  );

  useEffect(() => {
    if (endpointOptions.length === 0) return;
    if (
      selectedEndpointId &&
      endpointOptions.some((endpoint) => endpoint.id === selectedEndpointId)
    ) {
      return;
    }
    const storedId =
      typeof window !== "undefined"
        ? window.localStorage.getItem(REMOTE_ACCESS_ENDPOINT_KEY)
        : null;
    setSelectedEndpointId(resolveEndpointSelection(endpointOptions, storedId));
  }, [endpointOptions, selectedEndpointId]);

  useEffect(() => {
    if (!selectedEndpointId || typeof window === "undefined") return;
    window.localStorage.setItem(REMOTE_ACCESS_ENDPOINT_KEY, selectedEndpointId);
  }, [selectedEndpointId]);

  const selectedEndpoint =
    endpointOptions.find((endpoint) => endpoint.id === selectedEndpointId) ??
    endpointOptions[0] ??
    null;

  const baseUrl =
    selectedEndpoint?.url ?? (typeof window !== "undefined" ? window.location.origin : "");
  const phoneUrl = !health?.authRequired
    ? `${baseUrl}/`
    : pairing
      ? `${baseUrl}/login?pairCode=${encodeURIComponent(pairing.code)}`
      : `${baseUrl}/login`;

  const expiresLabel = pairing ? new Date(pairing.expiresAt).toLocaleTimeString() : null;

  const handleGenerate = async () => {
    setIsGenerating(true);
    try {
      const next = await createPairingCode();
      setPairing(next);
      toast.success("Pairing code created");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to create pairing code");
    } finally {
      setIsGenerating(false);
    }
  };

  const copyText = async (value: string, label: string) => {
    try {
      await navigator.clipboard.writeText(value);
      toast.success(`${label} copied`);
    } catch {
      toast.error(`Failed to copy ${label.toLowerCase()}`);
    }
  };

  return (
    <SettingRow
      label="Open On Phone"
      description="Pick a reachable address for this machine, then scan a QR code to open Relay on another device."
      vertical
    >
      <div className="space-y-3">
        <div className="rounded-xl border border-border/70 bg-surface/30 p-4 text-[0.75rem] text-muted">
          {health?.authRequired
            ? "Relay is password-protected. Scanning the QR code will open the login page, and you can optionally generate a one-time pairing code so your phone opens already prefilled."
            : "Relay is running in open mode. Scanning the QR code opens the Relay UI directly on your phone."}
        </div>

        <div className="rounded-xl border border-border/70 bg-surface/40 p-4">
          <div className="grid gap-4 md:grid-cols-[172px_minmax(0,1fr)] md:items-start">
            <div className="flex flex-col items-center gap-3 rounded-xl border border-border/60 bg-white p-3">
              <QRCodeSVG
                value={phoneUrl}
                size={148}
                marginSize={2}
                bgColor="#ffffff"
                fgColor="#111111"
                level="M"
                includeMargin={false}
              />
              <div className="text-center text-[0.6875rem] uppercase tracking-[0.18em] text-black/60">
                Scan to open
              </div>
            </div>

            <div className="space-y-3">
              {endpointOptions.length > 0 ? (
                <div className="space-y-1.5">
                  <div className="text-[0.6875rem] uppercase tracking-[0.18em] text-muted">
                    Device Address
                  </div>
                  <Select
                    value={selectedEndpointId}
                    onChange={(e) => setSelectedEndpointId(e.target.value)}
                    className="w-full"
                  >
                    {endpointOptions.map((endpoint) => (
                      <option key={endpoint.id} value={endpoint.id}>
                        {endpoint.label}
                      </option>
                    ))}
                  </Select>
                </div>
              ) : null}

              <div className="text-[0.75rem] text-muted">{endpointHint(selectedEndpoint)}</div>

              {selectedEndpoint ? (
                <div className="flex flex-wrap gap-2 text-[0.6875rem]">
                  <span className="rounded bg-surface px-1.5 py-0.5 font-medium text-text">
                    {selectedEndpoint.kind === "browser"
                      ? "Current URL"
                      : selectedEndpoint.kind === "tailscale"
                        ? "Tailscale"
                        : selectedEndpoint.kind === "lan"
                          ? "LAN"
                          : "Local Only"}
                  </span>
                  {!isLocalhostUrl(selectedEndpoint.url) ? (
                    <span className="rounded bg-emerald-500/10 px-1.5 py-0.5 font-medium text-emerald-400">
                      Phone-ready
                    </span>
                  ) : null}
                </div>
              ) : null}

              {endpointOptions.length > 1 ? (
                <div className="text-[0.75rem] text-muted">
                  Relay will remember this address the next time you open Settings.
                </div>
              ) : null}

              <div className="space-y-1.5">
                <div className="text-[0.6875rem] uppercase tracking-[0.18em] text-muted">
                  Phone Link
                </div>
                <Input readOnly value={phoneUrl} className="w-full font-mono text-[0.75rem]" />
              </div>

              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => void copyText(phoneUrl, "Link")}
                  className="border border-border text-text"
                >
                  Copy Link
                </Button>
              </div>

              {health?.authRequired ? (
                <div className="rounded-lg border border-border/60 bg-bg/35 p-3">
                  <div className="flex flex-wrap items-center gap-3">
                    <Button
                      type="button"
                      variant="primary"
                      size="sm"
                      onClick={() => void handleGenerate()}
                      disabled={isGenerating}
                    >
                      {isGenerating
                        ? "Generating..."
                        : pairing
                          ? "Regenerate Pairing Code"
                          : "Generate Pairing Code"}
                    </Button>
                    {expiresLabel ? (
                      <span className="text-[0.75rem] text-muted">Expires at {expiresLabel}</span>
                    ) : null}
                  </div>

                  {pairing ? (
                    <div className="mt-3 space-y-3">
                      <div>
                        <div className="text-[0.6875rem] uppercase tracking-[0.18em] text-muted">
                          Pairing Code
                        </div>
                        <div className="mt-2 font-mono text-2xl font-semibold tracking-[0.24em] text-text-bright">
                          {pairing.code}
                        </div>
                      </div>

                      <div className="text-[0.75rem] text-muted">
                        The QR code and phone link above now open a login page with this code
                        prefilled.
                      </div>

                      <div className="flex flex-wrap gap-2">
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => void copyText(pairing.code, "Code")}
                          className="border border-border text-text"
                        >
                          Copy Code
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <div className="mt-3 text-[0.75rem] text-muted">
                      Without a pairing code, your phone will open the normal login page.
                    </div>
                  )}
                </div>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    </SettingRow>
  );
}

// ─── Theme toggle (segmented) ──────────────────────────────────────────────

function ThemeToggle({
  value,
  onChange,
}: {
  value: ThemePreference;
  onChange: (v: ThemePreference) => void;
}) {
  const options = [
    { value: "light" as const, icon: Sun, label: "Light" },
    { value: "dark" as const, icon: Moon, label: "Dark" },
    { value: "system" as const, icon: Monitor, label: "System" },
  ];

  return (
    <div className="flex rounded-lg border border-border bg-surface/60 p-0.5">
      {options.map((opt) => {
        const Icon = opt.icon;
        const active = value === opt.value;
        return (
          <button
            key={opt.value}
            onClick={() => onChange(opt.value)}
            className={`flex items-center gap-1.5 rounded-md px-3 py-1 text-[0.75rem] font-medium transition-colors ${
              active ? "bg-surface-hover text-text-bright shadow-sm" : "text-muted hover:text-text"
            }`}
          >
            <Icon size={13} />
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

function SidebarLayoutSettingsRow() {
  const { data: settings } = useGlobalSettings();
  const save = useAutoSave();
  const value: SidebarLayout = settings?.sidebarLayout === "projects" ? "projects" : "inbox";

  const options = [
    { value: "projects" as const, icon: FolderTree, label: "Projects" },
    { value: "inbox" as const, icon: Inbox, label: "Inbox" },
  ];

  return (
    <SettingRow
      label="Sidebar layout"
      description="Group chats under their project, or show one flat list sorted by activity."
    >
      <div className="flex rounded-lg border border-border bg-surface/60 p-0.5">
        {options.map((opt) => {
          const Icon = opt.icon;
          const active = value === opt.value;
          return (
            <button
              key={opt.value}
              onClick={() => save.mutate({ sidebarLayout: opt.value })}
              className={`flex items-center gap-1.5 rounded-md px-3 py-1 text-[0.75rem] font-medium transition-colors ${
                active
                  ? "bg-surface-hover text-text-bright shadow-sm"
                  : "text-muted hover:text-text"
              }`}
            >
              <Icon size={13} />
              {opt.label}
            </button>
          );
        })}
      </div>
    </SettingRow>
  );
}

// ─── Providers Section ─────────────────────────────────────────────────────

export function ProvidersSettingsSection() {
  const { data: settings } = useGlobalSettings();
  const save = useAutoSave();
  const providerGlobalState = useProviderRuntimeStore((s) => s.providerGlobalState);

  const { data: providers = [] } = useQuery({
    queryKey: ["providers"],
    queryFn: fetchProviders,
    staleTime: 60_000,
  });

  const defaultProvider = settings?.defaultProvider ?? "";
  const providerDefaults = settings?.providerDefaults ?? {};

  const handleProviderChange = (provider: string) => {
    save.mutate({ defaultProvider: provider || null });
  };

  const handleProviderDefaultChange = (
    provider: string,
    field: keyof ProviderDefaults,
    value: string,
  ) => {
    let parsed: string | number | boolean | undefined = value || undefined;
    if (field === "fastMode" && value) {
      parsed = value === "true";
    }
    const updated = {
      ...providerDefaults,
      [provider]: { ...providerDefaults[provider], [field]: parsed },
    };
    save.mutate({ providerDefaults: updated });
  };

  return (
    <SettingsSection
      title="Providers"
      description="Default provider, model, and per-provider settings."
    >
      {/* Default Provider — only show if multiple providers */}
      {providers.length > 1 && (
        <SettingRow label="Default Provider" description="The default provider for new sessions.">
          <Select
            inputSize="md"
            value={defaultProvider}
            onChange={(e) => handleProviderChange(e.target.value)}
            className="w-44"
          >
            {providers.map((p) => (
              <option key={p.provider} value={p.provider}>
                {p.label}
              </option>
            ))}
          </Select>
        </SettingRow>
      )}

      {/* Per-provider defaults — always expanded */}
      {providers.map((p) => (
        <ProviderDefaultsRow
          key={p.provider}
          provider={p}
          defaults={providerDefaults[p.provider] ?? {}}
          onChange={(field, value) => handleProviderDefaultChange(p.provider, field, value)}
          runtimeState={providerGlobalState[p.provider]}
          availableProviders={providers}
        />
      ))}
    </SettingsSection>
  );
}

// ─── Provider Version Advisory Card ────────────────────────────────────────
//
// Shown inside each provider's row when the version probe has produced an
// advisory. "behind_latest" → orange call-to-action with copyable update
// command when installable; channel lag and unknown probes offer a recheck.

export function ProviderVersionAdvisoryCard({
  provider,
  advisory,
}: {
  provider: ProviderKind;
  advisory: ProviderVersionAdvisory;
}) {
  const queryClient = useQueryClient();
  const [copied, setCopied] = useState(false);
  const [confirmingUpdate, setConfirmingUpdate] = useState(false);

  const recheckMutation = useMutation({
    mutationFn: () => recheckProviderVersions(provider),
    onSuccess: (providers) => {
      queryClient.setQueryData(["providers"], providers);
      toast.success("Version check complete");
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : "Recheck failed");
    },
  });

  const updateMutation = useMutation({
    mutationFn: () => runProviderUpdate(provider),
    onSuccess: ({ providers, result }) => {
      queryClient.setQueryData(["providers"], providers);
      if (result.status === "updated") toast.success(result.message);
      else if (result.status === "failed") toast.error(result.message);
      else toast.warning(result.message);
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : "Update failed");
    },
    onSettled: () => setConfirmingUpdate(false),
  });

  const result = updateMutation.data?.result;
  const updateDetails = (result || updateMutation.error) && (
    <div aria-live="polite" className="mt-2 text-[0.75rem] text-muted">
      {updateMutation.error && <p>{updateMutation.error.message}</p>}
      {result && (
        <>
          <p>{result.message}</p>
          <details className="mt-1" open={result.status !== "updated"}>
            <summary className="min-h-10 cursor-pointer py-2 text-accent">Command output</summary>
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded bg-bg/60 p-2 font-mono text-[0.6875rem]">
              {result.command ? `$ ${result.command}\n` : ""}
              {result.output || "No command output."}
            </pre>
          </details>
        </>
      )}
    </div>
  );

  const onCopy = async () => {
    if (!advisory.updateCommand) return;
    try {
      await navigator.clipboard.writeText(advisory.updateCommand);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_500);
    } catch {
      toast.error("Failed to copy");
    }
  };

  if (advisory.status === "unknown") {
    // Probe hasn't completed (or failed). Offer a manual recheck so users
    // aren't stuck waiting up to 30 min for the next background pass.
    const checked = advisory.checkedAt ? new Date(advisory.checkedAt) : null;
    return (
      <>
        <div className="flex items-center gap-2 text-[0.75rem] text-muted">
          <RefreshCw size={12} />
          <span>
            {checked
              ? `Version check unavailable · last attempted ${formatRelativeTime(checked)}`
              : "Checking for updates…"}
          </span>
          <button
            type="button"
            onClick={() => recheckMutation.mutate()}
            disabled={recheckMutation.isPending || updateMutation.isPending}
            className="text-accent hover:underline disabled:opacity-50"
          >
            {recheckMutation.isPending ? "Checking…" : "Check now"}
          </button>
        </div>
        {updateDetails}
      </>
    );
  }

  if (advisory.status === "current") {
    const checked = advisory.checkedAt ? new Date(advisory.checkedAt) : null;
    return (
      <>
        <div className="flex items-center gap-2 text-[0.75rem] text-muted">
          <CheckCircle2 size={12} className="text-success" />
          <span>
            Up to date
            {advisory.currentVersion ? ` · ${formatVersion(advisory.currentVersion)}` : ""}
            {checked ? ` · checked ${formatRelativeTime(checked)}` : ""}
          </span>
          <button
            type="button"
            onClick={() => recheckMutation.mutate()}
            disabled={recheckMutation.isPending || updateMutation.isPending}
            className="text-accent hover:underline disabled:opacity-50"
          >
            {recheckMutation.isPending ? "Checking…" : "Re-check"}
          </button>
        </div>
        {updateDetails}
      </>
    );
  }

  // status === "behind_latest"
  const installLabel = advisory.installMethod ? INSTALL_METHOD_LABEL[advisory.installMethod] : null;
  const installable = hasInstallableProviderUpdate(advisory);
  const canRunUpdate =
    !!advisory.updateCommand && advisory.installMethod !== "manual" && installable;

  return (
    <>
      <div className="rounded-md border border-warning/40 bg-warning/5 p-3">
        <div className="flex items-start gap-2">
          <DownloadCloud size={14} className="mt-0.5 shrink-0 text-warning" />
          <div className="min-w-0 flex-1">
            <div className="text-[0.8125rem] font-medium text-text-bright">
              {installable ? "Update available" : "New release"}:{" "}
              {formatVersion(
                installable
                  ? (advisory.availableVersion ?? advisory.latestVersion)
                  : advisory.latestVersion,
              )}
            </div>
            <div className="mt-0.5 text-[0.75rem] text-muted">
              Installed{" "}
              {advisory.currentVersion ? formatVersion(advisory.currentVersion) : "(unknown)"} →
              latest {formatVersion(advisory.latestVersion)}
              {installLabel ? ` · ${installLabel}` : ""}
            </div>

            {advisory.installMethod === "brew" && (
              <p className="mt-2 text-[0.75rem] text-muted">
                {advisory.availableVersion
                  ? `Homebrew currently offers ${formatVersion(advisory.availableVersion)}.${!installable ? " No newer Homebrew version is available to install yet." : ""}`
                  : "Homebrew availability could not be checked. Re-check before updating."}
              </p>
            )}

            {advisory.updateCommand && installable && (
              <div className="mt-2 flex items-center gap-2">
                <code className="flex-1 truncate rounded bg-bg/60 px-2 py-1 font-mono text-[0.6875rem] text-text">
                  {advisory.updateCommand}
                </code>
                <button
                  type="button"
                  onClick={onCopy}
                  className="text-[0.6875rem] text-accent hover:underline"
                >
                  {copied ? "Copied" : "Copy"}
                </button>
              </div>
            )}

            <div className="mt-2 flex items-center gap-3">
              {canRunUpdate &&
                (updateMutation.isPending ? (
                  <span className="flex items-center gap-1.5 text-[0.6875rem] text-muted">
                    <Loader2 size={11} className="animate-spin" />
                    Updating… this can take a minute
                  </span>
                ) : confirmingUpdate ? (
                  <>
                    <span className="text-[0.6875rem] text-muted">Run this update now?</span>
                    <button
                      type="button"
                      onClick={() => updateMutation.mutate()}
                      className="text-[0.6875rem] font-medium text-warning hover:underline"
                    >
                      Confirm
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmingUpdate(false)}
                      className="text-[0.6875rem] text-muted hover:text-text"
                    >
                      Cancel
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    onClick={() => setConfirmingUpdate(true)}
                    className="text-[0.6875rem] font-medium text-accent hover:underline"
                  >
                    Update now
                  </button>
                ))}
              <button
                type="button"
                onClick={() => recheckMutation.mutate()}
                disabled={recheckMutation.isPending || updateMutation.isPending}
                className="text-[0.6875rem] text-muted hover:text-text disabled:opacity-50"
              >
                {recheckMutation.isPending ? "Checking…" : "Re-check now"}
              </button>
            </div>
          </div>
        </div>
      </div>
      {updateDetails}
    </>
  );
}

function formatRelativeTime(date: Date): string {
  const diffMs = Date.now() - date.getTime();
  const minutes = Math.round(diffMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

// ─── Provider Defaults Row (always visible, no expand) ─────────────────────

function McpManagementForm({
  provider,
  runtimeState,
  availableProviders,
}: {
  provider: ProviderDescriptor;
  runtimeState?: ProviderGlobalState;
  availableProviders: ProviderDescriptor[];
}) {
  const [name, setName] = useState("");
  const [transport, setTransport] = useState<"http" | "sse" | "stdio">("http");
  const [url, setUrl] = useState("");
  const [command, setCommand] = useState("");
  const [commandArgs, setCommandArgs] = useState("");
  const [tokenEnvVar, setTokenEnvVar] = useState("");
  const [providerDialogOpen, setProviderDialogOpen] = useState(false);
  const [selectedProviders, setSelectedProviders] = useState<ProviderKind[]>([provider.provider]);
  const management = provider.capabilities.mcp?.management;
  const compatibleProviders = getCompatibleMcpProviders(availableProviders, transport);
  const supportsBearerTokenEnvVar = compatibleProviders.some(
    (candidate) => candidate.capabilities.mcp?.management?.bearerTokenEnvVar,
  );
  const bearerTokenProviderLabels = compatibleProviders
    .filter((candidate) => candidate.capabilities.mcp?.management?.bearerTokenEnvVar)
    .map((candidate) => candidate.label)
    .join("/");
  const addMutation = useMutation({
    mutationFn: async (targets: ProviderKind[]) => {
      const results = await Promise.allSettled(
        targets.map(async (target) => {
          await addProviderMcpServer(target, {
            name: name.trim(),
            transport,
            url: transport === "stdio" ? undefined : url.trim(),
            command: transport === "stdio" ? command.trim() : undefined,
            args:
              transport === "stdio"
                ? commandArgs
                    .split("\n")
                    .map((arg) => arg.trim())
                    .filter(Boolean)
                : undefined,
            bearerTokenEnvVar:
              transport === "http" &&
              availableProviders.find((candidate) => candidate.provider === target)?.capabilities
                .mcp?.management?.bearerTokenEnvVar
                ? tokenEnvVar.trim() || undefined
                : undefined,
          });
          return target;
        }),
      );
      return results.map((result, index) => ({
        provider: targets[index],
        error: result.status === "rejected" ? result.reason : undefined,
      }));
    },
    onSuccess: (results) => {
      const succeeded = results.filter((result) => !result.error);
      const failed = results.filter((result) => result.error);
      if (succeeded.length) {
        toast.success(
          `MCP server added to ${succeeded.map((result) => result.provider).join(", ")}`,
          { description: "New Chats can load the server." },
        );
      }
      if (failed.length) {
        toast.error(`Could not add to ${failed.map((result) => result.provider).join(", ")}`, {
          description: failed
            .map((result) =>
              result.error instanceof Error ? result.error.message : String(result.error),
            )
            .join(" · "),
        });
      }
      if (!succeeded.length) return;
      setName("");
      setUrl("");
      setCommand("");
      setCommandArgs("");
      setTokenEnvVar("");
      setProviderDialogOpen(false);
      setSelectedProviders([provider.provider]);
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "Failed to add server"),
  });
  if (!management) return null;

  const describeConnectionState = (state: ProviderMcpServerStatus["connectionState"]) => {
    if (state === "unknown") return "Configured · status not reported";
    if (state === "needs_auth") return "Needs authentication";
    return state.charAt(0).toUpperCase() + state.slice(1);
  };

  const submitAdd = () => {
    if (compatibleProviders.length > 1) {
      setSelectedProviders([provider.provider]);
      setProviderDialogOpen(true);
      return;
    }
    addMutation.mutate([provider.provider]);
  };

  return (
    <div className="ml-7 mt-4 border-t border-border/30 pt-4">
      <div className="text-[0.75rem] font-medium text-text-bright">Add MCP server</div>
      <div className="mt-0.5 text-[0.6875rem] text-muted">
        Relay passes this configuration to {provider.label}. Credentials in URLs are rejected.
      </div>
      <div className="mt-3">
        <McpServerFormFields
          name={name}
          onNameChange={setName}
          transport={transport}
          transports={management.transports}
          onTransportChange={setTransport}
          target={transport === "stdio" ? command : url}
          onTargetChange={transport === "stdio" ? setCommand : setUrl}
          args={commandArgs}
          onArgsChange={setCommandArgs}
          tokenEnvVar={tokenEnvVar}
          onTokenEnvVarChange={setTokenEnvVar}
          tokenProviderLabels={supportsBearerTokenEnvVar ? bearerTokenProviderLabels : undefined}
          pending={addMutation.isPending}
          onSubmit={submitAdd}
        />
      </div>
      {runtimeState?.mcpServers?.length ? (
        <div className="mt-3">
          <div className="space-y-1">
            {runtimeState.mcpServers.map((server) => (
              <div
                key={server.id}
                className="flex items-center justify-between rounded-md bg-surface-inset/60 px-2.5 py-1.5"
              >
                <div className="min-w-0">
                  <div className="truncate text-[0.75rem] text-text-bright">{server.name}</div>
                  <div className="text-[0.6875rem] text-muted">
                    {describeConnectionState(server.connectionState)}
                  </div>
                </div>
                {server.connectionState === "needs_auth" ? (
                  <div className="text-[0.6875rem] text-muted">
                    Authenticate with the {provider.label} CLI.
                  </div>
                ) : null}
              </div>
            ))}
          </div>
          <div className="mt-2 text-[0.6875rem] text-muted">
            Remove servers with the {provider.label} CLI.
          </div>
        </div>
      ) : null}
      <Dialog.Root open={providerDialogOpen} onOpenChange={setProviderDialogOpen}>
        <Dialog.Content maxWidth="max-w-md">
          <Dialog.Header>
            <Dialog.Title>Add MCP server to providers</Dialog.Title>
            <Dialog.Close />
          </Dialog.Header>
          <p className="text-[0.75rem] text-muted">
            This {transport.toUpperCase()} server can be added to multiple installed providers.
          </p>
          <div className="space-y-2 rounded-lg border border-border/50 bg-surface-inset/50 p-3">
            {compatibleProviders.map((candidate) => (
              <CheckboxField
                key={candidate.provider}
                checked={selectedProviders.includes(candidate.provider)}
                onCheckedChange={(checked) =>
                  setSelectedProviders((current) =>
                    checked
                      ? [...new Set([...current, candidate.provider])]
                      : current.filter((value) => value !== candidate.provider),
                  )
                }
                label={
                  <span className="inline-flex items-center gap-2">
                    <ProviderLogo provider={candidate.provider} className="h-3.5 w-3.5" />
                    {candidate.label}
                    {candidate.provider === provider.provider ? (
                      <span className="text-muted/70">(current)</span>
                    ) : null}
                  </span>
                }
              />
            ))}
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="ghost" onClick={() => setProviderDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              type="button"
              disabled={!selectedProviders.length || addMutation.isPending}
              onClick={() => addMutation.mutate(selectedProviders)}
            >
              {addMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              Add to {selectedProviders.length} provider{selectedProviders.length === 1 ? "" : "s"}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Root>
    </div>
  );
}

function ProviderDefaultsRow({
  provider,
  defaults,
  onChange,
  runtimeState,
  availableProviders,
}: {
  provider: ProviderDescriptor;
  defaults: ProviderDefaults;
  onChange: (field: keyof ProviderDefaults, value: string) => void;
  runtimeState?: ProviderGlobalState;
  availableProviders: ProviderDescriptor[];
}) {
  const { data: providerModels } = useQuery({
    queryKey: ["provider-models", provider.provider],
    queryFn: () => fetchProviderModels(provider.provider),
    staleTime: 60_000,
  });
  const models = providerModels?.models ?? [];
  const caps = providerModels?.capabilities ?? provider.capabilities;

  // Find actual defaults to show in placeholder text
  const defaultModel = models.find((m) => m.isDefault);

  // Per-model capabilities: reasoning effort levels and fast mode vary by model
  // (e.g. extra effort only on latest Opus). Use the selected model's resolvedCapabilities
  // so the controls reflect what that model actually supports.
  const selectedModel = defaults.model ? models.find((m) => m.id === defaults.model) : defaultModel;
  const modelCaps = selectedModel?.resolvedCapabilities ?? caps;
  const defaultRuntimeLabel = caps.runtimeModes?.["approval-required"]?.label;

  const hasAnyControls =
    caps.supportsModelSelection ||
    (caps.supportsReasoningEffort && caps.reasoningEffortLevels) ||
    !!caps.runtimeModes ||
    (caps.supportsFastMode && caps.fastModes);

  const hasRuntime = runtimeState != null;
  const accountLabel =
    runtimeState?.account?.label ?? runtimeState?.account?.email ?? runtimeState?.account?.plan;

  const versionAdvisory = provider.capabilities.versionAdvisory;
  // Always render the advisory section when an advisory exists, including
  // status: "unknown" — the card surfaces a "Re-check" button so users have a
  // way to retry the probe when the initial pass failed (e.g. transient
  // network outage on startup). Without this branch the section would
  // silently disappear for the entire 30-min refresh window.
  const showAdvisory = versionAdvisory != null;

  if (!hasAnyControls && !hasRuntime && !showAdvisory) return null;

  return (
    <div className="py-5">
      <div className="flex items-center gap-2.5 mb-4">
        <ProviderLogo provider={provider.provider} className="h-4 w-4" />
        <div>
          <div className="text-[0.8125rem] font-medium text-text-bright">{provider.label}</div>
          <div className="mt-0.5 text-[0.75rem] text-muted">
            Saved defaults when using {provider.label}.
          </div>
        </div>
      </div>

      {showAdvisory && versionAdvisory && (
        <div className={`pl-7 ${hasAnyControls ? "mb-4" : ""}`}>
          <ProviderVersionAdvisoryCard provider={provider.provider} advisory={versionAdvisory} />
        </div>
      )}

      {hasAnyControls && (
        <div className="flex flex-wrap gap-4 pl-7">
          {caps.supportsModelSelection && (
            <div className="flex flex-col gap-1.5">
              <label className="text-[0.6875rem] font-medium text-muted">Model</label>
              <Select
                inputSize="md"
                value={defaults.model ?? ""}
                onChange={(e) => onChange("model", e.target.value)}
              >
                <option value="">
                  {defaultModel ? `${defaultModel.label} (default)` : "Provider default"}
                </option>
                {models
                  .filter((m) => !m.hidden)
                  .map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label}
                    </option>
                  ))}
              </Select>
            </div>
          )}
          {modelCaps.supportsReasoningEffort && modelCaps.reasoningEffortLevels && (
            <div className="flex flex-col gap-1.5">
              <label className="text-[0.6875rem] font-medium text-muted">Reasoning</label>
              <Select
                inputSize="md"
                value={defaults.reasoningEffort ?? ""}
                onChange={(e) => onChange("reasoningEffort", e.target.value)}
              >
                <option value="">
                  {modelCaps.reasoningEffortLevels.find((l) => l.isDefault)?.label ?? "Medium"}{" "}
                  (default)
                </option>
                {modelCaps.reasoningEffortLevels.map((level) => (
                  <option key={level.effort} value={level.effort}>
                    {level.label}
                  </option>
                ))}
              </Select>
            </div>
          )}
          {caps.runtimeModes && (
            <div className="flex flex-col gap-1.5">
              <label className="text-[0.6875rem] font-medium text-muted">Mode</label>
              <Select
                inputSize="md"
                value={defaults.runtimeMode ?? ""}
                onChange={(e) => onChange("runtimeMode", e.target.value)}
              >
                <option value="">
                  {defaultRuntimeLabel ? `${defaultRuntimeLabel} (default)` : "Default"}
                </option>
                {(["approval-required", "full-access", "plan"] as const)
                  .filter((mode) => caps.runtimeModes?.[mode])
                  .map((mode) => (
                    <option key={mode} value={mode}>
                      {caps.runtimeModes![mode]!.label}
                    </option>
                  ))}
              </Select>
            </div>
          )}
          {modelCaps.supportsFastMode && modelCaps.fastModes && (
            <div className="flex flex-col gap-1.5">
              <label className="text-[0.6875rem] font-medium text-muted">Speed</label>
              <Select
                inputSize="md"
                value={defaults.fastMode != null ? String(defaults.fastMode) : ""}
                onChange={(e) => onChange("fastMode", e.target.value)}
              >
                <option value="">{modelCaps.fastModes.off.label} (default)</option>
                <option value="true">{modelCaps.fastModes.on.label}</option>
                <option value="false">{modelCaps.fastModes.off.label}</option>
              </Select>
            </div>
          )}
        </div>
      )}

      {/* Runtime state (account, MCP, rate limits) */}
      {hasRuntime && (
        <div className={`pl-7 ${hasAnyControls ? "mt-4 border-t border-border/30 pt-4" : ""}`}>
          <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1 text-[0.75rem]">
            {accountLabel && (
              <div className="flex items-baseline gap-1.5">
                <span className="text-[0.6875rem] text-muted">Account</span>
                <span className="font-medium text-text-bright">{accountLabel}</span>
              </div>
            )}
            {runtimeState?.account?.plan && runtimeState.account.plan !== accountLabel && (
              <div className="flex items-baseline gap-1.5">
                <span className="text-[0.6875rem] text-muted">Plan</span>
                <span className="font-medium text-text-bright capitalize">
                  {runtimeState.account.plan}
                </span>
              </div>
            )}
            {caps.mcp && typeof runtimeState?.mcpServers?.length === "number" && (
              <div className="flex items-baseline gap-1.5">
                <span className="text-[0.6875rem] text-muted">Provider MCP servers</span>
                <span className="font-medium text-text-bright">
                  {runtimeState.mcpServers.length}
                </span>
              </div>
            )}
          </div>
          {runtimeState?.account?.rateLimits?.length ? (
            <div className="mt-3 space-y-2">
              <div className="text-[0.6875rem] text-muted">Rate Limits</div>
              {flattenRateLimitWindows(runtimeState.account.rateLimits).map(
                ({ window, key, qualifier }) => (
                  <RateLimitBar key={key} window={window} size="md" qualifier={qualifier} />
                ),
              )}
            </div>
          ) : null}
        </div>
      )}
      <McpManagementForm
        provider={provider}
        runtimeState={runtimeState}
        availableProviders={availableProviders}
      />
    </div>
  );
}

// ─── Git Section ───────────────────────────────────────────────────────────

export function GitSettingsSection() {
  const { data: settings } = useGlobalSettings();
  const save = useAutoSave();
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const handleBranchChange = useCallback(
    (value: string) => {
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

  return (
    <SettingsSection
      title="Git"
      description="Default branch settings for new spaces. Projects can override these."
    >
      <SettingRow
        label="Default Space Branch"
        description="Base branch for new spaces when a project doesn't specify one."
      >
        <Input
          defaultValue={settings?.defaultSpaceBranch ?? ""}
          onChange={(e) => handleBranchChange(e.target.value)}
          placeholder="e.g. main"
          className="w-48"
        />
      </SettingRow>

      <SettingRow
        label="Branch Source"
        description="Whether to branch from local or remote tracking branches."
      >
        <RadioGroup
          value={settings?.spaceBranchSource ?? "local"}
          onValueChange={handleBranchSourceChange}
          className="flex items-center gap-4"
          name="g-space-branch-source"
        >
          <RadioGroupField value="local" label="Local" />
          <RadioGroupField value="remote" label="Remote" />
        </RadioGroup>
      </SettingRow>
    </SettingsSection>
  );
}

// ─── Instructions Section ──────────────────────────────────────────────────

export function InstructionsSettingsSection() {
  const { data: settings } = useGlobalSettings();
  const save = useAutoSave();

  const handleBlur = useCallback(
    (markdown: string) => {
      const value = markdown.trim() || null;
      if (value !== (settings?.customInstructions ?? null)) {
        save.mutate({ customInstructions: value });
      }
    },
    [save, settings?.customInstructions],
  );

  return (
    <SettingsSection
      title="Global Instructions"
      description="Injected into every session across all projects. Project-level instructions are appended after these."
    >
      <div className="pt-2">
        <div className="overflow-hidden rounded-lg border border-border bg-bg shadow-sm shadow-black/5 transition-all duration-150 focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/15">
          <MarkdownEditor
            key={`global-instructions-${settings?.customInstructions ?? ""}`}
            defaultValue={settings?.customInstructions ?? ""}
            onBlur={handleBlur}
            ariaLabel="Global instructions"
            placeholder="e.g. Always respond concisely. Use American English spelling..."
            className="min-h-[160px] max-h-[480px] overflow-y-auto text-[0.8125rem] leading-relaxed"
          />
        </div>
      </div>
    </SettingsSection>
  );
}

// ─── Suggestions Section ─────────────────────────────────────────────────

export function SuggestionsSettingsSection() {
  const { data: settings } = useGlobalSettings();
  const save = useAutoSave();

  return (
    <SuggestionSettings
      config={settings?.suggestions}
      onChange={(suggestions) => save.mutate({ suggestions })}
      title="Suggestions"
      description="Customize the prompt suggestions shown on new chats. Projects can further customize these."
    />
  );
}
