import type { ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  AlertTriangle,
  GitBranch,
  Loader2,
  RefreshCcw,
  WifiOff,
  X,
  type LucideIcon,
} from "lucide-react";
import { Tooltip } from "@/components/ui/tooltip";
import { ComposerDock, useInComposerDockStack } from "./composer-dock";

export type ComposerNoticeTone = "warning" | "accent" | "neutral";

export interface ComposerNotice {
  key: string;
  tone: ComposerNoticeTone;
  icon: LucideIcon;
  iconClassName?: string;
  title: ReactNode;
  detail?: ReactNode;
  /** One trailing text action, e.g. Retry or Continue. */
  action?: { label: string; onClick: () => void };
  onDismiss?: () => void;
}

const TONE_CLASSES: Record<ComposerNoticeTone, { row: string; icon: string }> = {
  warning: { row: "bg-warning/8", icon: "text-warning" },
  accent: { row: "", icon: "text-accent" },
  neutral: { row: "", icon: "text-muted" },
};

const EASE = [0.22, 1, 0.36, 1] as const;

/**
 * Status notices (connection, branch change, …) docked above the composer.
 * Every notice shares one row treatment — icon, one-line title + detail, an
 * optional action, an optional dismiss — and they stack inside a single dock,
 * so several at once read as one strip instead of a pile of cards. Tone colours
 * the icon, and a warning (something that needs you) also tints its row so it
 * isn't missed; the dock itself stays the composer's surface.
 */
export function ComposerNotices({
  notices,
  isMobile,
}: {
  notices: ComposerNotice[];
  isMobile: boolean;
}) {
  // Standalone, the wrapper animates the dock's tuck too; in a stack the stack
  // owns the tuck and this is just a section growing in.
  const tuck = useInComposerDockStack() ? 0 : -12;
  return (
    <AnimatePresence initial={false}>
      {notices.length > 0 ? (
        <motion.div
          key="composer-notices"
          initial={{ opacity: 0, y: 12, height: 0, marginBottom: 0 }}
          animate={{ opacity: 1, y: 0, height: "auto", marginBottom: tuck }}
          exit={{ opacity: 0, y: 12, height: 0, marginBottom: 0 }}
          transition={{ duration: 0.22, ease: EASE }}
          className="relative overflow-hidden"
        >
          <ComposerDock isMobile={isMobile} tucked={false}>
            <NoticeRows notices={notices} />
          </ComposerDock>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}

/**
 * The same notices with no composer to dock onto (the chat is still loading):
 * a free-standing box in the composer's column, so a reconnect is never hidden.
 */
export function DetachedComposerNotices({ notices }: { notices: ComposerNotice[] }) {
  if (notices.length === 0) return null;
  return (
    <div className="shrink-0 pb-4 max-[768px]:pb-1.5">
      <div className="mx-auto max-w-3xl px-6 max-[768px]:px-2">
        <div className="overflow-hidden rounded-2xl border border-border/60 bg-surface">
          <NoticeRows notices={notices} />
        </div>
      </div>
    </div>
  );
}

function NoticeRows({ notices }: { notices: ComposerNotice[] }) {
  return (
    <div className="divide-y divide-border/40">
      <AnimatePresence initial={false}>
        {notices.map((notice) => (
          <motion.div
            key={notice.key}
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.18, ease: EASE }}
            className="overflow-hidden"
          >
            <NoticeRow notice={notice} />
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}

function NoticeRow({ notice }: { notice: ComposerNotice }) {
  const Icon = notice.icon;
  const tone = TONE_CLASSES[notice.tone];
  return (
    <div
      className={`flex min-h-9 items-center gap-2.5 py-1.5 pl-3.5 pr-1.5 max-[768px]:min-h-10 ${tone.row}`}
    >
      <Icon size={14} className={`shrink-0 ${tone.icon} ${notice.iconClassName ?? ""}`.trim()} />
      <p className="line-clamp-2 min-w-0 flex-1 text-[0.75rem] leading-snug">
        <span className="font-medium text-text-bright">{notice.title}</span>
        {notice.detail ? <span className="text-muted"> · {notice.detail}</span> : null}
      </p>
      {notice.action ? (
        <button
          type="button"
          onClick={notice.action.onClick}
          className="shrink-0 rounded-md px-2 py-1 text-[0.75rem] font-medium text-accent transition-colors hover:bg-hover-highlight max-[768px]:min-h-10"
        >
          {notice.action.label}
        </button>
      ) : null}
      {notice.onDismiss ? (
        <Tooltip content="Dismiss">
          <button
            type="button"
            aria-label="Dismiss"
            onClick={notice.onDismiss}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:bg-hover-highlight hover:text-text max-[768px]:h-10 max-[768px]:w-10"
          >
            <X size={13} />
          </button>
        </Tooltip>
      ) : null}
    </div>
  );
}

// ── Notice builders ──────────────────────────────────────────────────

export type ConnectionNoticeKind = "reconnecting" | "resyncing" | "running" | "interrupted";

export function connectionNotice({
  kind,
  onDismiss,
  onContinue,
  onRetry,
}: {
  kind: ConnectionNoticeKind;
  onDismiss?: () => void;
  onContinue?: () => void;
  onRetry?: () => void;
}): ComposerNotice {
  // Reconnecting/resyncing clear themselves, so they get no dismiss: hiding a
  // state that is still true only makes it easier to miss.
  const base = { key: "connection" };
  if (kind === "reconnecting") {
    return {
      ...base,
      tone: "warning",
      icon: WifiOff,
      title: "Reconnecting to Relay",
      action: onRetry ? { label: "Retry", onClick: onRetry } : undefined,
    };
  }
  if (kind === "resyncing") {
    return {
      ...base,
      tone: "accent",
      icon: Loader2,
      iconClassName: "animate-spin",
      title: "Restoring live state",
    };
  }
  if (kind === "running") {
    return {
      ...base,
      onDismiss,
      tone: "accent",
      icon: RefreshCcw,
      title: "Reconnected",
      detail: "this chat is still running",
    };
  }
  return {
    ...base,
    onDismiss,
    tone: "warning",
    icon: AlertTriangle,
    title: "Agent stopped while you were disconnected",
    action: onContinue ? { label: "Continue", onClick: onContinue } : undefined,
  };
}

export function branchChangeNotice({
  originalBranch,
  currentBranch,
  onDismiss,
}: {
  originalBranch: string;
  currentBranch: string;
  onDismiss?: () => void;
}): ComposerNotice {
  return {
    key: "branch-change",
    tone: "neutral",
    icon: GitBranch,
    title: "Branch changed",
    detail: (
      <>
        <code className="text-text">{originalBranch}</code> →{" "}
        <code className="text-text">{currentBranch}</code>
      </>
    ),
    onDismiss,
  };
}
