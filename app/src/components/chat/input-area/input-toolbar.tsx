import { Children, type ReactNode, useEffect, useRef, useState } from "react";
import { Check, Ellipsis, Paperclip } from "lucide-react";
import { Button } from "../../ui/button";
import { Tooltip } from "../../ui/tooltip";
import { ActionButton } from "./action-button";
import "./input-toolbar.css";

export interface OverflowSection {
  label: string;
  options: { label: string; selected: boolean; onSelect: () => void }[];
}

interface InputToolbarProps {
  isMobile: boolean;
  disabled: boolean;
  controls: ReactNode[];
  isProcessing: boolean;
  showAttachButton?: boolean;
  overflowSections?: OverflowSection[];
  onCancel: () => void;
  /** When provided, shows a "Stop task" button alongside the full cancel. */
  onStopCurrentTask?: () => void;
  onAttach: () => void;
  onSend: () => void;
  sendLabel?: string;
  sendTooltip?: string;
  isSendDisabled: boolean;
  secondaryActionLabel?: string;
  onSecondaryAction?: () => void;
  isSecondaryActionDisabled?: boolean;
}

export function InputToolbar({
  isMobile,
  disabled,
  controls,
  isProcessing,
  showAttachButton = true,
  overflowSections,
  onCancel,
  onStopCurrentTask,
  onAttach,
  onSend,
  sendLabel,
  sendTooltip,
  isSendDisabled,
  secondaryActionLabel,
  onSecondaryAction,
  isSecondaryActionDisabled,
}: InputToolbarProps) {
  const [overflowOpen, setOverflowOpen] = useState(false);
  const overflowRef = useRef<HTMLDivElement>(null);
  const overflowTriggerRef = useRef<HTMLButtonElement>(null);
  const populatedControls = Children.toArray(controls);
  const hasSecondaryAction = !!secondaryActionLabel && !!onSecondaryAction;

  // First control (typically model picker) stays always visible; rest can overflow
  const primaryControl = populatedControls[0] ?? null;
  const overflowControls = populatedControls.slice(1);
  const hasOverflow = overflowControls.length > 0;

  // Close overflow when clicking outside
  useEffect(() => {
    if (!overflowOpen) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (overflowRef.current?.contains(target) || overflowTriggerRef.current?.contains(target))
        return;
      setOverflowOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [overflowOpen]);

  return (
    <div className={`relative flex items-center gap-0.5 px-2 ${isMobile ? "pb-1" : "pb-2"}`}>
      {/* Left section: attach + controls */}
      <div className="flex min-w-0 flex-1 items-center gap-2">
        {showAttachButton ? (
          <Tooltip content="Attach file">
            <Button
              variant="icon"
              onClick={onAttach}
              disabled={disabled}
              className="h-7 w-7 shrink-0 !rounded-full max-[768px]:h-9 max-[768px]:w-9"
            >
              <Paperclip size={15} />
            </Button>
          </Tooltip>
        ) : null}

        {showAttachButton && primaryControl ? (
          <span aria-hidden="true" className="h-4 w-px shrink-0 bg-border/60" />
        ) : null}

        {/* Primary control — always inline */}
        {primaryControl}

        {/* Separator before overflow section — hidden at narrow, shown inline at ≥480px */}
        {primaryControl && hasOverflow ? (
          <span
            aria-hidden="true"
            className="toolbar-overflow-separator h-4 w-px shrink-0 bg-border/60"
          />
        ) : null}

        {/* Overflow controls — inline icon buttons at ≥480px */}
        {hasOverflow ? (
          <div className="toolbar-overflow-controls items-center gap-2">
            {overflowControls.map((control, index) => (
              <div key={index} className="flex items-center gap-2">
                {index > 0 ? (
                  <span aria-hidden="true" className="h-4 w-px shrink-0 bg-border/60" />
                ) : null}
                {control}
              </div>
            ))}
          </div>
        ) : null}

        {/* Overflow panel — structured list at <480px */}
        {hasOverflow && overflowSections && overflowSections.length > 0 ? (
          <div
            ref={overflowRef}
            className="toolbar-overflow-panel"
            data-open={overflowOpen || undefined}
          >
            {overflowSections.map((section, sectionIndex) => (
              <div key={section.label}>
                {sectionIndex > 0 ? <div className="mx-1 my-1 h-px bg-border/60" /> : null}
                <div className="px-3 pt-1.5 pb-0.5 text-[0.6875rem] font-medium text-muted">
                  {section.label}
                </div>
                {section.options.map((option) => (
                  <button
                    key={option.label}
                    onClick={() => {
                      option.onSelect();
                    }}
                    className="flex w-full items-center gap-2.5 px-3 py-1 text-left text-[0.8125rem] text-text transition-colors hover:bg-surface-hover max-[768px]:py-2.5"
                  >
                    <span className="w-4 shrink-0">
                      {option.selected ? (
                        <Check size={13} strokeWidth={2.5} className="text-text" />
                      ) : null}
                    </span>
                    <span>{option.label}</span>
                  </button>
                ))}
              </div>
            ))}
          </div>
        ) : null}

        {/* Overflow trigger — shown at narrow, hidden at ≥480px */}
        {hasOverflow ? (
          <Tooltip content={overflowOpen ? "Hide options" : "More options"}>
            <button
              ref={overflowTriggerRef}
              onClick={() => setOverflowOpen(!overflowOpen)}
              className="toolbar-overflow-trigger h-8 w-8 shrink-0 items-center justify-center rounded-full text-muted transition-colors hover:bg-surface-hover hover:text-text max-[768px]:h-10 max-[768px]:w-10"
            >
              <Ellipsis size={16} />
            </button>
          </Tooltip>
        ) : null}
      </div>

      {/* Right section: secondary action + send/queue/stop buttons */}
      <div className="flex items-center gap-2">
        {hasSecondaryAction ? (
          <Button
            variant="ghost"
            onClick={onSecondaryAction}
            disabled={isSecondaryActionDisabled}
            className="h-8 shrink-0 rounded-full px-3.5 text-[0.8125rem] max-[768px]:h-10"
          >
            {secondaryActionLabel}
          </Button>
        ) : null}
        {isProcessing ? (
          <>
            {!isSendDisabled && (
              <ActionButton
                isStop={false}
                onClick={onSend}
                onStopClick={onCancel}
                disabled={isSendDisabled}
                variant="queue"
                tooltip={isMobile ? "Queue message" : "Queue message (Enter)"}
                stopTooltip=""
              />
            )}
            {onStopCurrentTask && (
              <Tooltip content={isMobile ? "Stop task" : "Stop task"}>
                <button
                  type="button"
                  onClick={onStopCurrentTask}
                  className="inline-flex h-8 items-center justify-center gap-1.5 rounded-full border border-error/40 bg-error/10 px-3 text-[0.75rem] font-medium text-error hover:bg-error/20 max-[768px]:h-10"
                >
                  Stop task
                </button>
              </Tooltip>
            )}
            <ActionButton
              isStop={true}
              onClick={onCancel}
              onStopClick={onCancel}
              disabled={false}
              stopTooltip={
                onStopCurrentTask
                  ? isMobile
                    ? "Stop all"
                    : "Stop all (Esc)"
                  : isMobile
                    ? "Cancel"
                    : "Cancel (Esc)"
              }
            />
          </>
        ) : (
          <ActionButton
            isStop={false}
            onClick={onSend}
            onStopClick={onCancel}
            disabled={isSendDisabled}
            label={sendLabel}
            tooltip={sendTooltip ?? (isMobile ? "Send" : "Send (Enter)")}
            stopTooltip={isMobile ? "Cancel" : "Cancel (Esc)"}
          />
        )}
      </div>
    </div>
  );
}
