import { hasInstallableProviderUpdate } from "@shared/provider-update";
import type {
  ProviderDescriptor,
  ProviderInstallMethod,
  ProviderVersionAdvisory,
} from "@shared/types";

/**
 * Pure helpers backing the provider-update launch notification. Split out so
 * the toast component stays a thin shell and the dedup/key logic is unit
 * testable without React or sonner in the loop.
 */

export interface ProviderUpdateCandidate {
  provider: ProviderDescriptor["provider"];
  label: string;
  advisory: ProviderVersionAdvisory & {
    status: "behind_latest";
    latestVersion: string;
  };
}

export function isUpdateCandidate(
  descriptor: ProviderDescriptor,
): descriptor is ProviderDescriptor & {
  capabilities: { versionAdvisory: ProviderVersionAdvisory };
} {
  const advisory = descriptor.capabilities.versionAdvisory;
  return (
    !!advisory &&
    advisory.status === "behind_latest" &&
    typeof advisory.latestVersion === "string" &&
    hasInstallableProviderUpdate(advisory)
  );
}

export function collectUpdateCandidates(
  providers: ReadonlyArray<ProviderDescriptor>,
): ProviderUpdateCandidate[] {
  const out: ProviderUpdateCandidate[] = [];
  for (const descriptor of providers) {
    if (!isUpdateCandidate(descriptor)) continue;
    out.push({
      provider: descriptor.provider,
      label: descriptor.label,
      advisory: {
        ...descriptor.capabilities.versionAdvisory,
        latestVersion:
          descriptor.capabilities.versionAdvisory.availableVersion ??
          descriptor.capabilities.versionAdvisory.latestVersion,
      } as ProviderUpdateCandidate["advisory"],
    });
  }
  return out;
}

/**
 * Stable key identifying "the set of advisories currently visible." Used to
 * suppress repeat toasts when the user already dismissed the same advisory
 * combination. Sorted so order of providers doesn't churn the key.
 */
export function providerAdvisoryNotificationKey(
  candidates: ReadonlyArray<ProviderUpdateCandidate>,
): string | null {
  if (candidates.length === 0) return null;
  return candidates
    .map((c) => `${c.provider}:${c.advisory.latestVersion}`)
    .sort()
    .join("|");
}

export function formatVersion(value: string | null): string {
  if (!value) return "";
  return value.startsWith("v") ? value : `v${value}`;
}

export function formatProviderList(candidates: ReadonlyArray<ProviderUpdateCandidate>): string {
  const names = candidates.map((c) => c.label);
  if (names.length <= 1) return names.join("");
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
}

export function buildToastTitle(candidates: ReadonlyArray<ProviderUpdateCandidate>): string {
  if (candidates.length === 1) {
    const c = candidates[0];
    return `${c.label} update available (${formatVersion(c.advisory.latestVersion)})`;
  }
  return `${candidates.length} provider updates available`;
}

export function buildToastDescription(candidates: ReadonlyArray<ProviderUpdateCandidate>): string {
  if (candidates.length === 1) {
    const c = candidates[0];
    const current = c.advisory.currentVersion
      ? formatVersion(c.advisory.currentVersion)
      : "(unknown)";
    return `Installed ${current} → latest ${formatVersion(c.advisory.latestVersion)}.`;
  }
  return `Updates available for ${formatProviderList(candidates)}.`;
}

export const INSTALL_METHOD_LABEL: Record<ProviderInstallMethod, string> = {
  npm: "npm",
  brew: "Homebrew",
  bun: "bun",
  pnpm: "pnpm",
  native: "Built-in updater",
  manual: "Manual install",
};
