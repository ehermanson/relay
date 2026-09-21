import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { ChevronRight, GitBranch, Plus } from "lucide-react";
import { ProviderLogo } from "@/components/ui/provider-logo";
import { ProjectAvatar } from "@/components/ui/project-avatar";
import { MobileSidebarToggle } from "@/components/ui/view-header";
import { NewChatMenu } from "@/components/layout/new-chat-menu";
import { AddProjectDialog } from "@/components/layout/sidebar-chrome";
import { buildInboxProjectOptions, type InboxSourceGroup } from "@/lib/inbox";
import { buildMobileHome, homeActivity, keepHomeOrder } from "@/lib/mobile-home";
import { getInboxSpaceRoute } from "@/lib/space-navigation";
import { getInstanceChatRoute } from "@/lib/project-route";
import { formatTimeAgo } from "@/lib/utils";
import { findProviderModelLabel } from "@shared/provider-catalog";

function Activity({ attention, running }: { attention: number; running: number }) {
  return (
    <>
      {attention > 0 && <span className="text-warning">{attention} needs input</span>}
      {running > 0 && <span className="text-accent">{running} running</span>}
    </>
  );
}

export function MobileHome({
  groups,
  loading,
  onNewChat,
}: {
  groups: InboxSourceGroup[];
  loading: boolean;
  onNewChat: (dir: string) => void;
}) {
  const model = buildMobileHome(groups);
  const [addProjectOpen, setAddProjectOpen] = useState(false);
  const [order, setOrder] = useState<{ projects: string[]; recent: string[] } | null>(null);
  // Capture after initial hydration. Status and timestamps stay live, positions
  // stay steady until Home is reopened. Newly discovered entries append.
  if (!loading && order === null) {
    setOrder({ projects: model.projects.map((p) => p.dir), recent: model.recent.map((e) => e.id) });
  }
  const projects = keepHomeOrder(model.projects, order?.projects ?? [], (p) => p.dir);
  const recent = keepHomeOrder(model.recent, order?.recent ?? [], (e) => e.id).slice(0, 4);
  const options = buildInboxProjectOptions(projects);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex shrink-0 items-center gap-2 border-b border-border/70 px-2 py-2">
        <MobileSidebarToggle />
        <h1 className="flex-1 text-[0.875rem] font-semibold text-text-bright">Home</h1>
        {options.length > 0 && (
          <NewChatMenu
            projectOptions={options}
            soleTarget={options.length === 1 ? options[0].dir : null}
            onCreate={onNewChat}
            icon={
              <>
                <Plus size={16} />
                New chat
              </>
            }
            tooltipSide="bottom"
            align="end"
            triggerClassName="flex min-h-10 items-center gap-1.5 rounded-lg px-3 text-[0.75rem] font-medium text-text hover:bg-surface-hover"
          />
        )}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5">
        <section aria-labelledby="home-continue" className="mb-7">
          <h2 id="home-continue" className="mb-3 text-[0.875rem] font-semibold text-text-bright">
            Continue
          </h2>
          {recent.length > 0 ? (
            <div className="divide-y divide-border/60 overflow-hidden rounded-xl border border-border bg-surface">
              {recent.map((entry) => {
                const route =
                  entry.kind === "space"
                    ? getInboxSpaceRoute(entry)
                    : getInstanceChatRoute(entry.instance);
                const destinationChatId =
                  "chatId" in route.params ? route.params.chatId : undefined;
                const chat =
                  entry.kind === "chat"
                    ? entry.instance
                    : entry.instances.find((instance) => instance.id === destinationChatId);
                const modelId =
                  chat?.providerStatus?.effectiveModel ??
                  chat?.stats?.model ??
                  chat?.preferredModel;
                const modelLabel =
                  modelId && chat
                    ? (findProviderModelLabel(chat.provider, modelId) ?? modelId)
                    : null;
                const activity = homeActivity(
                  entry.kind === "space" ? entry.instances : [entry.instance],
                );
                return (
                  <Link
                    key={entry.id}
                    to={route.to}
                    params={route.params}
                    className="flex min-h-16 items-center gap-3 px-3 py-3 hover:bg-surface-hover"
                  >
                    <ProjectAvatar iconPath={entry.iconPath} name={entry.projectName} size={28} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 text-[0.625rem] text-muted">
                        <span className="min-w-0 flex-1 truncate">{entry.projectName}</span>
                        {entry.recencyAt > 0 && (
                          <span className="shrink-0">{formatTimeAgo(entry.recencyAt)}</span>
                        )}
                      </div>
                      <div className="mt-0.5 flex items-center gap-1.5 text-[0.8125rem] font-medium text-text">
                        {entry.kind === "space" && (
                          <GitBranch size={13} className="shrink-0 text-muted" />
                        )}
                        <span className="truncate">
                          {entry.kind === "space" ? entry.space.name : entry.instance.name}
                        </span>
                      </div>
                      {(chat || activity.attention > 0 || activity.running > 0) && (
                        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[0.625rem] text-muted">
                          {chat && (
                            <span className="flex min-w-0 items-center gap-1">
                              <span
                                role="img"
                                aria-label={`${chat.provider} provider`}
                                className="shrink-0"
                              >
                                <ProviderLogo provider={chat.provider} className="h-3 w-3" />
                              </span>
                              {modelLabel && <span className="truncate">{modelLabel}</span>}
                            </span>
                          )}
                          <Activity {...activity} />
                        </div>
                      )}
                    </div>
                    <ChevronRight size={14} className="shrink-0 text-muted/60" />
                  </Link>
                );
              })}
            </div>
          ) : (
            <p className="text-[0.75rem] text-muted">
              {loading ? "Loading recent chats…" : "Start a chat to pick up your work here."}
            </p>
          )}
        </section>
        <section aria-labelledby="home-projects">
          <div className="mb-2 flex items-center justify-between">
            <h2 id="home-projects" className="text-[0.875rem] font-semibold text-text-bright">
              Projects
            </h2>
            <button
              type="button"
              onClick={() => setAddProjectOpen(true)}
              className="min-h-10 rounded-lg px-2 text-[0.6875rem] font-medium text-muted hover:bg-surface-hover"
            >
              Add project
            </button>
          </div>
          <div className="divide-y divide-border/60">
            {projects.map((project) => (
              <Link
                key={project.dir}
                to="/projects/$projectId"
                params={{ projectId: project.projectId }}
                className="flex min-h-16 items-center gap-3 rounded-lg px-1 py-3 hover:bg-surface-hover"
              >
                <ProjectAvatar iconPath={project.iconPath} name={project.name} size={32} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[0.8125rem] font-medium text-text">
                    {project.name}
                  </div>
                  <div className="mt-0.5 flex flex-wrap gap-x-2 text-[0.625rem] text-muted">
                    <span>
                      {project.recencyAt > 0 ? formatTimeAgo(project.recencyAt) : "No chats yet"}
                    </span>
                    <Activity {...project} />
                  </div>
                </div>
                <ChevronRight size={14} className="shrink-0 text-muted/60" />
              </Link>
            ))}
          </div>
          {projects.length === 0 && (
            <p className="py-3 text-[0.75rem] text-muted">
              {loading ? "Loading projects…" : "Add a project to get started."}
            </p>
          )}
        </section>
      </div>
      <AddProjectDialog
        open={addProjectOpen}
        onOpenChange={setAddProjectOpen}
        registeredDirs={new Set(groups.filter((g) => g.project).map((g) => g.dir))}
      />
    </div>
  );
}
