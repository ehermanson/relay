import { Info, TerminalSquare } from "lucide-react";
import type { ProviderKind, SessionStats } from "@shared/types";
import { Button } from "../ui/button";
import { Tooltip } from "../ui/tooltip";
import { ContextRing } from "@/components/ui/context-ring";
import { useProviderGlobalState } from "@/stores/provider-runtime-store";
import { worstRateLimitStatus } from "@/lib/utils";

export function HeaderIconSkeleton({ className = "" }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={`h-7 w-7 shrink-0 animate-pulse rounded-md border border-border/50 bg-surface-hover/80 max-[768px]:h-10 max-[768px]:w-10 max-[768px]:rounded-xl ${className}`}
    />
  );
}

export function HeaderTerminalToggle({ open, onClick }: { open: boolean; onClick: () => void }) {
  return (
    <Tooltip content={open ? "Hide terminal" : "Show terminal"}>
      <Button variant="icon" toggled={open} onClick={onClick} className="shrink-0">
        <TerminalSquare size={15} strokeWidth={2} />
      </Button>
    </Tooltip>
  );
}

export function HeaderContextToggle({
  stats,
  active,
  onClick,
  tooltip,
  provider,
  configDir,
}: {
  stats?: SessionStats | null;
  active?: boolean;
  onClick?: () => void;
  tooltip?: string;
  provider?: ProviderKind;
  /** The chat's account (config dir); rate limits are per login. */
  configDir?: string;
}) {
  const providerGlobalState = useProviderGlobalState(provider, configDir);
  const rateLimits = providerGlobalState?.account?.rateLimits ?? [];
  const rateLimitStatus = worstRateLimitStatus(rateLimits);

  if (stats?.contextTokens) {
    return (
      <ContextRing
        stats={stats}
        active={active}
        onClick={onClick}
        rateLimitStatus={rateLimitStatus}
      />
    );
  }

  return (
    <Tooltip content={tooltip ?? (active ? "Hide current context" : "Show current context")}>
      <Button variant="icon" toggled={active} onClick={onClick} className="shrink-0">
        <Info size={15} strokeWidth={2} />
      </Button>
    </Tooltip>
  );
}
