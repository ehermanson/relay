/**
 * Pure presentation helpers for provider account profiles. The matching logic
 * itself (which profile a config dir belongs to) is shared with the server via
 * `@shared/account-profiles`; this module only decides what to *say* about it.
 */

import { findProfileForConfigDir } from "@shared/account-profiles";
import type {
  ProviderAccountProfile,
  ProviderAccountProfileStatus,
  ProviderAccountStatus,
} from "@shared/types";

/** Shown for a chat bound to a config dir that no registered profile owns. */
export const OTHER_ACCOUNT_LABEL = "Other account";

/**
 * `email · org · plan`, using whichever identity fields the probe reported.
 * `label` is the provider's org/workspace name; a plan repeats nothing else.
 */
export function formatIdentity(identity: ProviderAccountStatus | undefined): string | null {
  if (!identity) return null;
  const parts: string[] = [];
  for (const value of [identity.email, identity.label, identity.plan]) {
    const trimmed = value?.trim();
    if (trimmed && !parts.includes(trimmed)) parts.push(trimmed);
  }
  // No name at all: say how it authenticates ("Enterprise gateway", "Signed in").
  if (!parts.length && identity.status?.trim()) parts.push(identity.status.trim());
  return parts.length ? parts.join(" · ") : null;
}

/**
 * One line describing what we know about a profile's login: the identity when
 * probed, otherwise the probe state in words. Never empty — every row needs a
 * visible answer without hovering.
 */
export function formatProfileIdentity(status: ProviderAccountProfileStatus): string {
  const identity = formatIdentity(status.identity);
  switch (status.probeState) {
    case "ok":
      return identity ?? "Signed in";
    case "probing":
      return identity ?? "Checking…";
    case "error":
      return status.probeError?.trim() || "Not signed in";
    default:
      return identity ?? "Checking…";
  }
}

export interface ChatAccountLabel {
  /** Short chip text: the profile label, or `OTHER_ACCOUNT_LABEL`. */
  label: string;
  /** Longer detail for a tooltip: the identity when known, else the config dir. */
  detail: string | null;
  /** The matched profile, if any. */
  profile: ProviderAccountProfileStatus | ProviderAccountProfile | undefined;
}

/**
 * Which account a chat runs under. An absent `configDir` is the default
 * profile; a dir no profile owns is "Other account" with the dir as detail.
 */
export function resolveChatAccountLabel(
  profiles: ProviderAccountProfileStatus[],
  configDir: string | null | undefined,
): ChatAccountLabel {
  const profile = findProfileForConfigDir(profiles, configDir) as
    | ProviderAccountProfileStatus
    | undefined;
  if (!profile) {
    return { label: OTHER_ACCOUNT_LABEL, detail: configDir ?? null, profile: undefined };
  }
  const identity = "probeState" in profile ? formatIdentity(profile.identity) : null;
  return { label: profile.label, detail: identity ?? profile.configDir, profile };
}

/** Polling is only worth it while some probe hasn't settled. */
export function hasUnsettledProbe(profiles: ProviderAccountProfileStatus[] | undefined): boolean {
  return (profiles ?? []).some((p) => p.probeState === "probing" || p.probeState === "unknown");
}
