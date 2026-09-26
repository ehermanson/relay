import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams, Link } from "@tanstack/react-router";
import { GitBranch, MessageSquare, Pin, Search } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { EmptyProjectActions } from "@/components/empty-project-actions";
import { EmptyState } from "@/components/empty-state";
import { CreateSpaceDialog, useCreateSpaceDialog } from "@/components/spaces/create-space-dialog";
import { Tooltip } from "@/components/ui/tooltip";
import { useProjectContext } from "@/context/project-context";
import { useWSMethods, useWSState } from "@/context/websocket-context";
import { useActionToasts } from "@/context/action-toast-context";
import { useMediaQuery } from "@/hooks/use-media-query";
import { fetchProjectChats, fetchAllSpaces } from "@/lib/api";
import { getInstanceChatRoute, instanceMatchesProject } from "@/lib/project-route";
import { isAttachedReviewInstance } from "@/lib/review-session";
import {
  compareChatListOrder,
  deriveInstanceStatusPresentation,
  formatModel,
  formatTimeAgo,
  formatTokens,
  getChatSortTimestamp,
  getDisplaySessionStats,
} from "@/lib/utils";
import { StatusDot } from "@/components/ui/status-dot";
import { ChatListRow } from "@/components/chat/chat-list-row";
import type { InstanceInfo } from "@shared/types";

function SessionCard({
  instance,
  parentName,
  isMobile,
}: {
  instance: InstanceInfo;
  parentName?: string;
  isMobile: boolean;
}) {
  const route = getInstanceChatRoute(instance);
  const recencyAt = getChatSortTimestamp(instance);
  const displayStats = instance.stats
    ? getDisplaySessionStats(instance.provider, instance.stats)
    : null;

  return (
    <Link
      to={route.to}
      params={route.params}
      className="group flex items-center gap-3 rounded-lg border border-border/80 bg-surface px-4 py-3 transition-all duration-150 hover:-translate-y-px hover:border-accent/30 hover:bg-surface-hover hover:shadow-sm"
    >
      {/* Status dot */}
      <StatusDot variant={deriveInstanceStatusPresentation(instance).variant} size={6} />

      {/* Main column — name, preview, parent */}
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <div className="min-w-0 truncate text-[0.8125rem] font-medium text-text-bright">
            {instance.name}
          </div>
          {instance.pinned && <Pin size={11} className="shrink-0 fill-current text-muted" />}
        </div>
        {parentName && (
          <div className="mt-0.5 truncate text-[0.6875rem] text-muted">
            {"\u21B3"} from {parentName}
          </div>
        )}
        {instance.lastMessage && (
          <div className="mt-0.5 truncate text-[0.6875rem] text-muted">
            {instance.lastMessage.text}
          </div>
        )}

        {/* Mobile: inline model */}
        {isMobile && instance.stats?.model && (
          <div className="mt-1 flex items-center gap-2 text-[0.625rem] text-muted">
            <span>{formatModel(instance.stats.model)}</span>
          </div>
        )}
      </div>

      {/* Git branch badge */}
      {instance.gitBranch && (
        <Badge variant="default" className="hidden shrink-0 sm:flex">
          <GitBranch size={10} className="mr-1" />
          <span className="max-w-[120px] truncate">{instance.gitBranch}</span>
        </Badge>
      )}

      {/* Model + cost column (desktop) */}
      {!isMobile && instance.stats && (
        <div className="hidden shrink-0 text-right sm:block">
          {instance.stats.model && (
            <div className="text-[0.6875rem] text-muted">{formatModel(instance.stats.model)}</div>
          )}
          <Tooltip
            content={
              <div className="flex flex-col gap-0.5">
                <div>Total: {formatTokens(displayStats?.totalTokens ?? 0)}</div>
                <div>Input: {formatTokens(displayStats?.inputTokens ?? 0)}</div>
                <div>Output: {formatTokens(instance.stats.outputTokens)}</div>
                {instance.stats.cacheCreationTokens > 0 && (
                  <div>Cache write: {formatTokens(instance.stats.cacheCreationTokens)}</div>
                )}
                {instance.stats.cacheReadTokens > 0 && (
                  <div>Cache read: {formatTokens(instance.stats.cacheReadTokens)}</div>
                )}
              </div>
            }
          >
            <div className="text-[0.6875rem] text-muted">
              {formatTokens(displayStats?.totalTokens ?? 0)} tokens
            </div>
          </Tooltip>
        </div>
      )}

      {/* Timestamps column */}
      <div className="hidden shrink-0 text-right sm:block">
        {recencyAt > 0 && (
          <div className="text-[0.6875rem] text-muted">{formatTimeAgo(recencyAt)}</div>
        )}
        {instance.createdAt > 0 && (
          <div className="text-[0.625rem] text-muted opacity-60">
            {new Date(instance.createdAt).toLocaleDateString(undefined, {
              month: "short",
              day: "numeric",
            })}
          </div>
        )}
      </div>
    </Link>
  );
}

/**
 * Self-contained chat list (search + cards + empty states) for a project.
 * Reads the active project from route params + ProjectContext, so it can be
 * dropped into any padded container. Rendered by the project Overview tab
 * (Overview IS the chat list); rows are dense on mobile, rich cards on desktop.
 */
export function ProjectChatList() {
  const { projectId: routeProjectId } = useParams({ strict: false }) as { projectId: string };
  const isMobile = useMediaQuery("(max-width: 768px)");
  const queryClient = useQueryClient();
  const { addMessageHandler, send } = useWSMethods();
  const { instances } = useWSState();
  const { artifacts } = useProjectContext();
  const { trackInstanceCreate } = useActionToasts();
  const [searchQuery, setSearchQuery] = useState("");
  const spaceDialog = useCreateSpaceDialog();
  const projectId = artifacts.projectId || routeProjectId;
  const spacesQueryKey = ["spaces", projectId] as const;
  const chatsQueryKey = ["projectChats", projectId] as const;

  const { data: spaces = [] } = useQuery({
    queryKey: spacesQueryKey,
    queryFn: () => fetchAllSpaces(projectId),
    enabled: !!projectId,
  });
  const { data: chatSummaries = [] } = useQuery({
    queryKey: chatsQueryKey,
    queryFn: () => fetchProjectChats(projectId),
    enabled: !!projectId,
  });

  useEffect(() => {
    return addMessageHandler((message) => {
      if (message.type === "space_list" && message.projectDirectory === artifacts.directory) {
        queryClient.setQueryData(spacesQueryKey, message.spaces);
        return;
      }
      if (message.type === "instance_created" || message.type === "instance_removed") {
        void queryClient.invalidateQueries({ queryKey: chatsQueryKey });
        return;
      }
    });
  }, [addMessageHandler, artifacts.directory, chatsQueryKey, queryClient, spacesQueryKey]);

  const projectInstancesMap = new Map<string, InstanceInfo>();
  for (const chat of chatSummaries) {
    projectInstancesMap.set(chat.id, chat);
  }
  for (const inst of instances) {
    if (!instanceMatchesProject(inst, projectId)) continue;
    projectInstancesMap.set(inst.id, inst);
  }
  const projectInstances = Array.from(projectInstancesMap.values()).sort(compareChatListOrder);
  // Resolve a chat's space tag (branch, falling back to space name). Default
  // ("main") space chats are untagged standalone chats.
  const spacesById = new Map(spaces.map((s) => [s.id, s]));
  const spaceLabelFor = (inst: InstanceInfo): string | undefined => {
    if (!inst.spaceId) return undefined;
    const space = spacesById.get(inst.spaceId);
    if (!space || space.isDefault) return undefined;
    return space.gitBranch ?? space.name;
  };

  // One flat list on every viewport — standalone + space chats together, each
  // space chat tagged with its branch. The Spaces tab handles space lifecycle.
  const listInstances = projectInstances.filter((inst) => !isAttachedReviewInstance(inst));

  // Build a lookup for parent session names
  const parentNames = new Map<string, string>();
  const instancesBySessionId = new Map<string, InstanceInfo>();
  for (const inst of projectInstances) {
    if (inst.sessionId) {
      instancesBySessionId.set(inst.sessionId, inst);
    }
  }
  for (const inst of projectInstances) {
    if (inst.parentSessionId) {
      const parent = instancesBySessionId.get(inst.parentSessionId);
      if (parent) parentNames.set(inst.id, parent.name);
    }
  }

  const filtered = searchQuery
    ? listInstances.filter(
        (inst) =>
          inst.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
          inst.gitBranch?.toLowerCase().includes(searchQuery.toLowerCase()) ||
          spaceLabelFor(inst)?.toLowerCase().includes(searchQuery.toLowerCase()) ||
          inst.lastMessage?.text?.toLowerCase().includes(searchQuery.toLowerCase()),
      )
    : listInstances;

  const handleNewChat = () => {
    if (artifacts.directory) {
      trackInstanceCreate(artifacts.directory);
      send({ type: "create_instance", workingDirectory: artifacts.directory });
    }
  };

  const handleNewSpace = () => {
    if (artifacts.directory) {
      spaceDialog.open(artifacts.directory);
    }
  };

  return (
    <>
      {listInstances.length > 0 && (
        <div className="relative mb-3">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" />
          <Input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search chats..."
            className="h-8 !rounded-md !bg-surface !py-1.5 pl-8 pr-3"
          />
        </div>
      )}
      {listInstances.length === 0 ? (
        <EmptyState
          icon={<MessageSquare size={24} strokeWidth={1.5} />}
          title="No chats yet"
          description="Start a chat or create a space to get going"
        >
          <div className="mt-5">
            <EmptyProjectActions onNewChat={handleNewChat} onNewSpace={handleNewSpace} />
          </div>
        </EmptyState>
      ) : filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <p className="text-sm text-muted">No chats match &quot;{searchQuery}&quot;</p>
        </div>
      ) : isMobile ? (
        <div className="divide-y divide-border/60 overflow-hidden rounded-lg border border-border/80 bg-surface">
          {filtered.map((inst) => (
            <ChatListRow key={inst.id} instance={inst} showModel spaceLabel={spaceLabelFor(inst)} />
          ))}
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {filtered.map((inst, index) => (
            <div
              key={inst.id}
              className="opacity-0 animate-stagger-fade-in"
              style={{ animationDelay: `${Math.min(index, 8) * 30}ms` }}
            >
              <SessionCard
                instance={inst}
                parentName={parentNames.get(inst.id)}
                isMobile={isMobile}
              />
            </div>
          ))}
        </div>
      )}

      <CreateSpaceDialog
        dir={spaceDialog.dir}
        projectName={artifacts.directory?.split("/").pop() || artifacts.directory || ""}
        projectId={projectId}
        onOpenChange={(open) => !open && spaceDialog.close()}
      />
    </>
  );
}
