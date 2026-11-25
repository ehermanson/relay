/**
 * Antigravity plan limits, read the way Usage-Meter does it:
 * `agy -p /usage --output-format json`. Print-mode `/usage` is read-only — it
 * answers with agy's own sign-in, starts no agent turn, spends no quota and
 * leaves no conversation behind.
 *
 * Shape (agy 1.5.x): `{ status, command: { name: "usage", data: { groups: [
 *   { name, buckets: [{ id, name, window: "5h"|"weekly", remaining_fraction, reset_time }] }
 * ] } } }`. Each group is a pool of models sharing a 5-hour and a weekly limit.
 */

import { execFile } from "node:child_process";
import type { CoreConfig } from "#core/config.js";
import type { ProviderRateLimitStatus, ProviderRateLimitWindow } from "#core/types.js";
import {
  buildAntigravitySpawnEnv,
  findAntigravityBinary,
} from "#core/providers/antigravity-cli.js";

const USAGE_TIMEOUT_MS = 30_000;

const WINDOW_MINUTES: Record<string, number> = {
  "5h": 300,
  "5hr": 300,
  five_hour: 300,
  "five-hour": 300,
  daily: 1440,
  day: 1440,
  "24h": 1440,
  "1d": 1440,
  weekly: 10080,
  week: 10080,
  "7d": 10080,
};

function bucketMinutes(bucket: Record<string, unknown>): number | undefined {
  const key = typeof bucket.window === "string" ? bucket.window.trim().toLowerCase() : "";
  if (WINDOW_MINUTES[key]) return WINDOW_MINUTES[key];
  // A new or missing `window`: fall back to the bucket's id and name.
  const text = `${bucket.id ?? ""} ${bucket.name ?? ""}`.toLowerCase();
  if (/5h|five hour|5-hour/.test(text)) return 300;
  if (/week|7d/.test(text)) return 10080;
  if (/daily|24h/.test(text)) return 1440;
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Plan limits from a decoded `/usage` result, or null when it carries none
 * (an error, an API-key login with no account quota). One limit per model
 * group, shorter windows first. Like Usage-Meter, a secondary pool is left out
 * while every window in it reads 0% used, so an unused pool isn't noise.
 */
export function parseAntigravityUsage(
  root: unknown,
  now: number = Date.now(),
): ProviderRateLimitStatus[] | null {
  const record = asRecord(root);
  if (!record) return null;
  const status = typeof record.status === "string" ? record.status.toUpperCase() : undefined;
  if (status && status !== "SUCCESS") return null;
  const data = asRecord(asRecord(record.command)?.data) ?? asRecord(record.data);
  const groups = Array.isArray(data?.groups) ? data.groups : null;
  if (!groups) return null;

  const limits: ProviderRateLimitStatus[] = [];
  for (const [groupIndex, rawGroup] of groups.entries()) {
    const group = asRecord(rawGroup);
    if (!group || !Array.isArray(group.buckets)) continue;
    const windows: ProviderRateLimitWindow[] = [];
    for (const rawBucket of group.buckets) {
      const bucket = asRecord(rawBucket);
      if (!bucket) continue;
      const resetMs =
        typeof bucket.reset_time === "string" ? Date.parse(bucket.reset_time) : Number.NaN;
      const minutes = bucketMinutes(bucket);
      let fraction =
        typeof bucket.remaining_fraction === "number" ? bucket.remaining_fraction : null;
      // Go/protobuf JSON drops zero floats: an exhausted bucket omits
      // remaining_fraction. Read that as 0% left only for a real window
      // with a future reset.
      if (fraction === null) {
        if (minutes && Number.isFinite(resetMs) && resetMs > now) fraction = 0;
        else continue;
      }
      // Locked placeholder buckets carry an epoch reset.
      if (Number.isFinite(resetMs) && resetMs <= 0 && fraction <= 0) continue;
      const usedPercent = Math.max(0, Math.min(100, (1 - fraction) * 100));
      const next: ProviderRateLimitWindow = {
        label:
          typeof bucket.name === "string" && bucket.name.trim() ? bucket.name.trim() : undefined,
        usedPercent,
        remaining: Math.max(0, Math.round(100 - usedPercent)),
        windowMinutes: minutes,
        resetAt:
          Number.isFinite(resetMs) && resetMs > 0 ? new Date(resetMs).toISOString() : undefined,
      };
      // One window per span: keep the higher usage.
      const same = windows.findIndex((w) => w.windowMinutes === minutes && minutes !== undefined);
      if (same >= 0) {
        if ((next.usedPercent ?? 0) > (windows[same].usedPercent ?? 0)) windows[same] = next;
      } else {
        windows.push(next);
      }
    }
    if (!windows.length) continue;
    windows.sort(
      (a, b) =>
        (a.windowMinutes ?? Number.MAX_SAFE_INTEGER) - (b.windowMinutes ?? Number.MAX_SAFE_INTEGER),
    );
    if (groupIndex > 0 && windows.every((w) => (w.usedPercent ?? 0) < 0.5)) continue;
    const name =
      typeof group.name === "string" && group.name.trim() ? group.name.trim() : undefined;
    limits.push({ name, scope: name ?? `group-${groupIndex}`, windows });
  }
  return limits.length ? limits : null;
}

/** Decode agy's stdout, tolerating a preface or trailer around the JSON object. */
export function decodeAntigravityJson(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

/** Read Antigravity plan limits for one agy home. Null when unavailable. */
export function fetchAntigravityUsage({
  home,
  logger,
}: {
  home?: string;
  logger: CoreConfig["logger"];
}): Promise<ProviderRateLimitStatus[] | null> {
  const binary = findAntigravityBinary();
  if (!binary) return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile(
      binary,
      ["--log-file", "/dev/null", "-p", "/usage", "--output-format", "json"],
      {
        env: buildAntigravitySpawnEnv(home),
        timeout: USAGE_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
      },
      (err, stdout, stderr) => {
        // agy may print a JSON error object even on a non-zero exit.
        const limits = parseAntigravityUsage(decodeAntigravityJson(String(stdout ?? "")));
        if (!limits) {
          logger.debug(
            `[Antigravity] /usage returned no limits${err ? ` (${err.message})` : ""}: ${String(
              stderr ?? "",
            )
              .trim()
              .slice(0, 300)}`,
          );
        }
        resolve(limits);
      },
    );
  });
}
