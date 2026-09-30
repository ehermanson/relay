import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { useProviderRuntimeStore } from "@/stores/provider-runtime-store";
import { stateKeyFor } from "@/lib/account-scope";
import { formatTimeUntil } from "@/lib/utils";
import type { ProviderKind } from "@shared/types";

type RateLimitStatus = "allowed" | "allowed_warning" | "rejected";

// Rate-limit state belongs to the provider, not to an individual chat. Keep it
// outside the hook so navigating between chats cannot make an unchanged warning
// look like a new transition. An explicit recovery still arms the next warning.
const lastSeenStatuses = new Map<string, RateLimitStatus>();

/**
 * Fires a toast when a provider rate limit window transitions into
 * "allowed_warning" or "rejected". Re-fires if the status later resets and
 * re-enters the warning/rejected state.
 */
export function useRateLimitWarning(
  provider: ProviderKind | undefined,
  onOpenContext: () => void,
  /** The chat's account (config dir); absent = the default account. */
  configDir?: string,
) {
  const providerGlobalState = useProviderRuntimeStore((s) => s.providerGlobalState);
  // Keep the latest callback without making it an effect dependency.
  const onOpenContextRef = useRef(onOpenContext);
  onOpenContextRef.current = onOpenContext;

  useEffect(() => {
    if (!provider) return;
    const stateKey = stateKeyFor(provider, configDir);
    const rateLimits = providerGlobalState[stateKey]?.account?.rateLimits ?? [];

    for (const limit of rateLimits) {
      const windows = limit.windows ?? [];
      for (let i = 0; i < windows.length; i++) {
        const window = windows[i];
        const key = `${stateKey}/${limit.scope ?? limit.name ?? "unknown"}/${i}`;
        const currentStatus = (window.status ?? "allowed") as RateLimitStatus;
        const prevStatus = lastSeenStatuses.get(key) ?? "allowed";
        if (currentStatus === prevStatus) continue;

        lastSeenStatuses.set(key, currentStatus);
        if (currentStatus === "allowed") continue; // recovered — nothing to surface

        const resetIn = window.resetAt ? formatTimeUntil(window.resetAt) : "";
        const resetDesc = resetIn ? ` · resets in ${resetIn}` : "";
        const limitName = formatWindowName(limit.scope ?? limit.name);
        const action = { label: "View context", onClick: () => onOpenContextRef.current() };

        if (currentStatus === "allowed_warning") {
          toast.warning(`Rate limit warning${resetDesc}`, {
            description: `Approaching the ${limitName} limit`,
            action,
            duration: 8000,
          });
        } else {
          toast.error(`Rate limit reached${resetDesc}`, {
            description: `The ${limitName} limit has been hit`,
            action,
            duration: 12000,
          });
        }
      }
    }
  }, [provider, configDir, providerGlobalState]);
}

/** Test-only reset for module-scoped transition memory. */
export function resetRateLimitWarningState(): void {
  lastSeenStatuses.clear();
}

function formatWindowName(scope: string | undefined): string {
  if (!scope) return "usage";
  return scope.replace(/_/g, " ");
}
