import { readFileSync } from "node:fs";
import { join } from "node:path";
import { effortRank, lowerEffortCap } from "#core/provider-catalog.js";
import type { ReasoningEffort } from "#core/types.js";

/**
 * Claude Code's `maxEffortLevel` setting: the highest reasoning effort a
 * session may use. A settings file may set it at the top level and per model
 * (`modelSettings.<model>.maxEffortLevel`, which replaces the top-level value
 * for that model). Across settings files the lowest cap wins. The CLI clamps
 * the effort itself; Relay reads the caps only to hide levels it would clamp.
 */
export interface ClaudeEffortCaps {
  /** Cap for models no `modelSettings` entry names. */
  default?: ReasoningEffort;
  /** Caps keyed by normalized model id. */
  byModel: Record<string, ReasoningEffort>;
}

export function claudeManagedSettingsPath(platform: NodeJS.Platform = process.platform): string {
  if (platform === "darwin") return "/Library/Application Support/ClaudeCode/managed-settings.json";
  if (platform === "win32") return "C:/Program Files/ClaudeCode/managed-settings.json";
  return "/etc/claude-code/managed-settings.json";
}

/** `claude-opus-4-6[1m]`, `claude-opus-4-6-20260101`, `us.anthropic.claude-opus-4-6-v1:0` → `claude-opus-4-6`. */
export function normalizeClaudeModelKey(model: string): string {
  return model
    .trim()
    .toLowerCase()
    .replace(/\[[^\]]*\]$/, "")
    .replace(/^(?:[a-z]{2,4}\.)?anthropic\./, "")
    .replace(/-v\d+(?::\d+)?$/, "")
    .replace(/(?:-|@)\d{8}$/, "");
}

function readCap(value: unknown): ReasoningEffort | undefined {
  return typeof value === "string" && effortRank(value) !== undefined ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Combine settings files' caps: per model, each file's own entry or its top-level cap; lowest wins. */
export function resolveClaudeEffortCaps(settingsFiles: unknown[]): ClaudeEffortCaps {
  const files = settingsFiles.filter(isRecord).map((settings) => {
    const byModel: Record<string, ReasoningEffort> = {};
    if (isRecord(settings.modelSettings)) {
      for (const [model, entry] of Object.entries(settings.modelSettings)) {
        const cap = isRecord(entry) ? readCap(entry.maxEffortLevel) : undefined;
        if (cap) byModel[normalizeClaudeModelKey(model)] = cap;
      }
    }
    return { top: readCap(settings.maxEffortLevel), byModel };
  });

  const caps: ClaudeEffortCaps = { byModel: {} };
  for (const file of files) caps.default = lowerEffortCap(caps.default, file.top);
  const models = new Set(files.flatMap((file) => Object.keys(file.byModel)));
  for (const model of models) {
    let cap: ReasoningEffort | undefined;
    for (const file of files) cap = lowerEffortCap(cap, file.byModel[model] ?? file.top);
    if (cap) caps.byModel[model] = cap;
  }
  return caps;
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/** Caps from the login's user settings and the machine's managed settings. */
export function readClaudeEffortCaps(
  configDir: string,
  managedSettingsPath: string = claudeManagedSettingsPath(),
): ClaudeEffortCaps {
  return resolveClaudeEffortCaps([
    readJson(join(configDir, "settings.json")),
    readJson(managedSettingsPath),
  ]);
}

export function claudeEffortCapForModel(
  caps: ClaudeEffortCaps,
  model: string,
): ReasoningEffort | undefined {
  return caps.byModel[normalizeClaudeModelKey(model)] ?? caps.default;
}
