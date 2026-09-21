import { useMemo, useState } from "react";
import { ChevronRight } from "lucide-react";
import type { AgentInfo } from "@shared/types";
import { mergeAgentInfo } from "@shared/agent-info";
import type { ChatItem } from "@/lib/chat-types";
import {
  buildAgentAnchorIndex,
  formatAgentDuration,
  getChildAgents,
  isAgentActive,
} from "@/lib/agents";
import { formatTokens } from "@/lib/utils";
import { useAgentHistory } from "@/hooks/use-agent-history";
import { Spinner } from "@/components/ui/spinner";
import { MarkdownContent } from "@/components/chat/markdown-content";
import { ThinkingBlock } from "@/components/chat/thinking-block";
import { ActivityGroup } from "@/components/chat/activity-group";
import {
  AgentCardsProvider,
  useAgentCards,
  type AgentCardsContextValue,
} from "@/components/chat/agent-card-context";
import { AgentCard } from "@/components/chat/agent-card";
import { useAgentModelLabel } from "@/hooks/use-agent-model";

const LONG_ASSIGNMENT = 240;
/** Nesting guard for pathological parent cycles/depth. */
const MAX_NESTING = 4;
const EMPTY_AGENTS: Record<string, AgentInfo> = {};
const EMPTY_AGENT_ITEMS: Record<string, ChatItem[]> = {};

function itemText(item: ChatItem): string | undefined {
  return item.kind === "user" || item.kind === "assistant" ? item.text : undefined;
}

function normalizeForMatch(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

/** Loose equality for echoed prose (one side may carry extra formatting). */
function echoes(a: string, b: string): boolean {
  const na = normalizeForMatch(a);
  const nb = normalizeForMatch(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  return na.length > 40 && nb.length > 40 && (na.includes(nb) || nb.includes(na));
}

/**
 * Trim the assignment echo (leading user prompt) and the final-report echo
 * (trailing assistant message) out of a child's transcript. Both are surfaced
 * in their own Assignment / Result sections, so the Activity view should show
 * only the work in between rather than repeat them.
 */
function trimActivityEchoes(
  items: ChatItem[],
  assignment: string | undefined,
  result: string | undefined,
): ChatItem[] {
  let start = 0;
  let end = items.length;
  if (assignment) {
    while (start < end) {
      const t = itemText(items[start]);
      if (items[start].kind === "user" && t && echoes(t, assignment)) start++;
      else break;
    }
  }
  if (result) {
    while (end > start) {
      const item = items[end - 1];
      const t = itemText(item);
      if (item.kind === "assistant" && t && echoes(t, result)) end--;
      else break;
    }
  }
  return start === 0 && end === items.length ? items : items.slice(start, end);
}

interface AgentDetailProps {
  agent: AgentInfo;
  /** Result text to show when the agent has no `result` yet (e.g. the delegation tool_result). */
  fallbackResult?: string;
  /** Current nesting depth (0 = top-level card). */
  depth?: number;
}

/** Collapsible section label + optional trailing content (spinner, count). */
function SectionToggle({
  label,
  open,
  onToggle,
  trailing,
}: {
  label: string;
  open?: boolean;
  onToggle?: () => void;
  trailing?: React.ReactNode;
}) {
  const content = (
    <span className="flex items-center gap-1.5">
      {onToggle && (
        <ChevronRight
          size={9}
          strokeWidth={2.5}
          className={`text-muted/50 transition-transform ${open ? "rotate-90" : ""}`}
        />
      )}
      <span className="text-[0.625rem] uppercase tracking-[0.12em] text-muted/60">{label}</span>
      {trailing}
    </span>
  );
  if (!onToggle) return <div className="flex items-center">{content}</div>;
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      className="flex w-full items-center text-left max-[768px]:min-h-9"
    >
      {content}
    </button>
  );
}

function Assignment({ text }: { text: string }) {
  const isLong = text.length > LONG_ASSIGNMENT;
  const [open, setOpen] = useState(!isLong);
  return (
    <div className="flex flex-col gap-1.5">
      <SectionToggle label="Assignment" open={open} onToggle={isLong ? () => setOpen((v) => !v) : undefined} />
      <pre
        className={`whitespace-pre-wrap break-words rounded-md border border-border/40 bg-surface/50 px-2.5 py-2 font-sans text-[0.75rem] leading-relaxed text-muted ${
          open ? "" : "line-clamp-2"
        }`}
      >
        {text}
      </pre>
    </div>
  );
}

/**
 * A child agent's conversation rendered with the same building blocks as the
 * main chat (`ActivityGroup`, markdown assistant text, thinking blocks). User
 * rows here are the child's own prompts, not the human's.
 */
function NestedTranscript({ items }: { items: ChatItem[] }) {
  return (
    <div className="flex flex-col gap-2">
      {items.map((item, i) => {
        switch (item.kind) {
          case "user":
            return (
              <pre
                key={i}
                className="whitespace-pre-wrap break-words rounded-md border border-border/50 px-2.5 py-1.5 font-sans text-[0.75rem] text-muted"
              >
                {item.text}
              </pre>
            );
          case "assistant":
            return (
              <div key={i} className="text-[0.8125rem] max-[768px]:text-[16px]">
                <MarkdownContent text={item.text} />
              </div>
            );
          case "thinking-block":
            return <ThinkingBlock key={i} text={item.text} />;
          case "activity-group":
            return <ActivityGroup key={i} activities={item.activities} />;
          case "system":
            return (
              <div
                key={i}
                className={`text-[0.75rem] ${item.isError ? "text-error" : "text-muted"}`}
              >
                {item.text}
              </div>
            );
          default:
            return null;
        }
      })}
    </div>
  );
}

/**
 * Expanded body of a delegated agent: metadata, assignment, nested activity,
 * result. Shared by the in-chat card and the Agents sidecar. Mounting this
 * component is what triggers the on-demand history fetch — so it must only be
 * rendered while a detail is actually expanded. Live transcript, chat id and
 * provider come from `AgentCardsContext`.
 */
export function AgentDetail({ agent, fallbackResult, depth = 0 }: AgentDetailProps) {
  const ctx = useAgentCards();
  const liveAgents = ctx?.agents ?? EMPTY_AGENTS;
  const liveItems = ctx?.agentItems[agent.agentId];
  const { items, fetchedAgents, isLoading, unavailable } = useAgentHistory(
    ctx?.instanceId,
    agent.agentId,
    { enabled: true, liveItems, status: agent.status, revision: agent.endedAt },
  );

  // Agents visible from this detail: everything the chat knows plus whatever
  // the fetched transcript declared (grandchildren the main history never
  // saw). Live state wins field-by-field where both know an agent.
  const allAgents = useMemo(() => {
    if (Object.keys(fetchedAgents).length === 0) return liveAgents;
    const merged: Record<string, AgentInfo> = { ...fetchedAgents };
    for (const [id, live] of Object.entries(liveAgents)) {
      merged[id] = mergeAgentInfo(merged[id], live);
    }
    return merged;
  }, [fetchedAgents, liveAgents]);

  // The `agent` prop is the live/anchor snapshot; the fetched child transcript
  // can supply metadata the main history never had (Codex reports its model,
  // role, and assignment only in the child rollout). Render from the merged
  // record so those fields appear, while live fields still take precedence.
  const current = useMemo(
    () => (allAgents[agent.agentId] ? mergeAgentInfo(allAgents[agent.agentId], agent) : agent),
    [allAgents, agent],
  );
  const modelLabel = useAgentModelLabel(ctx?.instanceId, current, ctx?.provider);

  // Nested delegation: children declared by the provider via `parentAgentId`.
  // Those whose origin tool_use is inside this transcript render in place of
  // it; the rest are listed below the activity.
  const children = useMemo(() => getChildAgents(allAgents, agent.agentId), [allAgents, agent.agentId]);
  const childAgentsById = useMemo(() => {
    const map: Record<string, AgentInfo> = {};
    for (const child of children) map[child.agentId] = child;
    return map;
  }, [children]);
  const nestedAnchors = useMemo(
    () => buildAgentAnchorIndex(items, childAgentsById),
    [items, childAgentsById],
  );
  const unanchoredChildren = children.filter((c) => !c.originToolUseId || !nestedAnchors.has(c.originToolUseId));
  const nestedContext: AgentCardsContextValue = {
    agents: allAgents,
    agentItems: ctx?.agentItems ?? EMPTY_AGENT_ITEMS,
    anchoredAgents: nestedAnchors,
    instanceId: ctx?.instanceId,
    provider: ctx?.provider,
    pendingAgentId: ctx?.pendingAgentId,
  };

  const assignment = current.assignment?.trim() || undefined;
  const result = current.result ?? fallbackResult;
  const usage = current.usage;
  const metaParts: string[] = [];
  // `relation` ("child"/"peer") is redundant plumbing detail, not worth a chip.
  if (current.role && current.role !== current.name) metaParts.push(current.role);
  if (current.reasoningEffort) metaParts.push(`effort ${current.reasoningEffort}`);
  const usageParts: string[] = [];
  if (usage?.totalTokens !== undefined) usageParts.push(`${formatTokens(usage.totalTokens)} tokens`);
  if (usage?.toolUses !== undefined) usageParts.push(`${usage.toolUses} tool ${usage.toolUses === 1 ? "use" : "uses"}`);
  const duration = formatAgentDuration(
    usage?.durationMs ?? (current.startedAt && current.endedAt ? current.endedAt - current.startedAt : undefined),
  );
  if (duration) usageParts.push(duration);

  // Activity is the how; the result is the what. The assignment and the final
  // report are shown in their own sections, so they're trimmed from the trace
  // here to avoid showing each twice. A finished agent collapses the (dig-in)
  // trace by default; a still-working one shows it up front.
  const activityItems = useMemo(
    () => trimActivityEchoes(items, assignment, result),
    [items, assignment, result],
  );
  const hasActivity = activityItems.length > 0 || isLoading;
  const [activityOpen, setActivityOpen] = useState(
    () => isAgentActive(agent.status) || !(agent.result ?? fallbackResult),
  );
  const showStatusDetail = !!current.statusDetail && current.status !== "failed";
  const hasMeta =
    !modelLabel || metaParts.length > 0 || usageParts.length > 0 || showStatusDetail;

  return (
    <div className="flex flex-col gap-3 text-[0.8125rem]">
      {/* Metadata. The model is already shown in the always-visible card
          header / sidecar row above this detail, so it's repeated here only
          when it's unknown (a signal those surfaces omit). */}
      {hasMeta && (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 text-[0.6875rem]">
          {!modelLabel && <span className="italic text-muted/60">model unknown</span>}
          {metaParts.map((part) => (
            <span key={part} className="text-muted/70">
              {part}
            </span>
          ))}
          {usageParts.length > 0 && (
            <span className="tabular-nums text-muted/60">{usageParts.join(" · ")}</span>
          )}
          {showStatusDetail && <span className="text-muted/70">{current.statusDetail}</span>}
        </div>
      )}

      {assignment && <Assignment text={assignment} />}

      {/* Nested activity / transcript */}
      {hasActivity && (
        <div className="flex flex-col gap-1.5">
          <SectionToggle
            label="Activity"
            open={activityOpen}
            onToggle={() => setActivityOpen((v) => !v)}
            trailing={isLoading ? <Spinner size={10} className="text-muted" /> : undefined}
          />
          {activityOpen &&
            (activityItems.length > 0 ? (
              <AgentCardsProvider value={nestedContext}>
                <NestedTranscript items={activityItems} />
              </AgentCardsProvider>
            ) : null)}
        </div>
      )}

      {!hasActivity && unavailable && !result && (
        <div className="text-[0.75rem] text-muted/70">
          No detailed transcript is available for this agent.
        </div>
      )}

      {unanchoredChildren.length > 0 && depth < MAX_NESTING && (
        <div className="flex flex-col gap-1.5">
          <SectionToggle label="Delegated" />
          <AgentCardsProvider value={nestedContext}>
            <div className="flex flex-col gap-1">
              {unanchoredChildren.map((child) => (
                <AgentCard key={child.agentId} agent={child} depth={depth + 1} />
              ))}
            </div>
          </AgentCardsProvider>
        </div>
      )}

      {/* Result */}
      {result && (
        <div className="flex flex-col gap-1.5">
          <SectionToggle label={current.resultIsError ? "Result (error)" : "Result"} />
          <div
            className={`rounded-md border px-3 py-2.5 max-[768px]:text-[16px] ${
              current.resultIsError ? "border-error/30 bg-error-dim/40" : "border-border/60 bg-panel/40"
            }`}
          >
            <MarkdownContent text={result} />
          </div>
        </div>
      )}

      {current.status === "failed" && current.statusDetail && (
        <div className="rounded-md border border-error/30 bg-error-dim/40 px-3 py-2 text-[0.75rem] text-error/90">
          {current.statusDetail}
        </div>
      )}
    </div>
  );
}
