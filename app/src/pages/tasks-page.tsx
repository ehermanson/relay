import { useEffect, useRef, useState } from "react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowDownNarrowWide,
  Ban,
  Check,
  ChevronLeft,
  Circle,
  CircleCheck,
  CircleDashed,
  CircleX,
  EllipsisVertical,
  GitBranch,
  ListChecks,
  MessageSquarePlus,
  Send,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { MarkdownContent } from "@/components/chat/markdown-content";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmActionDialog } from "@/components/ui/confirm-action-dialog";
import { Dialog } from "@/components/ui/dialog";
import { Drawer } from "@/components/ui/drawer";
import { Input, Textarea, Select } from "@/components/ui/input";
import { Menu } from "@/components/ui/menu";
import { Tooltip } from "@/components/ui/tooltip";
import { EmptyState } from "@/components/empty-state";
import { PageShell } from "@/components/ui/page-shell";
import { useProjectContext } from "@/context/project-context";
import { useMediaQuery } from "@/hooks/use-media-query";
import { useScopedTasks } from "@/hooks/use-scoped-tasks";
import type { SpaceInfo, Task, TaskComment, TaskStatus, TaskType } from "@shared/types";
import {
  TaskApiError,
  addTaskCommentApi,
  fetchTask,
  fetchTaskComments,
  createTaskApi,
  updateTaskApi,
  deleteTaskApi,
  initTasksApi,
  createInstance,
  createSpace,
  fetchAllSpaces,
  searchChats,
} from "@/lib/api";
import { getInstanceChatRoute, getSpaceRoute } from "@/lib/project-route";
import { reportCreateInstanceError } from "@/stores/process-limit-store";
import { buildTaskReference } from "@/lib/task-links";
import { formatTimeAgo, getChatRecencyTimestamp } from "@/lib/utils";
import { patchTasksSearch } from "@/routes/_app/projects/$projectId/tasks/-search";
import {
  filterTasksForView,
  hasRevisionedTaskShape,
  normalizeTaskSpaceId,
  TASK_VIEW_STATUSES,
  taskScopeKey,
  type TaskListView,
} from "@/lib/task-scope";

// ─── Constants ──────────────────────────────────────────────────────────────

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

const statusDotColors: Record<string, string> = {
  open: "bg-accent",
  in_progress: "bg-warning",
  blocked: "bg-error",
  done: "bg-accent",
  cancelled: "bg-muted",
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
      return <CircleX size={size} strokeWidth={sw} className="text-muted" />;
    default:
      return <span className={`h-2 w-2 rounded-full ${statusDotColors[status] ?? "bg-muted"}`} />;
  }
}

function TaskLink({ task, onClick }: { task: Task; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-start gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-surface-hover"
    >
      <div className="flex gap-2 items-center pt-[2px]">
        <StatusIcon status={task.status} size={12} />
        <span className="shrink-0 font-mono text-[0.625rem] text-muted">{task.id}</span>
      </div>
      <span className="text-[0.8125rem] text-text-bright">{task.title}</span>
    </button>
  );
}

function TaskLinkSection({
  label,
  tasks,
  taskIds = [],
  onSelect,
}: {
  label: string;
  tasks: Task[];
  taskIds?: string[];
  onSelect: (id: string) => void;
}) {
  const resolvedIds = new Set(tasks.map((task) => task.id));
  const unresolvedIds = taskIds.filter((id) => !resolvedIds.has(id));
  if (tasks.length === 0 && unresolvedIds.length === 0) return null;
  return (
    <div className="mb-4">
      <h4 className="mb-1.5 text-[0.6875rem] font-medium text-muted">{label}</h4>
      <div className="flex flex-col gap-1">
        {tasks.map((t) => (
          <TaskLink key={t.id} task={t} onClick={() => onSelect(t.id)} />
        ))}
        {unresolvedIds.map((id) => (
          <button
            key={id}
            type="button"
            onClick={() => onSelect(id)}
            className="flex min-h-8 items-center gap-2 rounded-md px-2 py-1.5 text-left font-mono text-[0.6875rem] text-muted transition-colors hover:bg-surface-hover hover:text-text max-[768px]:min-h-10"
          >
            {id}
          </button>
        ))}
      </div>
    </div>
  );
}

type SortKey = "priority" | "updated" | "type" | "created";

const SORT_OPTIONS: { key: SortKey; label: string }[] = [
  { key: "priority", label: "Priority" },
  { key: "updated", label: "Recently updated" },
  { key: "created", label: "Recently created" },
  { key: "type", label: "Type" },
];

function sortTasks(tasks: Task[], sortKey: SortKey): Task[] {
  return [...tasks].sort((a, b) => {
    switch (sortKey) {
      case "priority":
        return a.priority - b.priority;
      case "updated":
        return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
      case "created":
        return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
      case "type":
        return a.type.localeCompare(b.type);
      default:
        return 0;
    }
  });
}

function getColumnSortKey(status: TaskStatus, boardSort: SortKey): SortKey {
  return status === "done" || status === "cancelled" ? "updated" : boardSort;
}

// ─── Task Card ──────────────────────────────────────────────────────────────

function TaskCard({
  task,
  onClick,
  onStartChat,
  canStartChat = true,
}: {
  task: Task;
  onClick: () => void;
  onStartChat: (task: Task) => void;
  canStartChat?: boolean;
}) {
  const timeAgo = formatTimeAgo(task.updatedAt);
  const blockerCount = task.blockedBy?.length ?? 0;

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick();
        }
      }}
      className="w-full cursor-pointer rounded-lg border border-border/70 bg-surface px-3 py-2 text-left transition-all duration-150 hover:-translate-y-px hover:border-border-hover hover:bg-surface-hover hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/30"
    >
      <div className="mb-1 flex items-start gap-2">
        <span className="text-[0.8125rem] font-medium leading-snug text-text-bright">
          {task.title}
        </span>
        {canStartChat && (
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto h-7 shrink-0 px-2 text-[0.6875rem]"
            onClick={(e) => {
              e.stopPropagation();
              onStartChat(task);
            }}
          >
            Start Chat
          </Button>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="shrink-0 font-mono text-[0.625rem] text-muted/70">{task.id}</span>
        <Badge variant={priorityVariants[task.priority] ?? "default"} size="sm">
          {priorityLabels[task.priority] ?? `P${task.priority}`}
        </Badge>
        <Badge size="sm">{typeLabels[task.type] ?? task.type}</Badge>
        {task.archived && <Badge size="sm">Archived</Badge>}
        {task.tags?.map((tag) => (
          <Badge key={tag} size="sm" variant="default">
            {tag}
          </Badge>
        ))}
        {blockerCount > 0 && (
          <Tooltip content={`Blocked by ${blockerCount} task${blockerCount !== 1 ? "s" : ""}`}>
            <span className="inline-flex items-center gap-0.5 text-[0.625rem] text-muted">
              <Ban size={9} />
              {blockerCount}
            </span>
          </Tooltip>
        )}
        <span className="ml-auto shrink-0 text-[0.625rem] text-muted/70">{timeAgo}</span>
      </div>
    </div>
  );
}

// ─── Task Drawer Content ────────────────────────────────────────────────────

function TaskDrawerBody({
  projectId,
  spaceId,
  task,
  allTasks,
  onSelectTask,
  onUpdate,
  onDelete,
  onStartChat,
  onStartSpace,
  readOnly,
  showBack,
  onBack,
}: {
  projectId: string;
  spaceId?: string;
  task: Task;
  allTasks: Task[];
  onSelectTask: (id: string) => void;
  onUpdate: (task: Task, patch: Partial<Task>) => void;
  onDelete: (task: Task) => void;
  onStartChat: (task: Task) => void;
  onStartSpace: (task: Task) => void;
  readOnly?: boolean;
  showBack?: boolean;
  onBack?: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [editTitle, setEditTitle] = useState(task.title);
  const [editDescription, setEditDescription] = useState(task.description);
  const [editPriority, setEditPriority] = useState(task.priority);
  const [editType, setEditType] = useState(task.type);
  const [editTags, setEditTags] = useState(task.tags?.join(", ") ?? "");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [commentBody, setCommentBody] = useState("");
  const [commentError, setCommentError] = useState("");
  const [commentSubmitting, setCommentSubmitting] = useState(false);
  const queryClient = useQueryClient();
  const commentsQueryKey = ["taskComments", projectId, spaceId ?? "main", task.id] as const;
  const {
    data: comments = [],
    isLoading: commentsLoading,
    isError: commentsError,
  } = useQuery({
    queryKey: commentsQueryKey,
    queryFn: () => fetchTaskComments(projectId, task.id, { spaceId }),
  });

  const handleSave = () => {
    const tags = editTags
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    onUpdate(task, {
      title: editTitle,
      description: editDescription,
      priority: editPriority,
      type: editType,
      tags,
    });
    setEditing(false);
  };

  // Find blockers and dependents from all tasks
  const blockers = allTasks.filter((t) => task.blockedBy?.includes(t.id));
  const dependents = allTasks.filter((t) => t.blockedBy?.includes(task.id));
  const children = allTasks.filter((t) => t.parent === task.id);
  const parentTask = task.parent ? allTasks.find((t) => t.id === task.parent) : null;
  const navigate = useNavigate({ from: "/projects/$projectId/tasks/" });
  const { data: relatedChats = [], isLoading: relatedChatsLoading } = useQuery({
    queryKey: ["taskRelatedChats", projectId, spaceId ?? "main", task.id],
    queryFn: async () => {
      const results = await searchChats(`@task:${task.id}`, { projectId, limit: 50 });
      return results
        .filter((chat) => taskScopeKey(chat.spaceId) === taskScopeKey(spaceId))
        .sort(
          (a, b) => (b.lastMessageAt ?? b.lastActivityAt) - (a.lastMessageAt ?? a.lastActivityAt),
        );
    },
    enabled: Boolean(projectId),
  });

  return (
    <>
      <Drawer.Header className="items-start">
        <div className="flex min-w-0 flex-1 items-start gap-2">
          {showBack && (
            <Button variant="icon" size="icon-sm" onClick={onBack} className="mt-0.5 shrink-0">
              <ChevronLeft size={14} />
            </Button>
          )}
          <div className="min-w-0 flex-1">
            {editing ? (
              <Input
                type="text"
                value={editTitle}
                onChange={(e) => setEditTitle(e.target.value)}
                inputSize="sm"
                className="!text-[0.9375rem] font-semibold text-text-bright"
              />
            ) : (
              <Drawer.Title>{task.title}</Drawer.Title>
            )}
            <span className="shrink-0 font-mono text-xs text-muted">{task.id}</span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {editing ? (
            <>
              <Button variant="primary" size="sm" onClick={handleSave}>
                Save
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
                Cancel
              </Button>
            </>
          ) : (
            <Menu.Root>
              <Menu.Trigger className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted transition-all duration-150 hover:bg-surface-hover hover:text-text">
                <EllipsisVertical size={14} />
              </Menu.Trigger>
              <Menu.Content>
                {!readOnly && (
                  <Menu.Item onClick={() => onStartChat(task)}>
                    <MessageSquarePlus size={13} strokeWidth={2} className="text-muted" />
                    Start Chat
                  </Menu.Item>
                )}
                <Menu.Item onClick={() => onStartSpace(task)}>
                  <GitBranch size={13} strokeWidth={2} className="text-muted" />
                  Start Space
                </Menu.Item>
                <Menu.Separator />
                {!task.archived && !readOnly && (
                  <Menu.Item onClick={() => setEditing(true)}>
                    <Pencil size={13} strokeWidth={2} className="text-muted" />
                    Edit
                  </Menu.Item>
                )}
                {!task.archived && !readOnly && <Menu.Separator />}
                {!task.archived && !readOnly && (
                  <Menu.Item danger onClick={() => setConfirmDelete(true)}>
                    <Trash2 size={13} />
                    Delete
                  </Menu.Item>
                )}
              </Menu.Content>
            </Menu.Root>
          )}
          <Drawer.Close />
        </div>
      </Drawer.Header>
      <Drawer.Body className="px-5 py-4">
        {/* Status + metadata */}
        <div className="mb-4 flex flex-wrap items-center gap-2">
          {task.archived || readOnly ? (
            <>
              <Badge>
                <StatusIcon status={task.status} size={10} />
                {statusLabels[task.status]}
              </Badge>
              {task.archived && !readOnly && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="max-[768px]:min-h-10"
                  onClick={() => onUpdate(task, { status: "open" })}
                >
                  Reopen
                </Button>
              )}
            </>
          ) : (
            <Select
              value={task.status}
              onChange={(e) => onUpdate(task, { status: e.target.value as TaskStatus })}
            >
              {(["open", "in_progress", "done", "cancelled"] as TaskStatus[]).map((s) => (
                <option key={s} value={s}>
                  {statusLabels[s]}
                </option>
              ))}
              {task.status === "blocked" && (
                <option value="blocked" disabled>
                  Blocked
                </option>
              )}
            </Select>
          )}
          {task.archived && <Badge size="sm">Archived</Badge>}
          {editing ? (
            <>
              <Select
                value={editPriority}
                onChange={(e) => setEditPriority(Number(e.target.value))}
              >
                {[0, 1, 2, 3, 4].map((p) => (
                  <option key={p} value={p}>
                    {priorityLabels[p]}
                  </option>
                ))}
              </Select>
              <Select value={editType} onChange={(e) => setEditType(e.target.value as TaskType)}>
                {(["epic", "task", "bug"] as TaskType[]).map((t) => (
                  <option key={t} value={t}>
                    {typeLabels[t]}
                  </option>
                ))}
              </Select>
            </>
          ) : (
            <>
              <Badge variant={priorityVariants[task.priority] ?? "default"}>
                {priorityLabels[task.priority] ?? `P${task.priority}`}
              </Badge>
              <Badge>{typeLabels[task.type] ?? task.type}</Badge>
            </>
          )}
        </div>

        {/* Tags */}
        {editing ? (
          <div className="mb-4">
            <label className="mb-1.5 block text-[0.6875rem] font-medium text-muted">
              Tags (comma-separated)
            </label>
            <Input
              type="text"
              value={editTags}
              onChange={(e) => setEditTags(e.target.value)}
              inputSize="sm"
              placeholder="e.g. ui, perf, backend"
            />
          </div>
        ) : (
          task.tags &&
          task.tags.length > 0 && (
            <div className="mb-4 flex flex-wrap gap-1">
              {task.tags.map((tag) => (
                <Badge key={tag} size="sm" variant="default">
                  {tag}
                </Badge>
              ))}
            </div>
          )
        )}

        <TaskLinkSection
          label="Parent"
          tasks={parentTask ? [parentTask] : []}
          taskIds={task.parent ? [task.parent] : []}
          onSelect={onSelectTask}
        />
        <TaskLinkSection label="Children" tasks={children} onSelect={onSelectTask} />
        <TaskLinkSection
          label="Blocked by"
          tasks={blockers}
          taskIds={task.blockedBy}
          onSelect={onSelectTask}
        />
        <TaskLinkSection label="Blocks" tasks={dependents} onSelect={onSelectTask} />
        <div className="mb-4">
          <h4 className="mb-1.5 text-[0.6875rem] font-medium text-muted">Related chats</h4>
          {relatedChatsLoading ? (
            <div className="text-[0.75rem] text-muted">Loading related chats…</div>
          ) : relatedChats.length > 0 ? (
            <div className="flex flex-col gap-1">
              {relatedChats.map((chat) => {
                const route = chat.spaceId
                  ? {
                      to: "/projects/$projectId/spaces/$spaceId/$chatId" as const,
                      params: { projectId, spaceId: chat.spaceId, chatId: chat.instanceId },
                    }
                  : {
                      to: "/projects/$projectId/chats/$chatId" as const,
                      params: { projectId, chatId: chat.instanceId },
                    };
                return (
                  <button
                    key={chat.instanceId}
                    type="button"
                    onClick={() => navigate(route)}
                    className="flex items-start justify-between gap-3 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-surface-hover"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[0.8125rem] text-text-bright">{chat.title}</div>
                      <div className="truncate font-mono text-[0.625rem] text-muted">
                        {chat.instanceId}
                      </div>
                    </div>
                    <span className="shrink-0 text-[0.625rem] text-muted">
                      {formatTimeAgo(getChatRecencyTimestamp(chat))}
                    </span>
                  </button>
                );
              })}
            </div>
          ) : (
            <div className="text-[0.75rem] text-muted">No chats linked to this task yet.</div>
          )}
        </div>

        <div className="mb-4 text-[0.6875rem] text-muted">
          Updated {formatTimeAgo(task.updatedAt)}
        </div>

        {/* Description */}
        {editing ? (
          <div className="mb-4">
            <label className="mb-1.5 block text-[0.6875rem] font-medium text-muted">
              Description
            </label>
            <Textarea
              value={editDescription}
              onChange={(e) => setEditDescription(e.target.value)}
              rows={6}
              inputSize="sm"
              className="!text-[0.8125rem]"
              placeholder="Markdown description..."
            />
          </div>
        ) : task.description ? (
          <div className="prose-sm text-sm">
            <MarkdownContent text={task.description} />
          </div>
        ) : (
          <p className="text-sm text-muted italic">No description</p>
        )}
        <div className="mt-6 border-t border-border/70 pt-4">
          <h4 className="mb-2 text-[0.6875rem] font-medium text-muted">Discussion</h4>
          {commentsLoading ? (
            <p className="text-[0.75rem] text-muted">Loading discussion…</p>
          ) : commentsError ? (
            <p className="mb-3 text-[0.75rem] text-error">Discussion could not be loaded.</p>
          ) : comments.length > 0 ? (
            <div className="mb-3 flex flex-col gap-2">
              {comments.map((comment: TaskComment) => (
                <div key={comment.id} className="rounded-md bg-surface-inset/50 px-3 py-2">
                  <div className="mb-1 flex items-center justify-between gap-2 text-[0.625rem] text-muted">
                    <span>{comment.author || "Relay user"}</span>
                    <span>{formatTimeAgo(comment.createdAt)}</span>
                  </div>
                  <div className="whitespace-pre-wrap text-[0.8125rem] text-text">
                    {comment.body}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="mb-3 text-[0.75rem] text-muted">No discussion yet.</p>
          )}
          {!readOnly && (
            <div className="flex items-end gap-2">
              <Textarea
                value={commentBody}
                onChange={(event) => setCommentBody(event.target.value)}
                rows={2}
                inputSize="sm"
                placeholder="Add a comment"
                className="flex-1"
              />
              <Button
                variant="primary"
                size="sm"
                className="max-[768px]:min-h-10"
                disabled={commentSubmitting || !commentBody.trim()}
                onClick={async () => {
                  setCommentSubmitting(true);
                  setCommentError("");
                  try {
                    await addTaskCommentApi(
                      projectId,
                      task.id,
                      { body: commentBody.trim() },
                      { spaceId },
                    );
                    setCommentBody("");
                    await queryClient.invalidateQueries({ queryKey: commentsQueryKey });
                  } catch (error) {
                    setCommentError(
                      error instanceof Error ? error.message : "Failed to add comment",
                    );
                  } finally {
                    setCommentSubmitting(false);
                  }
                }}
              >
                <Send size={12} />
                Comment
              </Button>
            </div>
          )}
          {commentError && <p className="mt-2 text-[0.75rem] text-error">{commentError}</p>}
        </div>
      </Drawer.Body>
      <ConfirmActionDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title="Delete task?"
        description={
          <>
            <span className="font-medium text-text">{task.title}</span> will be deleted from this
            project&apos;s task list.
          </>
        }
        confirmLabel="Delete"
        onConfirm={() => {
          setConfirmDelete(false);
          onDelete(task);
        }}
      />
    </>
  );
}

// ─── Stacked Drawer ─────────────────────────────────────────────────────────

interface StackItem {
  key: string;
  taskId: string;
  open: boolean;
}

function StackedDrawer({
  projectId,
  spaceId,
  item,
  task,
  allTasks,
  isFirst,
  reversedPosition,
  onClose,
  onSelectTask,
  onUpdate,
  onDelete,
  onStartChat,
  onStartSpace,
  readOnly,
}: {
  projectId: string;
  spaceId?: string;
  item: StackItem;
  task: Task | null;
  allTasks: Task[];
  isFirst: boolean;
  reversedPosition: number;
  onClose: () => void;
  onSelectTask: (id: string) => void;
  onUpdate: (task: Task, patch: Partial<Task>) => void;
  onDelete: (task: Task) => void;
  onStartChat: (task: Task) => void;
  onStartSpace: (task: Task) => void;
  readOnly?: boolean;
}) {
  const {
    data: fetchedTask,
    isLoading: taskLoading,
    isError: taskError,
  } = useQuery({
    queryKey: ["task", projectId, spaceId ?? "main", item.taskId],
    queryFn: () => fetchTask(projectId, item.taskId, { spaceId }),
    enabled: item.open && !task,
  });
  const lastTask = useRef<Task | null>(null);
  const resolvedTask = task ?? fetchedTask ?? null;
  if (resolvedTask) lastTask.current = resolvedTask;
  const display = resolvedTask ?? lastTask.current;

  const isClosing = !item.open;
  const stackStyle: React.CSSProperties =
    reversedPosition > 0 && !isClosing
      ? {
          transform: `translateX(${-reversedPosition * 20}px) scale(${1 - reversedPosition * 0.03})`,
          opacity: Math.max(1 - reversedPosition * 0.04, 0.85),
        }
      : {};

  return (
    <Drawer.Root open={item.open} onOpenChange={(o) => !o && onClose()}>
      <Drawer.Content showBackdrop={isFirst} style={stackStyle}>
        {display && (
          <TaskDrawerBody
            key={display.id}
            projectId={projectId}
            spaceId={spaceId}
            task={display}
            allTasks={allTasks}
            onSelectTask={onSelectTask}
            onUpdate={onUpdate}
            onDelete={onDelete}
            onStartChat={onStartChat}
            onStartSpace={onStartSpace}
            readOnly={readOnly}
            showBack={!isFirst}
            onBack={onClose}
          />
        )}
        {!display && taskLoading && <div className="p-5 text-sm text-muted">Loading task…</div>}
        {!display && !taskLoading && (
          <div className="p-5 text-sm text-muted">
            {taskError
              ? "This task could not be loaded."
              : "This task was not found in this Space."}
          </div>
        )}
      </Drawer.Content>
    </Drawer.Root>
  );
}

// ─── Kanban Column ──────────────────────────────────────────────────────────

function KanbanColumn({
  status,
  tasks,
  mobile,
  onSelectTask,
  onStartChat,
  canStartChat,
}: {
  status: string;
  tasks: Task[];
  mobile?: boolean;
  onSelectTask: (id: string) => void;
  onStartChat: (task: Task) => void;
  canStartChat?: boolean;
}) {
  if (tasks.length === 0) return null;

  const label = statusLabels[status] ?? status;

  return (
    <div className={mobile ? "flex flex-col" : "flex min-w-[280px] max-w-[320px] flex-1 flex-col"}>
      <div className="mb-2 flex items-center gap-2 px-1">
        <StatusIcon status={status} size={14} />
        <h3 className="text-[0.6875rem] font-medium text-muted">{label}</h3>
        <span className="text-[0.625rem] text-muted/60">{tasks.length}</span>
      </div>
      <div
        className={
          mobile ? "flex flex-col gap-2" : "flex flex-1 flex-col gap-2 overflow-y-auto pr-1"
        }
      >
        {tasks.map((task) => (
          <TaskCard
            key={task.id}
            task={task}
            onClick={() => onSelectTask(task.id)}
            onStartChat={onStartChat}
            canStartChat={canStartChat}
          />
        ))}
      </div>
    </div>
  );
}

// ─── Create Task Form ───────────────────────────────────────────────────────

function CreateTaskForm({
  projectId,
  spaceId,
  allTasks,
  onCreated,
}: {
  projectId: string;
  spaceId?: string;
  allTasks: Task[];
  onCreated: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState(2);
  const [type, setType] = useState<TaskType>("task");
  const [tags, setTags] = useState("");
  const [parent, setParent] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const reset = () => {
    setTitle("");
    setDescription("");
    setPriority(2);
    setType("task");
    setTags("");
    setParent("");
    setError("");
  };

  const close = () => {
    setOpen(false);
    reset();
  };

  const handleSubmit = async () => {
    if (!title.trim()) return;
    setSubmitting(true);
    setError("");
    try {
      await createTaskApi(
        projectId,
        {
          title: title.trim(),
          description: description.trim() || undefined,
          priority,
          type,
          tags: tags
            .split(",")
            .map((t) => t.trim())
            .filter(Boolean),
          parent: parent || null,
        },
        { spaceId },
      );
      const createdTitle = title.trim();
      close();
      onCreated();
      toast.success(`Created "${createdTitle}"`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create task");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
        <Plus size={14} />
        New Task
      </Button>
      <Dialog.Root open={open} onOpenChange={(o) => !o && close()}>
        {open && (
          <Dialog.Content maxWidth="max-w-lg">
            <Dialog.Header>
              <Dialog.Title>New task</Dialog.Title>
              <Dialog.Close />
            </Dialog.Header>
            <div className="flex flex-col gap-3">
              <Input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Task title"
                inputSize="sm"
                className="!text-sm text-text-bright"
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) handleSubmit();
                }}
              />
              <Textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Description (markdown)"
                rows={3}
                inputSize="sm"
              />
              <div className="flex flex-wrap gap-2">
                <Select value={priority} onChange={(e) => setPriority(Number(e.target.value))}>
                  {[0, 1, 2, 3, 4].map((p) => (
                    <option key={p} value={p}>
                      {priorityLabels[p]}
                    </option>
                  ))}
                </Select>
                <Select value={type} onChange={(e) => setType(e.target.value as TaskType)}>
                  {(["task", "epic", "bug"] as TaskType[]).map((t) => (
                    <option key={t} value={t}>
                      {typeLabels[t]}
                    </option>
                  ))}
                </Select>
                <Input
                  type="text"
                  value={tags}
                  onChange={(e) => setTags(e.target.value)}
                  placeholder="Tags (comma-sep)"
                  inputSize="sm"
                  className="!w-auto"
                />
                {allTasks.length > 0 && (
                  <Select
                    value={parent}
                    onChange={(e) => setParent(e.target.value)}
                    className="max-w-[200px]"
                  >
                    <option value="">No parent</option>
                    {allTasks.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.id} — {t.title}
                      </option>
                    ))}
                  </Select>
                )}
              </div>
              {error && (
                <div className="rounded-lg border border-error/25 bg-error/5 px-3 py-2 text-[0.8125rem] text-error">
                  {error}
                </div>
              )}
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={close} disabled={submitting}>
                Cancel
              </Button>
              <Button
                variant="primary"
                size="sm"
                onClick={handleSubmit}
                disabled={submitting || !title.trim()}
              >
                {submitting ? "Creating..." : "Create task"}
              </Button>
            </div>
          </Dialog.Content>
        )}
      </Dialog.Root>
    </>
  );
}

// ─── Main ───────────────────────────────────────────────────────────────────

export function TasksPage() {
  const { artifacts } = useProjectContext();
  const isMobile = useMediaQuery("(max-width: 768px)");
  const {
    task: selectedId,
    sort: sortParam,
    space: spaceParam,
    view: viewParam,
  } = useSearch({
    from: "/_app/projects/$projectId/tasks/",
  });
  const navigate = useNavigate({ from: "/projects/$projectId/tasks/" });
  const [stack, setStack] = useState<StackItem[]>([]);
  const [snippet, setSnippet] = useState<string | null>(null);
  const projectId = artifacts.projectId;
  const queryClient = useQueryClient();
  const view: TaskListView = viewParam === "history" ? "history" : "unfinished";
  const { data: spaces = artifacts.spaces } = useQuery({
    queryKey: ["spaces", projectId],
    queryFn: () => fetchAllSpaces(projectId),
    initialData: artifacts.spaces,
  });
  const spaceId = normalizeTaskSpaceId(spaceParam, spaces);
  const selectedSpace = spaces.find((space) => space.id === spaceId);
  const scopeName = selectedSpace?.name ?? (spaceId ? "the selected Space" : "Main");
  const scopeIsWritable = !selectedSpace || selectedSpace.status === "active";

  const tasksQuery = useScopedTasks(projectId, spaceId, {
    view,
    initialData:
      !spaceId && view === "unfinished" && hasRevisionedTaskShape(artifacts.tasks)
        ? artifacts.tasks
        : undefined,
  });
  const tasks = tasksQuery.data;

  const currentSort: SortKey =
    sortParam && SORT_OPTIONS.some((o) => o.key === sortParam)
      ? (sortParam as SortKey)
      : "priority";

  const refreshTasks = async () => {
    await queryClient.invalidateQueries({ queryKey: ["tasks", projectId, taskScopeKey(spaceId)] });
  };

  const handleMutationError = async (error: unknown, fallback: string) => {
    if (error instanceof TaskApiError && error.status === 409) {
      await refreshTasks();
      toast.error("This task changed on disk. Reloaded the latest version; review it and retry.");
      return;
    }
    toast.error(error instanceof Error ? error.message : fallback);
  };

  const handleCopySnippet = async () => {
    if (!snippet) return;
    try {
      await navigator.clipboard.writeText(snippet);
      toast.success("Copied task instructions");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to copy task instructions");
    }
  };

  const handleUpdate = async (task: Task, patch: Partial<Task>) => {
    try {
      await updateTaskApi(
        projectId,
        task.id,
        { ...patch, expectedRevision: task.revision },
        { spaceId },
      );
      await refreshTasks();
      await queryClient.invalidateQueries({
        queryKey: ["task", projectId, taskScopeKey(spaceId), task.id],
      });
      if (patch.title || patch.description || patch.priority != null || patch.type || patch.tags) {
        toast.success("Task updated");
      }
    } catch (e) {
      await handleMutationError(e, "Failed to update task");
    }
  };

  const handleDelete = async (task: Task) => {
    try {
      await deleteTaskApi(projectId, task.id, task.revision, { spaceId });
      setStack([]);
      navigate({ search: patchTasksSearch({ task: undefined }) });
      await refreshTasks();
      toast.success("Task deleted");
    } catch (e) {
      await handleMutationError(e, "Failed to delete task");
    }
  };

  const maybePromoteTaskToInProgress = async (task: Task, targetSpaceId = spaceId) => {
    if (task.status !== "open") return true;
    const previousStatus = task.status;
    try {
      const updated = await updateTaskApi(
        projectId,
        task.id,
        { status: "in_progress", expectedRevision: task.revision },
        { spaceId: targetSpaceId },
      );
      await queryClient.invalidateQueries({
        queryKey: ["tasks", projectId, taskScopeKey(targetSpaceId)],
      });
      toast.success("Task moved to In Progress", {
        action: {
          label: "Undo",
          onClick: () => {
            void updateTaskApi(
              projectId,
              task.id,
              { status: previousStatus, expectedRevision: updated.revision },
              { spaceId: targetSpaceId },
            )
              .then(() =>
                queryClient.invalidateQueries({
                  queryKey: ["tasks", projectId, taskScopeKey(targetSpaceId)],
                }),
              )
              .catch(() => {
                toast.error("Failed to restore task status");
              });
          },
        },
      });
      return true;
    } catch (error) {
      // Non-fatal — chat creation already succeeded.
      if (error instanceof TaskApiError && error.status === 404) return false;
      return true;
    }
  };

  const handleStartChat = async (task: Task) => {
    if (!artifacts.directory) {
      toast.error("Project directory not found");
      return;
    }
    try {
      const created = spaceId
        ? await createInstance({ spaceId })
        : await createInstance({ workingDirectory: artifacts.directory });
      const draft = buildTaskReference(task);
      sessionStorage.setItem(`relay:draft:${created.id}`, draft);
      await maybePromoteTaskToInProgress(task);
      await navigate(getInstanceChatRoute(created));
    } catch (e) {
      if (!reportCreateInstanceError(e, () => handleStartChat(task))) {
        toast.error(e instanceof Error ? e.message : "Failed to start chat");
      }
    }
  };

  const handleStartSpace = async (task: Task) => {
    // Create the chat for an existing space. Capacity-only failures retry just
    // this step so we don't create a second space for the one already made.
    const startChatInSpace = async (newSpaceId: string) => {
      try {
        const created = await createInstance({ spaceId: newSpaceId });
        const draft = buildTaskReference(task);
        sessionStorage.setItem(`relay:draft:${created.id}`, draft);
        const taskInNewSpace = await fetchTask(projectId, task.id, { spaceId: newSpaceId });
        if (taskInNewSpace) {
          await maybePromoteTaskToInProgress(taskInNewSpace, newSpaceId);
        } else {
          toast.warning(
            "Space created, but this task is not in its worktree. Commit the task file before creating a Space, or add it to the new Space.",
          );
        }
        await queryClient.invalidateQueries({ queryKey: ["spaces", projectId] });
        await navigate(getSpaceRoute(projectId, newSpaceId, created.id));
      } catch (e) {
        if (!reportCreateInstanceError(e, () => startChatInSpace(newSpaceId))) {
          toast.error(e instanceof Error ? e.message : "Failed to start space");
        }
      }
    };

    try {
      const space = await createSpace(projectId, {
        name: task.title,
        description: task.description || undefined,
        baseBranch: selectedSpace?.gitBranch || undefined,
      });
      await startChatInSpace(space.id);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to start space");
    }
  };

  // Sync URL → stack (initial load, browser back/forward)
  useEffect(() => {
    if (selectedId) {
      setStack((prev) => {
        if (prev.length === 0 || prev[0].taskId !== selectedId) {
          return [{ key: "base", taskId: selectedId, open: false }];
        }
        return prev;
      });
      requestAnimationFrame(() => {
        setStack((prev) => {
          const first = prev[0];
          if (first && !first.open && first.taskId === selectedId) {
            return [{ ...first, open: true }];
          }
          return prev;
        });
      });
    } else {
      setStack([]);
    }
  }, [selectedId]);

  const selectTask = (id: string) => {
    setStack([{ key: "base", taskId: id, open: false }]);
    navigate({ search: patchTasksSearch({ task: id }) });
    requestAnimationFrame(() => {
      setStack((prev) => {
        const first = prev[0];
        if (first && !first.open) {
          return [{ ...first, open: true }];
        }
        return prev;
      });
    });
  };

  const pushDrawer = (taskId: string) => {
    setStack((prev) => {
      const top = prev[prev.length - 1];
      if (top?.taskId === taskId) return prev;
      const key = `stacked-${Date.now()}`;
      return [...prev, { key, taskId, open: false }];
    });
    requestAnimationFrame(() => {
      setStack((prev) => {
        const last = prev[prev.length - 1];
        if (last && !last.open) {
          return prev.map((s, i) => (i === prev.length - 1 ? { ...s, open: true } : s));
        }
        return prev;
      });
    });
  };

  const popAt = (idx: number) => {
    if (idx === 0) {
      setStack((prev) => prev.map((s) => ({ ...s, open: false })));
      setTimeout(() => {
        setStack([]);
        navigate({ search: patchTasksSearch({ task: undefined }) });
      }, 200);
    } else {
      setStack((prev) => prev.map((s, i) => (i >= idx ? { ...s, open: false } : s)));
      setTimeout(() => {
        setStack((prev) => prev.slice(0, idx));
      }, 200);
    }
  };

  // ─── Empty state: init tasks or migrate ─────────────────────────────────

  const scopeControls = (
    <div className="flex flex-wrap items-center gap-2">
      <Select
        value={spaceId ?? ""}
        onChange={(event) => {
          const nextSpaceId = event.target.value || undefined;
          setStack([]);
          navigate({
            search: patchTasksSearch({ space: nextSpaceId, task: undefined }),
            replace: true,
          });
        }}
        aria-label="Task Space"
      >
        <option value="">Main</option>
        {spaces
          .filter((space: SpaceInfo) => !space.isDefault)
          .map((space: SpaceInfo) => (
            <option key={space.id} value={space.id}>
              {space.name}
              {space.status === "active" ? "" : ` (${space.status})`}
            </option>
          ))}
      </Select>
      <div className="flex rounded-md border border-border p-0.5">
        {(["unfinished", "history"] as TaskListView[]).map((option) => (
          <button
            key={option}
            type="button"
            onClick={() =>
              navigate({
                search: patchTasksSearch({
                  view: option === "history" ? "history" : undefined,
                  task: undefined,
                }),
                replace: true,
              })
            }
            className={`rounded px-2.5 py-1 text-[0.75rem] font-medium max-[768px]:min-h-10 ${
              view === option ? "bg-surface-hover text-text" : "text-muted hover:text-text"
            }`}
          >
            {option === "unfinished" ? "Unfinished" : "History"}
          </button>
        ))}
      </div>
    </div>
  );

  if (tasksQuery.isError) {
    return (
      <PageShell>
        <EmptyState
          icon={<ListChecks size={24} strokeWidth={1.5} />}
          title={`Could not load tasks from ${scopeName}`}
          description={
            tasksQuery.error instanceof Error
              ? tasksQuery.error.message
              : "Task files could not be read."
          }
        >
          <div className="mt-5 flex flex-col items-center gap-3">
            {scopeControls}
            <Button size="sm" onClick={() => tasksQuery.refetch()}>
              Retry
            </Button>
          </div>
        </EmptyState>
      </PageShell>
    );
  }

  if (tasks === null) {
    return (
      <PageShell>
        <EmptyState
          icon={<ListChecks size={24} strokeWidth={1.5} />}
          title="No tasks initialized"
          description={`Initialize task tracking in ${scopeName}`}
        >
          <div className="mt-5 flex flex-col items-center gap-4">
            {scopeControls}
            <Button
              size="sm"
              onClick={async () => {
                try {
                  const result = await initTasksApi(projectId, { spaceId });
                  setSnippet(result.snippet);
                  await refreshTasks();
                  toast.success("Initialized tasks");
                } catch (e) {
                  console.error("Failed to init tasks:", e);
                  toast.error(e instanceof Error ? e.message : "Failed to initialize tasks");
                }
              }}
            >
              Initialize Tasks
            </Button>
            {snippet && (
              <div className="mt-4 w-full max-w-lg text-left">
                <p className="mb-2 text-xs text-muted">
                  Add this to your CLAUDE.md or AGENTS.md so models know about tasks:
                </p>
                <div className="relative rounded-md border border-border bg-surface p-3">
                  <pre className="overflow-x-auto text-xs text-text">{snippet}</pre>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="absolute top-2 right-2 !text-[0.625rem]"
                    onClick={() => {
                      void handleCopySnippet();
                    }}
                  >
                    Copy
                  </Button>
                </div>
              </div>
            )}
          </div>
        </EmptyState>
      </PageShell>
    );
  }

  if (!tasks) return null;

  const statusOrder = TASK_VIEW_STATUSES[view];
  const visibleTasks = filterTasksForView(tasks, view);
  const openItems = stack.filter((item) => item.open);
  const drawerStack = stack.map((item, index) => {
    const task = tasks.find((candidate) => candidate.id === item.taskId) ?? null;
    const posInOpen = openItems.findIndex((candidate) => candidate.key === item.key);
    const reversedPosition = posInOpen >= 0 ? openItems.length - posInOpen - 1 : 0;

    return (
      <StackedDrawer
        key={item.key}
        projectId={projectId}
        spaceId={spaceId}
        item={item}
        task={task}
        allTasks={tasks}
        isFirst={index === 0}
        reversedPosition={reversedPosition}
        onClose={() => popAt(index)}
        onSelectTask={pushDrawer}
        onUpdate={handleUpdate}
        onDelete={handleDelete}
        onStartChat={handleStartChat}
        onStartSpace={handleStartSpace}
        readOnly={!scopeIsWritable}
      />
    );
  });

  if (visibleTasks.length === 0) {
    return (
      <PageShell>
        <EmptyState
          icon={<ListChecks size={24} strokeWidth={1.5} />}
          title={view === "history" ? "No completed or cancelled tasks" : "No unfinished tasks"}
          description={
            view === "history"
              ? `Task history in ${scopeName} will appear here.`
              : `Create a task in ${scopeName} to start tracking work.`
          }
        >
          <div className="mt-5 flex flex-col items-center gap-3">
            {scopeControls}
            {view === "unfinished" && scopeIsWritable && (
              <CreateTaskForm
                projectId={projectId}
                spaceId={spaceId}
                allTasks={tasks}
                onCreated={refreshTasks}
              />
            )}
          </div>
        </EmptyState>
        {drawerStack}
      </PageShell>
    );
  }

  // ─── Kanban view ────────────────────────────────────────────────────────

  const setSort = (key: SortKey) => {
    navigate({
      search: patchTasksSearch({
        sort: key === "priority" ? undefined : key,
      }),
      replace: true,
    });
  };

  const grouped = Object.fromEntries(
    statusOrder.map((s) => [
      s,
      sortTasks(
        visibleTasks.filter((t) => t.status === s),
        getColumnSortKey(s, currentSort),
      ),
    ]),
  );

  const sortLabel = SORT_OPTIONS.find((o) => o.key === currentSort)?.label ?? "Priority";

  const sortMenu = (
    <Menu.Root>
      <Menu.Trigger className="flex h-8 items-center gap-1 rounded-md border border-border px-2.5 text-[0.75rem] font-medium text-muted transition-colors hover:bg-surface-hover hover:text-text">
        <ArrowDownNarrowWide size={12} />
        {sortLabel}
      </Menu.Trigger>
      <Menu.Content>
        {SORT_OPTIONS.map((option) => (
          <Menu.Item key={option.key} onClick={() => setSort(option.key)}>
            <span className="flex-1">{option.label}</span>
            {currentSort === option.key && <Check size={14} className="shrink-0" />}
          </Menu.Item>
        ))}
      </Menu.Content>
    </Menu.Root>
  );

  if (isMobile) {
    return (
      <div className="flex-1 overflow-y-auto">
        <div className="flex flex-wrap items-center justify-between gap-2 px-4 pt-3 pb-1">
          {scopeControls}
          {view === "unfinished" && scopeIsWritable && (
            <CreateTaskForm
              projectId={projectId}
              spaceId={spaceId}
              allTasks={tasks}
              onCreated={refreshTasks}
            />
          )}
          {sortMenu}
        </div>
        <div className="flex flex-col gap-6 px-4 py-2">
          {statusOrder.map((s) => (
            <KanbanColumn
              key={s}
              status={s}
              tasks={grouped[s]}
              mobile
              onSelectTask={selectTask}
              onStartChat={handleStartChat}
              canStartChat={scopeIsWritable}
            />
          ))}
        </div>
        {drawerStack}
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-2 px-6 pt-3 pb-1">
        {scopeControls}
        <div className="flex items-center gap-2">
          {view === "unfinished" && scopeIsWritable && (
            <CreateTaskForm
              projectId={projectId}
              spaceId={spaceId}
              allTasks={tasks}
              onCreated={refreshTasks}
            />
          )}
          {sortMenu}
        </div>
      </div>
      <div className="flex flex-1 gap-4 overflow-x-auto px-6 py-2">
        {statusOrder.map((s) => (
          <KanbanColumn
            key={s}
            status={s}
            tasks={grouped[s]}
            onSelectTask={selectTask}
            onStartChat={handleStartChat}
            canStartChat={scopeIsWritable}
          />
        ))}
      </div>
      {drawerStack}
    </div>
  );
}
