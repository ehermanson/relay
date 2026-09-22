import type { ProviderUpdateResult, ProviderVersionAdvisory } from "#core/types.js";
import { compareSemver } from "#core/semver.js";

export function hasInstallableProviderUpdate(advisory: ProviderVersionAdvisory): boolean {
  const available =
    advisory.availableVersion ??
    (advisory.installMethod === "brew" ? null : advisory.latestVersion);
  return (
    !!available &&
    !!advisory.currentVersion &&
    compareSemver(available, advisory.currentVersion) > 0
  );
}

export function describeProviderUpdateResult(
  before: ProviderVersionAdvisory,
  after: ProviderVersionAdvisory | undefined,
  execution: { ok: boolean; output: string },
): ProviderUpdateResult {
  const base = { command: before.updateCommand, output: execution.output };
  if (!execution.ok)
    return { ...base, status: "failed", message: "Update command failed. See command output." };
  if (!before.currentVersion || !after?.currentVersion) {
    return {
      ...base,
      status: "unverified",
      message: "Update command finished, but the installed version could not be verified.",
    };
  }
  if (compareSemver(after.currentVersion, before.currentVersion) > 0) {
    return {
      ...base,
      status: "updated",
      message: `Updated from v${before.currentVersion} to v${after.currentVersion}.`,
    };
  }
  return {
    ...base,
    status: "unchanged",
    message: `No upgrade verified. Installed version is v${after.currentVersion}. See command output.`,
  };
}
