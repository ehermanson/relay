import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useQueries, useQuery } from "@tanstack/react-query";
import { BarChart3, CheckCircle2, FolderPlus, MessageSquare, Plus } from "lucide-react";
import { useWSState, useWSMethods } from "../context/websocket-context";
import { getInstanceProjectRouteId } from "../lib/project-route";
import { Tooltip } from "../components/ui/tooltip";
import { EmptyProjectActions } from "../components/empty-project-actions";
import { CreateSpaceDialog, useCreateSpaceDialog } from "../components/spaces/create-space-dialog";
import {
  formatTimeAgo,
  formatTokens,
  formatModel,
  getChatRecencyTimestamp,
  getDisplayTokenBreakdown,
} from "../lib/utils";
import { useMediaQuery } from "../hooks/use-media-query";
import { MobileHome } from "@/components/mobile-home";
import { ProviderLogo } from "@/components/ui/provider-logo";
import { useProjectNavigationModel } from "../hooks/use-project-navigation-model";
import { useActionToasts } from "@/context/action-toast-context";
import { fetchProjectIcons, fetchProjectArtifacts } from "../lib/api";
import type { InstanceInfo, ProjectArtifacts, ProviderKind } from "@shared/types";

// ─── Project Card ────────────────────────────────────────────────────────────

function StatsSkeleton() {
  return (
    <div className="flex items-center gap-3 border-t border-border/50 px-4 py-2.5">
      <span className="h-3.5 w-10 animate-pulse rounded bg-surface-hover" />
      <span className="h-3.5 w-14 animate-pulse rounded bg-surface-hover" />
      <span className="h-3.5 w-12 animate-pulse rounded bg-surface-hover" />
    </div>
  );
}

function ModelChipsSkeleton() {
  return (
    <div className="flex items-center gap-1.5 border-t border-border/50 px-4 py-2">
      <span className="h-5 w-20 animate-pulse rounded-md bg-surface-hover" />
      <span className="h-5 w-16 animate-pulse rounded-md bg-surface-hover" />
    </div>
  );
}

/** Full-card skeleton for the first-ever load, before the projects query resolves. */
function ProjectCardSkeleton() {
  return (
    <div className="flex flex-col rounded-xl border border-border bg-surface">
      <div className="flex items-start gap-3 px-4 pt-4 pb-3">
        <span className="h-9 w-9 shrink-0 animate-pulse rounded-lg bg-surface-hover" />
        <div className="flex min-w-0 flex-1 flex-col gap-1.5 pt-0.5">
          <span className="h-4 w-28 animate-pulse rounded bg-surface-hover" />
          <span className="h-3 w-36 animate-pulse rounded bg-surface-hover" />
        </div>
      </div>
      <StatsSkeleton />
    </div>
  );
}

function ProjectCard({
  directory,
  instances,
  projectId,
  iconPath,
  artifacts,
  artifactsLoading,
  chatsLoading,
  onNewSession,
  onCreateSpace,
}: {
  directory: string;
  instances: InstanceInfo[];
  projectId: string;
  iconPath?: string;
  artifacts?: ProjectArtifacts;
  artifactsLoading?: boolean;
  chatsLoading?: boolean;
  onNewSession: (dir: string) => void;
  onCreateSpace: (dir: string) => void;
}) {
  const dirName = directory.split("/").pop() || directory;
  const activeCount = instances.filter(
    (i) => i.status === "processing" || i.status === "idle",
  ).length;
  const lastActivity =
    instances.length > 0 ? Math.max(...instances.map((i) => getChatRecencyTimestamp(i))) : null;
  const [imgError, setImgError] = useState(false);
  const showIcon = iconPath && !imgError;

  // Token stats from artifacts
  const modelUsage = artifacts?.stats.modelUsage ?? [];
  const normalized = modelUsage.map(getDisplayTokenBreakdown);
  const totalTokens = normalized.reduce((s, r) => s + r.totalTokens, 0);
  const sessionCount = artifacts?.stats.sessionCount ?? instances.length;

  // Top models for display
  const topModels = [...modelUsage]
    .map((m) => ({ model: m, display: getDisplayTokenBreakdown(m) }))
    .sort((a, b) => b.display.totalTokens - a.display.totalTokens)
    .slice(0, 3);

  // Task stats
  const taskCount = artifacts?.tasks?.length ?? 0;
  const openTasks =
    artifacts?.tasks?.filter((t) => t.status === "open" || t.status === "in_progress").length ?? 0;

  return (
    <Link
      to="/projects/$projectId"
      params={{ projectId }}
      className="group flex flex-col rounded-xl border border-border bg-surface transition-all hover:border-border-bright hover:bg-surface-hover"
    >
      {/* Header */}
      <div className="flex items-start gap-3 px-4 pt-4 pb-3">
        {/* Icon */}
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border bg-bg text-[0.8125rem] font-semibold text-muted">
          {showIcon ? (
            <img
              src={`/api/file?path=${encodeURIComponent(iconPath)}`}
              alt=""
              className="h-9 w-9 rounded-lg object-contain"
              onError={() => setImgError(true)}
            />
          ) : (
            dirName.charAt(0).toUpperCase()
          )}
        </div>

        {/* Name + last active */}
        <div className="min-w-0 flex-1">
          <div className="truncate text-[0.875rem] font-semibold text-text-bright">{dirName}</div>
          <div className="text-[0.6875rem] text-muted">
            {lastActivity
              ? `last message: ${formatTimeAgo(lastActivity)}`
              : artifactsLoading || chatsLoading
                ? "\u00A0"
                : "No chats yet"}
          </div>
        </div>

        {/* New chat button */}
        <Tooltip content={`New chat in ${dirName}`}>
          <button
            type="button"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onNewSession(directory);
            }}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:bg-surface-hover hover:text-text"
          >
            <Plus size={14} />
          </button>
        </Tooltip>
      </div>

      {/* Getting started actions (no chats or history) — only after chats + artifacts have loaded */}
      {instances.length === 0 && sessionCount === 0 && !artifactsLoading && !chatsLoading && (
        <div
          className="border-t border-border/50 px-4 py-3"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
          }}
        >
          <EmptyProjectActions
            onNewChat={() => onNewSession(directory)}
            onNewSpace={() => onCreateSpace(directory)}
          />
        </div>
      )}

      {/* Stats row */}
      {artifactsLoading && instances.length > 0 ? (
        <StatsSkeleton />
      ) : instances.length > 0 || sessionCount > 0 ? (
        <div className="flex items-center gap-3 overflow-hidden border-t border-border/50 px-4 py-2.5 text-[0.6875rem]">
          {/* Chats */}
          <Tooltip content={`${sessionCount} session${sessionCount !== 1 ? "s" : ""}`}>
            <span className="flex shrink-0 items-center gap-1 text-muted">
              <MessageSquare size={11} />
              {sessionCount}
            </span>
          </Tooltip>

          {/* Active indicator */}
          {activeCount > 0 && (
            <span className="flex shrink-0 items-center gap-1 text-accent">
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-accent" />
              {activeCount} active
            </span>
          )}

          {/* Tokens */}
          {totalTokens > 0 && (
            <Tooltip content={`${formatTokens(totalTokens)} tokens`}>
              <span className="flex shrink-0 items-center gap-1 text-muted">
                <BarChart3 size={11} />
                {formatTokens(totalTokens)}
              </span>
            </Tooltip>
          )}

          {/* Tasks */}
          {taskCount > 0 && (
            <Tooltip
              content={`${taskCount} task${taskCount !== 1 ? "s" : ""}${openTasks > 0 ? `, ${openTasks} open` : ""}`}
            >
              <span className="flex shrink-0 items-center gap-1 text-muted">
                <CheckCircle2 size={11} />
                {openTasks > 0 ? `${openTasks} open` : `${taskCount}`}
              </span>
            </Tooltip>
          )}
        </div>
      ) : null}

      {/* Model chips */}
      {artifactsLoading && instances.length > 0 ? (
        <ModelChipsSkeleton />
      ) : topModels.length > 0 ? (
        <div className="flex items-center gap-1.5 overflow-hidden border-t border-border/50 px-4 py-2">
          {topModels.map(({ model: m }) => (
            <span
              key={`${m.providerName}-${m.model}`}
              className="flex shrink-0 items-center gap-1 rounded-md bg-surface-hover px-1.5 py-0.5 text-[0.625rem] text-muted"
            >
              <ProviderLogo
                provider={m.providerName as ProviderKind}
                className="h-2.5 w-2.5 shrink-0"
                muted
              />
              {formatModel(m.model)}
            </span>
          ))}
          {modelUsage.length > 3 && (
            <span className="text-[0.625rem] text-muted/50">+{modelUsage.length - 3}</span>
          )}
        </div>
      ) : null}
    </Link>
  );
}

// ─── Dashboard ──────────────────────────────────────────────────────────────

export function Dashboard() {
  const { instances, isSyncing } = useWSState();
  const { send } = useWSMethods();
  const { trackInstanceCreate } = useActionToasts();
  // Same merged model as the sidebar: REST chat summaries (react-query cached,
  // persisted across loads) merged with live WS instances, in the shared
  // user-defined project order on desktop. Mobile Home sorts the same data
  // live by recency, painting from cache without waiting on the WebSocket.
  const {
    groups: projectGroups,
    projectByDir,
    projects,
    projectsLoading,
    chatsLoadingByProjectId,
    projectSpaces,
    spacesLoadingByDir,
  } = useProjectNavigationModel();
  const isMobile = useMediaQuery("(max-width: 768px)");
  const navigate = useNavigate();
  const pendingCreate = useRef(false);
  const prevInstanceIds = useRef(new Set<string>());
  const spaceDialog = useCreateSpaceDialog();

  // Fetch project icons
  const { data: projectIcons = {} } = useQuery({
    queryKey: ["projectIcons"],
    queryFn: fetchProjectIcons,
  });

  // Navigate to newly created instance
  useEffect(() => {
    const currentIds = new Set(instances.map((i) => i.id));
    if (pendingCreate.current && prevInstanceIds.current.size > 0) {
      for (const inst of instances) {
        if (!prevInstanceIds.current.has(inst.id) && !inst.external) {
          pendingCreate.current = false;
          navigate({
            to: "/projects/$projectId/chats/$chatId",
            params: { projectId: getInstanceProjectRouteId(inst), chatId: inst.id },
          });
          break;
        }
      }
    }
    prevInstanceIds.current = currentIds;
  }, [instances, navigate]);

  const handleNewSession = (workingDirectory: string) => {
    pendingCreate.current = true;
    trackInstanceCreate(workingDirectory);
    send({ type: "create_instance", workingDirectory });
  };

  const handleCreateSpace = (dir: string) => {
    spaceDialog.open(dir);
  };

  // Fetch artifacts for each project (for stats)
  const projectEntries = useMemo(
    () =>
      projectGroups.map(([dir, groupInstances]) => ({
        dir,
        id:
          projectByDir.get(dir)?.id ??
          (groupInstances[0] ? getInstanceProjectRouteId(groupInstances[0]) : dir),
      })),
    [projectGroups, projectByDir],
  );

  const artifactResults = useQueries({
    queries: projectEntries.map(({ id }) => ({
      queryKey: ["projectArtifacts", id],
      queryFn: () => fetchProjectArtifacts(id),
      staleTime: 60_000,
      enabled: !isMobile,
    })),
  });

  const artifactsByDir = useMemo(() => {
    const map = new Map<string, ProjectArtifacts>();
    projectEntries.forEach(({ dir }, i) => {
      const data = artifactResults[i]?.data;
      if (data) map.set(dir, data);
    });
    return map;
  }, [projectEntries, artifactResults]);

  const artifactsLoadingByDir = useMemo(() => {
    const map = new Map<string, boolean>();
    projectEntries.forEach(({ dir }, i) => {
      map.set(dir, artifactResults[i]?.isLoading ?? false);
    });
    return map;
  }, [projectEntries, artifactResults]);

  // Aggregate stats
  const totalActive = instances.filter(
    (i) => i.status === "processing" || i.status === "idle",
  ).length;

  if (isMobile) {
    const groups = projectGroups.map(([dir, groupInstances]) => {
      const project = projectByDir.get(dir);
      return {
        dir,
        groupInstances,
        project,
        name: project?.name ?? dir.split("/").pop() ?? dir,
        projectId:
          project?.id ?? (groupInstances[0] ? getInstanceProjectRouteId(groupInstances[0]) : dir),
        iconPath: projectIcons[dir],
        spaces: projectSpaces[dir] ?? [],
      };
    });
    return (
      <MobileHome
        groups={groups}
        // Placeholders only: with nothing cached, "Loading…" is right until
        // both the summaries and the WS instance list have landed.
        loading={
          isSyncing ||
          projectsLoading ||
          Object.values(chatsLoadingByProjectId).some(Boolean) ||
          Object.values(spacesLoadingByDir).some(Boolean)
        }
        onNewChat={handleNewSession}
      />
    );
  }

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-5xl px-4 py-4 sm:px-6 sm:py-8">
          {/* Desktop header */}
          <div className="mb-6 hidden items-center justify-between gap-3 sm:flex">
            <div className="min-w-0 flex-1">
              <h1 className="text-[1.25rem] font-semibold tracking-tight text-text-bright">
                Projects
              </h1>
              {projectGroups.length > 0 && (
                <p className="mt-0.5 text-[0.75rem] text-muted">
                  {projectGroups.length} project{projectGroups.length !== 1 ? "s" : ""}
                  {totalActive > 0 && (
                    <span className="text-accent">
                      {" "}
                      · {totalActive} active session{totalActive !== 1 ? "s" : ""}
                    </span>
                  )}
                </p>
              )}
            </div>
          </div>

          {/* Project grid */}
          {projectGroups.length > 0 && (
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {projectGroups.map(([dir, groupInstances]) => {
                const project = projectByDir.get(dir);
                const pid =
                  project?.id ??
                  (groupInstances[0] ? getInstanceProjectRouteId(groupInstances[0]) : dir);
                return (
                  <ProjectCard
                    key={dir}
                    directory={dir}
                    instances={groupInstances}
                    projectId={pid}
                    iconPath={projectIcons[dir]}
                    artifacts={artifactsByDir.get(dir)}
                    artifactsLoading={artifactsLoadingByDir.get(dir)}
                    chatsLoading={project ? chatsLoadingByProjectId[project.id] : false}
                    onNewSession={handleNewSession}
                    onCreateSpace={handleCreateSpace}
                  />
                );
              })}
            </div>
          )}

          {/* First-ever load — no cached projects yet */}
          {projectGroups.length === 0 && projectsLoading && (
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              <ProjectCardSkeleton />
              <ProjectCardSkeleton />
              <ProjectCardSkeleton />
            </div>
          )}

          {/* Empty state */}
          {projectGroups.length === 0 && !projectsLoading && (
            <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border py-16 text-center">
              {projects.length === 0 ? (
                <>
                  <FolderPlus size={32} strokeWidth={1.5} className="mb-3 text-muted/40" />
                  <p className="mb-1 text-[0.8125rem] font-medium text-text">
                    Add a project to get started
                  </p>
                  <span className="text-[0.75rem] text-muted">
                    Use the Add Project button above to register a git repo
                  </span>
                </>
              ) : (
                <>
                  <MessageSquare size={32} strokeWidth={1.5} className="mb-3 text-muted/40" />
                  <p className="mb-1 text-[0.8125rem] font-medium text-text">No active chats</p>
                  <span className="text-[0.75rem] text-muted">
                    Select a project to start a new chat
                  </span>
                </>
              )}
            </div>
          )}
        </div>
      </div>

      <CreateSpaceDialog
        dir={spaceDialog.dir}
        projectName={
          spaceDialog.dir ? (projectByDir.get(spaceDialog.dir)?.name ?? spaceDialog.dir) : ""
        }
        projectId={spaceDialog.dir ? projectByDir.get(spaceDialog.dir)?.id : undefined}
        onOpenChange={(open) => !open && spaceDialog.close()}
      />
    </div>
  );
}
