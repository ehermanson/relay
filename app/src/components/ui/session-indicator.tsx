import { Terminal } from "lucide-react";
import { Tooltip } from "@/components/ui/tooltip";
import { deriveInstanceStatusPresentation } from "@/lib/utils";
import type { InstanceInfo } from "@shared/types";

/**
 * Unified session indicator for sidebar items.
 *
 * Always renders a fixed-width column to reserve space. The inner
 * content (terminal icon or dot) appears/disappears based on state.
 *
 * - **External sessions**: always renders a terminal icon. When `unread`
 *   is true the icon takes the status color (green/orange/red); otherwise
 *   it stays muted so the source is always visible.
 * - **Non-external sessions**: renders a small status dot only when
 *   `visible` is true (unread state); empty placeholder otherwise.
 *
 * Both shapes carry a tooltip with the current status label.
 */

interface SessionIndicatorProps {
  instance: Pick<InstanceInfo, "status" | "external" | "pendingTool">;
  unread: boolean;
  /** Whether the indicator content is mounted (controls fade lifecycle). */
  visible?: boolean;
  /** Whether the indicator is currently fading out. */
  fading?: boolean;
  /** Extra classes forwarded to the outermost wrapper. */
  className?: string;
}

const WRAPPER = "flex h-[16px] w-3 shrink-0 items-center justify-start";

export function SessionIndicator({
  instance,
  unread,
  visible = true,
  fading = false,
  className = "",
}: SessionIndicatorProps) {
  const status = deriveInstanceStatusPresentation(instance);
  const fadeClass = `transition-opacity duration-500 ${fading ? "opacity-0" : "opacity-100"}`;

  if (instance.external) {
    // Terminal icon — always visible; colored when unread, muted otherwise
    const iconColor = unread ? dotClassToTextColor(status.dotClass) : "text-muted/40";
    const animate =
      unread && status.dotClass.includes("animate-pulse-dot") ? "animate-pulse-dot" : "";

    return (
      <span className={`${WRAPPER} ${className}`}>
        <Tooltip content={unread ? status.label : "External session"} side="right">
          <Terminal size={12} strokeWidth={2} className={`${iconColor} ${animate} ${fadeClass}`} />
        </Tooltip>
      </span>
    );
  }

  // Non-external: reserve space, show dot only when visible
  return (
    <span className={`${WRAPPER} ${className}`}>
      {visible && (
        <Tooltip content={status.label} side="right">
          <span className={`h-[6px] w-[6px] rounded-full ${status.dotClass} ${fadeClass}`} />
        </Tooltip>
      )}
    </span>
  );
}

/** Map a dotClass like "bg-accent" / "bg-warning" / "bg-error" to a text color. */
export function dotClassToTextColor(dotClass: string): string {
  if (dotClass.includes("bg-warning")) return "text-warning";
  if (dotClass.includes("bg-error")) return "text-error";
  if (dotClass.includes("bg-accent")) return "text-accent";
  if (dotClass.includes("bg-muted")) return "text-muted";
  return "text-muted/40";
}
