/**
 * SessionDB — SQLite-backed session persistence for Relay
 *
 * Wraps node:sqlite with prepared statements for fast, synchronous access.
 * Handles schema migrations, corruption recovery, and index management.
 */

import { mkdirSync, renameSync, unlinkSync } from "fs";
import { dirname } from "path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import type { Logger } from "#core/logger.js";

const CURRENT_SCHEMA_VERSION = 26;
type SQLiteBindValue = string | number | bigint | null | NodeJS.ArrayBufferView;
type SQLiteBindParams = Record<string, SQLiteBindValue>;

function asBindParams<T extends object>(value: T): SQLiteBindParams {
  return value as unknown as SQLiteBindParams;
}

function asRow<T>(value: Record<string, unknown> | undefined): T | undefined {
  return value as T | undefined;
}

function asRows<T>(value: Record<string, unknown>[]): T[] {
  return value as unknown as T[];
}

export interface ProjectRow {
  id: string;
  name: string;
  slug: string;
  directory: string;
  repo_root: string | null;
  remote_url: string | null;
  target_branch: string | null;
  custom_instructions: string | null;
  default_space_branch: string | null;
  space_branch_source: string | null;
  default_provider: string | null;
  default_model: string | null;
  created_at: number;
  last_activity_at: number | null;
  suggestions_json: string | null;
}

export interface SpaceRow {
  id: string;
  project_directory: string;
  name: string;
  git_branch: string | null;
  worktree_path: string | null;
  is_default: number;
  status: string;
  created_at: number;
  last_activity_at: number;
  pinned?: number;
  merge_commit: string | null;
  merge_method: string | null;
  merged_at: number | null;
  target_branch: string | null;
  remote_status: string | null;
  pr_url: string | null;
  /** Local branch the space merges into (diff base, PR base, Complete target). */
  base_branch?: string | null;
  /** Last known PR status snapshot (JSON `SpacePrStatus`), refreshed on demand. */
  pr_status_json?: string | null;
}

export interface GlobalSettingsRow {
  id: number;
  theme: string;
  default_open_target: string | null;
  default_provider: string | null;
  default_model: string | null;
  default_space_branch: string | null;
  space_branch_source: string;
  provider_defaults_json: string | null;
  custom_instructions: string | null;
  project_order_json: string | null;
  suggestions_json: string | null;
  max_processes: number | null;
  sidebar_layout: string | null;
}

export interface SessionRow {
  session_id: string;
  instance_id: string;
  provider_name: string;
  name: string;
  working_directory: string;
  jsonl_path: string;
  created_at: number;
  last_activity_at: number;
  type: string;
  archived: number;
  custom_title: number;
  pinned: number;
  done_at: number | null;
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  summary: string | null;
  first_prompt: string | null;
  git_branch: string | null;
  message_count: number;
  allowed_tools: string;
  worktree_path: string | null;
  original_directory: string | null;
  parent_session_id: string | null;
  preferred_model: string | null;
  reasoning_budget: number | null;
  runtime_mode: string | null;
  last_message_text: string | null;
  last_message_from: string | null;
  last_message_at: number | null;
  git_info_branch: string | null;
  git_info_is_worktree: number | null;
  space_id: string | null;
  project_id: string | null;
  model: string | null;
}

export interface ManagedInstanceRow {
  instance_id: string;
  provider_name: string;
  provider_session_id: string | null;
  name: string;
  working_directory: string;
  created_at: number;
  last_activity_at: number;
  archived: number;
  custom_title: number;
  pinned: number;
  done_at: number | null;
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  git_branch: string | null;
  worktree_path: string | null;
  original_directory: string | null;
  parent_session_id: string | null;
  preferred_model: string | null;
  reasoning_budget: number | null;
  runtime_mode: string;
  resume_cursor_json: string | null;
  runtime_payload_json: string | null;
  transcript_path: string | null;
  last_message_text: string | null;
  last_message_from: string | null;
  last_message_at: number | null;
  git_info_branch: string | null;
  git_info_is_worktree: number | null;
  space_id: string | null;
  project_id: string | null;
  model: string | null;
  model_options_json: string | null;
  original_git_branch: string | null;
}

/**
 * Relay-level session event (e.g. a user-initiated model switch). These never
 * appear in the provider's transcript JSONL, so they are persisted here and
 * merged into history at hydrate time by timestamp.
 */
export interface SessionEventRow {
  id: number;
  instance_id: string;
  timestamp: number;
  event: string;
  payload_json: string | null;
}

export interface SpinOffRow {
  id: string;
  source_chat_id: string;
  source_chat_name: string | null;
  target_chat_id: string | null;
  target_chat_name: string | null;
  source_anchor_message_index: number | null;
  packet_json: string;
  status: string;
  created_at: number;
  sent_at: number | null;
}

function normalizeSessionRow(row: SessionRow): SessionRow {
  const normalized = { ...row };
  normalized.pinned ??= 0;
  normalized.done_at ??= null;
  normalized.summary ??= null;
  normalized.first_prompt ??= null;
  normalized.git_branch ??= null;
  normalized.allowed_tools ??= "[]";
  normalized.worktree_path ??= null;
  normalized.original_directory ??= null;
  normalized.parent_session_id ??= null;
  normalized.preferred_model ??= null;
  normalized.reasoning_budget ??= null;
  normalized.runtime_mode ??= null;
  normalized.last_message_text ??= null;
  normalized.last_message_from ??= null;
  normalized.last_message_at ??= null;
  normalized.git_info_branch ??= null;
  normalized.git_info_is_worktree ??= null;
  normalized.space_id ??= null;
  normalized.project_id ??= null;
  normalized.model ??= null;
  return normalized;
}

function normalizeManagedInstanceRow(row: ManagedInstanceRow): ManagedInstanceRow {
  const normalized = { ...row };
  normalized.pinned ??= 0;
  normalized.done_at ??= null;
  normalized.git_branch ??= null;
  normalized.worktree_path ??= null;
  normalized.original_directory ??= null;
  normalized.parent_session_id ??= null;
  normalized.preferred_model ??= null;
  normalized.reasoning_budget ??= null;
  normalized.resume_cursor_json ??= null;
  normalized.runtime_payload_json ??= null;
  normalized.transcript_path ??= null;
  normalized.last_message_text ??= null;
  normalized.last_message_from ??= null;
  normalized.last_message_at ??= null;
  normalized.git_info_branch ??= null;
  normalized.git_info_is_worktree ??= null;
  normalized.space_id ??= null;
  normalized.project_id ??= null;
  normalized.model ??= null;
  normalized.model_options_json ??= null;
  normalized.original_git_branch ??= null;
  return normalized;
}

function normalizeSpaceRow(row: SpaceRow): SpaceRow {
  const normalized = { ...row };
  normalized.git_branch ??= null;
  normalized.worktree_path ??= null;
  normalized.status ??= "active";
  normalized.pinned ??= 0;
  normalized.merge_commit ??= null;
  normalized.merge_method ??= null;
  normalized.merged_at ??= null;
  normalized.target_branch ??= null;
  normalized.remote_status ??= null;
  normalized.pr_url ??= null;
  normalized.base_branch ??= null;
  return normalized;
}

function normalizeProjectRow(row: ProjectRow): ProjectRow {
  const normalized = { ...row };
  // Slug is required at the application layer (it's how URLs are built), but
  // callers that build rows directly (tests, low-level migrations) may omit it.
  // Derive a structural default from directory basename; uniqueness is still
  // enforced by the partial UNIQUE INDEX on the column.
  if (typeof normalized.slug !== "string" || normalized.slug.length === 0) {
    const base = (normalized.directory.split("/").pop() || normalized.id)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
    normalized.slug = base.length > 0 ? base : "project";
  }
  normalized.repo_root ??= null;
  normalized.remote_url ??= null;
  normalized.target_branch ??= null;
  normalized.custom_instructions ??= null;
  normalized.default_space_branch ??= null;
  normalized.space_branch_source ??= null;
  normalized.default_provider ??= null;
  normalized.default_model ??= null;
  normalized.last_activity_at ??= null;
  normalized.suggestions_json ??= null;
  return normalized;
}

interface SearchResultRow {
  instance_id: string;
  source: string;
  project_id: string;
  space_id: string;
  last_activity_at: string;
  last_message_at: string;
  created_at: string;
  archived: string;
  pinned: string;
  title: string;
  summary: string;
  first_prompt: string;
  last_message_text: string;
  git_branch: string;
  transcript_content: string;
  title_snippet: string | null;
  summary_snippet: string | null;
  prompt_snippet: string | null;
  message_snippet: string | null;
  transcript_snippet: string | null;
  rank: number;
  combined_rank: number;
}

// `weight` is the bm25 per-column weight: a title hit should outrank a hit
// buried in a huge transcript, so title ≫ summary/branch > prompts/messages > transcript.
const SEARCH_INDEX_COLUMNS = [
  { name: "instance_id", unindexed: true },
  { name: "source", unindexed: true },
  { name: "project_id", unindexed: true },
  { name: "space_id", unindexed: true },
  { name: "last_activity_at", unindexed: true },
  { name: "last_message_at", unindexed: true },
  { name: "created_at", unindexed: true },
  { name: "archived", unindexed: true },
  { name: "pinned", unindexed: true },
  { name: "title", weight: 8.0 },
  { name: "summary", weight: 4.0 },
  { name: "first_prompt", weight: 3.0 },
  { name: "last_message_text", weight: 3.0 },
  { name: "git_branch", weight: 4.0 },
  { name: "transcript_content", weight: 1.0 },
] as const;

const SEARCH_SNIPPET_COLUMNS = [
  { name: "title", alias: "title_snippet", maxTokens: 40 },
  { name: "summary", alias: "summary_snippet", maxTokens: 60 },
  { name: "first_prompt", alias: "prompt_snippet", maxTokens: 60 },
  { name: "last_message_text", alias: "message_snippet", maxTokens: 60 },
  { name: "transcript_content", alias: "transcript_snippet", maxTokens: 60 },
] as const;

type SearchIndexColumnName = (typeof SEARCH_INDEX_COLUMNS)[number]["name"];

const SEARCH_INDEX_COLUMN_NUMBER = new Map<SearchIndexColumnName, number>(
  SEARCH_INDEX_COLUMNS.map((column, index) => [column.name, index]),
);

function getSearchIndexColumnNumber(name: SearchIndexColumnName): number {
  const columnNumber = SEARCH_INDEX_COLUMN_NUMBER.get(name);
  if (columnNumber == null) {
    throw new Error(`Unknown search index column: ${name}`);
  }
  return columnNumber;
}

function buildSearchIndexSchemaSql(): string {
  return SEARCH_INDEX_COLUMNS.map((column) =>
    "unindexed" in column && column.unindexed
      ? `        ${column.name} UNINDEXED`
      : `        ${column.name}`,
  ).join(",\n");
}

function buildSnippetSelectSql(): string {
  return SEARCH_SNIPPET_COLUMNS.map(
    (column) =>
      `snippet(search_index, ${getSearchIndexColumnNumber(column.name)}, '<mark>', '</mark>', '…', ${column.maxTokens}) AS ${column.alias}`,
  ).join(",\n        ");
}

// Chat recency = max(last_message_at, last_activity_at), matching the inbox's
// getChatRecencyTimestamp — either can lead (tool-only activity bumps
// last_activity_at without a message).
const RECENCY_SQL =
  "MAX(COALESCE(CAST(NULLIF(s.last_message_at, '') AS REAL), 0.0), CAST(s.last_activity_at AS REAL))";

/** Weighted bm25 expression (one weight per column; unindexed columns get 0) */
function buildBm25Sql(): string {
  const weights = SEARCH_INDEX_COLUMNS.map((column) =>
    "weight" in column ? column.weight.toFixed(1) : "0.0",
  );
  return `bm25(search_index, ${weights.join(", ")})`;
}

function buildSearchStatementSql(
  whereClause: string,
  options: { projectBoost?: boolean } = {},
): string {
  // Project boost: results in the boost project rank 2× better (bm25 is negative,
  // so multiplying makes it more negative). The `!= ''` guard keeps an empty boost
  // id from boosting projectless rows.
  const boostSql = options.projectBoost
    ? " * (CASE WHEN s.project_id = ? AND s.project_id != '' THEN 2.0 ELSE 1.0 END)"
    : "";
  return `
      SELECT *,
        ${buildSnippetSelectSql()},
        ${buildBm25Sql()} * (1.0 / (1.0 + (CAST(? AS REAL) - ${RECENCY_SQL}) / 1000.0 / 86400.0 / 30.0))${boostSql} AS combined_rank
      FROM search_index s
      WHERE ${whereClause}
      ORDER BY combined_rank
      LIMIT ?
    `;
}

// Pinned-first, then recency — matching compareChatListOrder in the UI
const RECENT_CHATS_ORDER_SQL = `ORDER BY CAST(s.pinned AS INTEGER) DESC, ${RECENCY_SQL} DESC`;

export interface SearchResult {
  instanceId: string;
  source: "session" | "managed";
  projectId: string | null;
  spaceId: string | null;
  lastActivityAt: number;
  lastMessageAt: number | null;
  createdAt: number;
  title: string;
  summary: string | null;
  gitBranch: string | null;
  snippet: string | null;
  matchField: string | null;
  rank: number;
  /** True when the result came from the OR fallback (not all terms matched) */
  partial?: boolean;
}

/** Strip all HTML tags except <mark> and </mark> from FTS5 snippet output */
export function sanitizeSnippet(html: string | null): string | null {
  if (!html) return null;
  // First, temporarily replace allowed <mark> tags with placeholders
  let s = html.replace(/<mark>/g, "\x00MARK_OPEN\x00").replace(/<\/mark>/g, "\x00MARK_CLOSE\x00");
  let stripped = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "<") {
      const closeIdx = s.indexOf(">", i + 1);
      const tagBody = closeIdx === -1 ? "" : s.slice(i + 1, closeIdx);
      if (closeIdx !== -1 && /^\/?[A-Za-z][^>]*$/.test(tagBody)) {
        i = closeIdx;
        continue;
      }
      stripped += "\x00LT\x00";
      continue;
    }
    if (ch === ">") {
      stripped += "\x00GT\x00";
      continue;
    }
    stripped += ch;
  }
  s = stripped;
  // Escape remaining HTML entities in the text content
  s = s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  s = s.replace(/\x00LT\x00/g, "&lt;").replace(/\x00GT\x00/g, "&gt;");
  // Restore allowed <mark> tags
  s = s.replace(/\x00MARK_OPEN\x00/g, "<mark>").replace(/\x00MARK_CLOSE\x00/g, "</mark>");
  return s;
}

export class SessionDB {
  private db: DatabaseSync;
  private transactionDepth = 0;

  /** Set to true if the DB was corrupt and had to be recreated */
  needsRebuild = false;

  // Prepared statements
  private stmtUpsert!: StatementSync;
  private stmtGetBySessionId!: StatementSync;
  private stmtGetByInstanceId!: StatementSync;
  private stmtGetByJsonlPath!: StatementSync;
  private stmtGetAllActive!: StatementSync;
  private stmtGetAll!: StatementSync;
  private stmtGetAllIncludeArchived!: StatementSync;
  private stmtUpsertManaged!: StatementSync;
  private stmtGetManagedByInstanceId!: StatementSync;
  private stmtGetAllManagedActive!: StatementSync;
  private stmtGetByProjectId!: StatementSync;
  private stmtGetManagedByProjectId!: StatementSync;
  private stmtGetBySpaceId!: StatementSync;
  private stmtGetManagedBySpaceId!: StatementSync;
  private stmtArchiveManaged!: StatementSync;
  private stmtArchive!: StatementSync;
  private stmtArchiveByInstanceId!: StatementSync;
  private stmtUnarchive!: StatementSync;
  private stmtUpdateStats!: StatementSync;
  private stmtUpdateLastActivity!: StatementSync;
  private stmtUpdateName!: StatementSync;
  private stmtSetPinned!: StatementSync;
  private stmtSetManagedPinned!: StatementSync;
  private stmtSetDone!: StatementSync;
  private stmtSetManagedDone!: StatementSync;
  private stmtGetJsonlPaths!: StatementSync;
  private stmtDeleteBySessionId!: StatementSync;
  private stmtDeleteByInstanceId!: StatementSync;
  private stmtDeleteManagedByInstanceId!: StatementSync;
  private stmtInsertSessionEvent!: StatementSync;
  private stmtGetSessionEvents!: StatementSync;
  private stmtDeleteSessionEvents!: StatementSync;
  private stmtUpdateAllowedTools!: StatementSync;
  private stmtUpdateWorkingDirectory!: StatementSync;
  private stmtUpdateSessionModel!: StatementSync;
  private stmtUpdatePreferredModel!: StatementSync;
  private stmtGetProjectStats!: StatementSync;
  private stmtGetGlobalStats!: StatementSync;
  private stmtUpsertProject!: StatementSync;
  private stmtGetProject!: StatementSync;
  private stmtGetProjectBySlug!: StatementSync;
  private stmtGetProjectByDir!: StatementSync;
  private stmtGetAllProjects!: StatementSync;
  private stmtDeleteProject!: StatementSync;
  private stmtAddRemovedProjectDir!: StatementSync;
  private stmtClearRemovedProjectDir!: StatementSync;
  private stmtGetRemovedProjectDirs!: StatementSync;
  private stmtUpdateProjectActivity!: StatementSync;
  private stmtUpdateSessionProjectId!: StatementSync;
  private stmtUpdateManagedSessionProjectId!: StatementSync;
  private stmtClearSessionProjectId!: StatementSync;
  private stmtClearManagedSessionProjectId!: StatementSync;
  private stmtUpdateSpaceProjectDirectoryById!: StatementSync;
  private stmtGetDistinctSessionDirs!: StatementSync;
  private stmtGetProjectModelStats!: StatementSync;
  private stmtUpsertSpace!: StatementSync;
  private stmtGetSpace!: StatementSync;
  private stmtGetSpaceByWorktreePath!: StatementSync;
  private stmtGetSpacesByProject!: StatementSync;
  private stmtGetDefaultSpace!: StatementSync;
  private stmtUpdateSpaceStatus!: StatementSync;
  private stmtUpdateSpaceActivity!: StatementSync;
  private stmtUpdateSpaceName!: StatementSync;
  private stmtUpdateSpacePinned!: StatementSync;
  private stmtDeleteSpace!: StatementSync;
  private stmtGetSpaceChatCount!: StatementSync;
  private stmtUpdateSessionSpaceId!: StatementSync;
  private stmtGetGlobalSettings!: StatementSync;
  private stmtUpdateGlobalSettings!: StatementSync;
  private stmtUpdateManagedSpaceId!: StatementSync;
  private stmtUpdateSpaceMergeMetadata!: StatementSync;
  private stmtUpdateSpaceRemoteStatus!: StatementSync;
  private stmtGetAllSpaces!: StatementSync;
  private stmtUpdateSpaceBaseBranch!: StatementSync;
  private stmtUpdateSpacePrStatus!: StatementSync;
  private stmtGetSpacesByProjectAll!: StatementSync;
  private stmtSearchProject!: StatementSync;
  private stmtSearchGlobal!: StatementSync;
  private stmtRecentChatsProject!: StatementSync;
  private stmtRecentChatsGlobal!: StatementSync;
  private stmtDeleteSearchDoc!: StatementSync;
  private stmtGetSearchDocRowids!: StatementSync;
  private stmtDeleteSearchDocRowids!: StatementSync;
  private stmtInsertSearchDocRowid!: StatementSync;
  private stmtInsertSearchDoc!: StatementSync;
  private stmtUpsertSearchContent!: StatementSync;
  private stmtGetSearchContent!: StatementSync;
  private stmtGetSearchContentSourceKey!: StatementSync;
  private stmtDeleteSearchContent!: StatementSync;
  private stmtInsertSpinOff!: StatementSync;
  private stmtGetSpinOff!: StatementSync;
  private stmtGetSpinOffsBySourceChat!: StatementSync;
  private stmtGetSpinOffsByTargetChat!: StatementSync;
  private stmtUpdateSpinOffStatus!: StatementSync;

  constructor(dbPath: string, logger: Logger) {
    // Ensure the directory exists
    mkdirSync(dirname(dbPath), { recursive: true });

    try {
      this.db = this.openDatabase(dbPath);
    } catch {
      // Corrupted file — rename (with WAL/SHM cleanup) and retry
      logger.warn(`[SessionDB] Database corrupted, recreating: ${dbPath}`);
      try {
        this.relocateDatabase(dbPath, `${dbPath}.corrupt.${Date.now()}`);
      } catch {
        // ignore rename errors
      }
      this.db = this.openDatabase(dbPath);
      this.needsRebuild = true;
    }

    this.migrate();
    this.ensureIndexes();
    this.prepareStatements();
  }

  /** Rename the DB file and remove its orphaned WAL/SHM sidecar files. */
  private relocateDatabase(fromPath: string, toPath: string): void {
    renameSync(fromPath, toPath);
    for (const suffix of ["-wal", "-shm"]) {
      try {
        unlinkSync(fromPath + suffix);
      } catch {
        // sidecar may not exist
      }
    }
  }

  private openDatabase(path: string): DatabaseSync {
    const db = new DatabaseSync(path, {
      timeout: 3000,
      readBigInts: false,
      allowBareNamedParameters: true,
      allowUnknownNamedParameters: true,
    });
    db.exec("PRAGMA journal_mode = WAL");
    return db;
  }

  private withTransaction<T>(fn: () => T): T {
    const savepoint = `relay_tx_${this.transactionDepth++}`;
    this.db.exec(`SAVEPOINT ${savepoint}`);
    try {
      const result = fn();
      this.db.exec(`RELEASE SAVEPOINT ${savepoint}`);
      return result;
    } catch (error) {
      try {
        this.db.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
      } catch {
        // Ignore rollback failures so the original error wins.
      }
      try {
        this.db.exec(`RELEASE SAVEPOINT ${savepoint}`);
      } catch {
        // Ignore cleanup failures so the original error wins.
      }
      throw error;
    } finally {
      this.transactionDepth = Math.max(0, this.transactionDepth - 1);
    }
  }

  private configureStatement(stmt: StatementSync): StatementSync {
    stmt.setAllowBareNamedParameters(true);
    stmt.setAllowUnknownNamedParameters(true);
    return stmt;
  }

  private ensureIndexes(): void {
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_sessions_space_id ON sessions(space_id);
      CREATE INDEX IF NOT EXISTS idx_managed_sessions_space_id ON managed_sessions(space_id);
      CREATE TABLE IF NOT EXISTS outbox_receipts (
        id TEXT PRIMARY KEY,
        instance_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('reserved', 'accepted')),
        created_at INTEGER NOT NULL
      );
    `);
    this.ensureSearchIndex();

    // Spin-off records stored in legacy `handoffs` table (added post-v20, uses
    // CREATE IF NOT EXISTS to avoid destructive schema-version bump).
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS handoffs (
        id TEXT PRIMARY KEY,
        source_chat_id TEXT NOT NULL,
        source_chat_name TEXT,
        target_chat_id TEXT,
        target_chat_name TEXT,
        source_anchor_message_index INTEGER,
        packet_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'draft',
        created_at INTEGER NOT NULL,
        sent_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_handoffs_source_chat_id ON handoffs(source_chat_id);
      CREATE INDEX IF NOT EXISTS idx_handoffs_target_chat_id ON handoffs(target_chat_id);
    `);
  }

  /** Reserve before handing a message to a provider. A stale reservation means
   * delivery is uncertain, so clients must not retry it automatically. */
  reserveOutboxReceipt(id: string, instanceId: string): "new" | "reserved" | "accepted" {
    const inserted =
      this.db
        .prepare(
          "INSERT OR IGNORE INTO outbox_receipts (id, instance_id, state, created_at) VALUES (?, ?, 'reserved', ?)",
        )
        .run(id, instanceId, Date.now()).changes > 0;
    const row = this.db
      .prepare("SELECT instance_id, state FROM outbox_receipts WHERE id = ?")
      .get(id) as { instance_id: string; state: "reserved" | "accepted" };
    if (row.instance_id !== instanceId) throw new Error("Send ID belongs to another chat");
    return inserted ? "new" : row.state;
  }

  getOutboxReceipt(id: string): { instanceId: string; state: "reserved" | "accepted" } | null {
    const row = this.db
      .prepare("SELECT instance_id, state FROM outbox_receipts WHERE id = ?")
      .get(id) as { instance_id: string; state: "reserved" | "accepted" } | undefined;
    return row ? { instanceId: row.instance_id, state: row.state } : null;
  }

  acceptOutboxReceipt(id: string): void {
    this.db.prepare("UPDATE outbox_receipts SET state = 'accepted' WHERE id = ?").run(id);
  }

  releaseOutboxReceipt(id: string): void {
    this.db.prepare("DELETE FROM outbox_receipts WHERE id = ? AND state = 'reserved'").run(id);
  }

  private ensureSearchIndex(): void {
    // Drop the search_index if it's a legacy contentless table or is missing
    // the transcript_content column. The index is rebuilt on every startup,
    // so dropping it is safe.
    const info = this.db
      .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='search_index'")
      .get() as { sql: string } | undefined;
    const missingSearchColumn =
      info && SEARCH_INDEX_COLUMNS.some((column) => !info.sql.includes(column.name));
    if (
      info?.sql?.includes("content=''") ||
      info?.sql?.includes('content=""') ||
      missingSearchColumn
    ) {
      this.db.exec("DROP TABLE IF EXISTS search_index");
      this.db.exec("DROP TABLE IF EXISTS search_index_docs");
    }
    const hasDocRowids = !!this.db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='search_index_docs'")
      .get();

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS search_content (
        instance_id TEXT PRIMARY KEY,
        transcript_text TEXT NOT NULL DEFAULT ''
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS search_index USING fts5(
${buildSearchIndexSchemaSql()},
        tokenize='unicode61'
      );

      -- instance → FTS rowid, so per-chat index updates delete by rowid
      CREATE TABLE IF NOT EXISTS search_index_docs (
        instance_id TEXT NOT NULL,
        source TEXT NOT NULL,
        doc_rowid INTEGER NOT NULL,
        PRIMARY KEY (instance_id, source)
      );
    `);
    const contentColumns = this.db.prepare("PRAGMA table_info(search_content)").all() as Array<{
      name?: string;
    }>;
    if (!contentColumns.some((column) => column.name === "source_key")) {
      this.db.exec("ALTER TABLE search_content ADD COLUMN source_key TEXT");
    }
    // Docs written before the rowid map existed could never be removed by
    // rowid; drop them (startup rebuilds the index anyway).
    if (!hasDocRowids) {
      this.db.exec("DELETE FROM search_index");
    }
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_version (
        version INTEGER NOT NULL
      )
    `);

    const versionRow = this.db.prepare("SELECT version FROM schema_version LIMIT 1").get() as
      | { version: number }
      | undefined;

    const currentVersion = versionRow?.version ?? 0;

    if (currentVersion === 0) {
      // Fresh database — create everything
      this.createSchema();
      this.ensureGlobalSettingsColumns();
      this.ensureSuggestionsColumns();
      this.ensureRuntimeModeColumns();
      this.ensureProjectSlugColumn();
      this.ensureChatFlagColumns();
      this.ensureSpacePinColumn();
      this.db.exec(`INSERT INTO schema_version (version) VALUES (${CURRENT_SCHEMA_VERSION})`);
      return;
    }

    if (currentVersion >= CURRENT_SCHEMA_VERSION) {
      // Current or newer can still have schema drift (e.g. interrupted/manual
      // migrations, branch switches, older dev checkouts). Keep lightweight
      // shape repairs idempotent and independent of schema_version.
      this.createSchema();
      this.ensureGlobalSettingsColumns();
      this.ensureSuggestionsColumns();
      this.ensureRuntimeModeColumns();
      this.ensureProjectSlugColumn();
      this.ensureChatFlagColumns();
      this.ensureSpacePinColumn();
      return;
    }

    // Older version — run idempotent schema creation to add any new
    // tables/indexes, then bump the version. Data is preserved.
    this.createSchema();
    this.ensureGlobalSettingsColumns();
    this.ensureSuggestionsColumns();
    this.ensureRuntimeModeColumns();
    this.ensureChatFlagColumns();
    this.ensureSpacePinColumn();
    this.db.exec(`UPDATE schema_version SET version = ${CURRENT_SCHEMA_VERSION}`);
  }

  private createSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        session_id TEXT PRIMARY KEY,
        instance_id TEXT NOT NULL UNIQUE,
        provider_name TEXT NOT NULL DEFAULT 'claude',
        name TEXT NOT NULL,
        working_directory TEXT NOT NULL,
        jsonl_path TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL,
        last_activity_at INTEGER NOT NULL,
        type TEXT NOT NULL DEFAULT 'external',
        archived INTEGER NOT NULL DEFAULT 0,
        custom_title INTEGER NOT NULL DEFAULT 0,
        pinned INTEGER NOT NULL DEFAULT 0,
        done_at INTEGER,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens INTEGER NOT NULL DEFAULT 0,
        summary TEXT,
        first_prompt TEXT,
        git_branch TEXT,
        message_count INTEGER NOT NULL DEFAULT 0,
        allowed_tools TEXT NOT NULL DEFAULT '[]',
        worktree_path TEXT,
        original_directory TEXT,
        parent_session_id TEXT,
        preferred_model TEXT,
        reasoning_budget INTEGER,
        runtime_mode TEXT,
        last_message_text TEXT,
        last_message_from TEXT,
        last_message_at INTEGER,
        git_info_branch TEXT,
        git_info_is_worktree INTEGER,
        space_id TEXT,
        project_id TEXT,
        model TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_sessions_working_directory ON sessions(working_directory);
      CREATE INDEX IF NOT EXISTS idx_sessions_archived ON sessions(archived);
      CREATE INDEX IF NOT EXISTS idx_sessions_last_activity_at ON sessions(last_activity_at);
      CREATE INDEX IF NOT EXISTS idx_sessions_jsonl_path ON sessions(jsonl_path);
      CREATE INDEX IF NOT EXISTS idx_sessions_project_id ON sessions(project_id);

      CREATE TABLE IF NOT EXISTS managed_sessions (
        instance_id TEXT PRIMARY KEY,
        provider_name TEXT NOT NULL,
        provider_session_id TEXT,
        name TEXT NOT NULL,
        working_directory TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_activity_at INTEGER NOT NULL,
        archived INTEGER NOT NULL DEFAULT 0,
        custom_title INTEGER NOT NULL DEFAULT 0,
        pinned INTEGER NOT NULL DEFAULT 0,
        done_at INTEGER,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens INTEGER NOT NULL DEFAULT 0,
        git_branch TEXT,
        worktree_path TEXT,
        original_directory TEXT,
        parent_session_id TEXT,
        preferred_model TEXT,
        reasoning_budget INTEGER,
        runtime_mode TEXT NOT NULL DEFAULT 'approval-required',
        resume_cursor_json TEXT,
        runtime_payload_json TEXT,
        transcript_path TEXT,
        last_message_text TEXT,
        last_message_from TEXT,
        last_message_at INTEGER,
        git_info_branch TEXT,
        git_info_is_worktree INTEGER,
        space_id TEXT,
        project_id TEXT,
        model TEXT,
        model_options_json TEXT,
        original_git_branch TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_managed_sessions_provider ON managed_sessions(provider_name);
      CREATE INDEX IF NOT EXISTS idx_managed_sessions_archived ON managed_sessions(archived);
      CREATE INDEX IF NOT EXISTS idx_managed_sessions_working_directory ON managed_sessions(working_directory);
      CREATE INDEX IF NOT EXISTS idx_managed_sessions_provider_session_id ON managed_sessions(provider_session_id);
      CREATE INDEX IF NOT EXISTS idx_managed_sessions_project_id ON managed_sessions(project_id);

      CREATE TABLE IF NOT EXISTS session_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        instance_id TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        event TEXT NOT NULL,
        payload_json TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_session_events_instance_id ON session_events(instance_id);

      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        slug TEXT,
        directory TEXT NOT NULL UNIQUE,
        repo_root TEXT,
        remote_url TEXT,
        target_branch TEXT,
        custom_instructions TEXT,
        default_space_branch TEXT,
        space_branch_source TEXT,
        default_provider TEXT,
        default_model TEXT,
        created_at INTEGER NOT NULL,
        last_activity_at INTEGER,
        suggestions_json TEXT
      );

      CREATE TABLE IF NOT EXISTS removed_projects (
        directory TEXT PRIMARY KEY,
        removed_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS spaces (
        id TEXT PRIMARY KEY,
        project_directory TEXT NOT NULL,
        name TEXT NOT NULL,
        git_branch TEXT,
        worktree_path TEXT,
        is_default INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'active',
        created_at INTEGER NOT NULL,
        last_activity_at INTEGER NOT NULL,
        pinned INTEGER NOT NULL DEFAULT 0,
        merge_commit TEXT,
        merge_method TEXT,
        merged_at INTEGER,
        target_branch TEXT,
        remote_status TEXT,
        pr_url TEXT,
        base_branch TEXT,
        pr_status_json TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_spaces_project_directory ON spaces(project_directory);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_spaces_default_per_project
        ON spaces(project_directory) WHERE is_default = 1;

      CREATE TABLE IF NOT EXISTS global_settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        theme TEXT DEFAULT 'dark',
        default_open_target TEXT,
        default_provider TEXT,
        default_model TEXT,
        default_space_branch TEXT,
        space_branch_source TEXT DEFAULT 'local',
        provider_defaults_json TEXT,
        custom_instructions TEXT,
        project_order_json TEXT,
        suggestions_json TEXT,
        max_processes INTEGER,
        sidebar_layout TEXT
      );

      INSERT OR IGNORE INTO global_settings (id) VALUES (1);
    `);
  }

  private ensureGlobalSettingsColumns(): void {
    const columns = this.db.prepare("PRAGMA table_info(global_settings)").all() as Array<{
      name?: string;
    }>;
    const columnNames = new Set(
      columns.map((column) => (typeof column.name === "string" ? column.name : "")).filter(Boolean),
    );

    if (!columnNames.has("project_order_json")) {
      this.db.exec("ALTER TABLE global_settings ADD COLUMN project_order_json TEXT");
    }
    if (!columnNames.has("max_processes")) {
      this.db.exec("ALTER TABLE global_settings ADD COLUMN max_processes INTEGER");
    }
    if (!columnNames.has("sidebar_layout")) {
      this.db.exec("ALTER TABLE global_settings ADD COLUMN sidebar_layout TEXT");
    }
  }

  /**
   * Migration for schema v24: collapse `skip_permissions` (and any legacy plan-mode
   * signal stored on managed_sessions.runtime_mode) into a single `runtime_mode`
   * column on both sessions and managed_sessions. Idempotent — safe to run on
   * fresh and migrated databases alike.
   */
  private ensureRuntimeModeColumns(): void {
    const tableHasColumn = (table: string, column: string): boolean => {
      const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
        name?: string;
      }>;
      return columns.some((c) => c.name === column);
    };

    // sessions: add runtime_mode if missing, backfill from skip_permissions, drop skip_permissions
    if (!tableHasColumn("sessions", "runtime_mode")) {
      this.db.exec("ALTER TABLE sessions ADD COLUMN runtime_mode TEXT");
    }
    if (tableHasColumn("sessions", "skip_permissions")) {
      this.db.exec(
        "UPDATE sessions SET runtime_mode = 'full-access' WHERE runtime_mode IS NULL AND skip_permissions = 1",
      );
      this.db.exec("ALTER TABLE sessions DROP COLUMN skip_permissions");
    }

    // managed_sessions: runtime_mode already exists from v23, but the column was
    // populated alongside skip_permissions. Backfill any rows where runtime_mode
    // is empty/default but skip_permissions indicates full-access, then drop the
    // legacy column.
    if (!tableHasColumn("managed_sessions", "runtime_mode")) {
      this.db.exec(
        "ALTER TABLE managed_sessions ADD COLUMN runtime_mode TEXT NOT NULL DEFAULT 'approval-required'",
      );
    }
    if (tableHasColumn("managed_sessions", "skip_permissions")) {
      // Where runtime_mode wasn't explicitly set (still at default) but
      // skip_permissions was on, prefer the user-meaningful full-access value.
      this.db.exec(
        "UPDATE managed_sessions SET runtime_mode = 'full-access' WHERE runtime_mode = 'approval-required' AND skip_permissions = 1",
      );
      this.db.exec("ALTER TABLE managed_sessions DROP COLUMN skip_permissions");
    }
  }

  /**
   * Migration for schema v25: add `slug` column to projects for human-readable URLs.
   * Backfill happens later in ProjectManager once it can compute basenames + handle collisions.
   * Idempotent.
   */
  private ensureProjectSlugColumn(): void {
    const columns = this.db.prepare("PRAGMA table_info(projects)").all() as Array<{
      name?: string;
    }>;
    const has = columns.some((c) => c.name === "slug");
    if (!has) {
      this.db.exec("ALTER TABLE projects ADD COLUMN slug TEXT");
    }
    this.db.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_slug ON projects(slug) WHERE slug IS NOT NULL",
    );
  }

  /**
   * Add the per-chat user flags (`pinned`, `done_at`) to both session tables.
   * Idempotent — safe to run on fresh and migrated databases alike.
   */
  private ensureChatFlagColumns(): void {
    const ensureFor = (table: "sessions" | "managed_sessions") => {
      const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
        name?: string;
      }>;
      const names = new Set(columns.map((c) => c.name));
      if (!names.has("pinned")) {
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0`);
      }
      if (!names.has("done_at")) {
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN done_at INTEGER`);
      }
    };
    ensureFor("sessions");
    ensureFor("managed_sessions");
  }

  /**
   * Add the independently persisted per-space columns (pin flag, recorded base
   * branch, last known PR status). Additive and idempotent, so existing
   * databases keep their data without a schema-version rebuild.
   */
  private ensureSpacePinColumn(): void {
    const columns = this.db.prepare("PRAGMA table_info(spaces)").all() as Array<{ name?: string }>;
    const names = new Set(columns.map((column) => column.name));
    if (!names.has("pinned")) {
      this.db.exec("ALTER TABLE spaces ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0");
    }
    if (!names.has("base_branch")) {
      this.db.exec("ALTER TABLE spaces ADD COLUMN base_branch TEXT");
    }
    if (!names.has("pr_status_json")) {
      this.db.exec("ALTER TABLE spaces ADD COLUMN pr_status_json TEXT");
    }
  }

  private ensureSuggestionsColumns(): void {
    const ensureFor = (table: "global_settings" | "projects") => {
      const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
        name?: string;
      }>;
      const names = new Set(
        columns
          .map((column) => (typeof column.name === "string" ? column.name : ""))
          .filter(Boolean),
      );
      // Legacy (pre-release) column rename: space_actions_json -> suggestions_json.
      if (names.has("space_actions_json") && !names.has("suggestions_json")) {
        this.db.exec(`ALTER TABLE ${table} RENAME COLUMN space_actions_json TO suggestions_json`);
        return;
      }
      if (!names.has("suggestions_json")) {
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN suggestions_json TEXT`);
      }
    };
    ensureFor("global_settings");
    ensureFor("projects");
  }

  private prepareStatements(): void {
    this.stmtUpsert = this.configureStatement(
      this.db.prepare(`
      INSERT INTO sessions (
        session_id, instance_id, provider_name, name, working_directory, jsonl_path,
        created_at, last_activity_at, type, archived, custom_title, pinned, done_at,
        input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens,
        summary, first_prompt, git_branch, message_count, allowed_tools,
        worktree_path, original_directory, parent_session_id, preferred_model, reasoning_budget, runtime_mode,
        last_message_text, last_message_from, last_message_at,
        git_info_branch, git_info_is_worktree, space_id, project_id, model
      ) VALUES (
        @session_id, @instance_id, @provider_name, @name, @working_directory, @jsonl_path,
        @created_at, @last_activity_at, @type, @archived, @custom_title, @pinned, @done_at,
        @input_tokens, @output_tokens, @cache_creation_tokens, @cache_read_tokens,
        @summary, @first_prompt, @git_branch, @message_count, @allowed_tools,
        @worktree_path, @original_directory, @parent_session_id, @preferred_model, @reasoning_budget, @runtime_mode,
        @last_message_text, @last_message_from, @last_message_at,
        @git_info_branch, @git_info_is_worktree, @space_id, @project_id, @model
      )
      ON CONFLICT(session_id) DO UPDATE SET
        instance_id = excluded.instance_id,
        provider_name = excluded.provider_name,
        name = excluded.name,
        working_directory = excluded.working_directory,
        jsonl_path = excluded.jsonl_path,
        last_activity_at = excluded.last_activity_at,
        type = excluded.type,
        archived = excluded.archived,
        custom_title = excluded.custom_title,
        -- pinned / done_at intentionally omitted: only setPinned() and
        -- setDone() mutate them, so upserts from stale info snapshots
        -- can't clobber a pin or a done marker
        input_tokens = excluded.input_tokens,
        output_tokens = excluded.output_tokens,
        cache_creation_tokens = excluded.cache_creation_tokens,
        cache_read_tokens = excluded.cache_read_tokens,
        summary = excluded.summary,
        first_prompt = excluded.first_prompt,
        git_branch = excluded.git_branch,
        message_count = excluded.message_count,
        allowed_tools = excluded.allowed_tools,
        worktree_path = excluded.worktree_path,
        original_directory = excluded.original_directory,
        parent_session_id = excluded.parent_session_id,
        preferred_model = excluded.preferred_model,
        reasoning_budget = excluded.reasoning_budget,
        runtime_mode = excluded.runtime_mode,
        last_message_text = excluded.last_message_text,
        last_message_from = excluded.last_message_from,
        last_message_at = excluded.last_message_at,
        git_info_branch = excluded.git_info_branch,
        git_info_is_worktree = excluded.git_info_is_worktree,
        space_id = excluded.space_id,
        project_id = excluded.project_id,
        model = excluded.model
    `),
    );

    this.stmtUpsertManaged = this.configureStatement(
      this.db.prepare(`
      INSERT INTO managed_sessions (
        instance_id, provider_name, provider_session_id, name, working_directory,
        created_at, last_activity_at, archived, custom_title, pinned, done_at,
        input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens,
        git_branch, worktree_path, original_directory, parent_session_id,
        preferred_model, reasoning_budget, runtime_mode,
        resume_cursor_json, runtime_payload_json, transcript_path,
        last_message_text, last_message_from, last_message_at,
        git_info_branch, git_info_is_worktree, space_id, project_id, model,
        model_options_json, original_git_branch
      ) VALUES (
        @instance_id, @provider_name, @provider_session_id, @name, @working_directory,
        @created_at, @last_activity_at, @archived, @custom_title, @pinned, @done_at,
        @input_tokens, @output_tokens, @cache_creation_tokens, @cache_read_tokens,
        @git_branch, @worktree_path, @original_directory, @parent_session_id,
        @preferred_model, @reasoning_budget, @runtime_mode,
        @resume_cursor_json, @runtime_payload_json, @transcript_path,
        @last_message_text, @last_message_from, @last_message_at,
        @git_info_branch, @git_info_is_worktree, @space_id, @project_id, @model,
        @model_options_json, @original_git_branch
      )
      ON CONFLICT(instance_id) DO UPDATE SET
        provider_name = excluded.provider_name,
        provider_session_id = excluded.provider_session_id,
        name = excluded.name,
        working_directory = excluded.working_directory,
        last_activity_at = excluded.last_activity_at,
        archived = excluded.archived,
        custom_title = excluded.custom_title,
        -- pinned / done_at intentionally omitted: only setPinned() and
        -- setDone() mutate them, so upserts from stale info snapshots
        -- can't clobber a pin or a done marker
        input_tokens = excluded.input_tokens,
        output_tokens = excluded.output_tokens,
        cache_creation_tokens = excluded.cache_creation_tokens,
        cache_read_tokens = excluded.cache_read_tokens,
        git_branch = excluded.git_branch,
        worktree_path = excluded.worktree_path,
        original_directory = excluded.original_directory,
        parent_session_id = excluded.parent_session_id,
        preferred_model = excluded.preferred_model,
        reasoning_budget = excluded.reasoning_budget,
        runtime_mode = excluded.runtime_mode,
        resume_cursor_json = excluded.resume_cursor_json,
        runtime_payload_json = excluded.runtime_payload_json,
        transcript_path = excluded.transcript_path,
        last_message_text = excluded.last_message_text,
        last_message_from = excluded.last_message_from,
        last_message_at = excluded.last_message_at,
        git_info_branch = excluded.git_info_branch,
        git_info_is_worktree = excluded.git_info_is_worktree,
        space_id = excluded.space_id,
        project_id = excluded.project_id,
        model = excluded.model,
        model_options_json = excluded.model_options_json,
        original_git_branch = excluded.original_git_branch
    `),
    );

    this.stmtGetBySessionId = this.configureStatement(
      this.db.prepare("SELECT * FROM sessions WHERE session_id = ?"),
    );

    this.stmtGetByInstanceId = this.configureStatement(
      this.db.prepare("SELECT * FROM sessions WHERE instance_id = ?"),
    );

    this.stmtGetManagedByInstanceId = this.configureStatement(
      this.db.prepare("SELECT * FROM managed_sessions WHERE instance_id = ?"),
    );

    this.stmtGetByJsonlPath = this.configureStatement(
      this.db.prepare("SELECT * FROM sessions WHERE jsonl_path = ?"),
    );

    this.stmtGetAllActive = this.configureStatement(
      this.db.prepare("SELECT * FROM sessions WHERE archived = 0 ORDER BY last_activity_at DESC"),
    );

    this.stmtGetAll = this.configureStatement(
      this.db.prepare("SELECT * FROM sessions WHERE archived = 0 ORDER BY last_activity_at DESC"),
    );

    this.stmtGetAllIncludeArchived = this.configureStatement(
      this.db.prepare("SELECT * FROM sessions ORDER BY last_activity_at DESC"),
    );

    this.stmtGetAllManagedActive = this.configureStatement(
      this.db.prepare(
        "SELECT * FROM managed_sessions WHERE archived = 0 ORDER BY last_activity_at DESC",
      ),
    );

    this.stmtGetByProjectId = this.configureStatement(
      this.db.prepare(
        "SELECT * FROM sessions WHERE project_id = ? AND archived = 0 ORDER BY last_activity_at DESC",
      ),
    );

    this.stmtGetManagedByProjectId = this.configureStatement(
      this.db.prepare(
        "SELECT * FROM managed_sessions WHERE project_id = ? AND archived = 0 ORDER BY last_activity_at DESC",
      ),
    );

    this.stmtGetBySpaceId = this.configureStatement(
      this.db.prepare(
        "SELECT * FROM sessions WHERE space_id = ? AND archived = 0 ORDER BY last_activity_at DESC",
      ),
    );

    this.stmtGetManagedBySpaceId = this.configureStatement(
      this.db.prepare(
        "SELECT * FROM managed_sessions WHERE space_id = ? AND archived = 0 ORDER BY last_activity_at DESC",
      ),
    );

    this.stmtArchive = this.configureStatement(
      this.db.prepare("UPDATE sessions SET archived = 1 WHERE session_id = ?"),
    );

    this.stmtArchiveByInstanceId = this.configureStatement(
      this.db.prepare("UPDATE sessions SET archived = 1 WHERE instance_id = ?"),
    );

    this.stmtArchiveManaged = this.configureStatement(
      this.db.prepare("UPDATE managed_sessions SET archived = 1 WHERE instance_id = ?"),
    );

    this.stmtUnarchive = this.configureStatement(
      this.db.prepare("UPDATE sessions SET archived = 0 WHERE session_id = ?"),
    );

    this.stmtUpdateStats = this.db.prepare(`
      UPDATE sessions SET
        input_tokens = @input_tokens,
        output_tokens = @output_tokens,
        cache_creation_tokens = @cache_creation_tokens,
        cache_read_tokens = @cache_read_tokens
      WHERE session_id = @session_id
    `);

    this.stmtUpdateLastActivity = this.db.prepare(
      "UPDATE sessions SET last_activity_at = ? WHERE session_id = ? AND last_activity_at IS NOT ?",
    );

    this.stmtUpdateName = this.db.prepare(
      "UPDATE sessions SET name = ?, custom_title = ? WHERE session_id = ?",
    );

    this.stmtSetPinned = this.db.prepare("UPDATE sessions SET pinned = ? WHERE instance_id = ?");

    this.stmtSetManagedPinned = this.db.prepare(
      "UPDATE managed_sessions SET pinned = ? WHERE instance_id = ?",
    );

    this.stmtSetDone = this.db.prepare("UPDATE sessions SET done_at = ? WHERE instance_id = ?");

    this.stmtSetManagedDone = this.db.prepare(
      "UPDATE managed_sessions SET done_at = ? WHERE instance_id = ?",
    );

    this.stmtGetJsonlPaths = this.db.prepare("SELECT jsonl_path FROM sessions");

    this.stmtDeleteBySessionId = this.db.prepare("DELETE FROM sessions WHERE session_id = ?");

    this.stmtDeleteByInstanceId = this.db.prepare("DELETE FROM sessions WHERE instance_id = ?");

    this.stmtDeleteManagedByInstanceId = this.db.prepare(
      "DELETE FROM managed_sessions WHERE instance_id = ?",
    );

    this.stmtInsertSessionEvent = this.db.prepare(
      "INSERT INTO session_events (instance_id, timestamp, event, payload_json) VALUES (?, ?, ?, ?)",
    );

    this.stmtGetSessionEvents = this.db.prepare(
      "SELECT * FROM session_events WHERE instance_id = ? ORDER BY timestamp ASC, id ASC",
    );

    this.stmtDeleteSessionEvents = this.db.prepare(
      "DELETE FROM session_events WHERE instance_id = ?",
    );

    this.stmtUpdateAllowedTools = this.db.prepare(
      "UPDATE sessions SET allowed_tools = ? WHERE session_id = ?",
    );

    this.stmtUpdateWorkingDirectory = this.db.prepare(
      "UPDATE sessions SET working_directory = ? WHERE session_id = ?",
    );

    this.stmtUpdateSessionModel = this.db.prepare(
      "UPDATE sessions SET model = ? WHERE session_id = ?",
    );

    this.stmtUpdatePreferredModel = this.db.prepare(
      "UPDATE sessions SET preferred_model = ? WHERE session_id = ?",
    );

    this.stmtGetProjectStats = this.db.prepare(`
      SELECT
        COALESCE(SUM(session_count), 0) as session_count,
        COALESCE(SUM(input_tokens), 0) as input_tokens,
        COALESCE(SUM(output_tokens), 0) as output_tokens,
        COALESCE(SUM(cache_creation_tokens), 0) as cache_creation_tokens,
        COALESCE(SUM(cache_read_tokens), 0) as cache_read_tokens
      FROM (
        SELECT
          COUNT(*) as session_count,
          COALESCE(SUM(input_tokens), 0) as input_tokens,
          COALESCE(SUM(output_tokens), 0) as output_tokens,
          COALESCE(SUM(cache_creation_tokens), 0) as cache_creation_tokens,
          COALESCE(SUM(cache_read_tokens), 0) as cache_read_tokens
        FROM sessions
        WHERE archived = 0 AND type = 'external' AND working_directory = ?
        UNION ALL
        SELECT
          COUNT(*) as session_count,
          COALESCE(SUM(input_tokens), 0) as input_tokens,
          COALESCE(SUM(output_tokens), 0) as output_tokens,
          COALESCE(SUM(cache_creation_tokens), 0) as cache_creation_tokens,
          COALESCE(SUM(cache_read_tokens), 0) as cache_read_tokens
        FROM managed_sessions
        WHERE archived = 0 AND working_directory = ?
      )
    `);

    this.stmtGetGlobalStats = this.db.prepare(`
      SELECT
        COALESCE(SUM(session_count), 0) as session_count,
        COALESCE(SUM(input_tokens), 0) as input_tokens,
        COALESCE(SUM(output_tokens), 0) as output_tokens,
        COALESCE(SUM(cache_creation_tokens), 0) as cache_creation_tokens,
        COALESCE(SUM(cache_read_tokens), 0) as cache_read_tokens
      FROM (
        SELECT
          COUNT(*) as session_count,
          COALESCE(SUM(input_tokens), 0) as input_tokens,
          COALESCE(SUM(output_tokens), 0) as output_tokens,
          COALESCE(SUM(cache_creation_tokens), 0) as cache_creation_tokens,
          COALESCE(SUM(cache_read_tokens), 0) as cache_read_tokens
        FROM sessions
        WHERE archived = 0 AND type = 'external'
        UNION ALL
        SELECT
          COUNT(*) as session_count,
          COALESCE(SUM(input_tokens), 0) as input_tokens,
          COALESCE(SUM(output_tokens), 0) as output_tokens,
          COALESCE(SUM(cache_creation_tokens), 0) as cache_creation_tokens,
          COALESCE(SUM(cache_read_tokens), 0) as cache_read_tokens
        FROM managed_sessions
        WHERE archived = 0
      )
    `);

    // Project CRUD
    this.stmtUpsertProject = this.db.prepare(`
      INSERT INTO projects (id, name, slug, directory, repo_root, remote_url, target_branch, custom_instructions, default_space_branch, space_branch_source, default_provider, default_model, created_at, last_activity_at, suggestions_json)
      VALUES (@id, @name, @slug, @directory, @repo_root, @remote_url, @target_branch, @custom_instructions, @default_space_branch, @space_branch_source, @default_provider, @default_model, @created_at, @last_activity_at, @suggestions_json)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        slug = excluded.slug,
        directory = excluded.directory,
        repo_root = excluded.repo_root,
        remote_url = excluded.remote_url,
        target_branch = excluded.target_branch,
        custom_instructions = excluded.custom_instructions,
        default_space_branch = excluded.default_space_branch,
        space_branch_source = excluded.space_branch_source,
        default_provider = excluded.default_provider,
        default_model = excluded.default_model,
        last_activity_at = excluded.last_activity_at,
        suggestions_json = excluded.suggestions_json
    `);
    this.stmtGetProject = this.db.prepare("SELECT * FROM projects WHERE id = ?");
    this.stmtGetProjectBySlug = this.db.prepare("SELECT * FROM projects WHERE slug = ?");
    this.stmtGetProjectByDir = this.db.prepare("SELECT * FROM projects WHERE directory = ?");
    this.stmtGetAllProjects = this.db.prepare(
      "SELECT * FROM projects ORDER BY last_activity_at DESC NULLS LAST, created_at DESC",
    );
    this.stmtDeleteProject = this.db.prepare("DELETE FROM projects WHERE id = ?");
    this.stmtAddRemovedProjectDir = this.db.prepare(
      "INSERT OR REPLACE INTO removed_projects (directory, removed_at) VALUES (?, ?)",
    );
    this.stmtClearRemovedProjectDir = this.db.prepare(
      "DELETE FROM removed_projects WHERE directory = ?",
    );
    this.stmtGetRemovedProjectDirs = this.db.prepare("SELECT directory FROM removed_projects");
    this.stmtUpdateProjectActivity = this.db.prepare(
      "UPDATE projects SET last_activity_at = ? WHERE id = ?",
    );
    this.stmtUpdateSessionProjectId = this.db.prepare(
      "UPDATE sessions SET project_id = ? WHERE working_directory = ?",
    );
    this.stmtUpdateManagedSessionProjectId = this.db.prepare(
      "UPDATE managed_sessions SET project_id = ? WHERE working_directory = ?",
    );
    this.stmtClearSessionProjectId = this.db.prepare(
      "UPDATE sessions SET project_id = NULL WHERE project_id = ?",
    );
    this.stmtClearManagedSessionProjectId = this.db.prepare(
      "UPDATE managed_sessions SET project_id = NULL WHERE project_id = ?",
    );
    this.stmtUpdateSpaceProjectDirectoryById = this.db.prepare(
      "UPDATE spaces SET project_directory = ? WHERE id = ?",
    );
    this.stmtGetDistinctSessionDirs = this.db.prepare(`
      SELECT DISTINCT working_directory FROM (
        SELECT working_directory FROM sessions WHERE archived = 0
        UNION
        SELECT working_directory FROM managed_sessions WHERE archived = 0
      )
    `);
    this.stmtGetProjectModelStats = this.db.prepare(`
      SELECT
        model,
        provider_name,
        COALESCE(SUM(session_count), 0) as session_count,
        COALESCE(SUM(input_tokens), 0) as input_tokens,
        COALESCE(SUM(output_tokens), 0) as output_tokens,
        COALESCE(SUM(cache_creation_tokens), 0) as cache_creation_tokens,
        COALESCE(SUM(cache_read_tokens), 0) as cache_read_tokens
      FROM (
        SELECT model, provider_name, COUNT(*) as session_count,
          SUM(input_tokens) as input_tokens, SUM(output_tokens) as output_tokens,
          SUM(cache_creation_tokens) as cache_creation_tokens, SUM(cache_read_tokens) as cache_read_tokens
        FROM sessions WHERE archived = 0 AND working_directory = ? AND model IS NOT NULL
        GROUP BY model, provider_name
        UNION ALL
        SELECT model, provider_name, COUNT(*) as session_count,
          SUM(input_tokens) as input_tokens, SUM(output_tokens) as output_tokens,
          SUM(cache_creation_tokens) as cache_creation_tokens, SUM(cache_read_tokens) as cache_read_tokens
        FROM managed_sessions WHERE archived = 0 AND working_directory = ? AND model IS NOT NULL
        GROUP BY model, provider_name
      )
      GROUP BY model, provider_name
      ORDER BY (input_tokens + output_tokens) DESC
    `);

    // Space statements
    this.stmtUpsertSpace = this.db.prepare(`
      INSERT INTO spaces (id, project_directory, name, git_branch, worktree_path, is_default, status, created_at, last_activity_at, pinned,
        merge_commit, merge_method, merged_at, target_branch, remote_status, pr_url, base_branch)
      VALUES (@id, @project_directory, @name, @git_branch, @worktree_path, @is_default, @status, @created_at, @last_activity_at, @pinned,
        @merge_commit, @merge_method, @merged_at, @target_branch, @remote_status, @pr_url, @base_branch)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        git_branch = excluded.git_branch,
        worktree_path = excluded.worktree_path,
        status = excluded.status,
        last_activity_at = excluded.last_activity_at,
        merge_commit = COALESCE(excluded.merge_commit, merge_commit),
        merge_method = COALESCE(excluded.merge_method, merge_method),
        merged_at = COALESCE(excluded.merged_at, merged_at),
        target_branch = COALESCE(excluded.target_branch, target_branch),
        remote_status = COALESCE(excluded.remote_status, remote_status),
        pr_url = COALESCE(excluded.pr_url, pr_url),
        base_branch = COALESCE(excluded.base_branch, base_branch)
    `);
    this.stmtGetSpace = this.db.prepare("SELECT * FROM spaces WHERE id = ?");
    this.stmtGetSpaceByWorktreePath = this.db.prepare(
      "SELECT * FROM spaces WHERE worktree_path = ? ORDER BY created_at DESC LIMIT 1",
    );
    this.stmtGetSpacesByProject = this.db.prepare(
      "SELECT * FROM spaces WHERE project_directory = ? AND status != 'archived' ORDER BY is_default DESC, last_activity_at DESC",
    );
    this.stmtGetDefaultSpace = this.db.prepare(
      "SELECT * FROM spaces WHERE project_directory = ? AND is_default = 1 LIMIT 1",
    );
    this.stmtUpdateSpaceStatus = this.db.prepare("UPDATE spaces SET status = ? WHERE id = ?");
    this.stmtUpdateSpaceActivity = this.db.prepare(
      "UPDATE spaces SET last_activity_at = ? WHERE id = ?",
    );
    this.stmtUpdateSpaceName = this.db.prepare(
      "UPDATE spaces SET name = ?, last_activity_at = ? WHERE id = ?",
    );
    this.stmtUpdateSpacePinned = this.db.prepare("UPDATE spaces SET pinned = ? WHERE id = ?");
    this.stmtDeleteSpace = this.db.prepare("DELETE FROM spaces WHERE id = ?");
    this.stmtGetSpaceChatCount = this.db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM sessions WHERE space_id = ? AND archived = 0) +
        (SELECT COUNT(*) FROM managed_sessions WHERE space_id = ? AND archived = 0)
      AS count
    `);
    this.stmtUpdateSessionSpaceId = this.db.prepare(
      "UPDATE sessions SET space_id = ? WHERE session_id = ?",
    );
    this.stmtUpdateManagedSpaceId = this.db.prepare(
      "UPDATE managed_sessions SET space_id = ? WHERE instance_id = ?",
    );
    this.stmtUpdateSpaceMergeMetadata = this.db.prepare(
      "UPDATE spaces SET status = 'completed', merge_commit = ?, merge_method = ?, merged_at = ?, target_branch = ? WHERE id = ?",
    );
    this.stmtUpdateSpaceRemoteStatus = this.db.prepare(
      "UPDATE spaces SET remote_status = ?, pr_url = COALESCE(?, pr_url) WHERE id = ?",
    );
    this.stmtGetSpacesByProjectAll = this.db.prepare(
      "SELECT * FROM spaces WHERE project_directory = ? AND is_default = 0 ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END, last_activity_at DESC",
    );
    this.stmtGetAllSpaces = this.db.prepare("SELECT * FROM spaces");
    this.stmtUpdateSpaceBaseBranch = this.db.prepare(
      "UPDATE spaces SET base_branch = ? WHERE id = ?",
    );
    this.stmtUpdateSpacePrStatus = this.db.prepare(
      "UPDATE spaces SET pr_status_json = ?, remote_status = COALESCE(?, remote_status), pr_url = COALESCE(?, pr_url) WHERE id = ?",
    );

    // Spin-offs (legacy storage remains in the `handoffs` table)
    this.stmtInsertSpinOff = this.db.prepare(`
      INSERT INTO handoffs (id, source_chat_id, source_chat_name, target_chat_id, target_chat_name,
        source_anchor_message_index, packet_json, status, created_at, sent_at)
      VALUES (@id, @source_chat_id, @source_chat_name, @target_chat_id, @target_chat_name,
        @source_anchor_message_index, @packet_json, @status, @created_at, @sent_at)
    `);
    this.stmtGetSpinOff = this.db.prepare("SELECT * FROM handoffs WHERE id = ?");
    this.stmtGetSpinOffsBySourceChat = this.db.prepare(
      "SELECT * FROM handoffs WHERE source_chat_id = ? ORDER BY created_at DESC",
    );
    this.stmtGetSpinOffsByTargetChat = this.db.prepare(
      "SELECT * FROM handoffs WHERE target_chat_id = ? ORDER BY created_at DESC",
    );
    this.stmtUpdateSpinOffStatus = this.db.prepare(`
      UPDATE handoffs SET status = @status, target_chat_id = @target_chat_id,
        target_chat_name = @target_chat_name, sent_at = @sent_at
      WHERE id = @id
    `);

    // Global settings
    this.stmtGetGlobalSettings = this.db.prepare("SELECT * FROM global_settings WHERE id = 1");
    this.stmtUpdateGlobalSettings = this.db.prepare(`
      UPDATE global_settings SET
        theme = @theme,
        default_open_target = @default_open_target,
        default_provider = @default_provider,
        default_model = @default_model,
        default_space_branch = @default_space_branch,
        space_branch_source = @space_branch_source,
        provider_defaults_json = @provider_defaults_json,
        custom_instructions = @custom_instructions,
        project_order_json = @project_order_json,
        suggestions_json = @suggestions_json,
        max_processes = @max_processes,
        sidebar_layout = @sidebar_layout
      WHERE id = 1
    `);

    // Search statements
    //
    // Ranking: blend FTS5 bm25 relevance with recency.
    // FTS5 rank is negative (more negative = more relevant).
    // Recency boost: 1 / (1 + age_in_days / 30)  — half-life ~30 days.
    // Combined: rank * recency_boost (both negative and <1, so product is more negative for recent+relevant).
    // The combined score is computed inline and used directly for ORDER BY + LIMIT.

    this.stmtSearchProject = this.db.prepare(
      buildSearchStatementSql(
        "search_index MATCH ?\n        AND s.project_id = ?\n        AND s.archived = '0'",
      ),
    );

    this.stmtSearchGlobal = this.db.prepare(
      buildSearchStatementSql("search_index MATCH ?\n        AND s.archived = '0'", {
        projectBoost: true,
      }),
    );

    // Recent chats (empty-query search): plain recency scan of the index, no MATCH
    this.stmtRecentChatsProject = this.db.prepare(`
      SELECT * FROM search_index s
      WHERE s.project_id = ? AND s.archived = '0'
      ${RECENT_CHATS_ORDER_SQL}
      LIMIT ?
    `);

    this.stmtRecentChatsGlobal = this.db.prepare(`
      SELECT * FROM search_index s
      WHERE s.archived = '0'
      ${RECENT_CHATS_ORDER_SQL}
      LIMIT ?
    `);

    this.stmtDeleteSearchDoc = this.db.prepare("DELETE FROM search_index WHERE rowid = ?");
    this.stmtGetSearchDocRowids = this.db.prepare(
      "SELECT doc_rowid FROM search_index_docs WHERE instance_id = ?",
    );
    this.stmtDeleteSearchDocRowids = this.db.prepare(
      "DELETE FROM search_index_docs WHERE instance_id = ?",
    );
    this.stmtInsertSearchDocRowid = this.db.prepare(
      "INSERT OR REPLACE INTO search_index_docs (instance_id, source, doc_rowid) VALUES (?, ?, ?)",
    );

    this.stmtInsertSearchDoc = this.db.prepare(`
      INSERT INTO search_index (
        instance_id, source, project_id, space_id,
        last_activity_at, last_message_at, created_at, archived, pinned,
        title, summary, first_prompt, last_message_text, git_branch,
        transcript_content
      ) VALUES (
        @instance_id, @source, @project_id, @space_id,
        @last_activity_at, @last_message_at, @created_at, @archived, @pinned,
        @title, @summary, @first_prompt, @last_message_text, @git_branch,
        @transcript_content
      )
    `);

    this.stmtUpsertSearchContent = this.db.prepare(`
      INSERT OR REPLACE INTO search_content (instance_id, transcript_text, source_key)
      VALUES (?, ?, ?)
    `);

    this.stmtGetSearchContentSourceKey = this.db.prepare(
      "SELECT source_key FROM search_content WHERE instance_id = ?",
    );

    this.stmtGetSearchContent = this.db.prepare(
      "SELECT transcript_text FROM search_content WHERE instance_id = ?",
    );

    this.stmtDeleteSearchContent = this.db.prepare(
      "DELETE FROM search_content WHERE instance_id = ?",
    );

    for (const value of Object.values(this)) {
      if (
        value &&
        typeof value === "object" &&
        "setAllowUnknownNamedParameters" in value &&
        typeof value.setAllowUnknownNamedParameters === "function" &&
        "setAllowBareNamedParameters" in value &&
        typeof value.setAllowBareNamedParameters === "function"
      ) {
        value.setAllowBareNamedParameters(true);
        value.setAllowUnknownNamedParameters(true);
      }
    }
  }

  upsert(row: SessionRow): void {
    this.stmtUpsert.run(asBindParams(normalizeSessionRow(row)));
  }

  upsertMany(rows: SessionRow[]): void {
    this.withTransaction(() => {
      for (const row of rows) {
        this.stmtUpsert.run(asBindParams(normalizeSessionRow(row)));
      }
    });
  }

  getBySessionId(sessionId: string): SessionRow | undefined {
    return asRow(this.stmtGetBySessionId.get(sessionId) as Record<string, unknown>);
  }

  getByInstanceId(instanceId: string): SessionRow | undefined {
    return asRow(this.stmtGetByInstanceId.get(instanceId) as Record<string, unknown>);
  }

  getManagedByInstanceId(instanceId: string): ManagedInstanceRow | undefined {
    return asRow(this.stmtGetManagedByInstanceId.get(instanceId) as Record<string, unknown>);
  }

  getByJsonlPath(jsonlPath: string): SessionRow | undefined {
    return asRow(this.stmtGetByJsonlPath.get(jsonlPath) as Record<string, unknown>);
  }

  getAllActive(): SessionRow[] {
    return asRows(this.stmtGetAllActive.all() as Record<string, unknown>[]);
  }

  getAll(includeArchived = false): SessionRow[] {
    if (includeArchived) {
      return asRows(this.stmtGetAllIncludeArchived.all() as Record<string, unknown>[]);
    }
    return asRows(this.stmtGetAll.all() as Record<string, unknown>[]);
  }

  archive(sessionId: string): void {
    const row = this.getBySessionId(sessionId);
    this.stmtArchive.run(sessionId);
    if (row) this.syncSearchIndexForInstance(row.instance_id);
  }

  archiveByInstanceId(instanceId: string): void {
    this.stmtArchiveByInstanceId.run(instanceId);
    this.syncSearchIndexForInstance(instanceId);
  }

  upsertManaged(row: ManagedInstanceRow): void {
    this.stmtUpsertManaged.run(asBindParams(normalizeManagedInstanceRow(row)));
  }

  getAllManagedActive(): ManagedInstanceRow[] {
    return asRows(this.stmtGetAllManagedActive.all() as Record<string, unknown>[]);
  }

  getByProjectId(projectId: string): SessionRow[] {
    return asRows(this.stmtGetByProjectId.all(projectId) as Record<string, unknown>[]);
  }

  getManagedByProjectId(projectId: string): ManagedInstanceRow[] {
    return asRows(this.stmtGetManagedByProjectId.all(projectId) as Record<string, unknown>[]);
  }

  getBySpaceId(spaceId: string): SessionRow[] {
    return asRows(this.stmtGetBySpaceId.all(spaceId) as Record<string, unknown>[]);
  }

  getManagedBySpaceId(spaceId: string): ManagedInstanceRow[] {
    return asRows(this.stmtGetManagedBySpaceId.all(spaceId) as Record<string, unknown>[]);
  }

  archiveManaged(instanceId: string): void {
    this.stmtArchiveManaged.run(instanceId);
    this.syncSearchIndexForInstance(instanceId);
  }

  unarchive(sessionId: string): void {
    this.stmtUnarchive.run(sessionId);
    const row = this.getBySessionId(sessionId);
    if (row) this.syncSearchIndexForInstance(row.instance_id);
  }

  updateStats(
    sessionId: string,
    stats: {
      inputTokens: number;
      outputTokens: number;
      cacheCreationTokens: number;
      cacheReadTokens: number;
    },
  ): void {
    this.stmtUpdateStats.run({
      session_id: sessionId,
      input_tokens: stats.inputTokens,
      output_tokens: stats.outputTokens,
      cache_creation_tokens: stats.cacheCreationTokens,
      cache_read_tokens: stats.cacheReadTokens,
    } as SQLiteBindParams);
  }

  updateLastActivity(sessionId: string, timestamp: number): void {
    // Shutdown calls this for every chat; skip the search-doc rewrite (which
    // re-tokenizes the whole transcript) when the timestamp didn't move.
    const result = this.stmtUpdateLastActivity.run(timestamp, sessionId, timestamp);
    if (Number(result.changes) === 0) return;
    const row = this.getBySessionId(sessionId);
    if (row) this.syncSearchIndexForInstance(row.instance_id);
  }

  updateName(sessionId: string, name: string, customTitle: boolean): void {
    this.stmtUpdateName.run(name, customTitle ? 1 : 0, sessionId);
    const row = this.getBySessionId(sessionId);
    if (row) this.syncSearchIndexForInstance(row.instance_id);
  }

  /** Set the pinned flag on whichever session table(s) know this instance. */
  setPinned(instanceId: string, pinned: boolean): boolean {
    const value = pinned ? 1 : 0;
    const external = this.stmtSetPinned.run(value, instanceId);
    const managed = this.stmtSetManagedPinned.run(value, instanceId);
    const changed = Number(external.changes) > 0 || Number(managed.changes) > 0;
    // Keep the search index's pinned column fresh — recentChats() sorts pinned-first
    if (changed) this.syncSearchIndexForInstance(instanceId);
    return changed;
  }

  /**
   * Mark a chat done as of `doneAt`, or clear the marker with `null`.
   *
   * Stored as a timestamp rather than a boolean so "new activity revives a
   * done chat" is derived, not pushed: a chat reads as done only while its
   * recency is at or below `done_at`. There is no single choke point where
   * activity is recorded, so a push-based revive would leak.
   */
  setDone(instanceId: string, doneAt: number | null): boolean {
    const external = this.stmtSetDone.run(doneAt, instanceId);
    const managed = this.stmtSetManagedDone.run(doneAt, instanceId);
    return Number(external.changes) > 0 || Number(managed.changes) > 0;
  }

  /**
   * Mark many chats at once, stamping the same `doneAt` on all of them.
   * Returns the subset of ids the write actually reached.
   *
   * Callers pass explicit ids rather than a "older than X" predicate because
   * `last_activity_at` is only half of a chat's recency — the other half is the
   * last message in its transcript — so only the caller knows what is stale.
   */
  setDoneBulk(instanceIds: readonly string[], doneAt: number | null): string[] {
    if (instanceIds.length === 0) return [];
    return this.withTransaction(() => {
      const updated: string[] = [];
      for (const id of instanceIds) {
        if (this.setDone(id, doneAt)) updated.push(id);
      }
      return updated;
    });
  }

  updateProvider(sessionId: string, provider: string): void {
    this.db
      .prepare("UPDATE sessions SET provider_name = ? WHERE session_id = ?")
      .run(provider, sessionId);
  }

  updateAllowedTools(sessionId: string, tools: string[]): void {
    this.stmtUpdateAllowedTools.run(JSON.stringify(tools), sessionId);
  }

  getJsonlPaths(): Set<string> {
    const rows = asRows<{ jsonl_path: string }>(
      this.stmtGetJsonlPaths.all() as Record<string, unknown>[],
    );
    return new Set(rows.map((r) => r.jsonl_path));
  }

  updateWorkingDirectory(sessionId: string, workingDirectory: string): void {
    this.stmtUpdateWorkingDirectory.run(workingDirectory, sessionId);
    const row = this.getBySessionId(sessionId);
    if (row) this.syncSearchIndexForInstance(row.instance_id);
  }

  updateSessionModel(sessionId: string, model: string | null): void {
    this.stmtUpdateSessionModel.run(model, sessionId);
  }

  updatePreferredModel(sessionId: string, model: string | null): void {
    this.stmtUpdatePreferredModel.run(model, sessionId);
  }

  getProjectStats(workingDirectory: string): {
    sessionCount: number;
    inputTokens: number;
    outputTokens: number;
    cacheCreationTokens: number;
    cacheReadTokens: number;
  } {
    const row = asRow<{
      session_count: number;
      input_tokens: number;
      output_tokens: number;
      cache_creation_tokens: number;
      cache_read_tokens: number;
    }>(this.stmtGetProjectStats.get(workingDirectory, workingDirectory) as Record<string, unknown>);
    if (!row) {
      return {
        sessionCount: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
      };
    }
    return {
      sessionCount: row.session_count,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      cacheCreationTokens: row.cache_creation_tokens,
      cacheReadTokens: row.cache_read_tokens,
    };
  }

  getGlobalStats(): {
    sessionCount: number;
    inputTokens: number;
    outputTokens: number;
    cacheCreationTokens: number;
    cacheReadTokens: number;
  } {
    const row = asRow<{
      session_count: number;
      input_tokens: number;
      output_tokens: number;
      cache_creation_tokens: number;
      cache_read_tokens: number;
    }>(this.stmtGetGlobalStats.get() as Record<string, unknown>);
    if (!row) {
      return {
        sessionCount: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
      };
    }
    return {
      sessionCount: row.session_count,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      cacheCreationTokens: row.cache_creation_tokens,
      cacheReadTokens: row.cache_read_tokens,
    };
  }

  deleteBySessionId(sessionId: string): void {
    const row = this.getBySessionId(sessionId);
    this.stmtDeleteBySessionId.run(sessionId);
    if (row) {
      this.syncSearchIndexForInstance(row.instance_id);
      // Clean up search content if the instance is fully gone
      if (!this.getManagedByInstanceId(row.instance_id)) {
        this.stmtDeleteSearchContent.run(row.instance_id);
      }
    }
  }

  deleteByInstanceId(instanceId: string): void {
    this.stmtDeleteByInstanceId.run(instanceId);
    this.syncSearchIndexForInstance(instanceId);
    if (!this.getManagedByInstanceId(instanceId)) {
      this.stmtDeleteSearchContent.run(instanceId);
    }
  }

  deleteManagedByInstanceId(instanceId: string): void {
    this.stmtDeleteManagedByInstanceId.run(instanceId);
    this.stmtDeleteSessionEvents.run(instanceId);
    this.syncSearchIndexForInstance(instanceId);
    if (!this.getByInstanceId(instanceId)) {
      this.stmtDeleteSearchContent.run(instanceId);
    }
  }

  // =========================================================================
  // Session events (Relay-level events merged into history at hydrate time)
  // =========================================================================

  insertSessionEvent(
    instanceId: string,
    timestamp: number,
    event: string,
    payloadJson: string | null,
  ): void {
    this.stmtInsertSessionEvent.run(instanceId, timestamp, event, payloadJson);
  }

  getSessionEvents(instanceId: string): SessionEventRow[] {
    return asRows<SessionEventRow>(
      this.stmtGetSessionEvents.all(instanceId) as Record<string, unknown>[],
    );
  }

  // =========================================================================
  // Project CRUD
  // =========================================================================

  upsertProject(row: ProjectRow): void {
    this.stmtUpsertProject.run(asBindParams(normalizeProjectRow(row)));
  }

  getProject(id: string): ProjectRow | undefined {
    return asRow(this.stmtGetProject.get(id) as Record<string, unknown>);
  }

  getProjectBySlug(slug: string): ProjectRow | undefined {
    return asRow(this.stmtGetProjectBySlug.get(slug) as Record<string, unknown>);
  }

  getProjectByDirectory(directory: string): ProjectRow | undefined {
    return asRow(this.stmtGetProjectByDir.get(directory) as Record<string, unknown>);
  }

  getAllProjects(): ProjectRow[] {
    return asRows(this.stmtGetAllProjects.all() as Record<string, unknown>[]);
  }

  deleteProject(id: string): void {
    this.stmtDeleteProject.run(id);
  }

  /** Tombstone a directory so session-history recovery won't re-create its project. */
  addRemovedProjectDirectory(directory: string, removedAt: number): void {
    this.stmtAddRemovedProjectDir.run(directory, removedAt);
  }

  clearRemovedProjectDirectory(directory: string): void {
    this.stmtClearRemovedProjectDir.run(directory);
  }

  getRemovedProjectDirectories(): Set<string> {
    const rows = this.stmtGetRemovedProjectDirs.all() as Array<{ directory?: unknown }>;
    return new Set(
      rows.map((row) => (typeof row.directory === "string" ? row.directory : "")).filter(Boolean),
    );
  }

  updateProjectActivity(id: string, timestamp: number): void {
    this.stmtUpdateProjectActivity.run(timestamp, id);
  }

  /** Bulk-assign project_id to all sessions matching a working directory */
  assignSessionsToProject(projectId: string | null, directory: string): void {
    this.stmtUpdateSessionProjectId.run(projectId, directory);
    this.stmtUpdateManagedSessionProjectId.run(projectId, directory);
  }

  /** Clear project_id on every session (any directory) currently assigned to a project */
  unassignSessionsFromProject(projectId: string): void {
    this.stmtClearSessionProjectId.run(projectId);
    this.stmtClearManagedSessionProjectId.run(projectId);
  }

  reassignSpacesToProjectDirectory(nextDirectory: string, previousDirectory: string): void {
    const existingDefault = this.getDefaultSpace(nextDirectory);
    const previousSpaces = this.getSpacesByProject(previousDirectory);

    this.withTransaction(() => {
      for (const space of previousSpaces) {
        if (space.is_default === 1 && existingDefault && space.id !== existingDefault.id) {
          this.db
            .prepare("UPDATE sessions SET space_id = ? WHERE space_id = ?")
            .run(existingDefault.id, space.id);
          this.db
            .prepare("UPDATE managed_sessions SET space_id = ? WHERE space_id = ?")
            .run(existingDefault.id, space.id);
          this.stmtDeleteSpace.run(space.id);
          continue;
        }

        this.stmtUpdateSpaceProjectDirectoryById.run(nextDirectory, space.id);
      }
    });
  }

  /** Get token usage breakdown by model for a project directory */
  getProjectModelStats(workingDirectory: string): Array<{
    model: string;
    providerName: string;
    sessionCount: number;
    inputTokens: number;
    outputTokens: number;
    cacheCreationTokens: number;
    cacheReadTokens: number;
  }> {
    const rows = asRows<{
      model: string;
      provider_name: string;
      session_count: number;
      input_tokens: number;
      output_tokens: number;
      cache_creation_tokens: number;
      cache_read_tokens: number;
    }>(
      this.stmtGetProjectModelStats.all(workingDirectory, workingDirectory) as Record<
        string,
        unknown
      >[],
    );
    return rows.map((r) => ({
      model: r.model,
      providerName: r.provider_name,
      sessionCount: r.session_count,
      inputTokens: r.input_tokens,
      outputTokens: r.output_tokens,
      cacheCreationTokens: r.cache_creation_tokens,
      cacheReadTokens: r.cache_read_tokens,
    }));
  }

  /** Get distinct working directories from active sessions (for migration backfill) */
  getDistinctSessionDirectories(): string[] {
    const rows = asRows<{ working_directory: string }>(
      this.stmtGetDistinctSessionDirs.all() as Record<string, unknown>[],
    );
    return rows.map((r) => r.working_directory);
  }

  // =========================================================================
  // Space methods
  // =========================================================================

  upsertSpace(row: SpaceRow): void {
    this.stmtUpsertSpace.run(asBindParams(normalizeSpaceRow(row)));
  }

  getSpace(id: string): SpaceRow | undefined {
    return asRow(this.stmtGetSpace.get(id) as Record<string, unknown>);
  }

  getSpaceByWorktreePath(worktreePath: string): SpaceRow | undefined {
    return asRow(this.stmtGetSpaceByWorktreePath.get(worktreePath) as Record<string, unknown>);
  }

  getSpacesByProject(projectDirectory: string): SpaceRow[] {
    return asRows(this.stmtGetSpacesByProject.all(projectDirectory) as Record<string, unknown>[]);
  }

  getDefaultSpace(projectDirectory: string): SpaceRow | undefined {
    return asRow(this.stmtGetDefaultSpace.get(projectDirectory) as Record<string, unknown>);
  }

  updateSpaceStatus(id: string, status: string): void {
    this.stmtUpdateSpaceStatus.run(status, id);
  }

  updateSpaceActivity(id: string, timestamp: number): void {
    this.stmtUpdateSpaceActivity.run(timestamp, id);
  }

  updateSpaceName(id: string, name: string, timestamp: number): void {
    this.stmtUpdateSpaceName.run(name, timestamp, id);
  }

  /** Set a space pin without coupling it to routine space persistence. */
  setSpacePinned(id: string, pinned: boolean): boolean {
    const result = this.stmtUpdateSpacePinned.run(pinned ? 1 : 0, id);
    return Number(result.changes) > 0;
  }

  deleteSpace(id: string): void {
    this.stmtDeleteSpace.run(id);
  }

  getSpaceChatCount(spaceId: string): number {
    const row = asRow<{ count: number }>(
      this.stmtGetSpaceChatCount.get(spaceId, spaceId) as Record<string, unknown>,
    );
    return row?.count ?? 0;
  }

  updateSessionSpaceId(sessionId: string, spaceId: string | null): void {
    this.stmtUpdateSessionSpaceId.run(spaceId, sessionId);
  }

  updateManagedSpaceId(instanceId: string, spaceId: string | null): void {
    this.stmtUpdateManagedSpaceId.run(spaceId, instanceId);
  }

  updateSpaceMergeMetadata(
    id: string,
    mergeCommit: string | undefined,
    mergeMethod: string,
    mergedAt: number,
    targetBranch: string,
  ): void {
    this.stmtUpdateSpaceMergeMetadata.run(
      mergeCommit ?? null,
      mergeMethod,
      mergedAt,
      targetBranch,
      id,
    );
  }

  updateSpaceRemoteStatus(id: string, remoteStatus: string, prUrl?: string | null): void {
    this.stmtUpdateSpaceRemoteStatus.run(remoteStatus, prUrl ?? null, id);
  }

  /** Every space row (all projects, all statuses) — for maintenance sweeps. */
  getAllSpaces(): SpaceRow[] {
    return asRows(this.stmtGetAllSpaces.all() as Record<string, unknown>[]);
  }

  setSpaceBaseBranch(id: string, baseBranch: string): void {
    this.stmtUpdateSpaceBaseBranch.run(baseBranch, id);
  }

  /**
   * Persist the last known PR status snapshot. `remoteStatus`/`prUrl` are
   * only written when provided (null keeps the current value).
   */
  setSpacePrStatus(
    id: string,
    prStatusJson: string | null,
    remoteStatus?: string | null,
    prUrl?: string | null,
  ): void {
    this.stmtUpdateSpacePrStatus.run(prStatusJson, remoteStatus ?? null, prUrl ?? null, id);
  }

  getSpacesByProjectAll(projectDirectory: string): SpaceRow[] {
    return asRows(
      this.stmtGetSpacesByProjectAll.all(projectDirectory) as Record<string, unknown>[],
    );
  }

  // =========================================================================
  // Global Settings
  // =========================================================================

  getGlobalSettings(): GlobalSettingsRow {
    const row = asRow<GlobalSettingsRow>(
      this.stmtGetGlobalSettings.get() as Record<string, unknown>,
    );
    if (!row) {
      this.db.exec("INSERT OR IGNORE INTO global_settings (id) VALUES (1)");
      return asRow<GlobalSettingsRow>(
        this.stmtGetGlobalSettings.get() as Record<string, unknown>,
      ) as GlobalSettingsRow;
    }
    return row;
  }

  updateGlobalSettings(patch: Partial<Omit<GlobalSettingsRow, "id">>): GlobalSettingsRow {
    const current = this.getGlobalSettings();
    // Use "key in patch" checks so explicit null clears the value (vs omitted = keep current)
    this.stmtUpdateGlobalSettings.run(
      asBindParams({
        theme: "theme" in patch ? patch.theme : current.theme,
        default_open_target:
          "default_open_target" in patch ? patch.default_open_target : current.default_open_target,
        default_provider:
          "default_provider" in patch ? patch.default_provider : current.default_provider,
        default_model: "default_model" in patch ? patch.default_model : current.default_model,
        default_space_branch:
          "default_space_branch" in patch
            ? patch.default_space_branch
            : current.default_space_branch,
        space_branch_source:
          "space_branch_source" in patch ? patch.space_branch_source : current.space_branch_source,
        provider_defaults_json:
          "provider_defaults_json" in patch
            ? patch.provider_defaults_json
            : current.provider_defaults_json,
        custom_instructions:
          "custom_instructions" in patch ? patch.custom_instructions : current.custom_instructions,
        project_order_json:
          "project_order_json" in patch ? patch.project_order_json : current.project_order_json,
        suggestions_json:
          "suggestions_json" in patch ? patch.suggestions_json : current.suggestions_json,
        max_processes: "max_processes" in patch ? patch.max_processes : current.max_processes,
        sidebar_layout: "sidebar_layout" in patch ? patch.sidebar_layout : current.sidebar_layout,
      }),
    );
    return this.getGlobalSettings();
  }

  // =========================================================================
  // Search
  // =========================================================================

  /**
   * Persist extracted transcript text for use during search indexing.
   * `sourceKey` identifies the transcript file state the text came from, so
   * startup can skip re-parsing unchanged transcripts; omit it for text built
   * from in-memory history.
   */
  updateSearchContent(instanceId: string, transcriptText: string, sourceKey?: string): void {
    this.stmtUpsertSearchContent.run(instanceId, transcriptText, sourceKey ?? null);
  }

  /** Whether stored search text was extracted from exactly this transcript state */
  hasSearchContentForSource(instanceId: string, sourceKey: string): boolean {
    const row = this.stmtGetSearchContentSourceKey.get(instanceId) as
      | { source_key: string | null }
      | undefined;
    return row?.source_key === sourceKey;
  }

  /** Remove all search docs for an instance before rebuilding its preferred doc */
  removeFromSearchIndex(instanceId: string): void {
    // Delete by rowid: a `WHERE instance_id = ?` on the FTS table scans every
    // doc (UNINDEXED columns have no lookup), which made per-chat syncs on
    // restore and shutdown cost seconds in aggregate.
    const docs = this.stmtGetSearchDocRowids.all(instanceId) as Array<{ doc_rowid: number }>;
    for (const doc of docs) {
      this.stmtDeleteSearchDoc.run(doc.doc_rowid);
    }
    this.stmtDeleteSearchDocRowids.run(instanceId);
  }

  private insertSearchDoc(
    source: "session" | "managed",
    row: SessionRow | ManagedInstanceRow,
  ): void {
    // Read transcript text from the search_content side table (populated by instance-manager)
    const contentRow = this.stmtGetSearchContent.get(row.instance_id) as
      | { transcript_text: string }
      | undefined;

    const result = this.stmtInsertSearchDoc.run(
      asBindParams({
        instance_id: row.instance_id,
        source,
        project_id: row.project_id ?? "",
        space_id: row.space_id ?? "",
        last_activity_at: String(row.last_activity_at),
        last_message_at: row.last_message_at == null ? "" : String(row.last_message_at),
        created_at: String(row.created_at),
        archived: String(row.archived),
        pinned: String(row.pinned ?? 0),
        title: row.name ?? "",
        summary: "summary" in row ? (row.summary ?? "") : "",
        first_prompt: "first_prompt" in row ? (row.first_prompt ?? "") : "",
        last_message_text: row.last_message_text ?? "",
        git_branch: row.git_branch ?? "",
        transcript_content: contentRow?.transcript_text ?? "",
      }),
    );
    this.stmtInsertSearchDocRowid.run(row.instance_id, source, result.lastInsertRowid);
  }

  // =========================================================================
  // Spin-offs
  // =========================================================================

  insertSpinOff(row: SpinOffRow): void {
    this.stmtInsertSpinOff.run(asBindParams(row));
  }

  getSpinOff(id: string): SpinOffRow | undefined {
    return asRow<SpinOffRow>(this.stmtGetSpinOff.get(id) as Record<string, unknown> | undefined);
  }

  getSpinOffsBySourceChat(sourceChatId: string): SpinOffRow[] {
    return asRows<SpinOffRow>(
      this.stmtGetSpinOffsBySourceChat.all(sourceChatId) as Record<string, unknown>[],
    );
  }

  getSpinOffsByTargetChat(targetChatId: string): SpinOffRow[] {
    return asRows<SpinOffRow>(
      this.stmtGetSpinOffsByTargetChat.all(targetChatId) as Record<string, unknown>[],
    );
  }

  updateSpinOffStatus(
    id: string,
    status: string,
    targetChatId: string | null,
    targetChatName: string | null,
    sentAt: number | null,
  ): void {
    this.stmtUpdateSpinOffStatus.run(
      asBindParams({
        id,
        status,
        target_chat_id: targetChatId,
        target_chat_name: targetChatName,
        sent_at: sentAt,
      }),
    );
  }

  /** Rebuild the preferred search doc for an instance, favoring managed rows over session shadows */
  syncSearchIndexForInstance(instanceId: string): void {
    this.removeFromSearchIndex(instanceId);

    const managed = this.getManagedByInstanceId(instanceId);
    if (managed && !managed.archived) {
      this.insertSearchDoc("managed", managed);
      return;
    }

    const session = this.getByInstanceId(instanceId);
    if (session && !session.archived) {
      this.insertSearchDoc("session", session);
    }
  }

  /** Rebuild search docs for an instance after persistence changes */
  indexSession(instanceId: string, source: "session" | "managed"): void {
    void source;
    this.syncSearchIndexForInstance(instanceId);
  }

  /** Rebuild the entire search index from sessions + managed_sessions */
  rebuildSearchIndex(): void {
    this.withTransaction(() => {
      this.db.exec("DELETE FROM search_index");
      this.db.exec("DELETE FROM search_index_docs");

      // Index managed sessions first so we can skip their shadow session rows
      const managed = asRows<ManagedInstanceRow>(
        this.db.prepare("SELECT * FROM managed_sessions").all() as Record<string, unknown>[],
      );
      const managedInstanceIds = new Set<string>();
      for (const row of managed) {
        managedInstanceIds.add(row.instance_id);
        if (!row.archived) {
          this.insertSearchDoc("managed", row);
        }
      }

      // Index session rows, skipping any that are shadows of managed sessions
      const sessions = this.getAll(true);
      for (const row of sessions) {
        if (managedInstanceIds.has(row.instance_id)) continue;
        if (!row.archived) {
          this.insertSearchDoc("session", row);
        }
      }
    });
  }

  /** Map a search_index row to the shared SearchResult shape */
  private toSearchResult(
    r: SearchResultRow,
    extras: { snippet: string | null; matchField: string | null; rank: number },
  ): SearchResult {
    return {
      instanceId: r.instance_id,
      source: r.source as "session" | "managed",
      projectId: r.project_id || null,
      spaceId: r.space_id || null,
      lastActivityAt: Number(r.last_activity_at),
      lastMessageAt:
        r.last_message_at != null && r.last_message_at !== "" ? Number(r.last_message_at) : null,
      createdAt: Number(r.created_at),
      title: r.title,
      summary: r.summary || null,
      gitBranch: r.git_branch || null,
      snippet: extras.snippet,
      matchField: extras.matchField,
      rank: extras.rank,
    };
  }

  /** Search chats using FTS5 */
  search(
    query: string,
    options: { projectId?: string; boostProjectId?: string; limit?: number } = {},
  ): SearchResult[] {
    const limit = options.limit ?? 20;

    // Sanitize for FTS5: wrap each token in quotes to avoid syntax errors
    const tokens = query
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map((token) => `"${token.replace(/"/g, '""')}"`);

    if (tokens.length === 0) return [];

    // Prefix-match the last token while the user is still typing it — trailing
    // whitespace means the word is complete, so match it exactly.
    if (!/\s$/.test(query)) {
      tokens[tokens.length - 1] += "*";
    }

    try {
      const now = Date.now();
      const executeSearch = (ftsQuery: string): SearchResultRow[] =>
        options.projectId
          ? asRows<SearchResultRow>(
              this.stmtSearchProject.all(now, ftsQuery, options.projectId, limit) as Record<
                string,
                unknown
              >[],
            )
          : asRows<SearchResultRow>(
              this.stmtSearchGlobal.all(
                now,
                options.boostProjectId ?? "",
                ftsQuery,
                limit,
              ) as Record<string, unknown>[],
            );

      // Tokens are ANDed, so one wrong word kills the whole query. When the
      // strict query matches nothing, retry with OR and flag results as partial.
      let partial = false;
      let rows = executeSearch(tokens.join(" "));
      if (rows.length === 0 && tokens.length > 1) {
        rows = executeSearch(tokens.join(" OR "));
        partial = rows.length > 0;
      }

      const results = rows.map((r) => {
        // FTS5 snippet() returns text even for non-matching columns (just no
        // highlights). Only treat a snippet as a real match if it contains a
        // <mark> tag — that means the search term actually hit that field.
        const hasHit = (s: string | null | undefined): s is string =>
          s != null && s.includes("<mark>");

        const hitTitle = hasHit(r.title_snippet) ? r.title_snippet : null;
        const hitSummary = hasHit(r.summary_snippet) ? r.summary_snippet : null;
        const hitPrompt = hasHit(r.prompt_snippet) ? r.prompt_snippet : null;
        const hitMessage = hasHit(r.message_snippet) ? r.message_snippet : null;
        const hitTranscript = hasHit(r.transcript_snippet) ? r.transcript_snippet : null;

        // Prefer summary/prompt/message/transcript over title for the displayed snippet,
        // since the title is already shown as the result heading.
        const bestSnippet =
          hitSummary || hitPrompt || hitMessage || hitTranscript || hitTitle || null;
        const matchField = hitSummary
          ? "summary"
          : hitPrompt
            ? "first prompt"
            : hitMessage
              ? "message"
              : hitTranscript
                ? "transcript"
                : hitTitle
                  ? "title"
                  : null;

        return this.toSearchResult(r, {
          snippet: sanitizeSnippet(bestSnippet),
          matchField,
          rank: r.combined_rank,
        });
      });

      if (partial) {
        for (const result of results) result.partial = true;
      }
      return results;
    } catch {
      // FTS5 query syntax errors should not crash the server
      return [];
    }
  }

  /** Most recently active chats, for the search dialog's empty-query state */
  recentChats(options: { projectId?: string; limit?: number } = {}): SearchResult[] {
    const limit = options.limit ?? 20;
    const rows = options.projectId
      ? asRows<SearchResultRow>(
          this.stmtRecentChatsProject.all(options.projectId, limit) as Record<string, unknown>[],
        )
      : asRows<SearchResultRow>(this.stmtRecentChatsGlobal.all(limit) as Record<string, unknown>[]);

    return rows.map((r) => this.toSearchResult(r, { snippet: null, matchField: null, rank: 0 }));
  }

  clear(): void {
    this.db.exec("DELETE FROM sessions");
    this.db.exec("DELETE FROM managed_sessions");
    this.db.exec("DELETE FROM spaces");
    this.db.exec("DELETE FROM session_events");
  }

  checkpointWal(): void {
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  }

  close(): void {
    this.db.close();
  }
}
