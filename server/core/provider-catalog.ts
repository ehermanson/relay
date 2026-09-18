import type {
  ProviderCapabilities,
  ProviderKind,
  ProviderModelOption,
  ReasoningEffort,
} from "#core/types.js";

export const PROVIDER_DISPLAY_NAMES: Record<ProviderKind, string> = {
  claude: "Claude Code",
  codex: "Codex",
};

const REASONING_LEVEL_DEFS: Record<ReasoningEffort, { label: string; description: string }> = {
  low: { label: "Low", description: "Fastest responses, minimal reasoning" },
  medium: { label: "Medium", description: "Balanced depth and speed" },
  high: { label: "High", description: "More reasoning for harder tasks" },
  xhigh: { label: "Extra High", description: "Extended reasoning for complex tasks" },
  max: { label: "Max", description: "Deepest reasoning, usually slower" },
};

type ReasoningLevel = {
  effort: ReasoningEffort;
  label: string;
  description: string;
  isDefault?: boolean;
};

function reasoningLevels(
  defaultEffort: ReasoningEffort,
  ...efforts: ReasoningEffort[]
): ReasoningLevel[] {
  return efforts.map((effort) => ({
    effort,
    ...REASONING_LEVEL_DEFS[effort],
    ...(effort === defaultEffort ? { isDefault: true } : {}),
  }));
}

const STANDARD_EFFORTS = reasoningLevels("medium", "low", "medium", "high", "max");
const EXTENDED_EFFORTS = reasoningLevels("xhigh", "low", "medium", "high", "xhigh", "max");

function toTitleCaseToken(token: string): string {
  return token
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

function formatCodexModelLabel(modelId: string): string {
  const parts = modelId.split("-");
  if (parts.length === 0) return modelId;
  return parts
    .map((part, index) => {
      if (index === 0 && /^gpt$/i.test(part)) return "GPT";
      if (/^\d+(?:\.\d+)*$/.test(part)) return part;
      if (/^[a-z]+$/i.test(part) && part.length <= 4) return part.toUpperCase();
      return toTitleCaseToken(part);
    })
    .join("-");
}

function codexFamilyRank(modelId: string): number {
  const lowerId = modelId.toLowerCase();
  if (/(?:^|-)spark(?:-|$)/.test(lowerId)) return 0;
  if (/(?:^|-)mini(?:-|$)/.test(lowerId)) return 1;
  if (/(?:^|-)codex(?:-|$)/.test(lowerId)) return 2;
  return 3;
}

function codexVersionTuple(modelId: string): number[] {
  const match = modelId.toLowerCase().match(/^gpt-(\d+(?:\.\d+)*)/);
  return match ? match[1].split(".").map((part) => Number.parseInt(part, 10) || 0) : [];
}

function compareVersionTuples(a: number[], b: number[]): number {
  const len = Math.max(a.length, b.length);
  for (let index = 0; index < len; index += 1) {
    const left = a[index] ?? 0;
    const right = b[index] ?? 0;
    if (left !== right) return left - right;
  }
  return 0;
}

function resolveCodexDefaultModelOption(
  models: readonly ProviderModelOption[],
): ProviderModelOption | undefined {
  if (models.length === 0) return undefined;
  const explicitDefault = models.find((model) => model.isDefault);
  if (explicitDefault) return explicitDefault;
  return [...models].sort((left, right) => {
    const versionOrder = compareVersionTuples(
      codexVersionTuple(right.id),
      codexVersionTuple(left.id),
    );
    if (versionOrder !== 0) return versionOrder;
    const familyOrder = codexFamilyRank(right.id) - codexFamilyRank(left.id);
    if (familyOrder !== 0) return familyOrder;
    return left.id.localeCompare(right.id);
  })[0];
}

function formatClaudeModelLabel(modelId: string): string | null {
  // Match any `claude-<family>-<major>[-<minor>]` id — the family list is
  // deliberately NOT a whitelist, so newly released family names (e.g.
  // "fable") format correctly without a code change.
  const match = modelId.match(/^claude-([a-z]+)-(\d+)(?:-(\d+))?/i);
  if (!match) return null;
  const family = toTitleCaseToken(match[1]);
  const version = match[3] ? `${match[2]}.${match[3]}` : match[2];
  return `${family} ${version}`;
}

/**
 * Offline fallback + metadata enrichment only. For Claude the SDK-discovered
 * model list is canonical (see the claude driver's getModels in
 * provider-registry.ts) — these entries render only before discovery resolves
 * or as appended extras when the SDK no longer enumerates them. Do not rely on
 * bumping this list to surface new models.
 */
export const BUILTIN_PROVIDER_MODELS: Record<ProviderKind, readonly ProviderModelOption[]> = {
  claude: [
    {
      provider: "claude",
      id: "claude-opus-5",
      label: "Opus 5",
      isDefault: true,
      capabilities: { reasoningEffortLevels: EXTENDED_EFFORTS },
    },
    {
      provider: "claude",
      id: "claude-opus-4-8",
      label: "Opus 4.8",
      capabilities: { reasoningEffortLevels: EXTENDED_EFFORTS },
    },
    {
      provider: "claude",
      id: "claude-fable-5",
      label: "Fable 5",
      capabilities: { reasoningEffortLevels: EXTENDED_EFFORTS },
    },
    {
      provider: "claude",
      id: "claude-sonnet-5",
      label: "Sonnet 5",
      capabilities: { reasoningEffortLevels: EXTENDED_EFFORTS },
    },
    {
      provider: "claude",
      id: "claude-opus-4-7",
      label: "Opus 4.7",
      capabilities: { reasoningEffortLevels: EXTENDED_EFFORTS },
    },
    {
      provider: "claude",
      id: "claude-opus-4-6",
      label: "Opus 4.6",
      capabilities: { reasoningEffortLevels: STANDARD_EFFORTS },
    },
    {
      provider: "claude",
      id: "claude-sonnet-4-6",
      label: "Sonnet 4.6",
      capabilities: { reasoningEffortLevels: STANDARD_EFFORTS },
    },
    {
      provider: "claude",
      id: "claude-haiku-4-5-20251001",
      label: "Haiku 4.5",
      capabilities: { reasoningEffortLevels: STANDARD_EFFORTS },
    },
  ],
  codex: [
    {
      provider: "codex",
      id: "gpt-5.4",
      label: "GPT-5.4",
      isDefault: true,
    },
    {
      provider: "codex",
      id: "gpt-5.3-codex",
      label: "GPT-5.3 Codex",
    },
    {
      provider: "codex",
      id: "gpt-5.3-codex-spark",
      label: "GPT-5.3 Codex Spark",
    },
    {
      provider: "codex",
      id: "gpt-5.2-codex",
      label: "GPT-5.2 Codex",
    },
    {
      provider: "codex",
      id: "gpt-5.2",
      label: "GPT-5.2",
    },
  ],
};

export const DEFAULT_PROVIDER_CAPABILITIES: Record<ProviderKind, ProviderCapabilities> = {
  claude: {
    supportsResume: true,
    supportsTranscriptReplay: true,
    supportsApprovals: true,
    supportsUserInputRequests: true,
    supportsReasoningEffort: true,
    supportsFastMode: false,
    supportsModelSelection: true,
    supportsTitleUpdates: false,
    interruptCancelQueued: true,
    mcp: {
      discovery: "chat",
      toolEnumeration: false,
      management: {
        scopes: ["global", "project"],
        bearerTokenEnvVar: false,
        transports: ["http", "sse", "stdio"],
      },
    },
    reasoningEffortLevels: EXTENDED_EFFORTS,
    composerHints: { helpText: "Use @ for files and / for commands and skills" },
    supportsAgentActivity: true,
    runtimeModes: {
      "approval-required": {
        label: "Ask Permission",
        description: "Ask before running commands or editing files",
      },
      "full-access": {
        label: "Full access",
        description: "Run commands and edit files without asking",
      },
      auto: {
        label: "Auto",
        description: "Safety classifier decides automatically which tool calls need approval",
      },
      plan: {
        label: "Plan",
        description: "Stay in planning mode for this chat",
      },
    },
  },
  codex: {
    supportsResume: true,
    supportsTranscriptReplay: true,
    supportsApprovals: true,
    supportsUserInputRequests: true,
    supportsReasoningEffort: true,
    supportsFastMode: true,
    supportsModelSelection: true,
    supportsTitleUpdates: true,
    mcp: {
      discovery: "global-and-chat",
      toolEnumeration: true,
      management: {
        scopes: ["global"],
        bearerTokenEnvVar: true,
        transports: ["http", "stdio"],
      },
    },
    reasoningEffortLevels: STANDARD_EFFORTS,
    composerHints: { helpText: "Use @ for files, / for commands, and $ for skills" },
    supportsAgentActivity: true,
    fastModes: {
      off: { label: "Standard", description: "Default speed with normal credit usage" },
      on: { label: "Fast", description: "About 1.5x faster, with credits used at 2x" },
    },
    runtimeModes: {
      "approval-required": {
        label: "Sandboxed",
        description: "Run commands in a workspace sandbox",
      },
      "full-access": {
        label: "Full access",
        description: "Run commands directly without sandboxing",
      },
      "writes-only": {
        label: "Approve writes",
        description: "Auto-allow read operations; only prompt for write operations",
      },
      plan: {
        label: "Plan",
        description: "Stay in planning mode for this chat",
      },
    },
  },
};

export function getProviderDisplayName(provider: ProviderKind): string {
  return PROVIDER_DISPLAY_NAMES[provider];
}

export function getBuiltinProviderModels(provider: ProviderKind): ProviderModelOption[] {
  return BUILTIN_PROVIDER_MODELS[provider].map((model) => ({ ...model }));
}

export function getDefaultProviderCapabilities(provider: ProviderKind): ProviderCapabilities {
  return DEFAULT_PROVIDER_CAPABILITIES[provider];
}

export function resolveProviderDefaultModelOption(
  provider: ProviderKind,
  models?: readonly ProviderModelOption[],
): ProviderModelOption | undefined {
  const catalogModels = BUILTIN_PROVIDER_MODELS[provider];
  const candidateModels = models && models.length > 0 ? models : catalogModels;
  if (candidateModels.length === 0) return undefined;
  if (provider === "codex") {
    return resolveCodexDefaultModelOption(candidateModels);
  }
  if (provider === "claude" && models && models.length > 0) {
    const explicitDefault = candidateModels.find((model) => model.isDefault);
    if (explicitDefault) return explicitDefault;
  }
  // Prefer the catalog's declared default by id (so an enriched model from
  // `models` — with resolvedCapabilities etc. — wins over the raw catalog
  // entry). Fall back to any isDefault model in the candidate list, then the
  // first candidate.
  const catalogDefault = catalogModels.find((model) => model.isDefault);
  return (
    (catalogDefault && candidateModels.find((model) => model.id === catalogDefault.id)) ??
    candidateModels.find((model) => model.isDefault) ??
    candidateModels[0]
  );
}

export function findProviderModelLabel(provider: ProviderKind, modelId: string): string | null {
  const known = BUILTIN_PROVIDER_MODELS[provider].find((model) => model.id === modelId)?.label;
  if (known) return known;
  if (provider === "claude") return formatClaudeModelLabel(modelId);
  if (provider === "codex") return formatCodexModelLabel(modelId);
  return null;
}

/**
 * Compute effective capabilities for a given (provider, model) pair.
 * Per-model capability overrides win over provider defaults; omitted fields
 * inherit. Pass `undefined` for `modelCapabilities` to get plain provider
 * capabilities back.
 *
 * Per-model overrides are *partial* — an override only covers the keys it
 * sets. Notably, if a model overrides `reasoningEffortLevels` it replaces
 * the array wholesale (not a per-entry merge).
 */
export function mergeCapabilities(
  providerCapabilities: ProviderCapabilities,
  modelCapabilities: Partial<ProviderCapabilities> | undefined,
): ProviderCapabilities {
  if (!modelCapabilities) return providerCapabilities;
  return { ...providerCapabilities, ...modelCapabilities };
}
