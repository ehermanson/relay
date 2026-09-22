import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { AnimatePresence, MotionConfig, motion } from "motion/react";
import { ChevronRight, GitBranch, Plus } from "lucide-react";
import { ProviderLogo } from "@/components/ui/provider-logo";
import { ProjectAvatar } from "@/components/ui/project-avatar";
import { MobileSidebarToggle } from "@/components/ui/view-header";
import { NewChatMenu } from "@/components/layout/new-chat-menu";
import { AddProjectDialog } from "@/components/layout/sidebar-chrome";
import { buildInboxProjectOptions, getAttentionLabel, type InboxSourceGroup } from "@/lib/inbox";
import {
  buildMobileHome,
  homeEntryChat,
  homeEntryInstances,
  type HomeEntry,
} from "@/lib/mobile-home";
import { getInboxSpaceRoute } from "@/lib/space-navigation";
import { getInstanceChatRoute } from "@/lib/project-route";
import { formatTimeAgo } from "@/lib/utils";
import { findProviderModelLabel } from "@shared/provider-catalog";

const ROW_TRANSITION = { type: "spring", stiffness: 500, damping: 40 } as const;

/** Why a row is in Needs input: the single reason, or a count when several chats wait. */
function attentionReason(entry: HomeEntry): string | null {
  const waiting = homeEntryInstances(entry).filter(
    (chat) =>
      chat.status !== "stopped" &&
      (chat.status === "error" || chat.pendingPermission || chat.pendingPlan || chat.pendingTool),
  );
  if (waiting.length === 0) return null;
  if (waiting.length === 1) return getAttentionLabel(waiting[0]);
  return `${waiting.length} chats need input`;
}

function HomeRow({ entry }: { entry: HomeEntry }) {
  const route =
    entry.kind === "space" ? getInboxSpaceRoute(entry) : getInstanceChatRoute(entry.instance);
  const destinationChatId = "chatId" in route.params ? route.params.chatId : undefined;
  const chat = homeEntryChat(entry, destinationChatId);
  const modelId =
    chat?.providerStatus?.effectiveModel ?? chat?.stats?.model ?? chat?.preferredModel;
  const modelLabel =
    modelId && chat ? (findProviderModelLabel(chat.provider, modelId) ?? modelId) : null;
  const reason = attentionReason(entry);
  const preview = chat?.lastMessage?.text.trim();
  return (
    <motion.div
      layout
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={ROW_TRANSITION}
      className="bg-surface"
    >
      <Link
        to={route.to}
        params={route.params}
        className="flex min-h-16 items-center gap-3 px-3 py-3 hover:bg-surface-hover"
      >
        <ProjectAvatar iconPath={entry.iconPath} name={entry.projectName} size={28} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 text-[0.625rem] text-muted">
            <span className="min-w-0 truncate">{entry.projectName}</span>
            {chat && (
              <span className="flex min-w-0 items-center gap-1">
                <span className="shrink-0 text-muted/40">·</span>
                <span role="img" aria-label={`${chat.provider} provider`} className="shrink-0">
                  <ProviderLogo provider={chat.provider} className="h-3 w-3" />
                </span>
                {modelLabel && <span className="truncate">{modelLabel}</span>}
              </span>
            )}
            {entry.recencyAt > 0 && (
              <span className="ml-auto shrink-0">{formatTimeAgo(entry.recencyAt)}</span>
            )}
          </div>
          <div className="mt-0.5 flex items-center gap-1.5 text-[0.8125rem] font-medium text-text">
            {entry.kind === "space" && <GitBranch size={13} className="shrink-0 text-muted" />}
            <span className="truncate">
              {entry.kind === "space" ? entry.space.name : entry.instance.name}
            </span>
          </div>
          {/* One line: what needs a decision, or what the agent is doing, then
              the last message so the row is decidable without opening it. */}
          {(reason || entry.running > 0 || preview) && (
            <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[0.6875rem] text-muted">
              {reason ? (
                <span className="shrink-0 font-medium text-warning">{reason}</span>
              ) : (
                entry.running > 0 && (
                  <span className="shrink-0 text-accent">
                    {entry.kind === "space" ? `${entry.running} running` : "Running"}
                  </span>
                )
              )}
              {preview && (
                <span className="min-w-0 truncate">
                  {chat?.lastMessage?.from === "user" && (
                    <span className="text-muted/70">You: </span>
                  )}
                  {preview}
                </span>
              )}
            </div>
          )}
        </div>
        <ChevronRight size={14} className="shrink-0 text-muted/60" />
      </Link>
    </motion.div>
  );
}

function HomeRows({ entries }: { entries: HomeEntry[] }) {
  return (
    <div className="divide-y divide-border/60 overflow-hidden rounded-xl border border-border bg-surface">
      <AnimatePresence initial={false} mode="popLayout">
        {entries.map((entry) => (
          <HomeRow key={entry.id} entry={entry} />
        ))}
      </AnimatePresence>
    </div>
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
  const { projects, needsInput, recent } = buildMobileHome(groups);
  const [addProjectOpen, setAddProjectOpen] = useState(false);
  // Relative timestamps read Date.now(); re-render each minute so an open Home
  // doesn't say "2m ago" indefinitely.
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((tick) => tick + 1), 60_000);
    return () => clearInterval(id);
  }, []);
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
      <MotionConfig reducedMotion="user">
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5">
          {needsInput.length > 0 && (
            <section aria-labelledby="home-needs-input" className="mb-7">
              <h2
                id="home-needs-input"
                className="mb-3 flex items-center gap-2 text-[0.875rem] font-semibold text-text-bright"
              >
                Needs input
                <span className="rounded-full bg-warning/15 px-1.5 text-[0.625rem] font-semibold text-warning">
                  {needsInput.length}
                </span>
              </h2>
              <HomeRows entries={needsInput} />
            </section>
          )}
          <section aria-labelledby="home-continue" className="mb-7">
            <h2 id="home-continue" className="mb-3 text-[0.875rem] font-semibold text-text-bright">
              Continue
            </h2>
            {recent.length > 0 ? (
              <HomeRows entries={recent} />
            ) : (
              <p className="text-[0.75rem] text-muted">
                {loading
                  ? "Loading recent chats…"
                  : needsInput.length > 0
                    ? "Everything else is waiting on you above."
                    : "Start a chat to pick up your work here."}
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
            {/* Projects are reachable from the sidebar too, so Home keeps them
                to a scrollable strip of avatars rather than a second list. */}
            {projects.length > 0 ? (
              <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 [scrollbar-width:none]">
                {projects.map((project) => {
                  const status =
                    project.attention > 0
                      ? { className: "bg-warning", label: `${project.attention} needs input` }
                      : project.running > 0
                        ? { className: "bg-accent", label: `${project.running} running` }
                        : null;
                  return (
                    <Link
                      key={project.dir}
                      to="/projects/$projectId"
                      params={{ projectId: project.projectId }}
                      aria-label={status ? `${project.name}: ${status.label}` : project.name}
                      className="flex w-[4.5rem] shrink-0 flex-col items-center gap-1.5 rounded-lg py-2 hover:bg-surface-hover"
                    >
                      <span className="relative">
                        <ProjectAvatar
                          iconPath={project.iconPath}
                          name={project.name}
                          size={44}
                          className="rounded-lg"
                        />
                        {status && (
                          <span
                            aria-hidden
                            className={`absolute -right-1 -top-1 h-3 w-3 rounded-full ring-2 ring-bg ${status.className}`}
                          />
                        )}
                      </span>
                      <span className="w-full truncate text-center text-[0.625rem] text-muted">
                        {project.name}
                      </span>
                    </Link>
                  );
                })}
              </div>
            ) : (
              <p className="py-3 text-[0.75rem] text-muted">
                {loading ? "Loading projects…" : "Add a project to get started."}
              </p>
            )}
          </section>
        </div>
      </MotionConfig>
      <AddProjectDialog
        open={addProjectOpen}
        onOpenChange={setAddProjectOpen}
        registeredDirs={new Set(groups.filter((g) => g.project).map((g) => g.dir))}
      />
    </div>
  );
}
