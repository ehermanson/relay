import { memo, useMemo } from "react";
import { Tooltip } from "../ui/tooltip";
import { Popover } from "../ui/popover";
import { useMediaQuery } from "@/hooks/use-media-query";
import type { ChatItem } from "@/hooks/use-instance-messages";

import { useProviderRuntimeStore } from "@/stores/provider-runtime-store";
import {
  formatTokens,
  formatModel,
  formatTimestamp,
  getContextWindowUsage,
  getDisplaySessionStats,
  instanceStatusVariant,
  rateLimitColorClass,
} from "../../lib/utils";
import type {
  SessionStats,
  InstanceInfo,
  ProviderStatusSummary,
  ProviderGlobalState,
  ProviderKind,
} from "@shared/types";
import { StatusDot } from "../ui/status-dot";
import { ProviderLogo } from "../ui/provider-logo";
import { RateLimitBar, flattenRateLimitWindows } from "../ui/rate-limit-bar";
import { McpServerList } from "./mcp-server-list";

// =============================================================================
// Shared primitives
// =============================================================================

function StatHelpIcon({ tooltip }: { tooltip: string }) {
  // Tooltips never open on touch — render a tap-to-open popover there instead,
  // with a slightly larger glyph so it's actually hittable.
  const isTouch = useMediaQuery("(pointer: coarse)");

  if (isTouch) {
    return (
      <Popover.Root>
        <Popover.Trigger className="inline-flex h-5 w-5 items-center justify-center rounded-full border border-border/70 text-[0.625rem] font-semibold leading-none text-muted/75">
          ?
        </Popover.Trigger>
        <Popover.Content
          side="bottom"
          align="start"
          className="max-w-xs !p-3 text-[0.75rem] leading-snug text-text"
        >
          {tooltip}
        </Popover.Content>
      </Popover.Root>
    );
  }

  return (
    <Tooltip content={tooltip} side="bottom">
      <span className="inline-flex h-3.5 w-3.5 cursor-help items-center justify-center rounded-full border border-border/70 text-[0.5625rem] font-semibold leading-none text-muted/75 transition-colors hover:border-border hover:text-text">
        ?
      </span>
    </Tooltip>
  );
}

function StatRow({ label, value, help }: { label: string; value: React.ReactNode; help?: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="flex items-center gap-1.5 text-[0.6875rem] text-muted">
        <span>{label}</span>
        {help && <StatHelpIcon tooltip={help} />}
      </span>
      <span className="text-[0.8125rem] font-medium text-text-bright">{value}</span>
    </div>
  );
}

function statusTone(status: string | undefined): "default" | "active" | "success" | "warning" {
  const normalized = status?.toLowerCase() ?? "";
  if (/(inprogress|running|working|connected|authenticated)/.test(normalized)) return "active";
  if (/(completed|done|ready|idle|available)/.test(normalized)) return "success";
  if (/(warning|limited|pending|auth|disconnected|failed|error)/.test(normalized)) return "warning";
  return "default";
}

// =============================================================================
// Token breakdown bar (shared between both modes)
// =============================================================================

interface TokenBreakdownSegment {
  label: string;
  pct: number;
  color: string;
}

function computeSegments(stats: SessionStats, provider?: string): TokenBreakdownSegment[] {
  const display = getDisplaySessionStats(provider, stats);
  const cacheRead = display.cacheReadTokens;
  const cacheWrite = display.cacheCreationTokens;
  const pureInput = display.inputTokens;
  const output = stats.outputTokens;
  const total = pureInput + cacheRead + cacheWrite + output;
  if (total === 0) return [];
  return [
    { label: "Input", pct: (pureInput / total) * 100, color: "bg-blue-400" },
    { label: "Cache read", pct: (cacheRead / total) * 100, color: "bg-emerald-400" },
    { label: "Cache write", pct: (cacheWrite / total) * 100, color: "bg-amber-400" },
    { label: "Output", pct: (output / total) * 100, color: "bg-purple-400" },
  ].filter((s) => s.pct > 0);
}

function TokenBreakdownBar({ segments }: { segments: TokenBreakdownSegment[] }) {
  if (segments.length === 0) return null;
  return (
    <div className="mt-4">
      <div className="mb-1.5 text-[0.6875rem] text-muted">Token Breakdown</div>
      <div className="flex h-2 w-full overflow-hidden rounded-full bg-surface-hover">
        {segments.map((seg) => (
          <div
            key={seg.label}
            className={`h-full shrink-0 ${seg.color}`}
            style={{ width: `${seg.pct}%` }}
          />
        ))}
      </div>
      <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5">
        {segments.map((seg) => (
          <span key={seg.label} className="flex items-center gap-1 text-[0.625rem] text-muted">
            <span className={`inline-block h-1.5 w-1.5 rounded-full ${seg.color}`} />
            {seg.label} {seg.pct.toFixed(1)}%
          </span>
        ))}
      </div>
    </div>
  );
}

// =============================================================================
// Context window usage bar (stacked categories or simple fallback)
// =============================================================================

/** Fixed palette — SDK colors may not contrast with dark backgrounds */
const CATEGORY_COLORS = [
  "bg-blue-400",
  "bg-emerald-400",
  "bg-amber-400",
  "bg-purple-400",
  "bg-rose-400",
  "bg-cyan-400",
  "bg-orange-400",
  "bg-indigo-400",
];

function ContextWindowBar({
  contextUsage,
  categories,
}: {
  contextUsage: { contextTokens: number; contextWindow: number; usagePct: number };
  categories?: SessionStats["contextCategories"];
}) {
  const activeCategories = categories?.filter(
    (c) =>
      c.tokens > 0 &&
      (c.kind ? c.kind === "used" || c.kind === "buffer" : !/free\s*space/i.test(c.name)),
  );
  const hasCategories = activeCategories && activeCategories.length > 0;

  return (
    <div className="mt-4">
      <div className="mb-1.5 flex items-center justify-between text-[0.6875rem] text-muted">
        <span>Current Context</span>
        <span className="tabular-nums">
          {formatTokens(contextUsage.contextTokens)} / {formatTokens(contextUsage.contextWindow)}
        </span>
      </div>
      <div className="flex h-2 w-full overflow-hidden rounded-full bg-surface-hover">
        {hasCategories ? (
          activeCategories.map((cat, i) => (
            <div
              key={cat.name}
              className={`h-full shrink-0 ${CATEGORY_COLORS[i % CATEGORY_COLORS.length]}`}
              style={{ width: `${(cat.tokens / contextUsage.contextWindow) * 100}%` }}
            />
          ))
        ) : (
          <div
            className={`h-full shrink-0 ${rateLimitColorClass(null, contextUsage.usagePct)}`}
            style={{ width: `${Math.min(contextUsage.usagePct, 100)}%` }}
          />
        )}
      </div>
      {hasCategories && (
        <div className="mt-2 flex flex-col gap-1">
          {activeCategories.map((cat, i) => {
            const catPct = (cat.tokens / contextUsage.contextWindow) * 100;
            return (
              <div key={cat.name} className="flex items-center gap-2 text-[0.6875rem]">
                <span
                  className={`h-2 w-2 shrink-0 rounded-[3px] ${CATEGORY_COLORS[i % CATEGORY_COLORS.length]}`}
                />
                <span className="min-w-0 flex-1 truncate text-muted">{cat.name}</span>
                <span className="shrink-0 tabular-nums text-muted/60">{catPct.toFixed(1)}%</span>
                <span className="shrink-0 w-12 text-right tabular-nums text-text-bright">
                  {formatTokens(cat.tokens)}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// =============================================================================
// Context Panel — unified for instance and space views
// =============================================================================

interface InstanceContextProps {
  mode: "instance";
  stats: SessionStats | null;
  items: ChatItem[];
  provider?: ProviderKind;
  providerStatus?: ProviderStatusSummary;
  providerGlobalState?: ProviderGlobalState;
  createdAt: number;
  lastActivityAt: number;
}

interface SpaceContextProps {
  mode: "space";
  stats: SessionStats | null;
  instances: InstanceInfo[];
  branch: string | null;
  status: string;
  activeCount: number;
  stoppedCount: number;
  createdAt: number;
}

export type ContextPanelProps = InstanceContextProps | SpaceContextProps;

export const ContextPanel = memo(function ContextPanel(props: ContextPanelProps) {
  if (props.mode === "instance") {
    return <InstanceContext {...props} />;
  }
  return <SpaceContext {...props} />;
});

// =============================================================================
// Instance context (chat sidecar)
// =============================================================================

function InstanceContext({
  stats,
  items,
  provider,
  providerStatus,
  providerGlobalState,
  createdAt,
  lastActivityAt,
}: InstanceContextProps) {
  const safeStats: SessionStats = stats ?? {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
  };
  const userCount = useMemo(() => items.filter((i) => i.kind === "user").length, [items]);
  const assistantCount = useMemo(() => items.filter((i) => i.kind === "assistant").length, [items]);
  const totalMessages = userCount + assistantCount;

  const displayStats = getDisplaySessionStats(provider, safeStats);
  const totalTokens = displayStats.totalTokens;
  // Use same 1M fallback as ContextRing when contextWindow isn't reported yet
  const contextUsage = getContextWindowUsage({
    contextTokens: safeStats.contextTokens,
    contextWindow: safeStats.contextWindow || (safeStats.contextTokens ? 1_000_000 : 0),
  });
  const reasoning = safeStats.reasoningTokens ?? 0;
  const segments = computeSegments(safeStats, provider);
  const globalProviderState = providerGlobalState;
  const hasProviderSummary = Boolean(
    providerStatus?.threadStatus ||
    providerStatus?.turnStatus ||
    providerStatus?.effectiveModel ||
    globalProviderState?.account?.label ||
    globalProviderState?.account?.email ||
    globalProviderState?.account?.plan ||
    globalProviderState?.account?.rateLimits?.length ||
    globalProviderState?.mcpServers?.length ||
    providerStatus?.mcpServers?.length ||
    providerStatus?.notices?.length ||
    globalProviderState?.notices?.length,
  );
  return (
    <div className="flex-1 overflow-y-auto">
      {/* Stats grid */}
      <div className="px-3.5 py-2.5">
        <div className="sidecar-stats-grid grid gap-x-4 gap-y-3">
          <StatRow
            label="Provider"
            value={provider ? provider.charAt(0).toUpperCase() + provider.slice(1) : "—"}
          />
          {contextUsage.contextWindow > 0 && (
            <>
              <StatRow
                label="Context Limit"
                help={
                  provider === "claude"
                    ? "Maximum context window for the current model. Claude limits are based on documented model limits."
                    : "Maximum context window reported by the current model."
                }
                value={formatTokens(contextUsage.contextWindow)}
              />
              <StatRow
                label="Context Usage"
                help="Estimated share of the context window occupied by the latest prompt state, not the whole session."
                value={`${contextUsage.usagePct.toFixed(1)}%`}
              />
            </>
          )}
          <StatRow
            label="Session Tokens"
            help="Cumulative chat total across input, output, and cache usage, normalized so cache-hit reads are not double-counted as input."
            value={formatTokens(totalTokens)}
          />
          <StatRow label="Messages" value={totalMessages} />
          <StatRow
            label="Input Tokens"
            help="Non-cache request tokens sent during this chat. For providers that fold cache-hit reads into input, this view subtracts those reads back out."
            value={formatTokens(displayStats.inputTokens)}
          />
          <StatRow
            label="Output Tokens"
            help="Tokens generated in model responses during this chat."
            value={formatTokens(safeStats.outputTokens)}
          />
          {reasoning > 0 && (
            <StatRow
              label="Reasoning Tokens"
              help="Internal reasoning tokens reported separately by models that expose thinking usage."
              value={formatTokens(reasoning)}
            />
          )}
          <StatRow
            label="Cache Tokens (read/write)"
            help="Prompt-cache tokens reused from earlier work or written for future reuse. Read tokens may also be counted in input."
            value={`${formatTokens(displayStats.cacheReadTokens)} / ${formatTokens(displayStats.cacheCreationTokens)}`}
          />
          <StatRow label="User Messages" value={userCount} />
          <StatRow label="Assistant Messages" value={assistantCount} />
          <div className="sidecar-stats-divider border-t border-border/30" />
          <StatRow label="Chat Created" value={formatTimestamp(createdAt)} />
          <StatRow label="Last Activity" value={formatTimestamp(lastActivityAt)} />
        </div>

        <TokenBreakdownBar segments={segments} />

        {/* Context window usage bar */}
        {contextUsage.contextWindow > 0 ? (
          <ContextWindowBar contextUsage={contextUsage} categories={safeStats.contextCategories} />
        ) : (
          <div className="mt-4 rounded-md border border-dashed border-border/50 px-3 py-2.5">
            <p className="text-[0.6875rem] text-muted/70">
              Context usage will appear after the next response.
            </p>
          </div>
        )}
      </div>

      {hasProviderSummary && provider && (
        <div className="border-t border-border/30 px-3.5 py-2.5">
          <div className="mb-1.5 text-[0.6875rem] text-muted">Provider Status</div>
          <ProviderStatusBlock
            provider={provider}
            providerStatus={providerStatus}
            globalState={globalProviderState}
          />
        </div>
      )}
    </div>
  );
}

// =============================================================================
// Shared: Provider status block (reused by instance + space context)
// =============================================================================

function ProviderStatusBlock({
  provider,
  providerStatus,
  globalState,
  mcpContext = "chat",
}: {
  provider: string;
  providerStatus?: ProviderStatusSummary;
  globalState?: ProviderGlobalState;
  mcpContext?: "chat" | "provider";
}) {
  const hasContent = Boolean(
    providerStatus?.threadStatus ||
    providerStatus?.turnStatus ||
    providerStatus?.effectiveModel ||
    globalState?.account?.label ||
    globalState?.account?.email ||
    globalState?.account?.plan ||
    globalState?.account?.rateLimits?.length ||
    globalState?.mcpServers?.length ||
    providerStatus?.mcpServers?.length ||
    providerStatus?.notices?.length ||
    globalState?.notices?.length,
  );

  if (!hasContent) return null;

  return (
    <div className="flex flex-col gap-1.5">
      {/* Provider identity + status row */}
      <div className="flex items-center gap-2">
        <ProviderLogo provider={provider as ProviderKind} className="h-3.5 w-3.5 shrink-0" />
        <span className="text-[0.8125rem] font-medium text-text-bright">
          {provider === "codex"
            ? "Codex"
            : provider === "claude"
              ? "Claude Code"
              : provider.charAt(0).toUpperCase() + provider.slice(1)}
        </span>
        {globalState?.account?.plan ? (
          <>
            <span className="text-muted/40">·</span>
            <span className="text-[0.75rem] text-muted capitalize">{globalState.account.plan}</span>
          </>
        ) : null}
        {providerStatus?.turnStatus || providerStatus?.threadStatus ? (
          <>
            <span className="text-muted/40">·</span>
            <StatusDot
              variant={
                statusTone(providerStatus?.turnStatus ?? providerStatus?.threadStatus) === "active"
                  ? "active"
                  : statusTone(providerStatus?.turnStatus ?? providerStatus?.threadStatus) ===
                      "success"
                    ? "success"
                    : statusTone(providerStatus?.turnStatus ?? providerStatus?.threadStatus) ===
                        "warning"
                      ? "error"
                      : "default"
              }
              size={6}
            />
            <span className="text-[0.75rem] text-muted">
              {providerStatus?.turnStatus ?? providerStatus?.threadStatus}
            </span>
          </>
        ) : null}
      </div>

      {/* Effective model */}
      {providerStatus?.effectiveModel ? (
        <span className="text-[0.75rem] text-muted ml-5.5">
          {formatModel(providerStatus?.effectiveModel)}
          {providerStatus?.reroutedFromModel &&
          providerStatus.reroutedFromModel !== providerStatus.effectiveModel
            ? ` (from ${formatModel(providerStatus?.reroutedFromModel)})`
            : ""}
        </span>
      ) : null}

      {/* Rate limit bars */}
      {globalState?.account?.rateLimits?.length ? (
        <div className="flex flex-col gap-2 mt-0.5">
          {flattenRateLimitWindows(globalState.account.rateLimits).map(
            ({ window, key, qualifier }) => (
              <RateLimitBar key={key} window={window} size="sm" qualifier={qualifier} />
            ),
          )}
        </div>
      ) : null}

      {/* MCP servers */}
      <McpServerList
        provider={provider as ProviderKind}
        globalServers={globalState?.mcpServers}
        chatServers={providerStatus?.mcpServers}
        context={mcpContext}
      />

      {/* Notices */}
      {providerStatus?.notices?.length || globalState?.notices?.length ? (
        <div className="flex flex-col gap-1">
          {[...(globalState?.notices ?? []), ...(providerStatus?.notices ?? [])].map(
            (notice, index) => (
              <div
                key={`${notice.source ?? "notice"}-${index}`}
                className="text-[0.75rem] text-warning"
              >
                {notice.message}
                {notice.detail ? <span className="ml-1 text-muted">{notice.detail}</span> : null}
              </div>
            ),
          )}
        </div>
      ) : null}
    </div>
  );
}

// =============================================================================
// Space context (space sidebar)
// =============================================================================

function SpaceContext({
  stats,
  instances,
  branch,
  status,
  activeCount,
  stoppedCount,
  createdAt,
}: SpaceContextProps) {
  const totalTokens = stats
    ? stats.inputTokens + stats.outputTokens + stats.cacheCreationTokens + stats.cacheReadTokens
    : 0;
  const segments = stats ? computeSegments(stats) : [];

  // Collect unique providers used in this space
  const providerGlobalStates = useProviderRuntimeStore((s) => s.providerGlobalState);
  const uniqueProviders = useMemo(() => {
    const seen = new Set<string>();
    for (const inst of instances) {
      if (inst.provider) seen.add(inst.provider);
    }
    return Array.from(seen);
  }, [instances]);

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="px-3.5 py-2.5">
        <div className="sidecar-stats-grid grid gap-x-4 gap-y-3">
          <StatRow label="Branch" value={branch ?? "—"} />
          <StatRow label="Status" value={status} />
          <StatRow label="Chats" value={instances.length} />
          {activeCount > 0 && <StatRow label="Active" value={activeCount} />}
          {stoppedCount > 0 && <StatRow label="Ended" value={stoppedCount} />}
          {stats && (
            <>
              <div className="sidecar-stats-divider border-t border-border/30" />
              <StatRow label="Total Tokens" value={formatTokens(totalTokens)} />
              <StatRow label="Input Tokens" value={formatTokens(stats.inputTokens)} />
              <StatRow label="Output Tokens" value={formatTokens(stats.outputTokens)} />
              <StatRow
                label="Cache Tokens (read/write)"
                value={`${formatTokens(stats.cacheReadTokens)} / ${formatTokens(stats.cacheCreationTokens)}`}
              />
            </>
          )}
          <div className="sidecar-stats-divider border-t border-border/30" />
          <StatRow label="Created" value={formatTimestamp(createdAt)} />
        </div>

        <TokenBreakdownBar segments={segments} />
      </div>

      {/* Provider status — one block per provider used in the space */}
      {uniqueProviders.length > 0 && (
        <div className="border-t border-border/30 px-3.5 py-2.5">
          <div className="mb-1.5 text-[0.6875rem] text-muted">Provider Status</div>
          <div className="flex flex-col gap-3">
            {uniqueProviders.map((p) => (
              <ProviderStatusBlock
                key={p}
                provider={p}
                globalState={providerGlobalStates[p as ProviderKind]}
                mcpContext="provider"
              />
            ))}
          </div>
        </div>
      )}

      {/* Per-chat breakdown */}
      {instances.length > 0 && (
        <div className="border-t border-border/30">
          <div className="px-3.5 py-2.5 text-[0.6875rem] text-muted">Per-chat</div>
          <div className="flex flex-col gap-0.5 px-3.5 pb-3">
            {instances.map((inst) => (
              <div key={inst.id} className="flex items-center gap-2 py-1">
                <StatusDot variant={instanceStatusVariant(inst.status)} />
                <span className="min-w-0 flex-1 truncate text-[0.8125rem] text-text">
                  {inst.name}
                </span>
                {inst.stats && (
                  <span className="shrink-0 text-[0.6875rem] text-muted/50">
                    {formatTokens(getDisplaySessionStats(inst.provider, inst.stats).totalTokens)}
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
