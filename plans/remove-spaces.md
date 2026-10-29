# Remove Spaces

Status (2026-10-29): done. All five steps landed on `remove-spaces`.

Spaces (branch-scoped worktree groups of chats, with Complete/merge, push/PR, PR status, and a shared brief) predate subagents and Relay orchestration. Usage has collapsed: 19 Spaces ever (16 completed, 3 archived), 1 created in the last 30 days. The feature spreads across ~65 server/UI files (~7.4k lines that exist only for it, plus ~1.2k lines of tests). Delegation (parent + children, cards, wakes, `chat_send`) now covers "several chats working one problem"; provider-native worktree subagents cover isolated parallel edits.

Decision: remove Spaces entirely, including every Space-specific git workflow (Complete, mark merged, push/PR, PR status). Project-level git (`GitStatusBar` push/pull/fetch/checkout on the main checkout) stays.

Possible future, not part of this: a grouped view of a parent chat with its delegated children. If built, it hangs off `InstanceInfo.delegation`, not a Space.

## Keep

- Project-level git: `GitStatusBar`, `gitPush/gitPull/gitFetch/checkoutBranch/listBranches`, `getDefaultBranch`, repo-status for `instance`/`project` targets.
- Worktree _detection_ (chats discovered running in a git worktree fold into their main project: `resolveWorktreeOrigin`, `isGitWorktree`, `normalizeProjectDirectory`).
- `worktree-changes.ts`, `repo-status-service.ts`, `task-manager.ts` (generic).
- Delegation, shared checkout only.

## Remove

**Server core**

- Delete `space-manager.ts`, `space-pr.ts`.
- `git.ts`: drop helpers only Spaces use (`addWorktree`, `mergeBranchIntoTarget`, `MergeTargetError`, `resolveLocalTargetBranch`, `inspectWorktreeGitPointer`, `getWorktreeDiff`, plus already-dead `squashMergeBranch`, `createWorktree`, `localBranchExists`, `getHeadCommit`). The orphan sweep goes too.
- `instance-manager.ts`: SpaceManager wiring, `spaceId` in `createInstance`, `isSpaceWritable`/`assertSpaceWritable`, Space bootstrap brief, Space restore/ownership inference and backfill, `stopSpaceChats`, Space task watchers, `isolation: "space"` delegation (`createChildSpace`, `discardChildSpace`, `delegationsInFlight` can stay for idempotency or go).
- `instance-restore.ts`, `instance-ownership.ts`, `instance-restore-state.ts`, `instance-persistence.ts`, `instance-listing.ts`, `session-context.ts`, `actions.ts` (`in-space`), `terminal-manager.ts` (space scope), `project-manager.ts` (`defaultSpaceBranch`), `types.ts`, `index.ts` re-exports.
- Orchestration: `isolation` param, `space_unavailable`, the closed-Space check in `chat_send`, `ChatDelegation.isolation`, instructions text.

**Server routes / WS**

- Delete `routes/spaces.ts` (+ registration). Drop `?spaceId=` task scoping, `spaceId` on create, Space diff base, `defaultSpaceBranch` settings, `spaceName` in health, repo-status `space` target.
- `websocket.ts`: `space_*` messages, broadcasts, listeners, Space terminal scope.
- Push notification Space URLs; desktop `projectRoots` stops fetching Space worktrees.

**App** (~5k lines deleted)

- Delete `components/spaces/*`, `inbox-space-item.tsx`, `sidebar-space-group.tsx`, `space-membership.ts`, `space-navigation.ts`, `space-view.ts`, `use-project-spaces.ts`, `spaces-page.tsx`, the `spaces/` routes.
- Inbox becomes chat-only (`InboxEntry` loses the space variant). Sidebar, mini sidebar, mobile Home, search, project tabs, New chat menu, settings (default Space branch), task page Space selector, account mismatch for spaces, sidecar/terminal space scopes.
- `getInstanceChatRoute` always `/projects/$projectId/chats/$chatId`.
- Keep a tiny redirect: `/projects/:p/spaces/:s/:chatId` → the chat route; `/projects/:p/spaces/*` → the project. Covers old tabs, bookmarks, push links.
- Drop `"spaces"` from persisted query keys; bump the cache buster.

**Tests / docs**

- Delete Space-only tests; trim mixed ones.
- AGENTS.md (Spaces section and every reference), `UBIQUITOUS_LANGUAGE.md`, README (incl. screenshot), `plans/inbox-spaces.md`, `docs/plans/task-files.md`, `plans/cross-chat-orchestration.md`.

## Data

- **No schema bump.** A bump rebuilds the DB, and `managed_sessions` is the source of truth for managed bindings. The `spaces` table and `space_id` / `default_space_branch` columns stay dormant on existing DBs: never read, never written. Fresh DBs don't create them. A later cleanup can drop them.
- Existing Space chats stay in their project (`project_id` + `original_directory` are already stored). Summaries stop emitting `spaceId`, so the UI never builds a Space link.
- **Closed-Space chats** (worktree deleted): today restore would silently move them to the main checkout and make them writable. Instead: a chat whose recorded worktree no longer exists is read-only (generic rule, no Space knowledge). They stay readable in their project. They were "done" only through their Space's status, so step 4 stamps `done_at` once for chats of completed/archived Spaces (`setDoneBulk`, before the Space rows go dormant); otherwise they reappear as active.
- **Active-Space chats** (worktree on disk): keep running in that worktree, like any discovered worktree chat.
- On-disk worktrees under `~/.relay/worktrees/space-*` are left alone, never deleted by Relay again. The user cleans up with git.
- **Delete guard:** deleting a chat must never remove a worktree another chat still uses. Today only the Space-ownership check prevents it.

## Order (each step green: build, typecheck, lint, tests)

1. **UI** — remove Space surfaces, add the redirect, chat-only inbox, route helper. Server untouched, so it's safe while the server still speaks Spaces.
2. **Orchestration** — drop `isolation: "space"` and the Space checks.
3. **Server API/WS** — routes, messages, broadcasts, settings, task scoping, repo-status target. Terminals opened under a Space scope (`space:<id>`) re-key to their chat or close at startup; the UI only asks for chat scopes now. `in-space` suggestions (`actions.ts`) go.
4. **Core** — SpaceManager, restore/ownership inference, writable checks, brief; the read-only-missing-worktree rule; delete guard; dormant columns.
5. **Dead code, tests, docs.**

## Decided

- Orchestration landed on main first; this work is on branch `remove-spaces`.
- `mergeInstance` ("Merge to main" for a chat on its own branch) stays.
- Closed-Space chats are read-only (and done).
- Fable review per step.

## Follow-ups

- A read-only chat has no UI indicator. Only the send error shows it; the client doesn't handle `chat_read_only` specially, and the diff drawer shows "no changes".
- The dormant `spaces` table and `space_id` / `default_space_branch` columns can be dropped in a future schema bump.
- Legacy `~/.relay/worktrees/space-*` directories are left for the user to remove with git.
