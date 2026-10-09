import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Reorder, useDragControls } from "motion/react";
import { ChevronDown, Zap, GripVertical, ListOrdered, Paperclip, Pencil, X } from "lucide-react";
import type { UserChatItem } from "@/lib/chat-types";
import { Tooltip } from "../ui/tooltip";
import { ComposerDock } from "./input-area/composer-dock";

export type QueuedChatItem = UserChatItem & { queued: true; queuedId: string };

export function isQueuedChatItem(item: { kind: string }): item is QueuedChatItem {
  return (
    item.kind === "user" && !!(item as UserChatItem).queued && !!(item as UserChatItem).queuedId
  );
}

interface QueuedMessagesTrayProps {
  items: QueuedChatItem[];
  isMobile: boolean;
  /** Interrupt the running turn and deliver the queue now. Absent when idle. */
  onSendNow?: (queuedId: string) => void;
  onEdit: (item: QueuedChatItem) => void;
  onRemove: (queuedId: string) => void;
  onReorder: (queuedIds: string[]) => void;
}

function previewText(item: QueuedChatItem): string {
  const text = (item.queuedSourceText ?? item.text).replace(/\s+/g, " ").trim();
  if (text) return text;
  const count = (item.queuedImages?.length ?? 0) + (item.queuedAttachments?.length ?? 0);
  return `${count} attachment${count === 1 ? "" : "s"}`;
}

const ACTION_CLASS =
  "flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-[0.75rem] text-muted transition-colors hover:bg-hover-highlight hover:text-text max-[768px]:min-h-10 max-[768px]:min-w-10 max-[768px]:justify-center";

/**
 * Messages queued while the agent works, docked above the composer. Drag the
 * grip to reorder (the queue is delivered top to bottom, coalesced into one
 * turn); Send now interrupts the running turn to deliver that one message,
 * leaving the rest queued.
 */
export function QueuedMessagesTray({
  items,
  isMobile,
  onSendNow,
  onEdit,
  onRemove,
  onReorder,
}: QueuedMessagesTrayProps) {
  const [collapsed, setCollapsed] = useState(false);
  const serverOrder = items.map((item) => item.queuedId);
  const serverKey = serverOrder.join("\n");
  // Local order while dragging; committed to the server on drop.
  const [order, setOrder] = useState(serverOrder);
  const orderRef = useRef(order);
  orderRef.current = order;
  const draggingRef = useRef(false);

  useEffect(() => {
    if (!draggingRef.current) setOrder(serverKey ? serverKey.split("\n") : []);
  }, [serverKey]);

  if (items.length === 0) return null;
  const byId = new Map(items.map((item) => [item.queuedId, item]));
  const visibleOrder = order.filter((id) => byId.has(id));
  for (const id of serverOrder) if (!visibleOrder.includes(id)) visibleOrder.push(id);
  const canReorder = items.length > 1;

  const commit = () => {
    draggingRef.current = false;
    const next = orderRef.current.filter((id) => byId.has(id));
    if (next.join("\n") !== serverKey) onReorder(next);
  };

  return (
    <ComposerDock isMobile={isMobile}>
      <button
        type="button"
        onClick={() => setCollapsed((value) => !value)}
        aria-expanded={!collapsed}
        className="flex w-full items-center gap-2 px-3 pb-1 pt-2 text-[0.8125rem] text-muted transition-colors hover:text-text max-[768px]:min-h-10"
      >
        <ListOrdered size={14} className="shrink-0" />
        <span className="flex-1 text-left">Queued</span>
        <span className="tabular-nums">{items.length}</span>
        <ChevronDown
          size={14}
          className={`shrink-0 transition-transform ${collapsed ? "-rotate-90" : ""}`}
        />
      </button>
      {!collapsed && (
        <Reorder.Group
          axis="y"
          values={visibleOrder}
          onReorder={setOrder}
          className="flex max-h-48 flex-col overflow-y-auto pb-1"
        >
          {visibleOrder.map((id) => (
            <QueuedRow
              key={id}
              item={byId.get(id)!}
              isMobile={isMobile}
              canReorder={canReorder}
              onDragStart={() => {
                draggingRef.current = true;
              }}
              onDragEnd={commit}
              onSendNow={onSendNow}
              onEdit={onEdit}
              onRemove={onRemove}
            />
          ))}
        </Reorder.Group>
      )}
    </ComposerDock>
  );
}

function QueuedRow({
  item,
  isMobile,
  canReorder,
  onDragStart,
  onDragEnd,
  onSendNow,
  onEdit,
  onRemove,
}: {
  item: QueuedChatItem;
  isMobile: boolean;
  canReorder: boolean;
  onDragStart: () => void;
  onDragEnd: () => void;
  onSendNow?: (queuedId: string) => void;
  onEdit: (item: QueuedChatItem) => void;
  onRemove: (queuedId: string) => void;
}) {
  const controls = useDragControls();
  const attachmentCount = (item.queuedImages?.length ?? 0) + (item.queuedAttachments?.length ?? 0);
  const startDrag = (event: ReactPointerEvent) => {
    if (!canReorder) return;
    event.preventDefault();
    controls.start(event);
  };

  return (
    <Reorder.Item
      value={item.queuedId}
      dragListener={false}
      dragControls={controls}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      layout="position"
      className="group relative flex items-center gap-1 bg-surface px-1.5 text-[0.8125rem] text-text/90"
      whileDrag={{ scale: 1.01, boxShadow: "0 6px 20px rgb(0 0 0 / 0.12)", zIndex: 1 }}
    >
      <span
        onPointerDown={startDrag}
        aria-hidden="true"
        className={`flex shrink-0 items-center justify-center self-stretch text-muted/60 ${
          canReorder
            ? "cursor-grab touch-none hover:text-text active:cursor-grabbing"
            : "opacity-40"
        } ${isMobile ? "w-8" : "w-5"}`}
      >
        <GripVertical size={14} />
      </span>
      <span className="min-w-0 flex-1 truncate py-1">{previewText(item)}</span>
      {attachmentCount > 0 && (
        <span className="flex shrink-0 items-center gap-0.5 text-[0.75rem] text-muted">
          <Paperclip size={12} />
          {attachmentCount}
        </span>
      )}
      <Tooltip content="Edit">
        <button
          type="button"
          aria-label="Edit queued message"
          onClick={() => onEdit(item)}
          className={ACTION_CLASS}
        >
          <Pencil size={13} />
        </button>
      </Tooltip>
      {onSendNow && (
        <Tooltip content="Interrupt the current turn and send this message now">
          <button
            type="button"
            aria-label="Send this message now"
            onClick={() => onSendNow(item.queuedId)}
            className={ACTION_CLASS}
          >
            <Zap size={13} />
            {!isMobile && "Send now"}
          </button>
        </Tooltip>
      )}
      <Tooltip content="Remove">
        <button
          type="button"
          aria-label="Remove queued message"
          onClick={() => onRemove(item.queuedId)}
          className={`${ACTION_CLASS} hover:!bg-error-dim hover:!text-error`}
        >
          <X size={14} />
        </button>
      </Tooltip>
    </Reorder.Item>
  );
}
