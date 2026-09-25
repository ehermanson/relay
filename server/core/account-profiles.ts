/**
 * Provider account profiles — pure helpers shared by the server (creation
 * resolution, multi-root discovery, profile routes) and the UI via
 * `@shared/account-profiles`.
 *
 * A profile is a provider config dir (Claude: `CLAUDE_CONFIG_DIR`) with a
 * label. The server's own resolved dir is the implicit default profile and is
 * never stored; user-added profiles live in `GlobalSettings.providerProfiles`.
 * No fs access here — validation that needs the filesystem lives at the route.
 */

import {
  DEFAULT_ACCOUNT_PROFILE_ID,
  type ProviderAccountProfile,
  type ProviderDefaults,
  type ProviderKind,
} from "#core/types.js";

/** Normalize a config dir for comparison: trailing slashes off, no `~` expansion here. */
export function normalizeConfigDir(dir: string): string {
  const trimmed = dir.trim().replace(/\/+$/, "");
  return trimmed || "/";
}

/** The implicit default profile for a provider (the server's resolved config dir). */
export function defaultAccountProfile(
  provider: ProviderKind,
  defaultConfigDir: string,
): ProviderAccountProfile {
  return {
    id: DEFAULT_ACCOUNT_PROFILE_ID,
    provider,
    label: "Default",
    configDir: normalizeConfigDir(defaultConfigDir),
  };
}

/** Default first, then the stored profiles for this provider in stored order. */
export function listAccountProfiles(
  stored: ProviderAccountProfile[] | null | undefined,
  provider: ProviderKind,
  defaultConfigDir: string,
): ProviderAccountProfile[] {
  const fallback = defaultAccountProfile(provider, defaultConfigDir);
  const own = (stored ?? []).filter(
    (p) => p.provider === provider && p.id !== DEFAULT_ACCOUNT_PROFILE_ID,
  );
  return [fallback, ...own];
}

/** Find the profile whose config dir matches (normalized), if any. */
export function findProfileForConfigDir(
  profiles: ProviderAccountProfile[],
  configDir: string | null | undefined,
): ProviderAccountProfile | undefined {
  if (!configDir) return profiles.find((p) => p.id === DEFAULT_ACCOUNT_PROFILE_ID);
  const target = normalizeConfigDir(configDir);
  return profiles.find((p) => normalizeConfigDir(p.configDir) === target);
}

export interface ResolveAccountProfileInput {
  provider: ProviderKind;
  /** Explicit choice for this chat, if the caller made one. */
  profileId?: string | null;
  /** `Project.defaultProfileId`. */
  projectDefaultProfileId?: string | null;
  /** `GlobalSettings.providerDefaults`. */
  providerDefaults?: Record<string, ProviderDefaults> | null;
  /** `listAccountProfiles(...)` output — default first. */
  profiles: ProviderAccountProfile[];
}

export interface ResolvedAccountProfile {
  profile: ProviderAccountProfile;
  /**
   * Config dir to bind the chat to, or `undefined` for the default profile so
   * `InstanceInfo.configDir` stays absent (the server's resolved dir).
   */
  configDir: string | undefined;
}

/**
 * Explicit > project default > global provider default > default profile.
 * An id that no longer resolves (deleted profile) falls through to the next
 * level rather than failing chat creation.
 */
export function resolveAccountProfile(input: ResolveAccountProfileInput): ResolvedAccountProfile {
  const byId = new Map(input.profiles.map((p) => [p.id, p]));
  const candidates = [
    input.profileId,
    input.projectDefaultProfileId,
    input.providerDefaults?.[input.provider]?.profileId,
  ];
  let profile: ProviderAccountProfile | undefined;
  for (const id of candidates) {
    if (id && byId.has(id)) {
      profile = byId.get(id);
      break;
    }
  }
  profile ??= byId.get(DEFAULT_ACCOUNT_PROFILE_ID) ?? input.profiles[0];
  const isDefault = profile.id === DEFAULT_ACCOUNT_PROFILE_ID;
  return { profile, configDir: isDefault ? undefined : profile.configDir };
}

export const ACCOUNT_PROFILE_LABEL_MAX = 40;

/**
 * Shape-level validation for a new/renamed profile. Filesystem checks (dir
 * exists, is a directory) are the route's job. Throws with a user-facing message.
 */
export function validateAccountProfileInput(
  input: { label?: unknown; configDir?: unknown },
  existing: ProviderAccountProfile[],
  options: { excludeId?: string } = {},
): { label: string; configDir: string } {
  const label = typeof input.label === "string" ? input.label.trim() : "";
  if (!label) throw new Error("Enter a name for this account");
  if (label.length > ACCOUNT_PROFILE_LABEL_MAX)
    throw new Error(`Account names are at most ${ACCOUNT_PROFILE_LABEL_MAX} characters`);
  const rawDir = typeof input.configDir === "string" ? input.configDir.trim() : "";
  if (!rawDir) throw new Error("Enter the account's config directory");
  const configDir = normalizeConfigDir(rawDir);
  if (!configDir.startsWith("/") && !configDir.startsWith("~"))
    throw new Error("Config directory must be an absolute path");
  for (const p of existing) {
    if (p.id === options.excludeId) continue;
    if (normalizeConfigDir(p.configDir) === configDir)
      throw new Error(`"${p.label}" already uses that config directory`);
    if (p.label.toLowerCase() === label.toLowerCase())
      throw new Error(`An account named "${p.label}" already exists`);
  }
  return { label, configDir };
}

/** Every distinct config dir a provider's chats may live under — default first. */
export function accountProfileRoots(profiles: ProviderAccountProfile[]): string[] {
  const seen = new Set<string>();
  const roots: string[] = [];
  for (const p of profiles) {
    const dir = normalizeConfigDir(p.configDir);
    if (seen.has(dir)) continue;
    seen.add(dir);
    roots.push(dir);
  }
  return roots;
}
