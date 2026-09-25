/**
 * Skill Discovery for Relay
 *
 * Scans well-known directories for installed skills (SKILL.md files).
 * Skills are discovered at multiple scopes: project → user → system.
 * Each scan directory is tagged with which providers can use skills found there.
 * When the same skill appears in multiple directories, providers are merged.
 * Only YAML frontmatter is read — not the full body.
 */

import { readdirSync, existsSync, statSync, openSync, readSync, closeSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import type { ProviderKind, SkillInfo } from "#core/types.js";
import { resolveClaudeConfigDir } from "#core/providers/claude-cli.js";

const SKILL_FILENAME = "SKILL.md";
const FRONTMATTER_FENCE = "---";
const MAX_FRONTMATTER_BYTES = 2048;

/** Internal skill entry before provider merging. */
interface RawSkill {
  name: string;
  description: string;
  source: SkillInfo["source"];
  path: string;
  providers: ProviderKind[];
}

/** Parse YAML frontmatter from a SKILL.md file (lightweight, no YAML library). */
function parseFrontmatter(content: string): { name?: string; description?: string } {
  const trimmed = content.trimStart();
  if (!trimmed.startsWith(FRONTMATTER_FENCE)) return {};

  const afterFirst = trimmed.indexOf("\n");
  if (afterFirst === -1) return {};

  const endFence = trimmed.indexOf(`\n${FRONTMATTER_FENCE}`, afterFirst);
  if (endFence === -1) return {};

  const yaml = trimmed.slice(afterFirst + 1, endFence);

  let name: string | undefined;
  let description: string | undefined;

  for (const line of yaml.split("\n")) {
    const nameMatch = line.match(/^name:\s*(.+)/);
    if (nameMatch) {
      name = nameMatch[1].trim().replace(/^["']|["']$/g, "");
      continue;
    }

    const descMatch = line.match(/^description:\s*(.+)/);
    if (descMatch) {
      let desc = descMatch[1].trim();
      // Handle YAML multi-line (>) — just take the first line
      if (desc === ">" || desc === "|") {
        description = undefined; // will be picked up by continuation lines below
      } else {
        description = desc.replace(/^["']|["']$/g, "");
      }
      continue;
    }

    // Continuation line for multi-line description
    if (description === undefined && name !== undefined && line.match(/^\s+\S/)) {
      description = line.trim();
      continue;
    }
  }

  return { name, description };
}

/** Read a single skill directory. Returns null if SKILL.md is missing or unparseable. */
function readSkill(
  dirPath: string,
  source: SkillInfo["source"],
  providers: ProviderKind[],
): RawSkill | null {
  const skillFile = join(dirPath, SKILL_FILENAME);
  try {
    if (!existsSync(skillFile)) return null;

    // Read only the beginning — frontmatter is small
    const fd = openSync(skillFile, "r");
    const buf = Buffer.alloc(MAX_FRONTMATTER_BYTES);
    const bytesRead = readSync(fd, buf, 0, MAX_FRONTMATTER_BYTES, 0);
    closeSync(fd);
    const content = buf.toString("utf-8", 0, bytesRead);

    const { name, description } = parseFrontmatter(content);

    // Fall back to directory name if name field is missing
    const skillName = name || dirPath.split("/").pop() || "unknown";

    return {
      name: skillName,
      description: description || "",
      source,
      path: dirPath,
      providers,
    };
  } catch {
    return null;
  }
}

/** Scan a single skills directory, returning all valid skills found. */
function scanDirectory(
  dirPath: string,
  source: SkillInfo["source"],
  providers: ProviderKind[],
): RawSkill[] {
  const results: RawSkill[] = [];
  try {
    if (!existsSync(dirPath)) return results;
    const entries = readdirSync(dirPath, { withFileTypes: true });

    for (const entry of entries) {
      // Skip hidden dirs except .system (Codex system skills)
      if (entry.name.startsWith(".") && entry.name !== ".system") continue;

      const entryPath = join(dirPath, entry.name);

      // Handle .system subdirectory (Codex system skills)
      if (entry.name === ".system") {
        results.push(...scanDirectory(entryPath, "system", providers));
        continue;
      }

      // Resolve symlinks — statSync follows them (unlike lstatSync)
      let isDir = entry.isDirectory();
      if (entry.isSymbolicLink()) {
        try {
          isDir = statSync(entryPath).isDirectory();
        } catch {
          continue;
        }
      }

      if (!isDir) continue;

      const skill = readSkill(entryPath, source, providers);
      if (skill) results.push(skill);
    }
  } catch {
    /* directory doesn't exist or isn't readable */
  }

  return results;
}

/**
 * Discover all installed skills across project, user, and system scopes.
 *
 * Each scan directory is tagged with the providers that scan it at runtime:
 * - ~/.claude/skills/, <project>/.claude/skills/ → claude
 * - ~/.codex/skills/ (incl. .system/) → codex
 * - ~/.agents/skills/ → codex (and other non-Claude providers)
 * - <project>/.agents/skills/ → claude + codex (shared, cross-provider convention)
 *
 * When the same skill name appears in multiple directories, the highest-priority
 * entry's path/source is kept, but providers are merged (union).
 *
 * @param projectDir - Optional project directory for project-scoped skills.
 * @returns Deduplicated list of skills with merged provider information.
 */
export function discoverSkills(
  projectDir?: string,
  options: { claudeDir?: string } = {},
): SkillInfo[] {
  const home = homedir();
  // User-level Claude skills live in the config dir, which may not be ~/.claude.
  const claudeDir = options.claudeDir ?? resolveClaudeConfigDir();
  const seen = new Map<string, RawSkill>();

  // Add skills, merging providers when the same name appears in multiple directories.
  // The first occurrence wins for path/source (higher priority scanned first).
  const addSkills = (skills: RawSkill[]) => {
    for (const skill of skills) {
      const existing = seen.get(skill.name);
      if (existing) {
        // Merge providers — add any new ones
        for (const p of skill.providers) {
          if (!existing.providers.includes(p)) {
            existing.providers.push(p);
          }
        }
      } else {
        seen.set(skill.name, { ...skill, providers: [...skill.providers] });
      }
    }
  };

  // 1. Project-level skills (highest priority)
  if (projectDir) {
    addSkills(scanDirectory(join(projectDir, ".claude", "skills"), "project", ["claude"]));
    // .agents/skills is a shared, cross-provider convention — scanned by Claude and Codex alike.
    addSkills(scanDirectory(join(projectDir, ".agents", "skills"), "project", ["claude", "codex"]));
  }

  // 2. User-level Claude skills
  addSkills(scanDirectory(join(claudeDir, "skills"), "user", ["claude"]));

  // 3. User-level Codex skills (includes .system/ as "system" source)
  addSkills(scanDirectory(join(home, ".codex", "skills"), "user", ["codex"]));

  // 4. Agents-level (shared — scanned by codex and other non-Claude providers)
  addSkills(scanDirectory(join(home, ".agents", "skills"), "user", ["codex"]));

  // Sort: project first, then user, then system; alphabetical within each group
  const sourceOrder = { project: 0, user: 1, system: 2 };
  return Array.from(seen.values())
    .map(
      (raw): SkillInfo => ({
        name: raw.name,
        description: raw.description,
        source: raw.source,
        path: raw.path,
        providers: raw.providers.sort(),
      }),
    )
    .sort((a, b) => {
      const sourceDiff = sourceOrder[a.source] - sourceOrder[b.source];
      if (sourceDiff !== 0) return sourceDiff;
      return a.name.localeCompare(b.name);
    });
}
