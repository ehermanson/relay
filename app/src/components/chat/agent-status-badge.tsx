import type { AgentLifecycle } from "@shared/types";
import { Spinner } from "@/components/ui/spinner";
import { StatusDot, type StatusDotVariant } from "@/components/ui/status-dot";

interface AgentStatusBadgeProps {
  status?: AgentLifecycle;
  /** Completed-with-error results read as failures. */
  resultIsError?: boolean;
  /** `dot` renders only the indicator (avatars); `badge` adds the label. */
  variant?: "badge" | "dot";
  className?: string;
}

type BadgeVariant = "default" | "accent" | "warning" | "error" | "claude" | "success";

interface StatusPresentation {
  label: string;
  badge: BadgeVariant;
  dot: StatusDotVariant;
  spinner?: boolean;
  muted?: boolean;
}

/**
 * Lifecycle → presentation. `unknown`/absent is a legitimate state and is
 * shown as such — never promoted to "done" or "running" by guesswork.
 */
export function getAgentStatusPresentation(
  status: AgentLifecycle | undefined,
  resultIsError?: boolean,
): StatusPresentation {
  if (resultIsError && (status === "completed" || status === undefined)) {
    return { label: "Error", badge: "error", dot: "error" };
  }
  switch (status) {
    case "running":
      return { label: "Running", badge: "claude", dot: "active", spinner: true };
    case "pending":
      return { label: "Queued", badge: "default", dot: "default", muted: true };
    case "waiting":
      return { label: "Needs input", badge: "warning", dot: "active" };
    case "completed":
      return { label: "Done", badge: "success", dot: "success" };
    case "failed":
      return { label: "Failed", badge: "error", dot: "error" };
    case "stopped":
      return { label: "Stopped", badge: "default", dot: "default", muted: true };
    case "unknown":
    default:
      return { label: "Unknown", badge: "default", dot: "default", muted: true };
  }
}

// Text colour per status. Resting states (done/stopped/queued/unknown) stay
// quiet so a wall of finished agents doesn't shout; only the states that want a
// human's attention (running, needs-input, failed) carry a saturated colour.
const TEXT_COLOR: Record<BadgeVariant, string> = {
  claude: "text-claude",
  warning: "text-warning",
  error: "text-error",
  success: "text-accent/80",
  accent: "text-accent",
  default: "text-muted",
};

/**
 * Compact lifecycle indicator shared by in-chat cards and the Agents sidecar.
 * Renders as a dot + label with no filled chip — lighter than a solid badge, so
 * a column of them reads as a calm status column rather than a row of pills.
 */
export function AgentStatusBadge({
  status,
  resultIsError,
  variant = "badge",
  className = "",
}: AgentStatusBadgeProps) {
  const p = getAgentStatusPresentation(status, resultIsError);

  if (variant === "dot") {
    if (p.spinner) return <Spinner size={10} className={`text-claude ${className}`} />;
    return (
      <span className={`inline-flex items-center ${className}`}>
        <StatusDot variant={p.dot} size={6} />
      </span>
    );
  }

  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap text-[0.625rem] font-medium ${TEXT_COLOR[p.badge]} ${className}`}
      title={`Agent status: ${p.label.toLowerCase()}`}
    >
      {p.spinner ? (
        <Spinner size={9} className="text-claude" />
      ) : (
        <StatusDot variant={p.dot} size={5} />
      )}
      {p.label}
    </span>
  );
}
