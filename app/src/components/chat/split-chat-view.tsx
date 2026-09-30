import { useState } from "react";
import { useNavigate, useParams } from "@tanstack/react-router";
import { Columns2, Plus, Search, X } from "lucide-react";
import { Group, Panel } from "react-resizable-panels";
import { ProviderLogo } from "@/components/ui/provider-logo";
import { useActiveAccount } from "@/hooks/use-active-account";
import { chatBelongsToAccount } from "@/lib/account-scope";
import { InstanceView } from "@/components/chat/instance-view";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ResizableHandle } from "@/components/ui/resizable-handle";
import { Tooltip } from "@/components/ui/tooltip";
import { useWSState } from "@/context/websocket-context";
import { toast } from "sonner";
import { createInstance } from "@/lib/api";
import { reportCreateInstanceError } from "@/stores/process-limit-store";
import { isAttachedReviewInstance } from "@/lib/review-session";
import { deriveInstanceStatusPresentation, formatTimeAgo } from "@/lib/utils";
import type { InstanceInfo } from "@shared/types";

function PaneHeader({
  instance,
  onClose,
}: {
  instance: InstanceInfo | undefined;
  onClose?: () => void;
}) {
  return (
    <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border/50 px-3">
      {instance ? (
        <>
          <span
            className={`h-2 w-2 shrink-0 rounded-full ${deriveInstanceStatusPresentation(instance).dotClass}`}
          />
          <span className="min-w-0 truncate text-[0.8125rem] font-medium text-text-bright">
            {instance.name}
          </span>
          <span className="shrink-0 text-[0.6875rem] text-muted">
            {instance.workingDirectory.split("/").pop() || instance.workingDirectory}
          </span>
        </>
      ) : (
        <span className="text-[0.8125rem] text-muted">Loading...</span>
      )}
      {onClose && (
        <Tooltip content="Close split">
          <Button variant="icon" size="icon-sm" onClick={onClose} className="ml-auto shrink-0">
            <X size={14} />
          </Button>
        </Tooltip>
      )}
    </div>
  );
}

/** Empty pane with session picker — shown when no secondary session is selected yet. */
function SessionPicker({
  instances,
  excludeId,
  onSelect,
  onNewChat,
  onClose,
}: {
  instances: InstanceInfo[];
  excludeId?: string;
  onSelect: (id: string) => void;
  onNewChat: () => void;
  onClose: () => void;
}) {
  const [filter, setFilter] = useState("");
  const filtered = instances
    .filter((i) => i.id !== excludeId)
    .filter((i) => !isAttachedReviewInstance(i))
    .filter(
      (i) =>
        !filter ||
        i.name.toLowerCase().includes(filter.toLowerCase()) ||
        i.workingDirectory.toLowerCase().includes(filter.toLowerCase()),
    );

  return (
    <div className="flex h-full flex-col overflow-hidden border-l border-border/30">
      {/* Header */}
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border/50 px-3">
        <Columns2 size={14} className="shrink-0 text-muted" />
        <span className="text-[0.8125rem] font-medium text-text-bright">
          Pick a session for split view
        </span>
        <Tooltip content="Close split">
          <Button variant="icon" size="icon-sm" onClick={onClose} className="ml-auto shrink-0">
            <X size={14} />
          </Button>
        </Tooltip>
      </div>

      {/* Search + new chat */}
      <div className="flex items-center gap-2 border-b border-border/30 px-3 py-2">
        <div className="relative min-w-0 flex-1">
          <Search
            size={13}
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted"
          />
          <Input
            type="text"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter sessions..."
            inputSize="sm"
            className="pl-8"
            autoFocus
          />
        </div>
        <Tooltip content="New chat in split">
          <Button variant="ghost" size="sm" onClick={onNewChat} className="shrink-0 gap-1.5">
            <Plus size={13} strokeWidth={2.5} />
            New
          </Button>
        </Tooltip>
      </div>

      {/* Session list */}
      <div className="flex-1 overflow-y-auto px-2 py-1.5">
        {filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-10 text-center">
            <p className="text-[0.8125rem] text-muted">No matching sessions</p>
          </div>
        ) : (
          <div className="flex flex-col gap-0.5">
            {filtered.map((inst) => (
              <button
                key={inst.id}
                type="button"
                onClick={() => onSelect(inst.id)}
                className="flex items-start gap-2.5 rounded-lg px-3 py-2 text-left transition-colors hover:bg-surface-hover"
              >
                <span
                  className={`mt-1.5 h-[6px] w-[6px] shrink-0 rounded-full ${deriveInstanceStatusPresentation(inst).dotClass}`}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="min-w-0 truncate text-[0.8125rem] font-medium text-text-bright">
                      {inst.name}
                    </span>
                    <ProviderLogo
                      provider={inst.provider}
                      className="h-3 w-3 shrink-0 text-muted/50"
                      muted
                    />
                  </div>
                  <div className="mt-0.5 flex items-center gap-1.5 text-[0.6875rem] text-muted">
                    <span className="truncate">
                      {inst.workingDirectory.split("/").pop() || inst.workingDirectory}
                    </span>
                    {inst.lastMessage && (
                      <>
                        <span className="text-border">&middot;</span>
                        <span className="shrink-0">
                          {formatTimeAgo(inst.lastMessage.timestamp)}
                        </span>
                      </>
                    )}
                  </div>
                  {inst.lastMessage && (
                    <div className="mt-0.5 truncate text-[0.6875rem] text-muted/70">
                      {inst.lastMessage.text}
                    </div>
                  )}
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

interface SplitChatViewProps {
  /** The secondary instance ID, or empty string / "pick" to show the session picker. */
  splitId: string;
}

export function SplitChatView({ splitId }: SplitChatViewProps) {
  const { chatId: primaryId, projectId } = useParams({ strict: false }) as {
    chatId?: string;
    projectId?: string;
  };
  const navigate = useNavigate({ from: "/projects/$projectId/chats/$chatId" });
  const { instances } = useWSState();
  // New chats bind to the active account (undefined below two accounts), and
  // the picker lists only the active account's chats (every chat with one).
  const account = useActiveAccount();
  const { accountIdParam } = account;
  const pickableInstances = account.isMulti
    ? instances.filter((i) => chatBelongsToAccount(i, account.activeId, account.accounts))
    : instances;

  const primaryInstance = instances.find((i) => i.id === primaryId);
  const resolvedSplitId = splitId && splitId !== "pick" ? splitId : null;
  const secondaryInstance = resolvedSplitId
    ? instances.find((i) => i.id === resolvedSplitId)
    : null;

  const closeSplit = () => {
    navigate({
      to: "/projects/$projectId/chats/$chatId",
      params: { projectId: projectId!, chatId: primaryId! },
      search: {},
    });
  };

  const selectSplit = (id: string) => {
    navigate({
      to: "/projects/$projectId/chats/$chatId",
      params: { projectId: projectId!, chatId: primaryId! },
      search: { split: id },
    });
  };

  const handleNewChat = async () => {
    const dir = primaryInstance?.workingDirectory;
    if (!dir) return;
    try {
      const inst = await createInstance({
        workingDirectory: dir,
        accountId: accountIdParam,
      });
      selectSplit(inst.id);
    } catch (e) {
      if (!reportCreateInstanceError(e, handleNewChat)) {
        toast.error(e instanceof Error ? e.message : "Failed to start chat");
      }
    }
  };

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <Group orientation="horizontal" className="min-h-0 flex-1">
        <Panel defaultSize="50" minSize="30">
          <div className="flex h-full flex-col overflow-hidden">
            <PaneHeader instance={primaryInstance} />
            <InstanceView instanceId={primaryId} compact />
          </div>
        </Panel>
        <ResizableHandle />
        <Panel defaultSize="50" minSize="30">
          {resolvedSplitId ? (
            <div className="flex h-full flex-col overflow-hidden border-l border-border/30">
              <PaneHeader instance={secondaryInstance ?? undefined} onClose={closeSplit} />
              <InstanceView instanceId={resolvedSplitId} compact />
            </div>
          ) : (
            <SessionPicker
              instances={pickableInstances}
              excludeId={primaryId}
              onSelect={selectSplit}
              onNewChat={handleNewChat}
              onClose={closeSplit}
            />
          )}
        </Panel>
      </Group>
    </div>
  );
}
