import { useCallback, useEffect, useState } from "react";
import { Circle, CircleDashed, CircleCheck, Ban, ListChecks } from "lucide-react";
import type { Task } from "@shared/types";
import { Badge } from "@/components/ui/badge";
import { Popover } from "@/components/ui/popover";
import { MarkdownContent } from "@/components/chat/markdown-content";
import { fetchTask } from "@/lib/api";

// ── Shared constants (mirrors tasks-page.tsx) ──────────────────────────────

const priorityLabels: Record<number, string> = {
  0: "P0",
  1: "P1",
  2: "P2",
  3: "P3",
  4: "P4",
};

const priorityVariants: Record<number, "error" | "warning" | "accent" | "default"> = {
  0: "error",
  1: "warning",
  2: "accent",
  3: "default",
  4: "default",
};

const statusLabels: Record<string, string> = {
  open: "Open",
  in_progress: "In Progress",
  blocked: "Blocked",
  done: "Done",
  cancelled: "Cancelled",
};

const typeLabels: Record<string, string> = {
  epic: "Epic",
  task: "Task",
  bug: "Bug",
};

function StatusIcon({ status, size = 14 }: { status: string; size?: number }) {
  const sw = 2.5;
  switch (status) {
    case "open":
      return <Circle size={size} strokeWidth={sw} className="text-accent" />;
    case "in_progress":
      return <CircleDashed size={size} strokeWidth={sw} className="text-warning" />;
    case "blocked":
      return <Ban size={size} strokeWidth={sw} className="text-error" />;
    case "done":
      return <CircleCheck size={size} strokeWidth={sw} className="text-accent" />;
    case "cancelled":
      return <Ban size={size} strokeWidth={sw} className="text-muted" />;
    default:
      return null;
  }
}

// ── Popover content ────────────────────────────────────────────────────────

function TaskPopoverContent({ task }: { task: Task }) {
  return (
    <div className="flex w-72 flex-col gap-2.5">
      {/* Header */}
      <div className="flex items-start gap-2">
        <ListChecks size={16} className="mt-0.5 shrink-0 text-muted" />
        <div className="min-w-0 flex-1">
          <div className="text-[0.8125rem] font-semibold leading-snug text-text">{task.title}</div>
          <div className="mt-0.5 font-mono text-[0.625rem] text-muted">{task.id}</div>
        </div>
      </div>

      {/* Status / Priority / Type row */}
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge size="sm" variant="default">
          <StatusIcon status={task.status} size={10} />
          {statusLabels[task.status] ?? task.status}
        </Badge>
        <Badge size="sm" variant={priorityVariants[task.priority] ?? "default"}>
          {priorityLabels[task.priority] ?? `P${task.priority}`}
        </Badge>
        <Badge size="sm" variant="default">
          {typeLabels[task.type] ?? task.type}
        </Badge>
      </div>

      {/* Tags */}
      {task.tags.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {task.tags.map((tag) => (
            <Badge key={tag} size="xs" variant="default">
              {tag}
            </Badge>
          ))}
        </div>
      )}

      {/* Description */}
      {task.description && (
        <div className="max-h-32 overflow-y-auto rounded-md bg-surface-inset/50 px-2.5 py-2 text-[0.75rem] leading-relaxed text-text/80">
          <MarkdownContent text={task.description} />
        </div>
      )}

      {/* Blocked by */}
      {task.blockedBy.length > 0 && (
        <div className="text-[0.6875rem] text-muted">
          <span className="font-medium">Blocked by:</span>{" "}
          {task.blockedBy.map((id) => (
            <code
              key={id}
              className="mx-0.5 rounded bg-surface-hover px-1 py-px font-mono text-[0.625rem]"
            >
              {id}
            </code>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Hook: manages popover state from task-chip-click events ────────────────

interface PopoverState {
  task: Task;
  anchor: HTMLElement;
}

export function useTaskMentionPopover(
  containerRef: React.RefObject<HTMLElement | null>,
  options: { projectId?: string; spaceId?: string; tasks: Task[] | null },
) {
  const [popoverState, setPopoverState] = useState<PopoverState | null>(null);

  const handleChipClick = useCallback(
    (e: Event) => {
      const { taskId, anchor } = (e as CustomEvent).detail as {
        taskId: string;
        anchor: HTMLElement;
      };
      const task = options.tasks?.find((candidate) => candidate.id === taskId);
      if (task) {
        setPopoverState((prev) => (prev?.task.id === taskId ? null : { task, anchor }));
        return;
      }
      if (!options.projectId) return;
      void fetchTask(options.projectId, taskId, { spaceId: options.spaceId })
        .then((resolved) => {
          if (resolved) setPopoverState({ task: resolved, anchor });
        })
        .catch(() => {
          // Keep the mention usable when the task was removed or its file is temporarily invalid.
        });
    },
    [options.projectId, options.spaceId, options.tasks],
  );

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    container.addEventListener("task-chip-click", handleChipClick);
    return () => container.removeEventListener("task-chip-click", handleChipClick);
  }, [containerRef, handleChipClick]);

  const close = useCallback(() => setPopoverState(null), []);

  return { popoverState, close };
}

// ── Rendered popover element ───────────────────────────────────────────────

export function TaskMentionPopoverOverlay({
  popoverState,
  onClose,
}: {
  popoverState: PopoverState | null;
  onClose: () => void;
}) {
  return (
    <Popover.Root
      open={!!popoverState}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      {popoverState && (
        <Popover.Content
          side="top"
          align="center"
          sideOffset={8}
          anchor={popoverState.anchor}
          className="p-3"
        >
          <TaskPopoverContent task={popoverState.task} />
        </Popover.Content>
      )}
    </Popover.Root>
  );
}
