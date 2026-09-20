/**
 * Shared header primitives for chat and space views.
 * Keeps token badge and layout consistent.
 */

import type { ReactNode } from "react";
import { GitBranch, Menu as MenuIcon, Zap } from "lucide-react";
import { Tooltip } from "./tooltip";
import { ProjectBreadcrumb } from "./project-breadcrumb";
import { useMediaQuery } from "@/hooks/use-media-query";
import { useLayoutStore } from "@/stores/layout-store";
import { formatTokens } from "@/lib/utils";
import "./view-header.css";

// ── Container ────────────────────────────────────────────────────────

interface ViewHeaderProps {
  children: ReactNode;
  className?: string;
  style?: React.CSSProperties;
}

export function ViewHeader({ children, className, style }: ViewHeaderProps) {
  return (
    <div
      className={`flex shrink-0 items-center gap-3 border-b border-border/70 px-4 py-2.5 max-[768px]:gap-2 max-[768px]:px-2 max-[768px]:py-2${className ? ` ${className}` : ""}`}
      style={style}
    >
      {children}
    </div>
  );
}

// ── Mobile sidebar toggle (hamburger) ────────────────────────────────

export function MobileSidebarToggle() {
  const isMobile = useMediaQuery("(max-width: 768px)");
  const { setMobileSidebarOpen } = useLayoutStore();
  if (!isMobile) return null;
  return (
    <Tooltip content="Menu">
      <button
        type="button"
        onClick={() => setMobileSidebarOpen(true)}
        className="flex h-9 w-9 items-center justify-center rounded-lg text-muted transition-colors hover:bg-surface-hover hover:text-text"
      >
        <MenuIcon size={18} strokeWidth={2.25} />
      </button>
    </Tooltip>
  );
}

// ── Token badge ──────────────────────────────────────────────────────

interface TokenBadgeProps {
  tokens: number;
  label?: string;
  tooltip?: ReactNode;
}

export function TokenBadge({ tokens, label, tooltip }: TokenBadgeProps) {
  if (tokens <= 0) return null;
  const badge = (
    <span className="hidden shrink-0 items-center gap-1 text-[0.6875rem] text-muted sm:inline-flex">
      <Zap size={10} />
      {label && <span className="text-muted/80">{label}</span>}
      {formatTokens(tokens)}
    </span>
  );
  return tooltip ? <Tooltip content={tooltip}>{badge}</Tooltip> : badge;
}

// ── Title area (wraps title + badges in a flex row) ──────────────────

interface ViewHeaderTitleProps {
  children: ReactNode;
}

export function ViewHeaderTitle({ children }: ViewHeaderTitleProps) {
  return <div className="flex min-w-0 flex-1 items-center gap-2">{children}</div>;
}

// ── Mobile header (shared layout for chat + space views) ─────────────

interface MobileViewHeaderProps {
  /** Primary title shown on the top line. */
  title: string;
  /** Target project for the breadcrumb dropdown. */
  projectId: string;
  /** Visible label for the breadcrumb. */
  projectLabel: string;
  /** Git branch shown after the breadcrumb, with icon. */
  gitBranch?: string;
  /** Action slot (buttons, menus). Rendered inline after the title block. */
  actions?: ReactNode;
  /** Dialogs or other siblings rendered at the end of the header. */
  children?: ReactNode;
}

export function MobileViewHeader({
  title,
  projectId,
  projectLabel,
  gitBranch,
  actions,
  children,
}: MobileViewHeaderProps) {
  return (
    <ViewHeader style={{ containerName: "view-header", containerType: "inline-size" }}>
      <MobileSidebarToggle />
      <div className="min-w-0 flex-1">
        <h1 className="truncate text-[0.875rem] font-semibold leading-snug tracking-tight text-text-bright">
          {title}
        </h1>
        <div className="flex items-center gap-1 text-[0.6875rem] leading-tight text-muted">
          <ProjectBreadcrumb projectId={projectId} label={projectLabel} mobile />
          {gitBranch && (
            <>
              <span className="text-border">·</span>
              <span className="flex items-center gap-0.5 truncate">
                <GitBranch size={10} strokeWidth={2} className="shrink-0" />
                <span className="truncate">{gitBranch}</span>
              </span>
            </>
          )}
        </div>
      </div>
      {actions}
      {children}
    </ViewHeader>
  );
}
