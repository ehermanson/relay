import { describe, expect, it } from "vitest";
import type { ProviderDescriptor } from "@shared/types";
import { collectUpdateCandidates, buildToastTitle } from "./provider-update-notification.logic";

function provider(availableVersion: string | null): ProviderDescriptor {
  return {
    provider: "codex",
    label: "Codex",
    capabilities: {
      versionAdvisory: {
        status: "behind_latest",
        currentVersion: "0.154.0",
        latestVersion: "0.156.0",
        availableVersion,
        installMethod: "brew",
        updateCommand: "brew upgrade codex",
        checkedAt: null,
        packageName: "@openai/codex",
      },
    },
  } as ProviderDescriptor;
}

describe("Homebrew update notifications", () => {
  it("suppresses unavailable and unverified releases", () => {
    expect(collectUpdateCandidates([provider("0.154.0"), provider(null)])).toEqual([]);
  });
  it("advertises the installable version when Homebrew trails npm", () => {
    expect(buildToastTitle(collectUpdateCandidates([provider("0.155.1")]))).toBe(
      "Codex update available (v0.155.1)",
    );
  });
});
