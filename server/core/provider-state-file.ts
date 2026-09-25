/**
 * Persistence helpers for ProviderGlobalState.
 *
 * Writes rate limits, account info, and other provider state to
 * `provider-state.json` inside the relay home directory so it survives
 * server restarts. The data is treated as stale-but-valid on restore: it
 * shows immediately while the live session catches up (rate limit windows,
 * for example, are only pushed by Codex mid-turn since their CLI update).
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ProviderGlobalState } from "#core/types.js";

export function providerStateFilePath(relayDir: string): string {
  return join(relayDir, "provider-state.json");
}

/**
 * Read persisted provider global state from disk. Returns an empty array
 * on any error (missing file, corrupt JSON, wrong shape). The caller should
 * merge these entries into in-memory state — treating them as stale data that
 * will be overwritten once live sessions emit fresh events.
 */
export function loadPersistedProviderState(filePath: string): ProviderGlobalState[] {
  try {
    const raw = readFileSync(filePath, "utf8");
    const data = JSON.parse(raw) as Record<string, unknown>;
    if (!Array.isArray(data?.states)) return [];
    return data.states
      .filter(
        (s): s is ProviderGlobalState =>
          s !== null &&
          typeof s === "object" &&
          typeof (s as ProviderGlobalState).provider === "string" &&
          typeof (s as ProviderGlobalState).updatedAt === "number",
      )
      .map(scrubLegacyAccountLabel);
  } catch {
    return [];
  }
}

/**
 * Write current provider global state to disk. Non-fatal — any I/O error
 * is silently ignored so persistence failures never crash the server.
 */
export function persistProviderState(filePath: string, states: ProviderGlobalState[]): void {
  try {
    writeFileSync(filePath, JSON.stringify({ savedAt: Date.now(), states }, null, 0), "utf8");
  } catch {
    /* non-fatal */
  }
}

/**
 * A short-lived build wrote the auth path ("Signed in via none") into
 * `account.label`. Labels persist here and merges are shallow, so nothing
 * later replaces it — drop it on load so the org name can take its place.
 */
function scrubLegacyAccountLabel(state: ProviderGlobalState): ProviderGlobalState {
  const label = state.account?.label;
  if (!label || !/^(Signed in via|Auth token \(|API key \()/i.test(label)) return state;
  const { label: _dropped, ...account } = state.account!;
  return { ...state, account };
}
