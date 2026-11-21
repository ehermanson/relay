/**
 * Antigravity model discovery.
 *
 * `agy models` prints one line per selectable variant — `<id>\t<label>` —
 * where most ids are a model family plus a thinking level
 * (`gemini-4-neon-high` → "Gemini 4 Neon (High)"). Inside an ACP session the
 * same choice is two config options: `model` (the family) and `thought_level`.
 * Relay presents families as models and their levels as reasoning effort, so
 * this module groups the variants. A family with a single variant (e.g.
 * `gpt-oss-120b-medium`) is its own model with no effort control, exactly as
 * the session's `model` option lists it.
 *
 * The list is account-dependent (subscription tier, enterprise gateways), so
 * it is always discovered, never hardcoded beyond an offline fallback.
 */

import { execFile } from "child_process";
import type { Logger } from "#core/logger.js";
import type { ProviderModelOption, ReasoningEffort } from "#core/types.js";
import {
  buildAntigravitySpawnEnv,
  findAntigravityBinary,
  normalizeAntigravityHomeDir,
  resolveAntigravityHomeDir,
} from "#core/providers/antigravity-cli.js";

const LEVELS = ["low", "medium", "high", "xhigh"] as const;
type Level = (typeof LEVELS)[number];
const LEVEL_SUFFIX_RE = /-(low|medium|high|xhigh)$/;
const LEVEL_LABEL_RE = /\s*\((low|medium|high|xhigh|extra(?:\s*high)?)\)\s*$/i;

const LEVEL_DEFS: Record<Level, { label: string; description: string }> = {
  low: { label: "Low", description: "Fastest responses, minimal thinking" },
  medium: { label: "Medium", description: "Balanced depth and speed" },
  high: { label: "High", description: "More thinking for harder tasks" },
  xhigh: { label: "Extra High", description: "Deepest thinking, usually slower" },
};

const REFRESH_TTL_MS = 30 * 60 * 1000;
const PROBE_TIMEOUT_MS = 60_000;

export interface AntigravityModelVariant {
  id: string;
  label: string;
}

/** Parse `agy models` output (`<id>\t<label>` per line; other lines ignored). */
export function parseAntigravityModelsOutput(output: string): AntigravityModelVariant[] {
  const variants: AntigravityModelVariant[] = [];
  for (const line of output.split("\n")) {
    const match = /^([A-Za-z0-9][\w.\-:/]*)\t+(.+)$/.exec(line.trim());
    if (match) variants.push({ id: match[1], label: match[2].trim() });
  }
  return variants;
}

/** Split `gemini-4-neon-high` into family + level (no level when there is no suffix). */
export function splitAntigravityModelId(id: string): { model: string; effort?: Level } {
  const match = LEVEL_SUFFIX_RE.exec(id);
  if (!match) return { model: id };
  return { model: id.slice(0, -match[0].length), effort: match[1] as Level };
}

/** Group variants into Relay models (families) with per-family effort levels. */
export function groupAntigravityModels(variants: AntigravityModelVariant[]): ProviderModelOption[] {
  const families = new Map<
    string,
    { label: string; levels: Level[]; variants: AntigravityModelVariant[] }
  >();
  for (const variant of variants) {
    const { model, effort } = splitAntigravityModelId(variant.id);
    const family = families.get(model) ?? {
      label: variant.label.replace(LEVEL_LABEL_RE, "").trim() || model,
      levels: [],
      variants: [],
    };
    family.variants.push(variant);
    if (effort && !family.levels.includes(effort)) family.levels.push(effort);
    families.set(model, family);
  }

  const models: ProviderModelOption[] = [];
  let first = true;
  for (const [familyId, family] of families) {
    // A lone variant is listed by the session under its full id.
    if (family.variants.length === 1) {
      const only = family.variants[0];
      models.push({
        provider: "antigravity",
        id: only.id,
        label: only.label,
        ...(first ? { isDefault: true } : {}),
        capabilities: { supportsReasoningEffort: false, reasoningEffortLevels: [] },
      });
      first = false;
      continue;
    }
    const levels = LEVELS.filter((level) => family.levels.includes(level));
    const defaultLevel: Level = levels.includes("high") ? "high" : levels[levels.length - 1];
    models.push({
      provider: "antigravity",
      id: familyId,
      label: family.label,
      ...(first ? { isDefault: true } : {}),
      capabilities: {
        supportsReasoningEffort: levels.length > 0,
        reasoningEffortLevels: levels.map((level) => ({
          effort: level,
          ...LEVEL_DEFS[level],
          ...(level === defaultLevel ? { isDefault: true } : {}),
        })),
      },
    });
    first = false;
  }
  return models;
}

/**
 * Map a Relay effort onto one the model offers. `max` (and anything above it)
 * means the deepest level available; an unavailable level steps down to the
 * nearest one below it.
 */
export function resolveAntigravityEffort(
  requested: ReasoningEffort,
  available: readonly string[],
): string | undefined {
  if (available.length === 0) return undefined;
  if (available.includes(requested)) return requested;
  const order = ["low", "medium", "high", "xhigh"];
  const rank =
    requested === "max" || requested === "ultracode" ? order.length - 1 : order.indexOf(requested);
  if (rank < 0) return undefined;
  for (let index = rank; index >= 0; index--) {
    if (available.includes(order[index])) return order[index];
  }
  return available[0];
}

interface ModelsEntry {
  models: ProviderModelOption[] | null;
  probedAt: number;
  inFlight: Promise<void> | null;
}

const modelsByHome = new Map<string, ModelsEntry>();

function entryFor(home?: string): ModelsEntry {
  const key = home?.trim() ? normalizeAntigravityHomeDir(home) : resolveAntigravityHomeDir();
  let entry = modelsByHome.get(key);
  if (!entry) {
    entry = { models: null, probedAt: 0, inFlight: null };
    modelsByHome.set(key, entry);
  }
  return entry;
}

export function getCachedAntigravityModels(home?: string): ProviderModelOption[] | null {
  return entryFor(home).models;
}

/** Test seam. */
export function setCachedAntigravityModels(
  models: ProviderModelOption[] | null,
  home?: string,
): void {
  const entry = entryFor(home);
  entry.models = models;
  entry.probedAt = models ? Date.now() : 0;
}

export function clearAntigravityModelsCache(): void {
  modelsByHome.clear();
}

/** Run `agy models` and parse it. Rejects when the CLI is missing or fails. */
export function discoverAntigravityModels(options: {
  home?: string;
  logger?: Logger;
  timeoutMs?: number;
}): Promise<ProviderModelOption[]> {
  const binary = findAntigravityBinary();
  if (!binary) return Promise.reject(new Error("agy not found"));
  return new Promise((resolve, reject) => {
    execFile(
      binary,
      ["models"],
      {
        env: buildAntigravitySpawnEnv(options.home),
        timeout: options.timeoutMs ?? PROBE_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
      },
      (error, stdout) => {
        const models = groupAntigravityModels(parseAntigravityModelsOutput(String(stdout ?? "")));
        if (models.length > 0) {
          resolve(models);
          return;
        }
        reject(error ?? new Error("agy models returned no models"));
      },
    );
  });
}

/**
 * Re-probe when the cache is missing or older than the TTL. Concurrent callers
 * share one probe; failures keep the last good list.
 */
export function refreshAntigravityModelsIfStale(options: {
  home?: string;
  logger?: Logger;
  force?: boolean;
}): Promise<void> {
  const entry = entryFor(options.home);
  if (entry.inFlight) return entry.inFlight;
  if (!options.force && entry.models && Date.now() - entry.probedAt < REFRESH_TTL_MS) {
    return Promise.resolve();
  }
  entry.inFlight = discoverAntigravityModels(options)
    .then((models) => {
      entry.models = models;
      entry.probedAt = Date.now();
    })
    .catch((error) => {
      // Keep the previous list; retry on the next TTL window.
      entry.probedAt = Date.now();
      options.logger?.warn?.(
        `[Antigravity] Model discovery failed: ${error instanceof Error ? error.message : error}`,
      );
    })
    .finally(() => {
      entry.inFlight = null;
    });
  return entry.inFlight;
}
