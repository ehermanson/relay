/**
 * FilesPanel — Reusable file-change tree used in both the chat sidecar
 * and the space sidebar.
 */

import { memo, useMemo, useState } from "react";
import { FileDiff } from "lucide-react";
import { FileIcon } from "../ui/file-icon";
import { Tooltip } from "../ui/tooltip";
import type { FileChange } from "@shared/types";

// =============================================================================
// Helpers
// =============================================================================

/** Strip the working directory prefix to show project-relative paths. */
export function relativePath(filePath: string, cwd: string): string {
  if (cwd && filePath.startsWith(cwd)) {
    const rel = filePath.slice(cwd.length);
    return rel.startsWith("/") ? rel.slice(1) : rel;
  }
  return filePath;
}

export function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`shrink-0 text-muted transition-transform duration-150 ${open ? "rotate-90" : ""}`}
    >
      <polyline points="9 18 15 12 9 6" />
    </svg>
  );
}

function DiffStats({ additions, deletions }: { additions?: number; deletions?: number }) {
  if (additions == null && deletions == null) return null;
  const add = additions ?? 0;
  const del = deletions ?? 0;
  return (
    <span className="sidecar-file-stats shrink-0 text-[0.6875rem] font-medium tabular-nums">
      <span className="text-green-400">+{add}</span>
      <span className="text-muted/40"> / </span>
      <span className="text-red-400">-{del}</span>
    </span>
  );
}

// =============================================================================
// Tree data structure
// =============================================================================

interface FileEntry {
  basename: string;
  file: FileChange;
  relPath: string;
}

interface TreeNode {
  /** Display label — may be a compressed multi-segment path like "components/layout" */
  label: string;
  /** Full relative path for this directory */
  fullPath: string;
  children: TreeNode[];
  files: FileEntry[];
  /** Aggregate stats */
  additions: number;
  deletions: number;
  hasDiffStats: boolean;
}

function buildTree(files: FileChange[], cwd: string): TreeNode {
  const compare = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });
  const root: TreeNode = {
    label: "",
    fullPath: "",
    children: [],
    files: [],
    additions: 0,
    deletions: 0,
    hasDiffStats: false,
  };

  for (const file of files) {
    const rel = relativePath(file.path, cwd);
    const parts = rel.split("/");
    const basename = parts.pop() || rel;
    let node = root;

    // Walk directory segments, creating nodes as needed
    for (let i = 0; i < parts.length; i++) {
      const segment = parts[i];
      let child = node.children.find((c) => c.label === segment);
      if (!child) {
        child = {
          label: segment,
          fullPath: parts.slice(0, i + 1).join("/"),
          children: [],
          files: [],
          additions: 0,
          deletions: 0,
          hasDiffStats: false,
        };
        node.children.push(child);
      }
      node = child;
    }

    node.files.push({ basename, file, relPath: rel });
  }

  // Sort children and files at every level
  function sortTree(node: TreeNode) {
    node.children.sort((a, b) => compare(a.label, b.label));
    node.files.sort((a, b) => compare(a.basename, b.basename));
    for (const child of node.children) sortTree(child);
  }
  sortTree(root);

  // Compress single-child chains (no files at the intermediate node)
  compressTree(root);

  // Roll up stats
  rollUpStats(root);

  return root;
}

/** Merge single-child directories: if a folder has no files and one child folder, merge them */
function compressTree(node: TreeNode): void {
  for (const child of node.children) compressTree(child);
  while (node.children.length === 1 && node.files.length === 0 && node.label !== "") {
    const only = node.children[0];
    node.label = node.label + "/" + only.label;
    node.fullPath = only.fullPath;
    node.children = only.children;
    node.files = only.files;
  }
}

/** Aggregate addition/deletion counts up the tree */
function rollUpStats(node: TreeNode): void {
  let additions = 0;
  let deletions = 0;
  let hasDiffStats = false;

  for (const { file } of node.files) {
    if (file.additions != null || file.deletions != null) {
      hasDiffStats = true;
      additions += file.additions ?? 0;
      deletions += file.deletions ?? 0;
    }
  }

  for (const child of node.children) {
    rollUpStats(child);
    additions += child.additions;
    deletions += child.deletions;
    if (child.hasDiffStats) hasDiffStats = true;
  }

  node.additions = additions;
  node.deletions = deletions;
  node.hasDiffStats = hasDiffStats;
}

// =============================================================================
// Tree renderer
// =============================================================================

function TreeNodeView({
  node,
  depth,
  collapsed,
  toggleDir,
  onFileClick,
}: {
  node: TreeNode;
  depth: number;
  collapsed: Set<string>;
  toggleDir: (path: string) => void;
  onFileClick?: (relPath: string) => void;
}) {
  const isRoot = node.label === "";
  const isOpen = !collapsed.has(node.fullPath);
  const indent = isRoot ? 0 : depth;

  return (
    <>
      {/* Directory header (skip for root) */}
      {!isRoot && (
        <button
          type="button"
          onClick={() => toggleDir(node.fullPath)}
          className="flex w-full items-center gap-1.5 rounded-lg py-1.5 text-[0.8125rem] leading-snug transition-colors hover:bg-surface-hover"
          style={{ paddingLeft: `${indent * 20 + 10}px`, paddingRight: "10px" }}
        >
          <ChevronIcon open={isOpen} />
          <FileIcon path={node.fullPath} kind="directory" size={15} />
          <span className="min-w-0 flex-1 truncate text-left font-medium text-text-bright">
            {node.label}
          </span>
          {node.hasDiffStats && <DiffStats additions={node.additions} deletions={node.deletions} />}
        </button>
      )}

      {/* Children (files + subdirectories) — collapsible for non-root */}
      {(isRoot || isOpen) && (
        <>
          {node.files.map(({ basename, file, relPath }) => (
            <Tooltip key={file.path} content={relPath} side="left">
              <div
                className={`flex items-center gap-1.5 rounded-lg py-1.5 text-[0.8125rem] leading-snug transition-colors hover:bg-surface-hover${onFileClick ? " cursor-pointer" : ""}`}
                style={{
                  paddingLeft: `${(indent + (isRoot ? 0 : 1)) * 20 + 10}px`,
                  paddingRight: "10px",
                }}
                onClick={onFileClick ? () => onFileClick(relPath) : undefined}
              >
                <FileIcon path={file.path} size={15} />
                <span className="min-w-0 flex-1 truncate text-text">{basename}</span>
                {file.origin === "worktree" && (
                  <span className="shrink-0 text-[0.625rem] text-muted/70">detected</span>
                )}
                {(file.additions != null || file.deletions != null) && (
                  <DiffStats additions={file.additions} deletions={file.deletions} />
                )}
              </div>
            </Tooltip>
          ))}

          {node.children.map((child) => (
            <TreeNodeView
              key={child.fullPath}
              node={child}
              depth={indent + (isRoot ? 0 : 1)}
              collapsed={collapsed}
              toggleDir={toggleDir}
              onFileClick={onFileClick}
            />
          ))}
        </>
      )}
    </>
  );
}

// =============================================================================
// Component
// =============================================================================

export const FilesPanel = memo(function FilesPanel({
  files,
  cwd,
  onViewChanges,
  onFileClick,
}: {
  files: FileChange[];
  cwd: string;
  onViewChanges?: () => void;
  onFileClick?: (filePath: string) => void;
}) {
  // When diff stats are available, filter out files with no net change (touched but reverted).
  // For non-git projects (no diff stats at all), show everything.
  const filteredFiles = useMemo(() => {
    const anyHasDiffStats = files.some((f) => f.additions != null || f.deletions != null);
    return anyHasDiffStats
      ? files.filter((f) => f.additions != null || f.deletions != null)
      : files;
  }, [files]);
  const tree = useMemo(() => buildTree(filteredFiles, cwd), [filteredFiles, cwd]);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const toggleDir = (dir: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(dir)) next.delete(dir);
      else next.add(dir);
      return next;
    });
  };

  const hasDiffStats = tree.hasDiffStats;

  return (
    <>
      {/* Header */}
      <div className="shrink-0 px-3.5 py-2.5">
        <div className="flex items-center gap-2">
          <span className="text-[0.75rem] font-medium text-muted">
            {filteredFiles.length} file{filteredFiles.length !== 1 ? "s" : ""} changed
          </span>
          {hasDiffStats && (
            <span className="sidecar-header-stats text-[0.6875rem] font-medium tabular-nums">
              <span className="text-green-400">+{tree.additions}</span>
              <span className="text-muted/40"> / </span>
              <span className="text-red-400">-{tree.deletions}</span>
            </span>
          )}
          {onViewChanges && (
            <Tooltip content="View full diff">
              <button
                type="button"
                onClick={onViewChanges}
                className="ml-auto flex items-center gap-1 rounded-md px-2 py-0.5 text-[0.6875rem] font-medium text-muted transition-colors hover:bg-surface-hover hover:text-text"
              >
                <FileDiff size={12} className="shrink-0" />
                <span className="sidecar-control-label">Full Diff</span>
              </button>
            </Tooltip>
          )}
        </div>
      </div>

      {/* File tree */}
      <div className="flex-1 overflow-y-auto px-2 pb-2">
        <TreeNodeView
          node={tree}
          depth={0}
          collapsed={collapsed}
          toggleDir={toggleDir}
          onFileClick={onFileClick}
        />
      </div>
    </>
  );
});
