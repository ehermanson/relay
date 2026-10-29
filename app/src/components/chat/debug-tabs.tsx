/**
 * Shared debug tab bar + data panes for the chat debug drawer.
 *
 * Renders: Provider | Session | Context | Raw | Processed | Instance
 * with a tree/raw toggle and per-tab descriptions.
 *
 * Accepts optional extra tabs via the `extraTabs` prop.
 */

import { useMemo, useState, type ReactNode } from "react";
import { JsonTreeViewer } from "../ui/json-tree-viewer";
import { Tabs } from "../ui/tabs";
import type { HistoryEntry, InstanceInfo, ProviderGlobalState } from "@shared/types";
import type { ChatItem } from "../../hooks/use-instance-messages";

// ── Types ────────────────────────────────────────────────────────────

type ViewMode = "tree" | "raw";

export interface ExtraTab {
  value: string;
  label: ReactNode;
  description: string;
  content: ReactNode | ((viewMode: ViewMode) => ReactNode);
}

export interface DebugTabsProps {
  /** The instance being inspected. When null, chat tabs are disabled. */
  instance: InstanceInfo | null;
  items?: ChatItem[];
  rawHistory?: HistoryEntry[] | null;
  isProcessing?: boolean;
  providerGlobalState?: ProviderGlobalState;
  /** Extra tabs prepended before the chat data tabs. */
  extraTabs?: ExtraTab[];
  /** Max height for data panes. */
  maxHeight?: string;
  /** Default active tab. */
  defaultTab?: string;
  /** Loading state — shown when instance is selected but data isn't ready. */
  loading?: boolean;
  /** Prompt shown when no instance is selected. */
  emptyMessage?: string;
}

// ── Constants ────────────────────────────────────────────────────────

const SESSION_EVENT_TYPES = new Set([
  "session_init",
  "provider_status",
  "provider_notice",
  "model_rerouted",
]);

const TAB_DESCRIPTIONS: Record<string, string> = {
  provider:
    "Current provider config and live status — which provider, model, and any runtime state like rate limits or reroutes.",
  session:
    "Lifecycle events for this session — init, provider status changes, notices, and model reroutes.",
  context:
    "Structured Relay-injected context for this session — bootstrap policy and any provider-visible runtime context Relay has stored.",
  raw: "The unprocessed message history from the server, exactly as received over the wire.",
  processed:
    "Messages after Relay transforms them into renderable items — grouped activities, merged tool results, thinking blocks, etc.",
  instance:
    "The full InstanceInfo object — status, git state, permissions, plan mode, stats, and everything the UI derives state from.",
};

const DATA_TAB_KEYS = ["provider", "session", "context", "raw", "processed", "instance"] as const;

// ── Component ────────────────────────────────────────────────────────

export function DebugTabs({
  instance,
  items = [],
  rawHistory,
  isProcessing = false,
  providerGlobalState,
  extraTabs = [],
  maxHeight = "calc(100vh - 200px)",
  defaultTab,
  loading,
  emptyMessage,
}: DebugTabsProps) {
  const resolvedDefault = defaultTab ?? (extraTabs.length > 0 ? extraTabs[0]!.value : "provider");
  const [activeTab, setActiveTab] = useState(resolvedDefault);
  const [viewMode, setViewMode] = useState<ViewMode>("tree");

  const tabData = useMemo(() => {
    if (!instance) return null;

    const sessionEvents = (rawHistory ?? [])
      .filter(
        (entry) =>
          entry.message.type === "system_event" &&
          SESSION_EVENT_TYPES.has((entry.message as { event?: string }).event ?? ""),
      )
      .map((entry) => entry.message);

    return {
      provider: {
        provider: instance.provider,
        preferredModel: instance.preferredModel ?? null,
        activeModel: instance.stats?.model ?? null,
        providerGlobalState: providerGlobalState ?? null,
        providerInstanceState: instance.providerStatus ?? null,
      },
      session: sessionEvents,
      context: instance.sessionContext ?? null,
      raw: rawHistory ?? [],
      processed: { items, isProcessing },
      instance: instance,
    };
    // `rawHistory` is mutated in place for live appends (see use-instance-messages),
    // so the array reference stays stable — depend on its length to re-run on
    // every new entry.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rawHistory?.length, items, isProcessing, instance, providerGlobalState]);

  const chatTabsDisabled = !instance;
  const isExtraTab = extraTabs.some((t) => t.value === activeTab);

  // Build description map including extra tabs
  const allDescriptions = useMemo(() => {
    const descs = { ...TAB_DESCRIPTIONS };
    for (const tab of extraTabs) {
      descs[tab.value] = tab.description;
    }
    return descs;
  }, [extraTabs]);

  return (
    <Tabs.Root value={activeTab} onValueChange={setActiveTab}>
      <div className="mb-2 flex items-center gap-2">
        <Tabs.List className="flex-1">
          {extraTabs.map((tab) => (
            <Tabs.Tab key={tab.value} value={tab.value}>
              {tab.label}
            </Tabs.Tab>
          ))}
          <Tabs.Tab value="provider" disabled={chatTabsDisabled}>
            Provider
          </Tabs.Tab>
          <Tabs.Tab value="session" disabled={chatTabsDisabled}>
            Session
          </Tabs.Tab>
          <Tabs.Tab value="context" disabled={chatTabsDisabled}>
            Context
          </Tabs.Tab>
          <Tabs.Tab value="raw" disabled={chatTabsDisabled}>
            Raw{rawHistory && instance ? ` (${rawHistory.length})` : ""}
          </Tabs.Tab>
          <Tabs.Tab value="processed" disabled={chatTabsDisabled}>
            Processed{instance ? ` (${items.length})` : ""}
          </Tabs.Tab>
          <Tabs.Tab value="instance" disabled={chatTabsDisabled}>
            Instance
          </Tabs.Tab>
        </Tabs.List>
        <div className="flex shrink-0 items-center rounded-md border border-border/50 text-[0.6875rem]">
          <button
            onClick={() => setViewMode("tree")}
            className={`rounded-l-md px-2 py-1 transition-colors ${
              viewMode === "tree"
                ? "bg-surface-hover text-text-bright"
                : "text-muted hover:text-text"
            }`}
          >
            Tree
          </button>
          <button
            onClick={() => setViewMode("raw")}
            className={`rounded-r-md border-l border-border/50 px-2 py-1 transition-colors ${
              viewMode === "raw"
                ? "bg-surface-hover text-text-bright"
                : "text-muted hover:text-text"
            }`}
          >
            Raw
          </button>
        </div>
      </div>

      <p className="mb-3 text-[0.6875rem] leading-relaxed text-muted">
        {allDescriptions[activeTab]}
      </p>

      {/* Extra tab panels */}
      {extraTabs.map((tab) => (
        <Tabs.Panel key={tab.value} value={tab.value}>
          {typeof tab.content === "function" ? tab.content(viewMode) : tab.content}
        </Tabs.Panel>
      ))}

      {/* Chat tabs — empty/loading states */}
      {!isExtraTab && chatTabsDisabled && emptyMessage && (
        <div className="py-8 text-center text-[0.8125rem] text-muted">{emptyMessage}</div>
      )}
      {!isExtraTab && loading && (
        <div className="py-8 text-center text-[0.8125rem] text-muted">Loading chat history…</div>
      )}

      {/* Chat data tab panels */}
      {tabData &&
        DATA_TAB_KEYS.map((key) => (
          <Tabs.Panel key={key} value={key}>
            <DataPane data={tabData[key]} viewMode={viewMode} maxHeight={maxHeight} />
          </Tabs.Panel>
        ))}
    </Tabs.Root>
  );
}

// ── DataPane ─────────────────────────────────────────────────────────

export function DataPane({
  data,
  viewMode,
  maxHeight,
}: {
  data: unknown;
  viewMode: ViewMode;
  maxHeight: string;
}) {
  if (viewMode === "tree") {
    return (
      <div className="rounded-lg border border-border bg-bg">
        <JsonTreeViewer data={data} maxHeight={maxHeight} defaultExpandDepth={1} />
      </div>
    );
  }

  return (
    <pre
      className="overflow-auto rounded-lg border border-border bg-bg p-3.5 font-mono text-[0.75rem] leading-relaxed text-text"
      style={{ maxHeight }}
    >
      {JSON.stringify(data, null, 2)}
    </pre>
  );
}
