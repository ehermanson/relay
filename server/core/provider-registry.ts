import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { CoreConfig } from "#core/config.js";
import { ClaudeProcess } from "#core/claude-process.js";
import {
  DEFAULT_PROVIDER_CAPABILITIES,
  findProviderModelLabel,
  getBuiltinProviderModels,
  getProviderDisplayName,
  resolveProviderDefaultModelOption,
} from "#core/provider-catalog.js";
import type { ProviderSession } from "#core/provider.js";
import type {
  FileChange,
  HistoryEntry,
  ProviderCapabilities,
  ProviderDescriptor,
  ProviderKind,
  ProviderModelOption,
  ProviderModelOptions,
  ProviderRuntimeMode,
  ProviderSessionBootstrap,
  ProviderRuntimeBinding,
  SessionStats,
  TaskItem,
} from "#core/types.js";
import {
  createSdkSessionSync,
  getSdkDiscoveredModels,
  refreshSdkDiscoveredModelsIfStale,
} from "#core/providers/claude-sdk.js";
import { findClaudeBinary, isClaudeInstalled } from "#core/providers/claude-cli.js";
import { findCodexBinary, isCodexInstalled } from "#core/providers/codex-cli.js";
import {
  buildVersionAdvisory,
  compareSemver,
  executeUpdateCommand,
} from "#core/provider-versions.js";
import type { ProviderVersionAdvisory } from "#core/types.js";
import { getCachedCodexModels, refreshCodexModelsIfStale } from "#core/providers/codex-models.js";
import { CodexAppServerSession } from "#core/providers/codex-app-server.js";
import { findCodexTranscriptPath, parseCodexTranscript } from "#core/providers/codex-transcript.js";
import {
  DEFAULT_CODEX_TRANSCRIPT_ACTIVITY_WINDOW_MS,
  listCodexTranscripts,
  readCodexSessionMeta,
  selectCodexExternalTranscripts,
} from "#core/providers/codex-discovery.js";
import {
  isGitWorktree,
  isRelayWorktreePath,
  resolveAnyWorktreeOrigin,
  resolveWorktreeOrigin,
} from "#core/git.js";

const execFileAsync = promisify(execFile);

type QueryFn = ((params: { prompt: unknown; options?: unknown }) => unknown) | null;

interface ProviderTranscriptParseResult {
  cwd: string;
  /** Session start recorded in the transcript, when the provider stores one. */
  createdAt?: number;
  history: HistoryEntry[];
  tasks: Map<string, TaskItem>;
  files: Map<string, FileChange>;
  stats: SessionStats;
}

interface ProviderDriverContext {
  providerDirs: Record<ProviderKind, string>;
  logger: CoreConfig["logger"];
  sdkQueryFn: QueryFn;
  registeredDirectories?: Set<string>;
}

interface ProviderSessionOptions {
  resumeSessionId?: string;
  model?: string;
  runtimeMode?: ProviderRuntimeMode;
  allowedTools?: string[];
  modelOptions?: ProviderModelOptions;
  bootstrapContext?: ProviderSessionBootstrap;
}

interface ProviderCaptureContext {
  proc: ProviderSession;
  binding?: ProviderRuntimeBinding;
  fallbackSessionId?: string;
  workingDirectory: string;
  providerDirs: Record<ProviderKind, string>;
}

export interface DiscoveredExternalSession {
  provider: ProviderKind;
  cwd: string;
  transcriptPath: string;
  sessionId: string;
  pid?: number;
}

export interface ProviderDiscoveryTiming {
  provider: ProviderKind;
  ms: number;
  sessionCount: number;
}

export interface LiveExternalDiscoveryResult {
  sessions: DiscoveredExternalSession[];
  timings: ProviderDiscoveryTiming[];
}

interface ProviderExternalDiscoveryContext extends ProviderDriverContext {
  excludePids: Set<number>;
  runningProcessCwds?: Map<string, Map<string, { count: number; pids: number[] }>>;
  /**
   * How recently a transcript must have been written to count as a live
   * session without a matching process. Only drivers whose sessions can run
   * without a discoverable local process (Codex Desktop) consult it.
   */
  transcriptActivityWindowMs?: number;
}

interface ProviderDriver {
  kind: ProviderKind;
  capabilities: ProviderCapabilities;
  isAvailable(context: ProviderDriverContext): boolean;
  createSession(
    config: CoreConfig,
    options: ProviderSessionOptions | undefined,
    context: ProviderDriverContext,
  ): ProviderSession;
  getModels(context: ProviderDriverContext): Promise<ProviderModelOption[]>;
  parseTranscript(
    filePath: string,
    parseClaudeTranscript: (filePath: string) => ProviderTranscriptParseResult,
  ): ProviderTranscriptParseResult;
  resolveManagedTranscriptPath(options: {
    providerDirs: Record<ProviderKind, string>;
    sessionId?: string;
    transcriptPath?: string;
    workingDirectory?: string;
  }): string | undefined;
  captureManagedSession(
    context: ProviderCaptureContext,
  ): { sessionId: string; transcriptPath?: string } | null;
  discoverExternalSessions?(
    context: ProviderExternalDiscoveryContext,
  ): Promise<DiscoveredExternalSession[]>;
}

type ClaudeSdkModelInfo = NonNullable<ReturnType<typeof getSdkDiscoveredModels>>[number];

/** Strip the CLI's 1M-context alias suffix (e.g. "claude-opus-4-8[1m]"). */
function stripClaude1mSuffix(id: string): string {
  return id.replace(/\[1m\]$/i, "");
}

export function inferClaudeModelIdFromSdkInfo(model: ClaudeSdkModelInfo): string | null {
  // Newer CLIs report the canonical id directly — always prefer it. The
  // display-text fallbacks below exist only for CLIs that predate
  // `resolvedModel`; do not extend their family whitelist, new families are
  // covered by resolvedModel.
  if (model.resolvedModel?.startsWith("claude-")) return stripClaude1mSuffix(model.resolvedModel);
  if (model.value.startsWith("claude-")) return stripClaude1mSuffix(model.value);
  const text = `${model.displayName ?? ""} ${model.description ?? ""}`;
  const match = text.match(/\b(Opus|Sonnet|Haiku|Fable)\s+(\d+)(?:\.(\d+))?\b/i);
  if (!match) return null;
  const family = match[1].toLowerCase();
  const major = match[2];
  const minor = match[3];
  return minor ? `claude-${family}-${major}-${minor}` : `claude-${family}-${major}`;
}

function resolveClaudeProjectDir(providerRoot: string, workingDirectory: string): string {
  const projectsDir = join(providerRoot, "projects");
  return join(projectsDir, workingDirectory.replace(/[^A-Za-z0-9_-]/g, "-"));
}

function findRecentJsonls(projectDir: string, count: number): string[] {
  try {
    const files = readdirSync(projectDir)
      .filter((file) => file.endsWith(".jsonl"))
      .map((file) => {
        const fullPath = join(projectDir, file);
        try {
          return { path: fullPath, mtime: statSync(fullPath).mtimeMs };
        } catch {
          return null;
        }
      })
      .filter((entry): entry is { path: string; mtime: number } => entry !== null)
      .sort((a, b) => b.mtime - a.mtime);
    return files.slice(0, count).map((entry) => entry.path);
  } catch {
    return [];
  }
}

function normalizeDiscoveryDirectory(directory: string): string {
  if (isRelayWorktreePath(directory)) {
    return resolveWorktreeOrigin(directory) ?? directory;
  }
  if (isGitWorktree(directory)) {
    return resolveAnyWorktreeOrigin(directory) ?? directory;
  }
  return directory;
}

function buildDiscoveryDirectoryCandidates(directory: string): string[] {
  const candidates = new Set<string>();
  const push = (value: string | null | undefined) => {
    if (!value) return;
    candidates.add(value);
    candidates.add(normalizeDiscoveryDirectory(value));
    if (existsSync(value)) {
      try {
        candidates.add(realpathSync(value));
      } catch {
        // best-effort canonicalization only
      }
    }
  };
  push(directory);
  return [...candidates];
}

function isRegisteredDiscoveryDirectory(
  directory: string,
  registeredDirectories?: Set<string>,
): boolean {
  if (!registeredDirectories || registeredDirectories.size === 0) return true;
  if (registeredDirectories.has(directory)) return true;
  if (existsSync(directory)) {
    try {
      if (registeredDirectories.has(realpathSync(directory))) return true;
    } catch {
      // best-effort canonicalization only
    }
  }
  for (const candidate of buildDiscoveryDirectoryCandidates(directory)) {
    if (registeredDirectories.has(candidate)) return true;
  }
  return false;
}

async function findRunningProcessCwdsAsync(
  commandName: string,
  excludePids: Set<number>,
): Promise<Map<string, { count: number; pids: number[] }>> {
  const all = await findRunningProcessCwdsByCommandAsync([commandName], excludePids);
  return all.get(commandName) ?? new Map();
}

async function findRunningProcessCwdsByCommandAsync(
  commandNames: string[],
  excludePids: Set<number>,
): Promise<Map<string, Map<string, { count: number; pids: number[] }>>> {
  const names = new Set(commandNames);
  const grouped = new Map<string, Map<string, { count: number; pids: number[] }>>();
  for (const name of names) {
    grouped.set(name, new Map());
  }

  try {
    if (names.size === 0) return grouped;

    const { stdout: psOutput } = await execFileAsync("ps", ["-eo", "pid=,ppid=,comm="], {
      encoding: "utf-8",
      timeout: 5000,
    });

    const ppidByPid = new Map<number, number>();
    const candidates: Array<{ pid: number; command: string }> = [];
    for (const line of psOutput.split("\n")) {
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
      if (!match) continue;
      const pid = parseInt(match[1], 10);
      ppidByPid.set(pid, parseInt(match[2], 10));
      const command = match[3].split("/").pop() ?? match[3];
      if (!names.has(command)) continue;
      if (excludePids.has(pid)) continue;
      candidates.push({ pid, command });
    }

    // Exclude descendants of this Relay server process. SDK-managed provider
    // CLIs are spawned as children of Relay but don't expose their PID
    // (ProviderSession.pid is undefined for SDK sessions), so excludePids
    // can't cover them. Without this check they get mispaired with external
    // sessions' JSONLs, and takeover then SIGKILLs a managed session's process.
    const isRelayDescendant = (pid: number): boolean => {
      let current = ppidByPid.get(pid);
      for (let depth = 0; current !== undefined && current > 1 && depth < 64; depth++) {
        if (current === process.pid) return true;
        current = ppidByPid.get(current);
      }
      return false;
    };

    const pids: number[] = [];
    const commandByPid = new Map<number, string>();
    for (const { pid, command } of candidates) {
      if (isRelayDescendant(pid)) continue;
      pids.push(pid);
      commandByPid.set(pid, command);
    }

    if (pids.length === 0) return grouped;

    const BATCH_SIZE = 64;
    for (let offset = 0; offset < pids.length; offset += BATCH_SIZE) {
      const batch = pids.slice(offset, offset + BATCH_SIZE);
      const { stdout } = await execFileAsync(
        "lsof",
        ["-p", batch.join(","), "-a", "-d", "cwd", "-Fp", "-Fn"],
        { encoding: "utf-8", timeout: 5000 },
      );

      let currentPid: number | null = null;
      for (const line of stdout.split("\n")) {
        if (line.startsWith("p")) {
          const parsed = parseInt(line.slice(1), 10);
          currentPid = Number.isFinite(parsed) ? parsed : null;
          continue;
        }
        if (!line.startsWith("n/") || currentPid === null) continue;
        const command = commandByPid.get(currentPid);
        if (!command) continue;
        const cwd = line.slice(1);
        const cwdInfo =
          grouped.get(command) ?? new Map<string, { count: number; pids: number[] }>();
        const existing = cwdInfo.get(cwd) ?? { count: 0, pids: [] };
        existing.count++;
        existing.pids.push(currentPid);
        cwdInfo.set(cwd, existing);
        grouped.set(command, cwdInfo);
      }
    }
  } catch {
    return grouped;
  }

  return grouped;
}

async function discoverClaudeExternalSessions(
  context: ProviderExternalDiscoveryContext,
): Promise<DiscoveredExternalSession[]> {
  const cwdInfoMap =
    context.runningProcessCwds?.get("claude") ??
    (await findRunningProcessCwdsAsync("claude", context.excludePids));
  const sessions: DiscoveredExternalSession[] = [];
  for (const [cwd, info] of cwdInfoMap) {
    if (!isRegisteredDiscoveryDirectory(cwd, context.registeredDirectories)) continue;
    const projectDir = resolveClaudeProjectDir(context.providerDirs.claude, cwd);
    if (!existsSync(projectDir)) continue;
    const jsonlPaths = findRecentJsonls(projectDir, info.count);
    for (let i = 0; i < jsonlPaths.length; i++) {
      const transcriptPath = jsonlPaths[i];
      const fileName = transcriptPath.split("/").pop() || "";
      sessions.push({
        provider: "claude",
        cwd,
        transcriptPath,
        sessionId: fileName.replace(".jsonl", ""),
        pid: info.pids[i],
      });
    }
  }
  return sessions;
}

async function discoverCodexExternalSessions(
  context: ProviderExternalDiscoveryContext,
): Promise<DiscoveredExternalSession[]> {
  const cwdInfoMap =
    context.runningProcessCwds?.get("codex") ??
    (await findRunningProcessCwdsAsync("codex", context.excludePids));
  // Process-backed cwds plus still-being-written rollouts (Codex Desktop
  // exposes no `codex` process with the project cwd) — see codex-discovery.ts.
  const selected = selectCodexExternalTranscripts({
    transcripts: listCodexTranscripts(context.providerDirs.codex),
    readMeta: (candidate) => readCodexSessionMeta(candidate.path, candidate.mtime),
    processCwds: cwdInfoMap,
    isRegisteredDirectory: (cwd) =>
      isRegisteredDiscoveryDirectory(cwd, context.registeredDirectories),
    activeSince:
      Date.now() -
      (context.transcriptActivityWindowMs ?? DEFAULT_CODEX_TRANSCRIPT_ACTIVITY_WINDOW_MS),
  });
  return selected.map((transcript) => ({
    provider: "codex",
    cwd: transcript.cwd,
    transcriptPath: transcript.path,
    sessionId: transcript.sessionId,
    pid: transcript.pid,
  }));
}

function createClaudeSession(
  config: CoreConfig,
  options: ProviderSessionOptions | undefined,
  context: ProviderDriverContext,
): ProviderSession {
  if (context.sdkQueryFn) {
    return createSdkSessionSync(
      {
        cwd: config.workingDirectory,
        model: options?.model,
        reasoningEffort: options?.modelOptions?.reasoningEffort,
        fastMode: options?.modelOptions?.fastMode,
        runtimeMode: options?.runtimeMode ?? config.defaultRuntimeMode,
        resumeSessionId: options?.resumeSessionId,
        logger: config.logger,
        processTimeout: config.processTimeout,
        allowedTools: options?.allowedTools,
        bootstrapContext: options?.bootstrapContext,
      },
      context.sdkQueryFn as Parameters<typeof createSdkSessionSync>[1],
    );
  }

  const proc = options?.resumeSessionId
    ? new ClaudeProcess(config, {
        resumeSessionId: options.resumeSessionId,
        model: options?.model,
        runtimeMode: options?.runtimeMode,
      })
    : new ClaudeProcess(config, {
        model: options?.model,
        runtimeMode: options?.runtimeMode,
      });

  if (options?.allowedTools) {
    for (const tool of options.allowedTools) {
      proc.addAllowedTool(tool);
    }
  }

  return proc;
}

const PROVIDER_DRIVERS: Record<ProviderKind, ProviderDriver> = {
  claude: {
    kind: "claude",
    capabilities: DEFAULT_PROVIDER_CAPABILITIES.claude,
    isAvailable() {
      return isClaudeInstalled();
    },
    createSession(config, options, context) {
      return createClaudeSession(config, options, context);
    },
    async getModels(context) {
      // Kick a background re-probe when the discovery snapshot is stale so a
      // long-running server surfaces newly released models without a restart.
      void refreshSdkDiscoveredModelsIfStale(context.logger);

      const sdkModels = getSdkDiscoveredModels();
      const builtins = getBuiltinProviderModels("claude");
      if (!sdkModels?.length) return builtins;

      // The SDK-discovered list is canonical (mirrors the Codex driver): new
      // models the CLI reports surface in SDK order without a catalog bump.
      // The builtin catalog only enriches metadata and appends still-valid
      // models the SDK no longer enumerates.

      // Programmatic per-model capabilities — derived from SDK metadata where
      // available. This is what makes e.g. new Opus higher reasoning tiers
      // surface in the UI without hardcoding it client-side.
      const claudeProviderCaps = DEFAULT_PROVIDER_CAPABILITIES.claude;
      const builtinEffortLevels = claudeProviderCaps.reasoningEffortLevels ?? [];
      const buildModelCapabilities = (
        sdkMatch: ClaudeSdkModelInfo | undefined,
        builtinOverride: Partial<ProviderCapabilities> | undefined,
      ): Partial<ProviderCapabilities> | undefined => {
        const override: Partial<ProviderCapabilities> = { ...(builtinOverride ?? {}) };
        if (sdkMatch) {
          if (typeof sdkMatch.supportsEffort === "boolean") {
            override.supportsReasoningEffort = sdkMatch.supportsEffort;
          }
          if (sdkMatch.supportedEffortLevels && sdkMatch.supportedEffortLevels.length > 0) {
            const allowed = new Set<string>(sdkMatch.supportedEffortLevels);
            // Use per-model levels as filter base (preserves per-model isDefault),
            // falling back to provider-level levels for SDK-only extras.
            const baseLevels = override.reasoningEffortLevels ?? builtinEffortLevels;
            const filtered = baseLevels.filter((level) => allowed.has(level.effort));
            if (filtered.length > 0) override.reasoningEffortLevels = filtered;
          }
          if (typeof sdkMatch.supportsFastMode === "boolean") {
            override.supportsFastMode = sdkMatch.supportsFastMode;
          }
        }
        return Object.keys(override).length > 0 ? override : undefined;
      };

      const builtinById = new Map(builtins.map((b) => [b.id, b]));
      const defaultEntry = sdkModels.find((m) => m.value === "default");
      const defaultId = defaultEntry ? inferClaudeModelIdFromSdkInfo(defaultEntry) : null;

      const discovered: ProviderModelOption[] = [];
      const seenIds = new Set<string>();
      const seenLabels = new Set<string>();
      for (const m of sdkModels) {
        if (m.value === "default") continue;
        // Fall back to the raw alias for entries we can't canonicalize — the
        // CLI accepts its own alias values as --model.
        const id = inferClaudeModelIdFromSdkInfo(m) ?? m.value;
        if (seenIds.has(id)) continue;
        seenIds.add(id);
        const builtin = builtinById.get(id);
        const label = findProviderModelLabel("claude", id) ?? m.displayName ?? id;
        seenLabels.add(label);
        const capabilities = buildModelCapabilities(m, builtin?.capabilities);
        discovered.push({
          provider: "claude" as const,
          id,
          label,
          description: m.description || builtin?.description,
          isDefault: defaultId !== null && id === defaultId,
          ...(capabilities ? { capabilities } : {}),
        });
      }

      // Builtin catalog entries the SDK didn't report stay selectable below
      // the discovered list — the Claude API accepts full model IDs even when
      // the SDK's alias list doesn't enumerate them, so removing them would
      // make valid choices disappear without actually preventing session use.
      const extras = builtins
        .filter((b) => !seenIds.has(b.id) && !seenLabels.has(b.label))
        .map((b) => ({ ...b, isDefault: false }));

      const models = [...discovered, ...extras];
      if (models.some((model) => model.isDefault)) return models;
      const defaultModel = resolveProviderDefaultModelOption("claude", models);
      return models.map((model) => ({
        ...model,
        isDefault: model.id === defaultModel?.id,
      }));
    },
    parseTranscript(filePath, parseClaudeTranscript) {
      return parseClaudeTranscript(filePath);
    },
    resolveManagedTranscriptPath(options) {
      if (options.transcriptPath && existsSync(options.transcriptPath)) {
        return options.transcriptPath;
      }
      if (!options.sessionId || !options.workingDirectory) {
        return options.transcriptPath;
      }
      const projectDir = resolveClaudeProjectDir(
        options.providerDirs.claude,
        options.workingDirectory,
      );
      return join(projectDir, `${options.sessionId}.jsonl`);
    },
    captureManagedSession(context) {
      const binding = context.binding ?? context.proc.getRuntimeBinding();
      const runtimeSessionId = binding.providerSessionId ?? context.fallbackSessionId;
      const projectDir = resolveClaudeProjectDir(
        context.providerDirs.claude,
        context.workingDirectory,
      );
      if (!existsSync(projectDir)) {
        return runtimeSessionId ? { sessionId: runtimeSessionId } : null;
      }

      if (runtimeSessionId) {
        const jsonlPath = join(projectDir, `${runtimeSessionId}.jsonl`);
        if (existsSync(jsonlPath)) {
          return { sessionId: runtimeSessionId, transcriptPath: jsonlPath };
        }
      }

      const files = readdirSync(projectDir)
        .filter((file) => file.endsWith(".jsonl"))
        .map((file) => {
          const fullPath = join(projectDir, file);
          try {
            return { path: fullPath, mtime: statSync(fullPath).mtimeMs };
          } catch {
            return null;
          }
        })
        .filter((entry): entry is { path: string; mtime: number } => entry !== null)
        .sort((a, b) => b.mtime - a.mtime);

      if (files.length === 0) {
        return runtimeSessionId ? { sessionId: runtimeSessionId } : null;
      }

      const newest = files[0];
      const fileName = newest.path.split("/").pop() || "";
      return {
        sessionId: runtimeSessionId ?? fileName.replace(".jsonl", ""),
        transcriptPath: newest.path,
      };
    },
    discoverExternalSessions(context) {
      return discoverClaudeExternalSessions(context);
    },
  },
  codex: {
    kind: "codex",
    capabilities: DEFAULT_PROVIDER_CAPABILITIES.codex,
    isAvailable() {
      return isCodexInstalled();
    },
    createSession(config, options) {
      return new CodexAppServerSession({
        cwd: config.workingDirectory,
        model: options?.model,
        runtimeMode: options?.runtimeMode ?? config.defaultRuntimeMode,
        resumeSessionId: options?.resumeSessionId,
        logger: config.logger,
        processTimeout: config.processTimeout,
        modelOptions: options?.modelOptions,
        bootstrapContext: options?.bootstrapContext,
      });
    },
    async getModels(context) {
      // Prefer the pre-warm cache populated at server boot so the first
      // /api/provider-models?provider=codex hit doesn't pay the cost of
      // spawning `codex app-server`. On a warm cache, kick a background
      // re-probe when stale so a long-running server picks up models added by
      // a CLI update (including Relay's own provider-update flow) without a
      // restart; on a cold cache, await the probe directly.
      const cached = getCachedCodexModels();
      if (cached) {
        void refreshCodexModelsIfStale({ logger: context.logger });
      } else {
        await refreshCodexModelsIfStale({ logger: context.logger });
      }
      const discovered = getCachedCodexModels() ?? [];
      if (discovered.length === 0) {
        return getBuiltinProviderModels("codex");
      }

      // Discovered list is canonical — new models the Codex binary reports
      // should surface even if we haven't added them to the builtin catalog.
      // Builtins still contribute polished labels + any per-model capability
      // overrides (Codex JSON-RPC doesn't expose capability metadata today).
      const builtinById = new Map(
        getBuiltinProviderModels("codex").map((model) => [model.id, model]),
      );
      // Default resolution: trust the binary's `isDefault` if any model is
      // marked. Otherwise fall back to our builtin catalog's default mark so
      // a predictable model (e.g. gpt-5.4) is selected. Without this, Codex
      // binaries that don't report `isDefault` would leave no model marked,
      // and `resolveProviderDefaultModelOption` would fall through to
      // `candidateModels[0]` — whatever the binary happened to list first.
      const discoveredHasDefault = discovered.some((model) => model.isDefault);
      const mergedModels = discovered.map((model) => {
        const builtin = builtinById.get(model.id);
        if (!builtin) {
          return {
            ...model,
            label:
              model.label && model.label !== model.id
                ? model.label
                : (findProviderModelLabel("codex", model.id) ?? model.label),
          };
        }
        const isDefault = discoveredHasDefault
          ? model.isDefault
          : (builtin.isDefault ?? model.isDefault);
        return {
          ...model,
          label: builtin.label || model.label,
          description: model.description ?? builtin.description,
          // Prefer discovered metadata where available; fall back to builtin.
          hidden: model.hidden ?? builtin.hidden,
          isDefault,
          availabilityNote: model.availabilityNote ?? builtin.availabilityNote,
          upgradeTo: model.upgradeTo ?? builtin.upgradeTo,
          ...(builtin.capabilities ? { capabilities: builtin.capabilities } : {}),
        };
      });
      if (mergedModels.some((model) => model.isDefault)) {
        return mergedModels;
      }
      const defaultModel = resolveProviderDefaultModelOption("codex", mergedModels);
      return mergedModels.map((model) => ({
        ...model,
        isDefault: model.id === defaultModel?.id,
      }));
    },
    parseTranscript(filePath) {
      const parsed = parseCodexTranscript(filePath);
      return {
        cwd: parsed.cwd,
        history: parsed.history,
        tasks: parsed.tasks,
        files: parsed.files,
        stats: parsed.stats,
      };
    },
    resolveManagedTranscriptPath(options) {
      if (options.transcriptPath && existsSync(options.transcriptPath)) {
        return options.transcriptPath;
      }
      if (!options.sessionId) {
        return options.transcriptPath;
      }
      return (
        findCodexTranscriptPath(options.providerDirs.codex, options.sessionId) ??
        options.transcriptPath
      );
    },
    captureManagedSession(context) {
      const binding = context.binding ?? context.proc.getRuntimeBinding();
      const sessionId = binding.providerSessionId ?? context.fallbackSessionId;
      if (!sessionId) {
        return null;
      }
      return {
        sessionId,
        transcriptPath:
          findCodexTranscriptPath(context.providerDirs.codex, sessionId) ?? binding.transcriptPath,
      };
    },
    discoverExternalSessions(context) {
      return discoverCodexExternalSessions(context);
    },
  },
};

export function getProviderDriver(provider: ProviderKind): ProviderDriver {
  return PROVIDER_DRIVERS[provider];
}

export function isProviderAvailable(
  provider: ProviderKind,
  context: ProviderDriverContext,
): boolean {
  // Tolerate unknown/stale provider kinds (e.g. a persisted row or WS payload
  // naming a provider this build no longer registers) — report unavailable
  // rather than throwing on the undefined driver lookup.
  const driver = PROVIDER_DRIVERS[provider] as ProviderDriver | undefined;
  return driver?.isAvailable(context) ?? false;
}

// ─── Version advisory cache ─────────────────────────────────────────────────
//
// Background-refreshed in-memory cache: probes each available provider's
// installed CLI vs the latest npm version, stashes the result here, and
// `getProviderCapabilities()` merges it into the descriptor returned to the
// UI. First-paint descriptors carry no advisory (status reads as "unknown" on
// the client) — the probe completes a few seconds later and the next refetch
// of `/api/providers` picks up the populated advisory.

const ADVISORY_REFRESH_INTERVAL_MS = 30 * 60 * 1_000;
const versionAdvisoryCache = new Map<ProviderKind, ProviderVersionAdvisory>();
let advisoryRefreshTimer: NodeJS.Timeout | null = null;
const inflightProbes = new Map<ProviderKind, Promise<void>>();
const probeGenerations = new Map<ProviderKind, number>();

const PROVIDER_BINARY_LOCATORS: Partial<Record<ProviderKind, () => string | null>> = {
  claude: findClaudeBinary,
  codex: findCodexBinary,
};

export function getCachedVersionAdvisory(
  provider: ProviderKind,
): ProviderVersionAdvisory | undefined {
  return versionAdvisoryCache.get(provider);
}

async function probeProviderVersionAdvisory(
  provider: ProviderKind,
  generation: number,
  options: { force?: boolean } = {},
): Promise<void> {
  const locator = PROVIDER_BINARY_LOCATORS[provider];
  if (!locator) return;
  const binaryPath = locator();
  const advisory = await buildVersionAdvisory({
    provider,
    binaryPath,
    force: options.force,
  });
  // A force-refresh may be started while an older background probe is still in
  // flight. Only the newest generation is allowed to publish so stale pre-update
  // results cannot overwrite the post-update advisory.
  if (probeGenerations.get(provider) === generation) {
    versionAdvisoryCache.set(provider, advisory);
  }
}

/**
 * Refresh advisories for one or all providers. Probes run in parallel; each
 * provider's probe is deduped via `inflightProbes` so concurrent callers (e.g.
 * UI mount + the background timer) share a single probe.
 *
 * Returns when all relevant probes complete. Never throws — individual probe
 * failures are absorbed by `buildVersionAdvisory()` which returns a status:
 * "unknown" advisory.
 */
export async function refreshProviderVersionAdvisories(
  options: {
    provider?: ProviderKind;
    force?: boolean;
  } = {},
): Promise<void> {
  const candidates: ProviderKind[] = options.provider
    ? [options.provider]
    : (Object.keys(PROVIDER_BINARY_LOCATORS) as ProviderKind[]);

  await Promise.all(
    candidates.map((provider) => {
      const existing = inflightProbes.get(provider);
      if (existing && !options.force) return existing;
      const generation = (probeGenerations.get(provider) ?? 0) + 1;
      probeGenerations.set(provider, generation);
      const probe = probeProviderVersionAdvisory(provider, generation, options).finally(() => {
        if (inflightProbes.get(provider) === probe) {
          inflightProbes.delete(provider);
        }
      });
      inflightProbes.set(provider, probe);
      return probe;
    }),
  );
}

export type ProviderUpdateOutcome =
  | { status: "no_update" }
  | { status: "failed"; output: string }
  | { status: "updated"; output: string };

const inflightUpdates = new Map<ProviderKind, Promise<ProviderUpdateOutcome>>();

/**
 * Run the cached advisory's update command for a provider, then force-refresh
 * the advisory so callers see the post-update state. The command is always
 * server-derived (from `buildUpdateCommand`), never client-supplied.
 *
 * Concurrent calls for the same provider share a single run — a second
 * request while an update is in flight awaits the same result rather than
 * spawning a second package-manager process.
 */
export function runProviderUpdate(provider: ProviderKind): Promise<ProviderUpdateOutcome> {
  const existing = inflightUpdates.get(provider);
  if (existing) return existing;

  const run = (async (): Promise<ProviderUpdateOutcome> => {
    const advisory = versionAdvisoryCache.get(provider);
    if (
      !advisory ||
      advisory.status !== "behind_latest" ||
      !advisory.updateCommand ||
      !advisory.installMethod ||
      advisory.installMethod === "manual"
    ) {
      return { status: "no_update" };
    }
    const providerBinaryPath =
      advisory.installMethod === "native" ? PROVIDER_BINARY_LOCATORS[provider]?.() : null;
    const result = await executeUpdateCommand(advisory.updateCommand, advisory.installMethod, {
      providerBinaryPath,
    });
    // Re-probe regardless of outcome so the advisory reflects reality (the
    // command may have partially succeeded, or failed after upgrading).
    await refreshProviderVersionAdvisories({ provider, force: true });
    return result.ok
      ? { status: "updated", output: result.output }
      : { status: "failed", output: result.output };
  })().finally(() => {
    inflightUpdates.delete(provider);
  });

  inflightUpdates.set(provider, run);
  return run;
}

function ensureAdvisoryRefreshTimer(): void {
  if (advisoryRefreshTimer) return;
  // Kick off an initial probe non-blocking; subsequent probes fire every 30min.
  void refreshProviderVersionAdvisories();
  advisoryRefreshTimer = setInterval(() => {
    void refreshProviderVersionAdvisories();
  }, ADVISORY_REFRESH_INTERVAL_MS);
  // Don't keep the process alive just for the version probe.
  advisoryRefreshTimer.unref?.();
}

export function listAvailableProviders(context: ProviderDriverContext): ProviderDescriptor[] {
  // Testing override: set RELAY_HIDE_PROVIDERS=1 to simulate no providers installed
  if (process.env.RELAY_HIDE_PROVIDERS === "1") {
    return [];
  }

  // Lazily start the background refresh on first descriptor request so test
  // environments that never call this don't accumulate stray intervals.
  ensureAdvisoryRefreshTimer();

  return (Object.keys(PROVIDER_DRIVERS) as ProviderKind[])
    .filter((provider) => isProviderAvailable(provider, context))
    .map((provider) => ({
      provider,
      label: getProviderDisplayName(provider),
      capabilities: getProviderCapabilities(provider),
    }));
}

export async function getProviderModels(
  provider: ProviderKind,
  context: ProviderDriverContext,
): Promise<ProviderModelOption[]> {
  return getProviderDriver(provider).getModels(context);
}

export function getProviderCapabilities(provider: ProviderKind): ProviderCapabilities {
  // Return static provider-level defaults. Per-model capability overrides
  // (derived from SDK discovery in getModels()) are applied via
  // mergeCapabilities() in the route — this avoids leaking capabilities from
  // one model onto another through provider-level aggregation.
  const base = getProviderDriver(provider).capabilities;
  const advisory = versionAdvisoryCache.get(provider);
  const effective = buildEffectiveProviderCapabilities(provider, base, advisory);
  // Always include a versionAdvisory if we have one cached; the UI uses its
  // presence (vs absence) to know whether the probe has completed yet.
  return advisory ? { ...effective, versionAdvisory: advisory } : effective;
}

const CODEX_WRITES_MIN_VERSION = "0.144.0";

function isTruthyEnvironmentValue(value: string | undefined): boolean {
  return value != null && ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function readClaudeUserSettings(): Record<string, unknown> | null {
  const configDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(configDir, "settings.json"), "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function isClaudeAutoModeAvailable(
  env: NodeJS.ProcessEnv = process.env,
  userSettings: Record<string, unknown> | null = readClaudeUserSettings(),
): boolean {
  if (userSettings?.disableAutoMode === "disable") return false;
  return [
    "CLAUDE_CODE_ENABLE_AUTO_MODE",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY",
  ].some((name) => isTruthyEnvironmentValue(env[name]));
}

export function buildEffectiveProviderCapabilities(
  provider: ProviderKind,
  base: ProviderCapabilities,
  advisory?: ProviderVersionAdvisory,
  options: {
    env?: NodeJS.ProcessEnv;
    claudeUserSettings?: Record<string, unknown> | null;
  } = {},
): ProviderCapabilities {
  const runtimeModes = { ...base.runtimeModes };

  if (provider === "codex") {
    const version = advisory?.currentVersion;
    const isValidVersion = !!version && /^v?\d+(?:\.\d+){0,2}(?:[-+]|$)/i.test(version);
    if (!isValidVersion || compareSemver(version, CODEX_WRITES_MIN_VERSION) < 0) {
      delete runtimeModes["writes-only"];
    }
  }

  if (
    provider === "claude" &&
    !isClaudeAutoModeAvailable(options.env, options.claudeUserSettings)
  ) {
    delete runtimeModes.auto;
  }

  return { ...base, runtimeModes };
}

export function createManagedProviderSession(
  provider: ProviderKind,
  config: CoreConfig,
  options: ProviderSessionOptions | undefined,
  context: ProviderDriverContext,
): ProviderSession {
  const driver = getProviderDriver(provider);
  if (!driver.isAvailable(context)) {
    const binary = provider === "codex" ? "Codex CLI" : getProviderDisplayName(provider);
    throw new Error(`${binary} is not available on this machine`);
  }
  const requestedMode = options?.runtimeMode ?? config.defaultRuntimeMode;
  const runtimeMode = getProviderCapabilities(provider).runtimeModes?.[requestedMode]
    ? requestedMode
    : "approval-required";
  return driver.createSession(config, { ...options, runtimeMode }, context);
}

export function resolveManagedTranscriptPathForProvider(
  provider: ProviderKind,
  options: Parameters<ProviderDriver["resolveManagedTranscriptPath"]>[0],
): string | undefined {
  return getProviderDriver(provider).resolveManagedTranscriptPath(options);
}

export function parseTranscriptForProvider(
  provider: ProviderKind,
  filePath: string,
  parseClaudeTranscript: (filePath: string) => ProviderTranscriptParseResult,
): ProviderTranscriptParseResult {
  return getProviderDriver(provider).parseTranscript(filePath, parseClaudeTranscript);
}

export function captureManagedSessionForProvider(
  provider: ProviderKind,
  context: ProviderCaptureContext,
): { sessionId: string; transcriptPath?: string } | null {
  return getProviderDriver(provider).captureManagedSession(context);
}

export async function discoverLiveExternalSessions(
  context: ProviderDriverContext,
  excludePids: Set<number>,
  options: { transcriptActivityWindowMs?: number } = {},
): Promise<LiveExternalDiscoveryResult> {
  const activeProviders = getRegisteredProviders().filter((provider) => {
    const driver = getProviderDriver(provider);
    return driver.discoverExternalSessions && driver.isAvailable(context);
  });
  const processCommands = activeProviders.flatMap((provider) => {
    if (provider === "claude") return ["claude"];
    if (provider === "codex") return ["codex"];
    return [];
  });
  const runningProcessCwds = await findRunningProcessCwdsByCommandAsync(
    processCommands,
    excludePids,
  );

  const results = await Promise.all(
    activeProviders.map(async (provider) => {
      const driver = getProviderDriver(provider);
      const startedAt = performance.now();
      const sessions = await driver.discoverExternalSessions!({
        ...context,
        excludePids,
        runningProcessCwds,
        transcriptActivityWindowMs: options.transcriptActivityWindowMs,
      });
      return {
        provider,
        sessions,
        ms: performance.now() - startedAt,
      };
    }),
  );
  return {
    sessions: results.flatMap((result) => result.sessions),
    timings: results.map((result) => ({
      provider: result.provider,
      ms: result.ms,
      sessionCount: result.sessions.length,
    })),
  };
}

export function getRegisteredProviders(): ProviderKind[] {
  return Object.keys(PROVIDER_DRIVERS) as ProviderKind[];
}
