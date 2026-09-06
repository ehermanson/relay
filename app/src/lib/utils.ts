import type { InstanceInfo, ProviderKind, ProviderRateLimitStatus, SpaceInfo } from "@shared/types";
import type { StatusDotVariant } from "@/components/ui/status-dot";

export interface InstanceStatusPresentation {
  variant: StatusDotVariant;
  dotClass: string;
  label: string;
}

export function deriveInstanceStatusPresentation(
  instance: Pick<InstanceInfo, "status" | "external" | "pendingTool">,
): InstanceStatusPresentation {
  if (instance.status === "stopped") {
    return {
      variant: "default",
      dotClass: "bg-muted",
      label: instance.external ? "External chat (ended)" : "Ended",
    };
  }
  if (instance.pendingTool) {
    return {
      variant: "active",
      dotClass: "animate-pulse-dot bg-warning",
      label: "Waiting for permission",
    };
  }
  if (instance.status === "processing") {
    return {
      variant: "active",
      dotClass: "animate-pulse-dot bg-warning",
      label: instance.external ? "External chat (active)" : "Processing",
    };
  }
  if (instance.status === "error") {
    return {
      variant: "error",
      dotClass: "bg-error",
      label: "Error",
    };
  }
  if (instance.external) {
    return {
      variant: "success",
      dotClass: "bg-accent",
      label: "External chat",
    };
  }
  return {
    variant: "success",
    dotClass: "bg-accent",
    label: "Idle",
  };
}

/** Map an instance to a StatusDot variant. */
export function instanceStatusVariant(
  statusOrInstance: string | Pick<InstanceInfo, "status" | "external" | "pendingTool">,
  pendingTool?: boolean,
): StatusDotVariant {
  if (typeof statusOrInstance === "string") {
    return deriveInstanceStatusPresentation({
      status: statusOrInstance as InstanceInfo["status"],
      external: false,
      pendingTool: pendingTool ? "pending" : undefined,
    }).variant;
  }
  return deriveInstanceStatusPresentation(statusOrInstance).variant;
}

export function escapeHtml(text: string): string {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

export function formatTimeAgo(timestamp: number | string): string {
  const ms = typeof timestamp === "string" ? new Date(timestamp).getTime() : timestamp;
  const diff = Date.now() - ms;
  if (isNaN(diff)) return "";
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return Math.floor(diff / 60_000) + "m ago";
  if (diff < 86_400_000) return Math.floor(diff / 3_600_000) + "h ago";
  const days = Math.floor(diff / 86_400_000);
  if (days < 30) return days + "d ago";
  return new Date(ms).toLocaleDateString();
}

export function formatTimeUntil(timestamp: number | string): string {
  const ms = typeof timestamp === "string" ? new Date(timestamp).getTime() : timestamp;
  const diff = ms - Date.now();
  if (isNaN(diff) || diff <= 0) return "";
  if (diff < 60_000) return "<1m";
  if (diff < 3_600_000) return Math.ceil(diff / 60_000) + "m";
  if (diff < 86_400_000) {
    const h = Math.floor(diff / 3_600_000);
    const m = Math.ceil((diff % 3_600_000) / 60_000);
    return m > 0 ? `${h}h ${m}m` : `${h}h`;
  }
  return Math.ceil(diff / 86_400_000) + "d";
}

export function formatTimestamp(ts: number): string {
  const date = new Date(ts);
  const now = new Date();
  const time = date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()
  ) {
    return time;
  }
  const day = date.toLocaleDateString([], { month: "short", day: "numeric" });
  return `${day}, ${time}`;
}

/**
 * Newest activity signal for a chat: the max of the last parsed message and
 * `lastActivityAt`, since either can lead (tool-only activity bumps
 * `lastActivityAt` without producing a message). `isChatDone` revives on this
 * value, so missing the newer signal would strand a revived chat in Done.
 */
export function getChatRecencyTimestamp(
  instance: Pick<InstanceInfo, "lastMessage" | "lastActivityAt">,
): number {
  return Math.max(instance.lastMessage?.timestamp ?? 0, instance.lastActivityAt ?? 0);
}

/** Canonical chat-list order: pinned chats first, then most recent activity. */
export function compareChatListOrder(
  a: Pick<InstanceInfo, "pinned" | "lastMessage" | "lastActivityAt">,
  b: Pick<InstanceInfo, "pinned" | "lastMessage" | "lastActivityAt">,
): number {
  const pinnedDelta = (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0);
  if (pinnedDelta !== 0) return pinnedDelta;
  return getChatRecencyTimestamp(b) - getChatRecencyTimestamp(a);
}

/**
 * Whether a chat should sort into the sidebar's "Done" section.
 *
 * `doneAt` is a timestamp, not a flag, so any activity after the user marked
 * the chat done automatically revives it — no server-side clearing needed.
 * Chats in a closed space are permanently done: the work is merged or
 * archived, so later activity shouldn't drag them back into the inbox.
 */
export function isChatDone(
  instance: Pick<InstanceInfo, "doneAt" | "lastMessage" | "lastActivityAt">,
  spaceStatus?: SpaceInfo["status"],
): boolean {
  if (spaceStatus === "completed" || spaceStatus === "archived") return true;
  if (instance.doneAt == null) return false;
  return getChatRecencyTimestamp(instance) <= instance.doneAt;
}

/**
 * Toggle an AskUserQuestion option in/out of the current selection.
 * Multi-select questions accumulate a set of labels; single-select ones replace
 * the prior choice (radio behavior — re-clicking the selected option keeps it).
 */
export function toggleAnswerSelection(
  current: string[] | undefined,
  answer: string,
  multiSelect: boolean | undefined,
): string[] {
  const list = current ?? [];
  if (multiSelect) {
    return list.includes(answer) ? list.filter((a) => a !== answer) : [...list, answer];
  }
  return [answer];
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "k";
  return String(n);
}

export function getDisplayTokenBreakdown(usage: {
  providerName?: ProviderKind | string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
}): {
  inputTokens: number;
  outputTokens: number;
  cacheTokens: number;
  totalTokens: number;
} {
  const cacheTokens = usage.cacheCreationTokens + usage.cacheReadTokens;
  const inputTokens =
    usage.providerName === "codex"
      ? Math.max(0, usage.inputTokens - usage.cacheReadTokens)
      : usage.inputTokens;
  return {
    inputTokens,
    outputTokens: usage.outputTokens,
    cacheTokens,
    totalTokens: inputTokens + usage.outputTokens + cacheTokens,
  };
}

export function getDisplaySessionStats(
  providerName: ProviderKind | string | undefined,
  stats: {
    inputTokens: number;
    outputTokens: number;
    cacheCreationTokens: number;
    cacheReadTokens: number;
  },
): {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
} {
  const display = getDisplayTokenBreakdown({
    providerName,
    inputTokens: stats.inputTokens,
    outputTokens: stats.outputTokens,
    cacheCreationTokens: stats.cacheCreationTokens,
    cacheReadTokens: stats.cacheReadTokens,
  });
  return {
    inputTokens: display.inputTokens,
    outputTokens: display.outputTokens,
    cacheCreationTokens: stats.cacheCreationTokens,
    cacheReadTokens: stats.cacheReadTokens,
    totalTokens: display.totalTokens,
  };
}

export function getContextWindowUsage(stats: { contextTokens?: number; contextWindow?: number }): {
  contextTokens: number;
  contextWindow: number;
  usagePct: number;
} {
  const contextWindow = stats.contextWindow && stats.contextWindow > 0 ? stats.contextWindow : 0;
  const rawContextTokens = stats.contextTokens ?? 0;
  if (!contextWindow || rawContextTokens <= 0) {
    return {
      contextTokens: 0,
      contextWindow,
      usagePct: 0,
    };
  }

  const contextTokens = Math.min(rawContextTokens, contextWindow);
  return {
    contextTokens,
    contextWindow,
    usagePct: Math.min(contextTokens / contextWindow, 1) * 100,
  };
}

// =============================================================================
// Rate limit color helpers
// =============================================================================

/**
 * Derive the worst rate limit status across all windows.
 * "rejected" beats "allowed_warning" beats null.
 */
export function worstRateLimitStatus(
  rateLimits: ProviderRateLimitStatus[],
): "allowed_warning" | "rejected" | null {
  let worst: "allowed_warning" | "rejected" | null = null;
  for (const limit of rateLimits) {
    for (const w of limit.windows ?? []) {
      if (w.status === "rejected") return "rejected";
      if (w.status === "allowed_warning") worst = "allowed_warning";
    }
  }
  return worst;
}

/**
 * Single source of truth for rate-limit severity tiers. Status takes priority
 * over percentage thresholds (pct expected 0–100). Both color helpers below
 * map from this so their thresholds can never drift apart.
 */
function rateLimitTier(
  status?: string | null,
  pct?: number | null,
): "critical" | "warning" | "normal" {
  if (status === "rejected" || (pct != null && pct > 90)) return "critical";
  if (status === "allowed_warning" || (pct != null && pct > 70)) return "warning";
  return "normal";
}

/** Tailwind bg class for a rate limit bar or fill. */
export function rateLimitColorClass(status?: string | null, pct?: number | null): string {
  const tier = rateLimitTier(status, pct);
  return tier === "critical" ? "bg-red-400" : tier === "warning" ? "bg-amber-400" : "bg-accent";
}

/**
 * SVG hex color for strokes / fills that can't use Tailwind classes.
 * Returns "currentColor" at the normal tier so it inherits the button color.
 */
export function rateLimitHexColor(status?: string | null, pct?: number | null): string {
  const tier = rateLimitTier(status, pct);
  return tier === "critical" ? "#ef4444" : tier === "warning" ? "#f59e0b" : "currentColor";
}

/** Turn a model ID like "claude-opus-4-6" into a short display name like "Opus 4.6" */
export function formatModel(model: string): string {
  // Match "claude-{family}-{major}-{minor}" or "claude-{family}-{major}"
  const m = model.match(/^claude-(\w+)-(\d+)(?:-(\d+))?/);
  if (!m) return model;
  const family = m[1].charAt(0).toUpperCase() + m[1].slice(1);
  const version = m[3] ? `${m[2]}.${m[3]}` : m[2];
  return `${family} ${version}`;
}
