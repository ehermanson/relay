# Worktree-local task files implementation plan

## Outcome and decisions

Replace the shared `.relay/tasks.json` snapshot with tracked Markdown task files. Each Space reads and writes its own worktree; the Project Tasks tab defaults to the Main space. Agents work offline through the same core functions exposed by a local CLI. Unrelated tasks merge independently. Same-task conflicts use normal Git review; no distributed claims or automatic last-writer-wins resolution.

Accepted automation tasks may be published without PR review, limited to task intake and bookkeeping. Unaccepted proposals may be discarded. Existing tasks may be cancelled; cancellation does not satisfy blockers. Delete only unreferenced tasks. Automatically archive done/cancelled tasks after 30 days when maintenance runs; retain canonical history in Git.

## Storage contract

- `.relay/tasks/<id>.md`: current tasks, YAML front matter plus Markdown description.
- `.relay/tasks/archive/<id>.md`: terminal history, same schema and stable identity.
- `.relay/task-discussion/<id>/<comment-id>.md`: immutable discussion entries, separate from task state.
- Schema v2: existing fields plus nullable `closedAt`; stored status open/in_progress/done/cancelled, derived blocked retained for presentation. Existing eight-hex and safe legacy slug IDs remain valid (lowercase alphanumeric/hyphen, at most 128 characters); new IDs use UUIDs. Runtime-only `revision` is a content hash; `archived` indicates location.
- Deterministic serializer, quoted string scalars, stable field order, no description rewrite on state-only changes. Parse YAML safely and validate strictly. No silent corruption recovery or overwriting malformed data.
- Validate IDs, filenames, duplicate IDs across both directories, priorities, timestamps, references, parent and blocker cycles. Missing or cancelled blockers cannot make work ready. Preserve the open-child completion guard. Deletion rejects incoming references.
- Worktree-local mutation lock and unique temporary file + rename. Expected revision checks for stale writes. Direct file editing remains possible and is validated on read/CI; it cannot promise lock coordination with an unaware editor.
- Directory existence enables tasks even when empty (tracked marker if necessary). No checked-in generated task index. Ignore locks/caches only.

## Shared API between implementation tracks

Core keeps existing exports (`hasTasks`, `initTasks`, `loadTasks`, `createTask`, `updateTask`, `deleteTask`) and adds:

- `loadTasks(dir, { includeArchived?: boolean }?)`: current task records, derived status; default excludes archive.
- `getTask(dir, id)`: resolve current/archive record with revision, or undefined.
- `updateTask(dir, id, patch)` supports `expectedRevision` in patch; `deleteTask(dir, id, expectedRevision?)` supports optimistic concurrency.
- `listTaskComments(dir, id)` / `addTaskComment(dir, id, { body, author?, replyTo? })`.
- `validateTasks(dir)`, `archiveTasks(dir, { days?: number }?)`, `migrateTasks(dir, { dryRun?: boolean }?)`, `formatTasks(dir, { check?: boolean }?)`.
- Typed task errors expose a code so HTTP can map not found, conflict, and validation failures.

HTTP task routes accept optional `?spaceId=`. Resolve only registered Spaces belonging to the Project, reject missing/broken/closed write scopes. Omitted scope means Main space. Existing list envelope `{ tasks }` remains; add `includeArchived=true`. Add GET task detail and GET/POST comments. PATCH passes `expectedRevision`; DELETE passes revision query/header. WebSocket task changes include optional `spaceId` and invalidate matching queries rather than replacing differently filtered lists.

## Track A — storage and offline CLI (GPT-5)

1. Implement parser/serializer, validation, atomic per-file operations, revision checks, comments, archive/reopen, and strict legacy read compatibility. Legacy mutations demand explicit migration.
2. Add `relay tasks list [--ready] [--json] [--include-archived]`, `show`, `create`, `update`, `delete`, `comment`, `validate`, `format [--check]`, `archive [--days 30]`, and `migrate [--dry-run|--apply]`; resolve cwd worktree without server/network.
3. Migration: strict validation; preserve original IDs and fields; write staged v2 output; archive existing terminal records; leave unknown closedAt null; round-trip compare; detect source changes; install directory and retire old snapshot safely. Refuse ambiguous dual sources and mismatched reruns.
4. Tests: round-trip Markdown/YAML, corrupt input preservation, UUID/legacy hex and slug IDs, duplicate and dangling references, cycles, cancellation blocking, delete guards, archive/reopen, revisions/locks, migration idempotence and field preservation, offline CLI, unrelated two-worktree merge.

Ownership: task-manager and helper files, task types in shared types.ts, core exports, task-manager tests, YAML dependency/package scripts if needed. CLI command wiring and CLI tests are delegated to Track B after its server work, allowing them to proceed alongside storage. Do not migrate the repository snapshot yet.

## Track B — server and bootstrap (GPT-5)

1. Scope all task REST reads/writes to resolved worktrees; add detail/comments and typed failures. Keep Project default Main space.
2. Include Space in task-change events and detect direct file edits using bounded watch/poll lifecycle with cleanup, including atomic replacement and Git checkout changes.
3. Bootstrap checks actual managed-session cwd and injects CLI/discovery guidance; both providers share the contract. Update follow-up injection and pick-up-task action. Ready ordering uses P0 first.
4. Remove history from routine Project artifacts; preserve compatibility for active records. Prevent malformed task files from breaking unrelated Project/session initialization; surface diagnostics instead.
5. Tests: cross-Project scope rejection, Main/Space isolation, invalid or closed Space, revisions, comments, archive detail, bootstrap cwd and legacy guidance suppression compatibility.

Ownership: project routes, instance-manager, session-context, actions, websocket, event type in types.ts (coordinate with A), server tests; then offline CLI command wiring and CLI tests from Track A. No storage or app edits.

## Track C — UI and references (GPT-5)

1. Add Space selection to Project Tasks with Main space default, scope-aware query keys and refresh events. Include unfinished default and done/cancelled/history views.
2. Add cancelled presentation and revision-aware edits/deletes; show actionable stale-write errors. Load archived detail and discussion on demand with comment creation.
3. Scope task mentions, popovers, reference expansion, and new chats to the actual Space. Starting a new Space updates the task in its new worktree, not the Main space; handle uncommitted tasks absent from the new worktree clearly.
4. Update app API functions and URL search parsing, maintain old eight-hex and slug mentions while accepting UUIDs; fetch individual archived references rather than requiring entire history in artifacts.
5. Focused UI helper tests for filtering, scoping, status/ID handling, and query invalidation.

Ownership: app files and app tests. Coordinate new shared type needs with A/B.

## Integration — primary agent

1. Review all tracks against contracts and integrate compile/test fixes. Run meaningful two-worktree scenarios and stale-write tests.
2. Update automation prompts to use CLI/shared writer, preserve dedup and watermark ordering, allow task-only publication without PR review. Keep changes isolated in a dedicated maintenance worktree; never auto-publish arbitrary code. Document API/local intake and offline fallback without adding an unnecessary replicated inbox service.
3. Update AGENTS.md, CLAUDE.md, README, ubiquitous glossary, gitignore and CI validation. Reconcile contradictory create-task guidance.
4. Mark tracked child work done as verified; migrate this repository's full current snapshot with the implemented command, compare IDs/fields/counts, then finish parent task using new storage.
5. Run `pnpm ci-check` (build → typecheck → lint → task checks → tests). Inspect final Git diff, task validation and formatter checks. No commit/push of implementation unless requested.

## Merge and recovery policy

Git merges unrelated task files normally. Same-task conflicts remain explicit, including metadata conflicts; resolve state and regenerate updatedAt. Archive/edit conflicts preserve ID and intended terminal/reopened state. Validate merged graph to catch cycles introduced by independent branches. No union merge driver. Old branches must rebase across migration and translate remaining snapshot edits. Canonical task files and comments stay tracked; caches remain disposable.

## Unresolved questions

None blocking implementation. Use the 30-day default and Main-space default agreed in discussion. Proposal intake can use the local offline CLI today; a hosted inbox/synchronization service is outside this change.

## Implementation discovery

The real snapshot contains 11 safe legacy slug IDs, including one unfinished task. The old eight-hex-only loader skipped these records. Migration must retain these IDs verbatim, validate them as path-safe lowercase alphanumeric/hyphen identifiers (maximum 128 characters), and keep their mentions usable. New IDs remain UUIDs. The migration baseline is 230 original tasks plus five tasks tracking this implementation.

## Execution results

All implementation tracks and integration are done. Three GPT-5.6 subagents implemented storage, server/CLI, and UI, with cross-review of migration and concurrency. The repository now uses the v2 task directory; the legacy snapshot has been removed.

- Migration: 235 tasks (230 original plus five implementation tasks), 202 historical tasks archived. Every original field compared equal before implementation-task status updates. All 11 legacy slug IDs retained.
- Storage, locking and CLI focused tests: 22 passing, including eight concurrent writers, live-owner protection and abandoned-gate behavior.
- Isolated Git worktree smoke test: unrelated task changes merge cleanly; conflicting edits affect only the shared task file; merged task graph validates.
- Final full gate: `NODE_OPTIONS=--no-experimental-webstorage pnpm ci-check` passed. Backend: 1,052 tests. UI: 35 files / 265 tests. The environment flag avoids Node's experimental localStorage conflict in this local test setup.
- Canonical task validation/format checks and source formatting checks passed. Existing Vite bundle-size and instance-manager lint warnings remain; no new check failures.
- Watcher tests cover missing and replaced task roots. The missing-root test allows the documented five-second reconciliation fallback under parallel test load.
- An abandoned short-lived lock gate deliberately fails closed; recovery instructions are in AGENTS.md. Direct editors do not participate in CLI/API lock coordination.
