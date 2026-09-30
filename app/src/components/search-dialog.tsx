import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useQueries, useQuery } from "@tanstack/react-query";
import { Check, ChevronDown, FolderOpen, GitBranch, Globe, MessageSquare } from "lucide-react";
import { fetchAllSpaces, searchChats, type SearchResultItem } from "@/lib/api";
import { useActiveAccount } from "@/hooks/use-active-account";
import { useProjectsQuery } from "@/hooks/use-projects-query";
import { projectBelongsToAccount } from "@/lib/account-scope";
import { formatTimeAgo } from "@/lib/utils";
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
  CommandGroup,
} from "@/components/ui/command";
import { Dialog } from "@/components/ui/dialog";
import { Menu } from "@/components/ui/menu";

export function useSearchDialog() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // Only handle Cmd+K (macOS) — skip Ctrl+K which is a text-editing shortcut
      if (e.key === "k" && e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        setOpen((prev) => !prev);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return { open, setOpen };
}

interface SearchDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function SearchDialog({ open, onOpenChange }: SearchDialogProps) {
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  // Search is global by default; the filter narrows to one project for this open only
  const [filterProjectId, setFilterProjectId] = useState<string | null>(null);
  const { projectId: routeProjectId } = useParams({ strict: false }) as { projectId?: string };
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement>(null);

  // Reset state when dialog opens — always back to global scope
  useEffect(() => {
    if (open) {
      setQuery("");
      setDebouncedQuery("");
      setFilterProjectId(null);
    }
  }, [open]);

  // Search is scoped to the active account like every other view: with two or
  // more accounts only that account's projects and chats surface. Direct chat
  // URLs still open — only search results are filtered, never navigation.
  const account = useActiveAccount();
  const { data: allProjects = [] } = useProjectsQuery();
  const projects = useMemo(
    () =>
      account.isMulti
        ? allProjects.filter((p) => projectBelongsToAccount(p, account.activeId, true))
        : allProjects,
    [allProjects, account.isMulti, account.activeId],
  );
  const projectNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const p of projects) map.set(p.id, p.name);
    return map;
  }, [projects]);

  // Current route's project first in the filter menu — it's the likeliest filter target
  const orderedProjects = useMemo(() => {
    if (!routeProjectId) return projects;
    const current = projects.filter((p) => p.id === routeProjectId);
    return [...current, ...projects.filter((p) => p.id !== routeProjectId)];
  }, [projects, routeProjectId]);

  // Debounce the search query to avoid flickering results on fast typing.
  // Queries under 2 chars fall back to the empty query (recent chats).
  useEffect(() => {
    if (query.trim().length < 2) {
      setDebouncedQuery("");
      return;
    }
    const id = setTimeout(() => setDebouncedQuery(query), 250);
    return () => clearTimeout(id);
  }, [query]);

  // The account scope is applied by the server, inside the query and before
  // its limit — filtering the top-20 here let 20 recent chats of one account
  // hide every chat of another. Sent only with two or more accounts (the
  // default account included, so its view stays scoped too); the
  // single-account wire is unchanged.
  const searchAccountId = account.isMulti ? account.activeId : undefined;

  const { data: rawResults = [], isFetching } = useQuery({
    queryKey: [
      "search",
      debouncedQuery,
      filterProjectId,
      routeProjectId ?? null,
      searchAccountId ?? null,
    ],
    // Empty query returns recent chats. When unfiltered, boost the current
    // route's project so local results rank first without hiding the rest.
    queryFn: () =>
      searchChats(debouncedQuery, {
        projectId: filterProjectId ?? undefined,
        boostProjectId: filterProjectId ? undefined : routeProjectId,
        limit: 20,
        accountId: searchAccountId,
      }),
    enabled: open,
    staleTime: 30_000,
    placeholderData: (prev) => prev,
  });

  // Chats without a registered project can't be navigated to — hide them,
  // along with chats of projects outside the active account's membership.
  const results = useMemo(() => {
    const visibleProjectIds = new Set(projects.map((p) => p.id));
    return rawResults.filter((r) => r.projectId && visibleProjectIds.has(r.projectId));
  }, [rawResults, projects]);

  const showingRecents = debouncedQuery.trim().length === 0;
  const showingPartial = !showingRecents && results.some((r) => r.partial);

  // Spaces per project — shares the sidebar's ["spaces", projectId] cache,
  // fetched only while the dialog is open
  const spaceQueries = useQueries({
    queries: projects.map((p) => ({
      queryKey: ["spaces", p.id],
      queryFn: () => fetchAllSpaces(p.id),
      enabled: open,
      staleTime: 60_000,
    })),
  });

  // Projects and spaces match client-side on the live query (no debounce needed)
  const localQuery = query.trim().toLowerCase();
  const projectMatches =
    localQuery.length < 2
      ? []
      : projects
          .filter((p) => !filterProjectId || p.id === filterProjectId)
          .filter((p) => p.name.toLowerCase().includes(localQuery))
          .slice(0, 3);
  const spaceMatches =
    localQuery.length < 2
      ? []
      : projects
          .flatMap((p, i) =>
            (filterProjectId && p.id !== filterProjectId ? [] : (spaceQueries[i]?.data ?? []))
              .filter((s) => !s.isDefault && s.status === "active")
              .filter(
                (s) =>
                  s.name.toLowerCase().includes(localQuery) ||
                  s.gitBranch?.toLowerCase().includes(localQuery),
              )
              .map((s) => ({ space: s, project: p })),
          )
          .slice(0, 3);
  const hasLocalMatches = projectMatches.length > 0 || spaceMatches.length > 0;

  const handleSelect = useCallback(
    (result: SearchResultItem) => {
      if (!result.projectId) return; // Cannot navigate without a project
      onOpenChange(false);

      const search = {
        q: query.trim() ? query : undefined,
        match: result.snippet ?? undefined,
      };
      if (result.spaceId) {
        navigate({
          to: "/projects/$projectId/spaces/$spaceId/$chatId",
          params: {
            projectId: result.projectId,
            spaceId: result.spaceId,
            chatId: result.instanceId,
          },
          search,
        });
      } else {
        navigate({
          to: "/projects/$projectId/chats/$chatId",
          params: {
            projectId: result.projectId,
            chatId: result.instanceId,
          },
          search,
        });
      }
    },
    [navigate, onOpenChange, query],
  );

  const selectFilter = useCallback((projectId: string | null) => {
    setFilterProjectId(projectId);
    inputRef.current?.focus();
  }, []);

  const getResultRecencyAt = useCallback(
    (result: SearchResultItem) => result.lastMessageAt ?? result.lastActivityAt,
    [],
  );

  const filterProjectName = filterProjectId
    ? (projectNameById.get(filterProjectId) ?? "Unknown")
    : null;

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Content maxWidth="max-w-xl" className="!p-0 !gap-0">
        <Command shouldFilter={false}>
          <div className="flex items-center">
            <CommandInput
              ref={inputRef}
              placeholder={
                filterProjectName ? `Search in ${filterProjectName}…` : "Search all projects…"
              }
              value={query}
              onValueChange={setQuery}
              className="!h-10 flex-1"
            />
            {projects.length > 0 && (
              <Menu.Root>
                <Menu.Trigger
                  className="mr-3 ml-auto flex shrink-0 items-center gap-1 rounded-md border border-border/70 px-2 py-1 text-[0.6875rem] text-muted transition-colors hover:bg-surface-hover hover:text-text"
                  title="Filter by project"
                >
                  {filterProjectName ? (
                    <>
                      <FolderOpen size={12} />
                      <span className="max-w-28 truncate">{filterProjectName}</span>
                    </>
                  ) : (
                    <>
                      <Globe size={12} />
                      All projects
                    </>
                  )}
                  <ChevronDown size={10} />
                </Menu.Trigger>
                <Menu.Content align="end">
                  <Menu.Item onClick={() => selectFilter(null)}>
                    <Globe size={13} className="text-muted" />
                    <span className="flex-1">All projects</span>
                    {filterProjectId === null && <Check size={13} className="text-accent" />}
                  </Menu.Item>
                  <Menu.Separator />
                  {orderedProjects.map((p) => (
                    <Menu.Item key={p.id} onClick={() => selectFilter(p.id)}>
                      <FolderOpen size={13} className="text-muted" />
                      <span className="max-w-48 flex-1 truncate">{p.name}</span>
                      {p.id === routeProjectId && (
                        <span className="text-[0.625rem] text-muted/70">current</span>
                      )}
                      {filterProjectId === p.id && <Check size={13} className="text-accent" />}
                    </Menu.Item>
                  ))}
                </Menu.Content>
              </Menu.Root>
            )}
          </div>
          <CommandList className="max-h-80 border-t border-border/70">
            {projectMatches.length > 0 && (
              <CommandGroup heading="Projects">
                {projectMatches.map((p) => (
                  <CommandItem
                    key={`project-${p.id}`}
                    value={`project-${p.id}`}
                    onSelect={() => {
                      onOpenChange(false);
                      navigate({ to: "/projects/$projectId", params: { projectId: p.id } });
                    }}
                    className="!py-2 !px-3"
                  >
                    <div className="flex items-center gap-2">
                      <FolderOpen size={13} className="shrink-0 text-muted" />
                      <span className="truncate text-[0.8125rem] font-medium text-text-bright">
                        {p.name}
                      </span>
                    </div>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
            {spaceMatches.length > 0 && (
              <CommandGroup heading="Spaces">
                {spaceMatches.map(({ space, project }) => (
                  <CommandItem
                    key={`space-${space.id}`}
                    value={`space-${space.id}`}
                    onSelect={() => {
                      onOpenChange(false);
                      navigate({
                        to: "/projects/$projectId/spaces/$spaceId",
                        params: { projectId: project.id, spaceId: space.id },
                      });
                    }}
                    className="!py-2 !px-3"
                  >
                    <div className="flex min-w-0 flex-1 items-center gap-2">
                      <GitBranch size={13} className="shrink-0 text-muted" />
                      <span className="truncate text-[0.8125rem] font-medium text-text-bright">
                        {space.name}
                      </span>
                      <span className="flex shrink-0 items-center gap-0.5 text-[0.625rem] text-muted/70">
                        <FolderOpen size={10} />
                        {project.name}
                      </span>
                      {space.gitBranch && (
                        <span className="truncate text-[0.625rem] text-muted/70">
                          {space.gitBranch}
                        </span>
                      )}
                    </div>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
            {results.length === 0 && !isFetching ? (
              !hasLocalMatches && (
                <CommandEmpty>
                  {showingRecents ? "No chats yet." : "No results found."}
                </CommandEmpty>
              )
            ) : (
              <CommandGroup
                heading={
                  showingRecents
                    ? "Recent chats"
                    : showingPartial
                      ? "Partial matches"
                      : hasLocalMatches
                        ? "Chats"
                        : undefined
                }
              >
                {results.map((result) => (
                  <CommandItem
                    key={`${result.source}-${result.instanceId}`}
                    value={`${result.source}-${result.instanceId}`}
                    onSelect={() => handleSelect(result)}
                    className="!py-2.5 !px-3"
                  >
                    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                      {/* Title row */}
                      <div className="flex items-center gap-2">
                        <MessageSquare size={13} className="shrink-0 text-muted" />
                        <span className="truncate text-[0.8125rem] font-medium text-text-bright">
                          {result.title}
                        </span>
                      </div>

                      {/* Snippet — skip for title-only matches (redundant with heading) */}
                      {result.snippet && result.matchField !== "title" && (
                        <p
                          className="truncate pl-[21px] text-xs text-muted [&_mark]:bg-accent/25 [&_mark]:text-text-bright [&_mark]:rounded-sm [&_mark]:px-0.5"
                          dangerouslySetInnerHTML={{ __html: result.snippet }}
                        />
                      )}

                      {/* Meta chips */}
                      <div className="flex items-center gap-2 pl-[21px] pt-0.5">
                        {result.matchField && result.matchField !== "title" && (
                          <span className="text-[0.625rem] uppercase tracking-wider text-muted/70">
                            {result.matchField}
                          </span>
                        )}
                        {result.projectId && (
                          <span className="flex items-center gap-0.5 text-[0.625rem] text-muted/70">
                            <FolderOpen size={10} />
                            {projectNameById.get(result.projectId) ?? "Unknown"}
                          </span>
                        )}
                        {Date.now() - getResultRecencyAt(result) < 86_400_000 && (
                          <span className="rounded bg-accent/15 px-1 py-px text-[0.5625rem] font-medium uppercase tracking-wider text-accent">
                            Recent
                          </span>
                        )}
                        {result.gitBranch && (
                          <span className="flex items-center gap-0.5 text-[0.625rem] text-muted/70">
                            <GitBranch size={10} />
                            {result.gitBranch}
                          </span>
                        )}
                        <span className="text-[0.625rem] text-muted/70">
                          {formatTimeAgo(getResultRecencyAt(result))}
                        </span>
                      </div>
                    </div>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
          </CommandList>

          {/* Footer */}
          <div className="flex items-center justify-between border-t border-border/70 px-3 py-1.5 text-[0.625rem] text-muted">
            <div className="flex items-center gap-3 max-[768px]:hidden">
              <span>
                <kbd className="rounded border border-border/70 px-1 py-0.5 font-mono text-[0.5625rem]">
                  ↑↓
                </kbd>{" "}
                navigate
              </span>
              <span>
                <kbd className="rounded border border-border/70 px-1 py-0.5 font-mono text-[0.5625rem]">
                  ↵
                </kbd>{" "}
                open
              </span>
              <span>
                <kbd className="rounded border border-border/70 px-1 py-0.5 font-mono text-[0.5625rem]">
                  esc
                </kbd>{" "}
                close
              </span>
            </div>
            {isFetching && <span className="text-muted/60">searching…</span>}
          </div>
        </Command>
      </Dialog.Content>
    </Dialog.Root>
  );
}
