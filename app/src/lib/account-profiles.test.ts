import { describe, expect, it } from "vitest";
import {
  OTHER_ACCOUNT_LABEL,
  formatIdentity,
  formatProfileIdentity,
  hasUnsettledProbe,
  resolveChatAccountLabel,
} from "./account-profiles";
import type { ProviderAccountProfileStatus } from "@shared/types";

function makeStatus(
  overrides: Partial<ProviderAccountProfileStatus> = {},
): ProviderAccountProfileStatus {
  return {
    id: "work",
    provider: "claude",
    label: "Work",
    configDir: "/Users/me/.claude-work",
    isDefault: false,
    probeState: "ok",
    ...overrides,
  };
}

const defaultProfile = makeStatus({
  id: "default",
  label: "Default",
  configDir: "/Users/me/.claude",
  isDefault: true,
  identity: { email: "me@example.com", plan: "max" },
});

describe("formatIdentity", () => {
  it("joins email, org, and plan with middle dots", () => {
    expect(formatIdentity({ email: "a@b.co", label: "Acme", plan: "team" })).toBe(
      "a@b.co · Acme · team",
    );
  });

  it("skips missing and duplicate parts", () => {
    expect(formatIdentity({ email: "a@b.co", label: "a@b.co" })).toBe("a@b.co");
    expect(formatIdentity({ plan: "  " })).toBeNull();
    expect(formatIdentity(undefined)).toBeNull();
  });
});

describe("formatProfileIdentity", () => {
  it("prefers the probed identity", () => {
    expect(formatProfileIdentity(defaultProfile)).toBe("me@example.com · max");
  });

  it("describes an unsettled probe", () => {
    expect(formatProfileIdentity(makeStatus({ probeState: "probing" }))).toBe("Checking…");
    expect(formatProfileIdentity(makeStatus({ probeState: "unknown" }))).toBe("Checking…");
  });

  it("shows the probe error, falling back to not signed in", () => {
    expect(formatProfileIdentity(makeStatus({ probeState: "error", probeError: "No login" }))).toBe(
      "No login",
    );
    expect(formatProfileIdentity(makeStatus({ probeState: "error" }))).toBe("Not signed in");
  });

  it("never returns an empty line for a successful probe without identity", () => {
    expect(formatProfileIdentity(makeStatus({ probeState: "ok" }))).toBe("Signed in");
  });
});

describe("resolveChatAccountLabel", () => {
  const work = makeStatus({ identity: { email: "work@acme.com", label: "Acme" } });
  const profiles = [defaultProfile, work];

  it("treats an absent configDir as the default profile", () => {
    const resolved = resolveChatAccountLabel(profiles, undefined);
    expect(resolved.label).toBe("Default");
    expect(resolved.detail).toBe("me@example.com · max");
    expect(resolved.profile?.id).toBe("default");
  });

  it("matches a registered profile by config dir, ignoring trailing slashes", () => {
    const resolved = resolveChatAccountLabel(profiles, "/Users/me/.claude-work/");
    expect(resolved.label).toBe("Work");
    expect(resolved.detail).toBe("work@acme.com · Acme");
  });

  it("falls back to the config dir when the profile has no identity", () => {
    const resolved = resolveChatAccountLabel(
      [defaultProfile, makeStatus({ probeState: "error" })],
      "/Users/me/.claude-work",
    );
    expect(resolved.label).toBe("Work");
    expect(resolved.detail).toBe("/Users/me/.claude-work");
  });

  it("labels an unregistered dir as another account with the dir as detail", () => {
    const resolved = resolveChatAccountLabel(profiles, "/Users/me/.claude-old");
    expect(resolved.label).toBe(OTHER_ACCOUNT_LABEL);
    expect(resolved.detail).toBe("/Users/me/.claude-old");
    expect(resolved.profile).toBeUndefined();
  });
});

describe("hasUnsettledProbe", () => {
  it("is true only while a probe is pending or unknown", () => {
    expect(hasUnsettledProbe(undefined)).toBe(false);
    expect(hasUnsettledProbe([defaultProfile])).toBe(false);
    expect(hasUnsettledProbe([defaultProfile, makeStatus({ probeState: "probing" })])).toBe(true);
    expect(hasUnsettledProbe([makeStatus({ probeState: "unknown" })])).toBe(true);
  });
});
