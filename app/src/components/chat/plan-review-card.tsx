import { useState, useRef, useCallback, useEffect } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "motion/react";
import { MessageSquarePlus, Pencil, Trash2 } from "lucide-react";
import { MarkdownContent } from "./markdown-content";

export interface PlanComment {
  id: string;
  quotedText: string;
  comment: string;
}

let commentIdCounter = 0;
function nextCommentId(): string {
  return `pc-${++commentIdCounter}-${Date.now()}`;
}

/** Extract the first markdown heading as a plan title. */
function extractPlanTitle(plan: string): string | null {
  const match = plan.match(/^#+\s+(.+)$/m);
  return match?.[1]?.trim() ?? null;
}

/** Animated floating button that appears near text selection. */
function SelectionPopover({ rect, onAddComment }: { rect: DOMRect; onAddComment: () => void }) {
  return createPortal(
    <motion.button
      type="button"
      initial={{ opacity: 0, scale: 0.85, y: 4 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.85, y: 4 }}
      transition={{ duration: 0.15, ease: [0.22, 1, 0.36, 1] }}
      onMouseDown={(e) => {
        e.preventDefault();
        onAddComment();
      }}
      className="fixed z-50 flex items-center gap-1.5 rounded-lg border border-border bg-surface px-2.5 py-1.5 text-[0.75rem] font-medium text-accent shadow-lg transition-colors hover:bg-surface-hover"
      style={{
        left: rect.left + rect.width / 2,
        top: rect.top - 8,
        transform: "translate(-50%, -100%)",
      }}
    >
      <MessageSquarePlus size={13} />
      Comment on selection
    </motion.button>,
    document.body,
  );
}

/** Renders the list of inline comments below the plan. */
function CommentList({
  comments,
  onEdit,
  onDelete,
}: {
  comments: PlanComment[];
  onEdit: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  if (comments.length === 0) return null;

  return (
    <div className="border-t border-border/60 px-3.5 py-2.5 space-y-1.5">
      <p className="text-[0.625rem] font-semibold uppercase tracking-[0.18em] text-muted">
        Comments ({comments.length})
      </p>
      {comments.map((c, idx) => (
        <div
          key={c.id}
          className="group rounded-md border-l-2 border-accent/30 bg-surface-hover/50 px-3 py-2"
        >
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0 flex-1">
              {c.quotedText && (
                <div className="mb-1 text-[0.75rem] leading-relaxed text-muted line-clamp-2">
                  <span className="font-medium text-muted/70">{idx + 1}.</span> &ldquo;
                  {c.quotedText}&rdquo;
                </div>
              )}
              <p className="text-[0.8125rem] text-text">{c.comment}</p>
            </div>
            <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
              <button
                type="button"
                onClick={() => onEdit(c.id)}
                className="rounded p-1 text-muted transition-colors hover:bg-surface-hover hover:text-text"
              >
                <Pencil size={12} />
              </button>
              <button
                type="button"
                onClick={() => onDelete(c.id)}
                className="rounded p-1 text-muted transition-colors hover:bg-surface-hover hover:text-red-400"
              >
                <Trash2 size={12} />
              </button>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

/** Inline comment editor shown inside the panel. */
function InlineCommentEditor({
  initialComment,
  quotedText,
  onSave,
  onCancel,
}: {
  initialComment?: string;
  quotedText?: string;
  onSave: (comment: string) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState(initialComment ?? "");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  return (
    <div className="border-t border-accent/20 bg-accent/3 px-3.5 py-2.5">
      {quotedText && (
        <div className="mb-2 rounded-md border-l-2 border-accent/30 bg-surface-hover/50 px-3 py-1.5 text-[0.75rem] leading-relaxed text-muted line-clamp-3">
          &ldquo;{quotedText}&rdquo;
        </div>
      )}
      <textarea
        ref={textareaRef}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Add your comment..."
        rows={2}
        className="w-full resize-none rounded-md border border-border bg-bg px-3 py-2 text-[0.8125rem] text-text placeholder:text-muted focus:border-accent focus:ring-1 focus:ring-accent-dim focus:outline-none"
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && text.trim()) {
            e.preventDefault();
            onSave(text.trim());
          }
          if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          }
        }}
      />
      <div className="mt-2 flex items-center gap-2">
        <button
          type="button"
          onClick={() => text.trim() && onSave(text.trim())}
          disabled={!text.trim()}
          className="rounded-md bg-accent/10 px-3 py-1 text-[0.75rem] font-medium text-accent transition-colors hover:bg-accent/15 disabled:opacity-30"
        >
          Save
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md px-3 py-1 text-[0.75rem] font-medium text-muted transition-colors hover:text-text"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

// ── Exported panel component (docked above the composer) ──

interface PlanReviewPanelProps {
  plan: string;
  /** Callback to append a comment. The parent (InputArea) builds the final message. */
  onCommentsChange: (comments: PlanComment[]) => void;
  comments: PlanComment[];
}

export function PlanReviewPanel({ plan, onCommentsChange, comments }: PlanReviewPanelProps) {
  const planRef = useRef<HTMLDivElement>(null);
  const [selectionPopover, setSelectionPopover] = useState<{
    text: string;
    rect: DOMRect;
  } | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editorQuote, setEditorQuote] = useState<string | undefined>(undefined);
  const [showEditor, setShowEditor] = useState(false);

  const title = extractPlanTitle(plan);

  // Clear selection popover on scroll
  useEffect(() => {
    if (!selectionPopover) return;
    const clear = () => setSelectionPopover(null);
    window.addEventListener("scroll", clear, true);
    return () => window.removeEventListener("scroll", clear, true);
  }, [selectionPopover]);

  // Clear selection popover on click outside
  useEffect(() => {
    if (!selectionPopover) return;
    const handler = (e: MouseEvent) => {
      // If clicking the popover button itself, let it handle
      if ((e.target as Element)?.closest?.("[data-plan-popover]")) return;
      setSelectionPopover(null);
    };
    // Use a timeout so the current mouseup doesn't immediately fire
    const timer = setTimeout(() => {
      document.addEventListener("mousedown", handler);
    }, 0);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("mousedown", handler);
    };
  }, [selectionPopover]);

  const handleMouseUp = useCallback(() => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return;

    const text = sel.toString().trim();
    if (!text || text.length < 3) return;

    const range = sel.getRangeAt(0);
    if (!planRef.current?.contains(range.commonAncestorContainer)) return;

    const rect = range.getBoundingClientRect();
    setSelectionPopover({ text, rect });
  }, []);

  const handleAddCommentFromSelection = useCallback(() => {
    if (!selectionPopover) return;
    setEditorQuote(selectionPopover.text);
    setEditingId(null);
    setShowEditor(true);
    setSelectionPopover(null);
    window.getSelection()?.removeAllRanges();
  }, [selectionPopover]);

  const handleSaveComment = useCallback(
    (commentText: string) => {
      if (editingId) {
        onCommentsChange(
          comments.map((c) => (c.id === editingId ? { ...c, comment: commentText } : c)),
        );
      } else {
        onCommentsChange([
          ...comments,
          { id: nextCommentId(), quotedText: editorQuote ?? "", comment: commentText },
        ]);
      }
      setShowEditor(false);
      setEditingId(null);
      setEditorQuote(undefined);
    },
    [editingId, editorQuote, comments, onCommentsChange],
  );

  const handleCancelEditor = useCallback(() => {
    setShowEditor(false);
    setEditingId(null);
    setEditorQuote(undefined);
  }, []);

  const handleEditComment = useCallback(
    (id: string) => {
      const c = comments.find((x) => x.id === id);
      if (!c) return;
      setEditingId(id);
      setEditorQuote(c.quotedText || undefined);
      setShowEditor(true);
    },
    [comments],
  );

  const handleDeleteComment = useCallback(
    (id: string) => {
      onCommentsChange(comments.filter((c) => c.id !== id));
    },
    [comments, onCommentsChange],
  );

  return (
    <div>
      {/* Header */}
      <div className="flex items-center gap-3 px-3.5 pt-3 pb-2">
        <p className="text-[0.625rem] font-semibold uppercase tracking-[0.18em] text-accent/70">
          Plan ready
        </p>
        {title && (
          <>
            <span className="h-3 w-px bg-border/60" aria-hidden="true" />
            <p className="min-w-0 flex-1 truncate text-[0.8125rem] font-medium text-text-bright">
              {title}
            </p>
          </>
        )}
      </div>

      {/* Plan content — scrollable, selectable */}
      <div
        ref={planRef}
        className="max-h-[40vh] overflow-y-auto border-t border-border/40 px-3.5 py-2.5 text-[0.8125rem] cursor-text"
        onMouseUp={handleMouseUp}
      >
        <MarkdownContent text={plan} />
      </div>

      {/* Hint for text selection */}
      {comments.length === 0 && !showEditor && (
        <div className="flex items-center gap-1.5 px-3.5 pb-1.5 text-[0.625rem] text-muted/50">
          <MessageSquarePlus size={11} />
          Select text above to add inline comments
        </div>
      )}

      {/* Selection popover */}
      <AnimatePresence>
        {selectionPopover && (
          <SelectionPopover
            rect={selectionPopover.rect}
            onAddComment={handleAddCommentFromSelection}
          />
        )}
      </AnimatePresence>

      {/* Comments list */}
      <CommentList comments={comments} onEdit={handleEditComment} onDelete={handleDeleteComment} />

      {/* Inline comment editor */}
      {showEditor && (
        <InlineCommentEditor
          initialComment={editingId ? comments.find((c) => c.id === editingId)?.comment : undefined}
          quotedText={editorQuote}
          onSave={handleSaveComment}
          onCancel={handleCancelEditor}
        />
      )}
    </div>
  );
}
