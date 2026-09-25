import { lazy, memo, Suspense, useMemo, useState, type ReactNode } from "react";
import { Check } from "lucide-react";
import { Progress } from "../ui/progress";
import { Spinner } from "../ui/spinner";
import type { ChatItem } from "@/hooks/use-instance-messages";
import type {
  AgentInfo,
  TaskItem,
  FileChange,
  ProviderRequest,
  SessionStats,
  ProviderStatusSummary,
} from "@shared/types";
import { findRequestAgentId } from "@/lib/agents";
import { MarkdownContent } from "./markdown-content";
import { FilesPanel } from "./files-panel";
import { ContextPanel } from "./context-panel";
import { AgentsPanel } from "./agents-panel";
import { SidecarShell, type SidecarTabDef } from "./sidecar-shell";
import { MobileSidecarOverlay } from "../ui/mobile-sidecar-overlay";
import "./sidecar.css";

const DiffDrawer = lazy(() => import("./diff-drawer").then((m) => ({ default: m.DiffDrawer })));

const PlanPanel = memo(function PlanPanel({ content }: { content: string }) {
  return (
    <div className="flex-1 overflow-y-auto px-3.5 py-3 text-[0.8125rem]">
      <MarkdownContent text={content} />
    </div>
  );
});

function StatusIcon({ status }: { status: TaskItem["status"] }) {
  switch (status) {
    case "completed":
      return (
        <div className="flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded bg-accent-dim text-accent">
          <Check size={10} strokeWidth={3} />
        </div>
      );
    case "in_progress":
      return (
        <div className="flex h-[18px] w-[18px] shrink-0 items-center justify-center">
          <Spinner size={14} />
        </div>
      );
    case "pending":
      return (
        <div className="flex h-[18px] w-[18px] shrink-0 items-center justify-center">
          <div className="h-[14px] w-[14px] rounded-full border-2 border-muted/30" />
        </div>
      );
  }
}

function sameTasks(prev: TaskItem[] | null, next: TaskItem[] | null): boolean {
  const prevList = prev ?? [];
  const nextList = next ?? [];
  if (prevList.length !== nextList.length) return false;
  for (let i = 0; i < prevList.length; i++) {
    const a = prevList[i];
    const b = nextList[i];
    if (!b) return false;
    if (
      a.id !== b.id ||
      a.subject !== b.subject ||
      a.status !== b.status ||
      a.activeForm !== b.activeForm
    ) {
      return false;
    }
  }
  return true;
}

function sameFiles(prev: FileChange[] | null, next: FileChange[] | null): boolean {
  const prevList = prev ?? [];
  const nextList = next ?? [];
  if (prevList.length !== nextList.length) return false;
  for (let i = 0; i < prevList.length; i++) {
    const a = prevList[i];
    const b = nextList[i];
    if (!b) return false;
    if (
      a.path !== b.path ||
      a.editCount !== b.editCount ||
      a.type !== b.type ||
      a.additions !== b.additions ||
      a.deletions !== b.deletions
    ) {
      return false;
    }
  }
  return true;
}

const TasksPanel = memo(function TasksPanel({ tasks }: { tasks: TaskItem[] }) {
  const completed = tasks.filter((t) => t.status === "completed").length;
  const total = tasks.length;
  const progress = total > 0 ? (completed / total) * 100 : 0;
  const allDone = completed === total;

  return (
    <>
      {/* Progress bar */}
      <div className="shrink-0 px-3.5 py-2.5">
        <div className="flex items-center justify-between pb-1.5">
          <span className={`text-[0.75rem] font-medium ${allDone ? "text-accent" : "text-muted"}`}>
            {completed}/{total} done
          </span>
          {allDone && <span className="text-[0.625rem] font-medium text-accent">Complete</span>}
        </div>
        <Progress value={progress} indicatorClass={allDone ? "bg-accent" : "bg-claude"} />
      </div>

      {/* Task list */}
      <div className="flex-1 overflow-y-auto px-2 pb-2">
        <div className="flex flex-col gap-0.5">
          {tasks.map((task) => (
            <div
              key={task.id}
              className="flex items-start gap-2.5 rounded-lg px-2.5 py-2 text-[0.8125rem] leading-snug transition-colors hover:bg-surface-hover"
            >
              <div className="mt-px">
                <StatusIcon status={task.status} />
              </div>
              <span
                className={`min-w-0 ${
                  task.status === "completed" ? "text-muted line-through" : "text-text"
                }`}
              >
                {task.status === "in_progress" && task.activeForm ? task.activeForm : task.subject}
              </span>
            </div>
          ))}
        </div>
      </div>
    </>
  );
});

// =============================================================================
// Tab system
// =============================================================================

import type { SidecarTab } from "@/stores/sidecar-store";
export type { SidecarTab } from "@/stores/sidecar-store";
import type { ProviderGlobalState, ProviderKind } from "@shared/types";

const TAB_LABELS: Record<SidecarTab, string> = {
  tasks: "Tasks",
  agents: "Agents",
  files: "Files",
  plan: "Plan",
  context: "Context",
  brief: "Brief",
  review: "Review",
};

interface SidecarProps {
  tasks: TaskItem[] | null;
  files: FileChange[] | null;
  planContent?: string | null;
  stats?: SessionStats | null;
  items?: ChatItem[];
  /**
   * Delegated agents for the Agents tab (rendered only when the tab is in
   * `tabs`). The reducer replaces both maps on change, so the memo compares
   * them by reference.
   */
  agents?: Record<string, AgentInfo>;
  agentItems?: Record<string, ChatItem[]>;
  pendingRequest?: ProviderRequest | null;
  provider?: ProviderKind;
  providerStatus?: ProviderStatusSummary;
  providerGlobalState?: ProviderGlobalState;
  /** Provider config dir the chat is bound to (absent = default account profile). */
  configDir?: string;
  instanceId?: string;
  createdAt?: number;
  lastActivityAt?: number;
  workingDirectory: string;
  /** Tab keys to render in the strip. On desktop pass a single-element list; on mobile pass all content panels. */
  tabs: ReadonlyArray<SidecarTab>;
  /** The tab whose content is currently shown. */
  activeTab: SidecarTab;
  /** Called when a tab is clicked (only relevant when tabs.length > 1). */
  onSelectTab?: (tab: SidecarTab) => void;
  /** Called when the close (X) button is clicked. */
  reviewContent?: ReactNode;
  onClose?: () => void;
  isMobileOverlay?: boolean;
}

function sameTabs(a: ReadonlyArray<SidecarTab>, b: ReadonlyArray<SidecarTab>): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

export const Sidecar = memo(
  function Sidecar({
    tasks,
    files,
    planContent,
    stats,
    items,
    agents,
    agentItems,
    pendingRequest,
    provider,
    providerStatus,
    providerGlobalState,
    configDir,
    instanceId,
    createdAt,
    lastActivityAt,
    workingDirectory,
    tabs,
    activeTab,
    onSelectTab,
    reviewContent,
    onClose,
    isMobileOverlay,
  }: SidecarProps) {
    const hasTasks = tasks && tasks.length > 0;
    const agentCount = agents ? Object.keys(agents).length : 0;
    const hasAgents = agentCount > 0;
    const hasFiles = files && files.length > 0;
    const hasPlan = !!planContent;
    const hasStats = !!stats && (stats.inputTokens > 0 || stats.outputTokens > 0);
    const hasReview = !!reviewContent;
    const hasProviderContext = Boolean(
      providerStatus?.threadStatus ||
      providerStatus?.turnStatus ||
      providerStatus?.effectiveModel ||
      providerStatus?.notices?.length ||
      providerGlobalState?.account ||
      providerGlobalState?.mcpServers?.length ||
      providerGlobalState?.apps?.length ||
      providerGlobalState?.notices?.length,
    );

    const [diffDrawerOpen, setDiffDrawerOpen] = useState(false);
    const [diffScrollToFile, setDiffScrollToFile] = useState<string | undefined>();

    const openDiffDrawer = (scrollTo?: string) => {
      setDiffScrollToFile(scrollTo);
      setDiffDrawerOpen(true);
    };

    const tabDefs = useMemo<(SidecarTabDef & { key: SidecarTab })[]>(() => {
      return tabs.map((tab) => {
        const def: SidecarTabDef & { key: SidecarTab } = { key: tab, label: TAB_LABELS[tab] };
        if (tab === "tasks" && tasks) def.count = tasks.length;
        if (tab === "files" && files) def.count = files.length;
        if (tab === "agents" && agentCount > 0) def.count = agentCount;
        return def;
      });
    }, [tabs, tasks, files, agentCount]);

    const renderTabContent = (key: string) => {
      if (key === "tasks" && hasTasks) return <TasksPanel tasks={tasks} />;
      if (key === "agents" && hasAgents && agents)
        return (
          <AgentsPanel
            agents={agents}
            agentItems={agentItems ?? {}}
            items={items}
            instanceId={instanceId}
            provider={provider}
            pendingAgentId={findRequestAgentId(pendingRequest, agents)}
          />
        );
      if (key === "plan" && hasPlan) return <PlanPanel content={planContent} />;
      if (key === "files" && hasFiles)
        return (
          <FilesPanel
            files={files}
            cwd={workingDirectory}
            onViewChanges={instanceId ? () => openDiffDrawer() : undefined}
            onFileClick={instanceId ? (path) => openDiffDrawer(path) : undefined}
          />
        );
      if (key === "context" && (hasStats || hasProviderContext))
        return (
          <ContextPanel
            mode="instance"
            stats={stats ?? null}
            items={items ?? []}
            provider={provider}
            providerStatus={providerStatus}
            providerGlobalState={providerGlobalState}
            configDir={configDir}
            createdAt={createdAt ?? Date.now()}
            lastActivityAt={lastActivityAt ?? Date.now()}
          />
        );
      if (key === "review" && hasReview) {
        return <div className="min-h-0 flex-1 overflow-hidden">{reviewContent}</div>;
      }
      return null;
    };

    const panel = (
      <SidecarShell
        tabs={tabDefs}
        activeTab={activeTab}
        onActiveTabChange={(key) => onSelectTab?.(key as SidecarTab)}
        renderTabContent={renderTabContent}
        isMobileOverlay={isMobileOverlay}
        onClose={onClose}
      />
    );

    const diffDrawer = diffDrawerOpen && instanceId && (
      <Suspense>
        <DiffDrawer
          instanceId={instanceId}
          knownFiles={files ?? undefined}
          workingDirectory={workingDirectory}
          onClose={() => setDiffDrawerOpen(false)}
          scrollToFile={diffScrollToFile}
        />
      </Suspense>
    );

    if (isMobileOverlay) {
      return (
        <>
          <MobileSidecarOverlay onClose={onClose ?? (() => {})}>{panel}</MobileSidecarOverlay>
          {diffDrawer}
        </>
      );
    }

    return (
      <>
        {panel}
        {diffDrawer}
      </>
    );
  },
  (prev, next) => {
    return (
      prev.activeTab === next.activeTab &&
      sameTabs(prev.tabs, next.tabs) &&
      prev.workingDirectory === next.workingDirectory &&
      prev.isMobileOverlay === next.isMobileOverlay &&
      prev.instanceId === next.instanceId &&
      prev.createdAt === next.createdAt &&
      prev.lastActivityAt === next.lastActivityAt &&
      prev.stats === next.stats &&
      prev.items === next.items &&
      prev.agents === next.agents &&
      prev.agentItems === next.agentItems &&
      prev.pendingRequest === next.pendingRequest &&
      prev.provider === next.provider &&
      prev.providerStatus === next.providerStatus &&
      prev.providerGlobalState === next.providerGlobalState &&
      prev.configDir === next.configDir &&
      prev.planContent === next.planContent &&
      prev.reviewContent === next.reviewContent &&
      prev.onSelectTab === next.onSelectTab &&
      prev.onClose === next.onClose &&
      sameTasks(prev.tasks, next.tasks) &&
      sameFiles(prev.files, next.files)
    );
  },
);
