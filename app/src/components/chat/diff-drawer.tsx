import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { PatchDiff } from "@pierre/diffs/react";
import { ChevronRight, WrapText, X } from "lucide-react";
import type { FileChange } from "@shared/types";
import { useTheme } from "@/stores/theme-store";
import { fetchInstanceDiff } from "../../lib/api";
import { useRepoStatus } from "@/hooks/use-repo-status";
import { Button } from "../ui/button";
import { FileIcon } from "../ui/file-icon";
import { MiddleTruncate } from "../ui/middle-truncate";
import { Spinner } from "../ui/spinner";
import { Tooltip } from "../ui/tooltip";

const GENERATED_PATTERNS = [
  /package-lock\.json$/,
  /yarn\.lock$/,
  /pnpm-lock\.yaml$/,
  /\.lock$/,
  /\.relay\/space-context\.md$/,
];

function isGenerated(path: string): boolean {
  return GENERATED_PATTERNS.some((re) => re.test(path));
}

interface FilePatch {
  path: string;
  patch: string;
  additions: number;
  deletions: number;
}

function splitPatch(patch: string): FilePatch[] {
  const files: FilePatch[] = [];
  const parts = patch.split(/^(?=diff --git )/m);
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const headerMatch = trimmed.match(/^diff --git a\/(.+?) b\//);
    const path = headerMatch?.[1] ?? "unknown";
    let additions = 0;
    let deletions = 0;
    for (const line of trimmed.split("\n")) {
      if (line.startsWith("+") && !line.startsWith("+++")) additions++;
      else if (line.startsWith("-") && !line.startsWith("---")) deletions++;
    }
    files.push({ path, patch: trimmed, additions, deletions });
  }
  return files;
}

function basename(filePath: string): string {
  return filePath.split("/").pop() ?? filePath;
}

function dirname(filePath: string): string {
  const parts = filePath.split("/");
  parts.pop();
  return parts.join("/");
}

interface DiffDrawerProps {
  instanceId?: string;
  rawDiff?: string;
  /** Load error for a caller-supplied diff (`rawDiff` mode). */
  rawError?: string | null;
  /** Retry handler shown with any load error. */
  onRetry?: () => void;
  knownFiles?: FileChange[];
  workingDirectory?: string;
  onClose: () => void;
  scrollToFile?: string;
}

export function DiffDrawer({
  instanceId,
  rawDiff,
  rawError,
  onRetry,
  knownFiles,
  workingDirectory,
  onClose,
  scrollToFile,
}: DiffDrawerProps) {
  const { theme } = useTheme();
  const usesQuery = rawDiff == null && rawError == null && !!instanceId;
  const {
    data: queriedDiff = null,
    isLoading: loading,
    error: queryError,
    refetch,
  } = useQuery({
    queryKey: ["instanceDiff", instanceId],
    queryFn: () => fetchInstanceDiff(instanceId!),
    enabled: usesQuery,
  });
  // Refetch while open only when the worktree actually changed (repo_status
  // fingerprint); no interval polling.
  useRepoStatus(usesQuery ? { kind: "instance", instanceId: instanceId! } : null, {
    invalidate: [["instanceDiff", instanceId]],
  });
  const diff = rawDiff ?? queriedDiff;
  const error = rawError ?? (queryError ? (queryError as Error).message : null);
  const retry = onRetry ?? (usesQuery ? () => void refetch() : undefined);
  const [diffStyle, setDiffStyle] = useState<"unified" | "split">("unified");
  const [wordWrap, setWordWrap] = useState(false);
  const [diffScope, setDiffScope] = useState<"chat" | "all">("chat");
  const [collapsedPaths, setCollapsedPaths] = useState<Set<string>>(new Set());
  const [otherExpanded, setOtherExpanded] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);

  const allFileDiffs = useMemo(() => (diff ? splitPatch(diff) : []), [diff]);

  const knownRelPaths = useMemo(() => {
    if (!knownFiles || !workingDirectory) return null;
    const set = new Set<string>();
    for (const file of knownFiles) {
      const rel = file.path.startsWith(workingDirectory)
        ? file.path.slice(workingDirectory.length).replace(/^\//, "")
        : file.path;
      set.add(rel);
    }
    return set;
  }, [knownFiles, workingDirectory]);

  const { tracked, other } = useMemo(() => {
    const trackedFiles: FilePatch[] = [];
    const otherFiles: FilePatch[] = [];
    for (const file of allFileDiffs) {
      if (knownRelPaths && knownRelPaths.has(file.path)) {
        trackedFiles.push(file);
      } else {
        otherFiles.push(file);
      }
    }
    if (!knownRelPaths) {
      const mainFiles: FilePatch[] = [];
      const generatedFiles: FilePatch[] = [];
      for (const file of allFileDiffs) {
        if (isGenerated(file.path)) generatedFiles.push(file);
        else mainFiles.push(file);
      }
      return { tracked: mainFiles, other: generatedFiles };
    }
    return { tracked: trackedFiles, other: otherFiles };
  }, [allFileDiffs, knownRelPaths]);

  // When scoped to "all", show tracked + other; when "chat", tracked only.
  // If knownFiles isn't available (e.g. space diff), "chat" scope has no meaning — show all.
  const hasScope = !!knownRelPaths;
  const visibleFiles = diffScope === "all" || !hasScope ? [...tracked, ...other] : tracked;
  const showOtherSection = diffScope === "all" && other.length > 0 && hasScope;

  useEffect(() => {
    if (allFileDiffs.length === 0) return;
    const autoCollapsed = new Set<string>();
    for (const file of other) {
      if (isGenerated(file.path)) autoCollapsed.add(file.path);
    }
    setCollapsedPaths(autoCollapsed);
  }, [allFileDiffs, other]);

  const toggleCollapsed = useCallback((path: string) => {
    setCollapsedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  useEffect(() => {
    if (!scrollToFile || allFileDiffs.length === 0 || !contentRef.current) return;
    setCollapsedPaths((prev) => {
      if (!prev.has(scrollToFile)) return prev;
      const next = new Set(prev);
      next.delete(scrollToFile);
      return next;
    });
    if (other.some((file) => file.path === scrollToFile)) {
      setOtherExpanded(true);
    }
    const timer = setTimeout(() => {
      const element = contentRef.current?.querySelector(
        `[data-file-path="${CSS.escape(scrollToFile)}"]`,
      );
      element?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 150);
    return () => clearTimeout(timer);
  }, [scrollToFile, allFileDiffs, other]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  const diffOptions = useMemo(
    () => ({
      diffStyle: diffStyle as "unified" | "split",
      overflow: wordWrap ? ("wrap" as const) : ("scroll" as const),
      theme: theme === "dark" ? ("github-dark" as const) : ("github-light" as const),
      themeType: theme as "dark" | "light",
      disableFileHeader: true,
    }),
    [diffStyle, wordWrap, theme],
  );

  const scrollToPath = useCallback(
    (path: string) => {
      if (other.some((file) => file.path === path)) setOtherExpanded(true);
      setCollapsedPaths((prev) => {
        if (!prev.has(path)) return prev;
        const next = new Set(prev);
        next.delete(path);
        return next;
      });
      requestAnimationFrame(() => {
        const element = contentRef.current?.querySelector(`[data-file-path="${CSS.escape(path)}"]`);
        element?.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    },
    [other],
  );

  const renderFileSection = (file: FilePatch) => {
    const isCollapsed = collapsedPaths.has(file.path);
    return (
      <div key={file.path} data-file-path={file.path}>
        <StickyFileHeader
          file={file}
          isCollapsed={isCollapsed}
          onToggle={() => toggleCollapsed(file.path)}
        />
        {!isCollapsed && <PatchDiff patch={file.patch} options={diffOptions} />}
      </div>
    );
  };

  return (
    <div className="fixed inset-0 z-50 flex" onClick={onClose}>
      <div className="animate-fade-in absolute inset-0 bg-black/60 backdrop-blur-sm" />

      <div
        className="diff-drawer animate-slide-in-right relative ml-auto flex h-full w-full max-w-full md:max-w-[90vw] flex-col overflow-hidden border-l border-border bg-surface pt-[var(--app-top-inset)] shadow-2xl lg:max-w-[80vw]"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex shrink-0 items-center gap-2 border-b border-border/60 px-4 py-3">
          <div className="flex shrink-0 items-center gap-3">
            <h2 className="text-[0.9375rem] font-semibold text-text-bright">Changes</h2>
            {visibleFiles.length > 0 && (
              <span className="text-[0.75rem] text-muted">
                {visibleFiles.length} file{visibleFiles.length !== 1 ? "s" : ""}
              </span>
            )}
          </div>
          <div className="ml-auto flex min-w-0 items-center gap-2 overflow-x-auto">
            {hasScope && (
              <div className="flex shrink-0 overflow-hidden rounded-md border border-border/60 text-[0.75rem]">
                <button
                  type="button"
                  onClick={() => setDiffScope("chat")}
                  className={`px-2.5 py-1 font-medium transition-colors ${
                    diffScope === "chat"
                      ? "bg-surface-hover text-text-bright"
                      : "text-muted hover:text-text"
                  }`}
                >
                  This chat
                </button>
                <button
                  type="button"
                  onClick={() => setDiffScope("all")}
                  className={`border-l border-border/60 px-2.5 py-1 font-medium transition-colors ${
                    diffScope === "all"
                      ? "bg-surface-hover text-text-bright"
                      : "text-muted hover:text-text"
                  }`}
                >
                  All changes
                </button>
              </div>
            )}

            <div className="flex shrink-0 overflow-hidden rounded-md border border-border/60 text-[0.75rem]">
              <button
                type="button"
                onClick={() => setDiffStyle("unified")}
                className={`px-2.5 py-1 font-medium transition-colors ${
                  diffStyle === "unified"
                    ? "bg-surface-hover text-text-bright"
                    : "text-muted hover:text-text"
                }`}
              >
                Unified
              </button>
              <button
                type="button"
                onClick={() => setDiffStyle("split")}
                className={`border-l border-border/60 px-2.5 py-1 font-medium transition-colors ${
                  diffStyle === "split"
                    ? "bg-surface-hover text-text-bright"
                    : "text-muted hover:text-text"
                }`}
              >
                Split
              </button>
            </div>

            <Tooltip content="Word wrap">
              <button
                type="button"
                onClick={() => setWordWrap((prev) => !prev)}
                className={`shrink-0 rounded-md border border-border/60 p-1.5 transition-colors ${
                  wordWrap ? "bg-surface-hover text-text-bright" : "text-muted hover:text-text"
                }`}
              >
                <WrapText size={14} />
              </button>
            </Tooltip>
          </div>

          <Button className="shrink-0" variant="icon" size="icon-sm" onClick={onClose}>
            <X size={16} />
          </Button>
        </div>

        <div className="flex min-h-0 flex-1">
          {visibleFiles.length > 1 && (
            <div className="hidden md:block w-56 shrink-0 overflow-y-auto border-r border-border/40 bg-panel-header/30 py-1">
              {(showOtherSection ? tracked : visibleFiles).map((file) => (
                <button
                  key={file.path}
                  type="button"
                  onClick={() => scrollToPath(file.path)}
                  className="flex w-full items-center gap-1.5 px-3 py-1 text-left text-[0.6875rem] transition-colors hover:bg-surface-hover"
                >
                  <FileIcon path={file.path} size={13} />
                  <MiddleTruncate text={file.path} className="min-w-0 flex-1 text-text" />
                  <span className="shrink-0 tabular-nums text-[0.625rem]">
                    <span className="text-green-400">+{file.additions}</span>
                    <span className="text-muted/30"> </span>
                    <span className="text-red-400">-{file.deletions}</span>
                  </span>
                </button>
              ))}
              {showOtherSection && (
                <>
                  <div className="mx-3 my-1 border-t border-border/30" />
                  <div className="px-3 py-1 text-[0.625rem] font-medium text-muted/50">
                    Other changes
                  </div>
                  {other.map((file) => (
                    <button
                      key={file.path}
                      type="button"
                      onClick={() => scrollToPath(file.path)}
                      className="flex w-full items-center gap-1.5 px-3 py-1 text-left text-[0.6875rem] transition-colors hover:bg-surface-hover"
                    >
                      <FileIcon path={file.path} size={13} />
                      <MiddleTruncate text={file.path} className="min-w-0 flex-1 text-muted" />
                    </button>
                  ))}
                </>
              )}
            </div>
          )}

          <div className="flex-1 overflow-auto" ref={contentRef}>
            {loading && usesQuery && (
              <div className="flex items-center justify-center py-20">
                <Spinner size={24} />
              </div>
            )}

            {error && (
              <div className="flex flex-col items-center gap-3 px-6 py-10 text-center text-[0.875rem]">
                <span className="text-red-400">{error}</span>
                {retry && (
                  <Button variant="ghost" size="sm" onClick={retry}>
                    Retry
                  </Button>
                )}
              </div>
            )}

            {!loading && !error && diff !== null && (
              <>
                {visibleFiles.length === 0 ? (
                  <div className="px-6 py-10 text-center text-[0.875rem] text-muted">
                    No changes detected.
                  </div>
                ) : (
                  <div className="flex flex-col">
                    {(showOtherSection ? tracked : visibleFiles).map(renderFileSection)}
                    {showOtherSection && (
                      <>
                        <button
                          type="button"
                          onClick={() => setOtherExpanded((prev) => !prev)}
                          className="sticky top-0 z-20 flex items-center gap-2 border-y border-border/40 bg-panel-header/80 px-4 py-2 text-[0.75rem] font-medium text-muted backdrop-blur-sm transition-colors hover:text-text"
                        >
                          <ChevronRight
                            size={12}
                            className={`shrink-0 transition-transform duration-150 ${otherExpanded ? "rotate-90" : ""}`}
                          />
                          {other.length} other file{other.length !== 1 ? "s" : ""} changed
                          <span className="text-muted/50">(lockfiles, generated)</span>
                        </button>
                        {otherExpanded && other.map(renderFileSection)}
                      </>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function StickyFileHeader({
  file,
  isCollapsed,
  onToggle,
}: {
  file: FilePatch;
  isCollapsed: boolean;
  onToggle: () => void;
}) {
  const dir = dirname(file.path);
  return (
    <button
      type="button"
      onClick={onToggle}
      className="sticky top-0 z-10 flex w-full items-center gap-2 border-b border-border/40 bg-panel-header/90 px-4 py-2 text-left text-[0.75rem] backdrop-blur-sm transition-colors hover:bg-surface-hover"
    >
      <ChevronRight
        size={12}
        className={`shrink-0 text-muted transition-transform duration-150 ${isCollapsed ? "" : "rotate-90"}`}
      />
      <FileIcon path={file.path} size={14} />
      <span className="font-medium text-text-bright">{basename(file.path)}</span>
      {dir && <span className="truncate text-muted/50">{dir}</span>}
      <span className="ml-auto shrink-0 tabular-nums">
        <span className="text-green-400">+{file.additions}</span>
        <span className="text-muted/40"> / </span>
        <span className="text-red-400">-{file.deletions}</span>
      </span>
    </button>
  );
}
