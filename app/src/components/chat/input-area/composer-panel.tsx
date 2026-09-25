import { useRef, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import type { ComposerEditorHandle } from "../composer-editor";
import { ComposerEditor } from "../composer-editor";
import { ComposerTextarea } from "../composer-textarea";
import { useMediaQuery } from "@/hooks/use-media-query";
import { useNativeMobileComposer } from "@/hooks/use-native-mobile-composer";
import { useTaskMentionPopover, TaskMentionPopoverOverlay } from "../task-mention-popover";
import type { Task } from "@shared/types";

interface ComposerPanelProps {
  compact: boolean;
  projectId?: string;
  spaceId?: string;
  tasks: Task[] | null;
  disabled: boolean;
  value: string;
  placeholder: string;
  topContent?: ReactNode;
  selectionOffset: number | null;
  onSelectionApplied: () => void;
  onChange: (value: string, selectionOffset: number) => void;
  onKeyDown: (event: React.KeyboardEvent) => void;
  onPaste: (event: React.ClipboardEvent) => void;
  composerMenu: ReactNode;
  toolbar: ReactNode;
  composerRef: React.RefObject<ComposerEditorHandle | null>;
  /** When true, allow the editor to expand taller (e.g. empty chat with a pre-filled spin-off draft). */
  expanded?: boolean;
}

export function ComposerPanel({
  compact,
  projectId,
  spaceId,
  tasks,
  disabled,
  value,
  placeholder,
  topContent,
  selectionOffset,
  onSelectionApplied,
  onChange,
  onKeyDown,
  onPaste,
  composerMenu,
  toolbar,
  composerRef,
  expanded,
}: ComposerPanelProps) {
  const editorContainerRef = useRef<HTMLDivElement>(null);
  const [nativeMobileComposer] = useNativeMobileComposer();
  const isCoarsePointer = useMediaQuery("(pointer: coarse)");
  // Experiment: native textarea on touch devices (Settings → General).
  const Editor = nativeMobileComposer && isCoarsePointer ? ComposerTextarea : ComposerEditor;
  const { popoverState, close: closeTaskPopover } = useTaskMentionPopover(editorContainerRef, {
    projectId,
    spaceId,
    tasks,
  });

  return (
    <>
      <AnimatePresence initial={false}>
        {topContent ? (
          <motion.div
            key="composer-top-content"
            initial={{ opacity: 0, y: 18, height: 0 }}
            animate={{ opacity: 1, y: 0, height: "auto" }}
            exit={{ opacity: 0, y: 18, height: 0 }}
            transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
            className="overflow-hidden"
          >
            {topContent}
          </motion.div>
        ) : null}
      </AnimatePresence>
      <div ref={editorContainerRef}>
        <Editor
          ref={composerRef}
          value={value}
          placeholder={placeholder}
          placeholderClassName={
            compact
              ? "px-3 pt-2.5 pb-1.5 text-[15px] leading-snug"
              : "px-4 pt-3 pb-1 text-[13px] leading-normal"
          }
          disabled={disabled}
          selectionOffset={selectionOffset}
          onSelectionApplied={onSelectionApplied}
          onChange={onChange}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          className={
            compact
              ? `min-h-[44px] ${expanded ? "max-h-[50vh]" : "max-h-[88px]"} overflow-y-auto bg-transparent px-3 pt-2.5 pb-1.5 text-[16px] leading-snug text-text outline-none placeholder:text-muted ${disabled ? "opacity-40" : ""}`
              : `min-h-[52px] ${expanded ? "max-h-[50vh]" : "max-h-[140px]"} overflow-y-auto bg-transparent px-4 pt-3 pb-1 text-sm leading-normal text-text outline-none placeholder:text-muted ${disabled ? "opacity-40" : ""}`
          }
        />
      </div>
      <TaskMentionPopoverOverlay popoverState={popoverState} onClose={closeTaskPopover} />
      {composerMenu}
      {toolbar}
    </>
  );
}
