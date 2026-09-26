import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams, Link } from "@tanstack/react-router";
import {
  AlertTriangle,
  Archive,
  ChevronDown,
  ChevronRight,
  GitBranch,
  GitMerge,
  Search,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/empty-state";
import { useProjectContext } from "@/context/project-context";
import { useWSMethods, useWSState } from "@/context/websocket-context";
import { useMediaQuery } from "@/hooks/use-media-query";
import { fetchProjectChats, fetchAllSpaces } from "@/lib/api";
import { getInstanceChatRoute, instanceMatchesProject } from "@/lib/project-route";
import { getResolvedSpaceId } from "@/lib/space-membership";
import { formatTimeAgo, getChatSortTimestamp, instanceStatusVariant } from "@/lib/utils";
import { PageShell } from "@/components/ui/page-shell";
import { StatusDot } from "@/components/ui/status-dot";
import type { InstanceInfo, SpaceInfo } from "@shared/types";

// ─── Space Card ──────────────────────────────────────────────────────────────

function SpaceCard({
  projectId,
  space,
  chats,
  isMobile,
}: {
  projectId: string;
  space: SpaceInfo;
  chats: InstanceInfo[];
  isMobile: boolean;
}) {
  const isClosed = space.status === "completed" || space.status === "archived";
  const lastActivity = Math.max(
    space.lastActivityAt || 0,
    ...chats.map((chat) => getChatSortTimestamp(chat)),
  );

  return (
    <div
      className={`overflow-hidden rounded-lg border border-border/80 bg-surface ${isClosed ? "opacity-75" : ""}`}
    >
      <Link
        to="/projects/$projectId/spaces/$spaceId"
        params={{ projectId, spaceId: space.id }}
        className="group flex items-center gap-3 px-4 py-3 transition-colors hover:bg-surface-hover"
      >
        <span
          className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-md ${
            space.status === "broken"
              ? "bg-warning/10 text-warning"
              : isClosed
                ? "bg-surface-hover text-muted"
                : "bg-accent/10 text-accent"
          }`}
        >
          {space.status === "broken" ? (
            <AlertTriangle size={14} strokeWidth={2.2} />
          ) : space.status === "completed" ? (
            <GitMerge size={14} strokeWidth={2.2} />
          ) : space.status === "archived" ? (
            <Archive size={14} strokeWidth={2.2} />
          ) : (
            <GitBranch size={14} strokeWidth={2.2} />
          )}
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 truncate text-[0.8125rem] font-semibold text-text-bright">
            {space.name}
            {space.status === "completed" && (
              <Badge variant="success" size="xs">
                Merged
              </Badge>
            )}
            {space.status === "broken" && (
              <Badge variant="warning" size="xs">
                Broken
              </Badge>
            )}
            {space.status === "archived" && (
              <Badge variant="default" size="xs">
                Archived
              </Badge>
            )}
          </div>
          <div className="mt-0.5 flex items-center gap-2 text-[0.6875rem] text-muted">
            {space.gitBranch && <span className="truncate">{space.gitBranch}</span>}
            <span>
              {chats.length} chat{chats.length !== 1 ? "s" : ""}
            </span>
          </div>
        </div>

        {!isMobile && lastActivity > 0 && (
          <div className="shrink-0 text-right text-[0.6875rem] text-muted">
            {formatTimeAgo(lastActivity)}
          </div>
        )}
      </Link>

      <div className="border-t border-border/60 bg-background/25 px-3 py-2">
        {chats.length === 0 ? (
          <div className="rounded-md border border-dashed border-border/60 px-4 py-3 text-[0.75rem] text-muted">
            No chats yet in this space
          </div>
        ) : (
          chats.map((chat) => {
            const route = getInstanceChatRoute(chat);
            return (
              <Link
                key={chat.id}
                to={route.to}
                params={route.params}
                className="group ml-4 flex items-center gap-3 rounded-md border border-transparent px-3 py-2 transition-colors hover:border-border/60 hover:bg-surface-hover/70"
              >
                <StatusDot
                  variant={instanceStatusVariant(chat.status, !!chat.pendingTool)}
                  size={6}
                />

                <div className="min-w-0 flex-1">
                  <div className="truncate text-[0.75rem] font-medium text-text">{chat.name}</div>
                  {chat.lastMessage && (
                    <div className="mt-0.5 truncate text-[0.6875rem] text-muted">
                      {chat.lastMessage.text}
                    </div>
                  )}
                </div>

                {!isMobile && getChatSortTimestamp(chat) > 0 && (
                  <div className="shrink-0 text-[0.6875rem] text-muted">
                    {formatTimeAgo(getChatSortTimestamp(chat))}
                  </div>
                )}
              </Link>
            );
          })
        )}
      </div>
    </div>
  );
}

// ─── Collapsible Section ─────────────────────────────────────────────────────

function SpaceSection({
  label,
  spaces,
  projectId,
  isMobile,
  defaultOpen,
  variant = "default",
}: {
  label: string;
  spaces: EnrichedSpace[];
  projectId: string;
  isMobile: boolean;
  defaultOpen: boolean;
  variant?: "default" | "warning" | "muted";
}) {
  const [open, setOpen] = useState(defaultOpen);

  if (spaces.length === 0) return null;

  const colorClass =
    variant === "warning"
      ? "text-warning hover:text-warning"
      : variant === "muted"
        ? "text-muted hover:text-text"
        : "text-muted hover:text-text";

  return (
    <div>
      <button
        onClick={() => setOpen(!open)}
        className={`flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-xs font-medium uppercase tracking-wide transition-colors ${colorClass}`}
      >
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        {label} ({spaces.length})
      </button>
      {open && (
        <div className="flex flex-col gap-3 pt-1">
          {spaces.map(({ space, chats }) => (
            <SpaceCard
              key={space.id}
              projectId={projectId}
              space={space}
              chats={chats}
              isMobile={isMobile}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Main Page ───────────────────────────────────────────────────────────────

interface EnrichedSpace {
  space: SpaceInfo;
  chats: InstanceInfo[];
  lastActivity: number;
}

export function SpacesPage() {
  const { projectId: routeProjectId } = useParams({ strict: false }) as { projectId: string };
  const isMobile = useMediaQuery("(max-width: 768px)");
  const queryClient = useQueryClient();
  const { addMessageHandler } = useWSMethods();
  const { instances } = useWSState();
  const { artifacts } = useProjectContext();
  const [searchQuery, setSearchQuery] = useState("");
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

  // Merge live instances with persisted chat summaries
  const projectInstancesMap = new Map<string, InstanceInfo>();
  for (const chat of chatSummaries) {
    projectInstancesMap.set(chat.id, chat);
  }
  for (const inst of instances) {
    if (!instanceMatchesProject(inst, projectId)) continue;
    projectInstancesMap.set(inst.id, inst);
  }
  const projectInstances = Array.from(projectInstancesMap.values()).sort(
    (a, b) => getChatSortTimestamp(b) - getChatSortTimestamp(a),
  );

  // Group chats by space
  const chatsBySpace = new Map<string, InstanceInfo[]>();
  for (const instance of projectInstances) {
    const resolvedSpaceId = getResolvedSpaceId(instance, spaces);
    if (!resolvedSpaceId) continue;
    const chats = chatsBySpace.get(resolvedSpaceId) ?? [];
    chats.push(instance);
    chatsBySpace.set(resolvedSpaceId, chats);
  }
  for (const chats of chatsBySpace.values()) {
    chats.sort((a, b) => getChatSortTimestamp(b) - getChatSortTimestamp(a));
  }

  const enrichSpace = (space: SpaceInfo): EnrichedSpace => ({
    space,
    chats: chatsBySpace.get(space.id) ?? [],
    lastActivity: Math.max(
      space.lastActivityAt || 0,
      ...(chatsBySpace.get(space.id) ?? []).map((chat) => getChatSortTimestamp(chat)),
    ),
  });

  const matchesSearch = (q: string, space: SpaceInfo, chats: InstanceInfo[]) =>
    space.name.toLowerCase().includes(q) ||
    space.gitBranch?.toLowerCase().includes(q) ||
    chats.some((c) => c.name.toLowerCase().includes(q));

  const lq = searchQuery?.toLowerCase() || "";

  const filterBySearch = (list: EnrichedSpace[]) =>
    searchQuery ? list.filter(({ space, chats }) => matchesSearch(lq, space, chats)) : list;

  const activeSpaces = filterBySearch(
    spaces
      .filter((s) => !s.isDefault && s.status === "active")
      .map(enrichSpace)
      .sort((a, b) => b.lastActivity - a.lastActivity),
  );

  const brokenSpaces = filterBySearch(
    spaces
      .filter((s) => !s.isDefault && s.status === "broken")
      .map(enrichSpace)
      .sort((a, b) => b.lastActivity - a.lastActivity),
  );

  const closedSpaces = filterBySearch(
    spaces
      .filter((s) => !s.isDefault && (s.status === "completed" || s.status === "archived"))
      .map(enrichSpace)
      .sort((a, b) => b.lastActivity - a.lastActivity),
  );

  const allNonDefault = spaces.filter((s) => !s.isDefault);
  const totalFiltered = activeSpaces.length + brokenSpaces.length + closedSpaces.length;

  const searchToolbar =
    allNonDefault.length > 0 ? (
      <div className="relative">
        <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" />
        <Input
          type="text"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="Search spaces..."
          className="h-8 !rounded-md !bg-surface !py-1.5 pl-8 pr-3"
        />
      </div>
    ) : undefined;

  if (allNonDefault.length === 0) {
    return (
      <PageShell maxWidth="wide">
        <EmptyState
          icon={<GitBranch size={24} strokeWidth={1.5} />}
          title="No spaces yet"
          description="Spaces let you work on isolated branches and merge back when ready"
        />
      </PageShell>
    );
  }

  return (
    <PageShell maxWidth="wide" toolbar={searchToolbar}>
      {searchQuery && totalFiltered === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <p className="text-sm text-muted">No spaces match &quot;{searchQuery}&quot;</p>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {/* Active spaces — shown flat, no collapsible header */}
          {activeSpaces.map(({ space, chats }, index) => (
            <div
              key={space.id}
              className="opacity-0 animate-stagger-fade-in"
              style={{ animationDelay: `${Math.min(index, 8) * 30}ms` }}
            >
              <SpaceCard projectId={projectId} space={space} chats={chats} isMobile={isMobile} />
            </div>
          ))}

          {/* Broken spaces */}
          <SpaceSection
            label="Needs repair"
            spaces={brokenSpaces}
            projectId={projectId}
            isMobile={isMobile}
            defaultOpen={true}
            variant="warning"
          />

          {/* Closed spaces */}
          <SpaceSection
            label="Closed"
            spaces={closedSpaces}
            projectId={projectId}
            isMobile={isMobile}
            defaultOpen={!!searchQuery || activeSpaces.length === 0}
            variant="muted"
          />
        </div>
      )}
    </PageShell>
  );
}
