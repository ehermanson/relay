# AGENTS.md — Relay

## Rules

- **Self-maintenance**: After any codebase change, check whether AGENTS.md and/or README.md need updating. Stale docs are worse than no docs.
- **Plan mode**: Make the plan extremely concise. Sacrifice grammar for the sake of concision. At the end of each plan, give a list of unresolved questions to answer, if any.
- **Workflow**: For anything beyond a trivial fix, create tasks in `.relay/tasks.json` before starting work. Relay manages this snapshot file atomically; update the canonical task object and persist the full snapshot. Set `status: "in_progress"` when starting, `status: "done"` when complete.

## Ubiquitous Language

Use `UBIQUITOUS_LANGUAGE.md` as the canonical glossary for domain terminology in user-facing language, docs, UI copy, issue discussion, and agent responses.

High-risk distinctions:

- **Project** = top-level codebase
- **Space** = branch-scoped collaboration area within a project
- **Chat** = user-facing conversation
- **Managed session** / **External session** = runtime behind a chat
- **Complete** = merge and close a space
- **Archive** = close a space without merging

## Project Overview

Relay is a bridge between remote devices and local AI coding agents. It manages multiple agent processes, discovers external sessions, and serves a React web UI.

**Three-layer structure:**

- `app/` — React UI (the product)
- `server/` — HTTP, WebSocket, auth, tunnel + `server/core/` (engine: managers, types, providers)
- `cli/` — CLI wiring (bin.ts, migration.ts)

## Architecture Philosophy

In the backend, Relay manages providers through a provider-driver registry (`server/core/provider-registry.ts`): each provider declares its capabilities and owns session creation, model lookup, transcript parsing, external-session discovery, and managed-session recovery behind the shared `ProviderSession`/`ProviderRuntimeBinding` contract. The UI asks the server for available providers (`GET /api/providers`) and provider-scoped model metadata plus capabilities (`GET /api/provider-models`), then shows or hides toolbar controls and picker options from that metadata.

**Key architectural invariants:**

- Relay is multi-provider. Never assume a behavior is Claude-only or Codex-only without checking the provider contract and the sibling driver(s). For provider-facing changes, either update every affected provider path or document why the behavior is genuinely provider-specific.
- `ProviderCapabilities` is the single source of truth for what controls the UI should render — never hardcode provider-specific logic in the UI
- SQLite has two distinct roles: `sessions` is a rebuildable Claude transcript index, while `managed_sessions` is the source of truth for managed-session provider bindings and restore metadata
- JSONL files on disk are the canonical transcript source — the DB is a cache/index that can be rebuilt by scanning `~/.claude/projects/`
- Core (`server/core/`) must never import from server; server imports from core; UI imports from core via `@shared` alias
- Session targeting after first response always uses `--resume <sessionId>`, never `--continue` (which picks the most-recently-modified session in CWD — wrong with concurrent sessions)

## Tech Stack

- **Runtime**: Node.js 22+, ESM only (`"type": "module"`), native TS execution in dev
- **Language**: TypeScript (strict mode)
- **Server**: `node:http` host server + Hono for HTTP routing + `ws` for WebSockets
- **UI**: React 19 + Vite + Tailwind CSS v4 + React Router
- **Tests**: Node.js built-in test runner (`node --test`)

## Build & Test

```bash
pnpm build          # tsc + vite build
pnpm build:server   # tsc only
pnpm build:app      # UI typecheck + vite build
pnpm typecheck      # server + UI TypeScript checks
pnpm test           # node --test test/*.test.js
pnpm dev            # server from TS source (no tsc) + vite dev
```

Always `pnpm build:server` before `pnpm test` — tests import from `dist/`.

`pnpm ci-check` runs the full CI gate locally in order (`build → typecheck → lint → test`; build first so tests see fresh `dist/`). A Husky `pre-push` hook (`.husky/pre-push`) runs it automatically, but **skips** when the pushed commits touch only docs/non-code files (`*.md`, `*.txt`, `docs/`, etc.) — any other changed path forces the full check. Bypass with `git push --no-verify` only when you know CI will pass.

### Dev Mode

`pnpm dev` runs the server directly from TypeScript source via Node's native type stripping (`--conditions=relay-dev` remaps `#` imports to `.ts` files). No `tsc --watch`, no `dist/` dependency, no auto-restart. Press `r` to manually restart the server.

This avoids the "using the tool to work on the tool" problem — AI agents modifying server files won't trigger disruptive mid-operation restarts.

Dev state is isolated: `pnpm dev` defaults `RELAY_HOME` to `~/.relay-develop` (override by setting `RELAY_HOME`), so a dev server never shares `sessions.db`, `provider-state.json`, or worktrees with a production install using `~/.relay`. Two servers writing the same home causes last-writer-wins state clobbering and schema-version DB rebuild ping-pong.

## Key Conventions

### Import Aliases

Server + CLI use Node.js native subpath imports (`#` prefix):

- `#core/foo.js` → `server/core/foo.ts` (compile) / `dist/server/core/foo.js` (runtime)
- `#server/foo.js` → `server/foo.ts` (compile) / `dist/server/foo.js` (runtime)

App uses Vite resolve.alias:

- `@/*` → `app/src/*`
- `@shared/*` → `server/core/*`

Zero relative path navigation (`../`) in any server/cli import.

### Package Exports

```json
{ ".": "./dist/server/core/index.js", "./server": "./dist/server/index.js" }
```

`server/index.ts` re-exports all of core — importing from `relay/server` gives you everything. UI imports shared types via `@shared/types` (Vite alias → `server/core/types.ts`).

### Config Hierarchy

- `CoreConfig` — minimal config for core modules
- `RelayConfig extends CoreConfig` — adds server-specific options (port, auth, rate limiting, etc.)
- Structural subtyping makes `RelayConfig` assignable to `CoreConfig`

### External Session Discovery

- InstanceManager polls provider-specific external discovery every 30s; drivers currently use `ps` + `lsof` and exclude managed PIDs plus any descendant of the Relay server process (SDK-managed CLIs don't expose a PID, so `ppid` ancestry is the only reliable exclusion — without it, external instances get mispaired with managed subprocess PIDs and takeover SIGKILLs a managed session)
- **Codex adds a second, PID-less signal** (`server/core/providers/codex-discovery.ts`): any rollout under `~/.codex/sessions` in a registered cwd whose mtime is within `DISCOVERY_INTERVAL × STALE_THRESHOLD` counts as a live external session with `pid: undefined`. Codex Desktop hosts threads inside ChatGPT.app, so there is no `codex` process with the project cwd to find — without this, those sessions surface only at the startup scan. This is deliberately not applied to Claude: Claude Code always runs as a `claude` process with the project cwd, so PID discovery is complete there. `readCodexSessionMeta` reads only the first line (rollouts are tens of MB; `session_meta` alone is ~20KB) and caches by path. Two exclusions keep the signal honest: **sub-agent rollouts** (`thread_source: "subagent"` / `source.subagent`, from `multi_agent` spawns) are never sessions of their own — skipped by discovery and the startup scan — and PID-less discovery skips rollouts whose `originator` is Relay's own (`RELAY_CODEX_ORIGINATOR`, the app-server `clientInfo.name`), since Relay's threads are managed by definition.
- **Codex rollout format is versioned by the CLI.** ≤ 0.152 records conversation turns as `event_msg` `user_message` / `agent_message` / `agent_reasoning`; ≥ 0.153 records `event_msg` `item_completed` with typed v2 items (`UserMessage`, `AgentMessage`, `Reasoning`, …) and no longer writes the legacy events. `extractCodexConversationMessage` (`codex-transcript.ts`) normalizes both and is the single reader for replay, scan-time titling, and last-message previews — never match on `user_message` directly. Do **not** read turns from `response_item` `message` entries: those include Codex's own user-role injections (`<recommended_plugins>`, `<environment_context>`). The scan-time meta reader streams the file head (up to 1MB) because 0.153 front-loads ~90KB of prompt/context before the first real user turn.
- `scanAllSessions()` walks provider transcript roots (`~/.claude/projects/`, `~/.codex/sessions/`) on startup for historical sessions
- `decodeProjectDir()` uses greedy filesystem-validated decode (not naive `-` → `/`) to handle dashed project names
- JSONL watchers track incremental changes with dedup: suppressed while process is active, offset advanced to EOF when process finishes

### iOS Keyboard Handling

The iOS keyboard is handled by **accepting** WebKit's native page push (the header slides off-screen while typing — standard iOS webapp behavior) and making scroll math visual-viewport-aware instead of mutating layout. The message-framing effect in `message-list.tsx` intersects the scroll container with `window.visualViewport` to compute the pin position (`messageTop − hiddenTop`), spacer size, and handoff threshold. Dead ends — tried and reverted (see git history), don't relearn them:

- iOS standalone PWAs do **not** resize the layout viewport for the keyboard (and ignore `interactive-widget=resizes-content`); they shrink the visual viewport and push the page via `visualViewport.offsetTop` + window scroll
- Reactive countermeasures jitter: `scrollTo(0,0)` fights an animated push (and `html { scroll-behavior: smooth }` animates the correction); transform-following the offset moves the focused input and re-triggers WebKit's reveal (feedback loop)
- Pre-shrinking `<body>` on `focusin` prevents the push, but iOS freezes web-content compositing during the keyboard presentation, so the shrink paints only after the transition settles (~1s perceived stall) — web-unfixable
- Pre-shrinking at `pointerdown` paints in time but moves the tap target mid-gesture — iOS abandons the tap (no focus, no keyboard)

### Mobile Type & Touch Targets

Mobile (≤768px) sizing is centralized in `app/src/index.css` — don't fight it per-component:

- A 17px root font plus a **mobile type ladder** that remaps the small rem utility classes (`text-[0.5625rem]`…`text-[0.8125rem]`, `text-xs`) up one step on phones. Use the rem scale for new text — never px sizes like `text-[11px]` (they silently opt out of the ladder). Deliberate px exceptions: the composer and chat message bodies are pinned to 16px (iOS anti-zoom parity), xterm and the diff drawer set their own mobile sizes.
- A `@media (pointer: coarse)` block gives menu items / options / tabs native hit heights centrally; undersized icon buttons get `max-[768px]:h-10 max-[768px]:w-10`-style bumps at the call site. Keep interactive targets ≥ ~40px on mobile — grow hit areas (padding/min-height), not glyphs.
- **Tooltips never open on touch.** Anything informational needs a tap path on mobile (e.g. context-panel help icons switch to a `Popover` on coarse pointers), and hover-gated affordances need a `pointer: coarse` override (see `sidebar.css`).
- Dialogs top-anchor on mobile (`dialog.tsx`) — the keyboard covers vertically centered dialogs.
- Mobile overlays (sidebar, sidecar) use the shared `SwipeableDrawer` (`app/src/components/ui/swipeable-drawer.tsx`): motion-drag swipe-to-dismiss with a progress-driven backdrop, plus opt-in edge-swipe-to-open. Don't hand-roll new overlay gestures — reuse it. Its edge listeners never block taps (they claim the gesture only after horizontal intent), but the OS back-gesture can win at the outermost bezel, so a tap affordance must always exist too.
- `SwipeableDrawer` owns scroll containment: a capture-phase `touchmove` guard cancels any touch that isn't inside an _overflowing_ `overflow-y: auto/scroll` element, and `[data-swipeable-drawer] * { overscroll-behavior: contain }` stops edge bounce chaining into the page. Two rules keep it working on iOS: (1) the guard never cancels inside a real scroller, not even at its edges — iOS decides on the first `touchmove` and a cancelled first event kills the whole gesture, so a 1px jitter at `scrollTop` 0 would dead-end every scroll; (2) the panel is a stretched flex column — never give it a percentage height (WebKit won't reliably resolve one through a row-flex item, and a collapsed panel means content never overflows, so touches scroll the page instead). Drawer content must be a genuine scroller filling the panel via `flex-1 min-h-0`.

### Lazy Hydration

Sidebar/dashboard rows render from persisted SQLite metadata first. Opening a chat triggers lazy hydration of transcript/task/file state and git info, but history reads stay passive: Relay does not boot/resume a stopped managed session until the user explicitly sends a message (or otherwise takes over/resumes it).

### Entry Screens & Project View

Phone users open Relay to start or continue a chat, so the entry screens lead with chats, not stats.

- **Project view IA is identical on mobile and desktop**: tabs are `Overview · Plans · [Tasks] · [Skills] · [Spaces] · Settings` — there is **no Chats tab**. **Overview _is_ the chat list** (`ProjectChatList` in `app/src/pages/chats-page.tsx`) with an expandable "Project stats" strip above it (token cards + model breakdown + docs, collapsed by default). The Overview tab carries the chat count + active badge.
- The chat list is **one flat list** of standalone + space chats; space chats are tagged with their branch via the shared `ChatListRow` (`app/src/components/chat/chat-list-row.tsx`). Only row density adapts: dense `ChatListRow`s on mobile, rich `SessionCard`s on desktop.
- **Chats can be pinned** to the top of their project's lists (sidebar context menu → Pin). Ordering is pinned-first-then-recency via the shared `compareChatListOrder` (`app/src/lib/utils.ts`) — use it for any per-project chat list, not a raw recency sort. The `pinned` flag lives on both session tables and is mutated only by `SessionDB.setPinned()` (deliberately excluded from the upserts' conflict-update so routine saves can't clobber it); `POST /api/instances/:id/pinned` works for chats with no live instance.
- The legacy `/projects/:id/chats` list route now **redirects to Overview** (`/projects/:id`); link there for "all chats", not to a separate page. The `chats/$chatId` individual chat view is unchanged.
- **Home/dashboard cards intentionally diverge by viewport** (the one justified split, driven by the desktop sidebar already listing chats): desktop cards show stats + model chips; mobile cards show the project's recent chats (top 5, via `ChatListRow`). Gate with `useMediaQuery("(max-width: 768px)")`.
- **Dashboard uses the same data model as the sidebar** (`useProjectNavigationModel`): REST chat summaries merged with live WS instances in the shared user-defined project order — never render entry-screen chat lists from WS state alone (it's empty until `instance_list` arrives).
- **The react-query cache is persisted to localStorage** (`relay:query-cache`, wired in `app/src/routes/__root.tsx`) for an allowlist of read-mostly entry-screen queries (`projects`, `projectChats`, `projectArtifacts`, `projectIcons`, `global-settings`, `spaces`), so revisits paint from last-known data and refetch in the background. Bump the `buster` string there when a persisted query's data shape changes incompatibly.

### Sidebar Layouts

The sidebar has two layouts, chosen by `GlobalSettings.sidebarLayout` (`"projects" | "inbox"`, default `"inbox"`, toggled in Settings → General). Both render from the same data — `useSidebarNavigationController` — so neither layout should fetch anything of its own. The default lives in the null→layout normalization (server `rowToSettings`, client `useSidebarLayout`/`DEFAULT_SETTINGS`): an unset value resolves to `"inbox"`, and only an explicit `"projects"` choice opts out — so flipping the default is a one-line change in each mapper, not a DB migration.

- **Projects** (`sidebar.tsx`): collapsible project groups → active spaces → chats. Unchanged behavior; treat it as the stable baseline.
- **Inbox** (`inbox-sidebar.tsx`): one flat recency-sorted list across every project via `useInboxNavigationModel`, which flattens the project groups. Each row (`inbox-item.tsx`) is three lines — project · title · branch + provider/model — since there are no project headers to supply that context. The timestamp/menu is anchored absolutely to the top-right (line-1 band) so the title and branch lines below use the full row width; only line 1 reserves space (`pr-10`) for it. A dropdown filters to a single project (deliberately **not** persisted — a sticky filter would silently hide chats after a reload). Project-level actions move into a collapsed "Projects" section at the bottom.
- **The header action slot carries each layout's primary action**: Add project in Projects mode, New chat in Inbox mode. `SidebarHeader`'s `action` prop overrides it; `AddProjectButton` is exported separately so it can live in either spot. When projects exist, Inbox packs **one** control row — project filter (flex) + `SidebarSearchIconButton` — instead of stacking search and filter on their own rows.
- **Only one `+` per corner.** Inbox's New chat lives in the header; Add project is a labelled item at the bottom of the project filter menu, **not** a second icon button on the control row — stacked in the same corner, two plus glyphs were a coin flip. The add/create forms live in one `AddProjectPanel` in `sidebar-chrome.tsx` with two surfaces around it: `AddProjectButton` (popover, for the header) and `AddProjectDialog` (for menu items, which can't anchor a popover). Each surface mounts the panel fresh, so tab/error state resets per open. With **no projects registered** there is no control row, so Inbox falls back to the default header action (Add project) and shows the full-width `SidebarSearchTrigger` on its own.
- `SIDEBAR_CONTROL_ROW_CLASS` uses `pl-3 pr-4` (not `px-3`) so its trailing icon button lines up with the header's `px-4` icon column instead of sitting 4px inside it.
- Chrome (header, search triggers, footer) lives in `sidebar-chrome.tsx` and the per-project menu in `project-actions-menu.tsx` — both layouts import them so they can't drift. Search has two forms there: the full-width `SidebarSearchTrigger` (Projects mode, and Inbox with no projects) and the compact `SidebarSearchIconButton` (Inbox's combined control row, ⌘K hint in its tooltip).
- Each inbox row's left column is a single `InboxAvatar`: the project favicon with a status badge on its corner (dot for managed chats, terminal glyph for external), replacing what were separate status-indicator and folder-icon columns. Quiet rows — stopped, read, unselected — desaturate; hover/selection/activity restore color. Status wording lives in the avatar tooltip, not in row text.
- `MiniSidebar` and the mobile overlay follow the setting: the collapsed rail lists chats in inbox mode (keyed by project favicon, not provider — most chats share a provider, so a column of provider marks carries no information), project icons in projects mode. The rail reuses `InboxAvatar` and shows `InboxChatSummary` on hover, since the hover card is the only place its project/branch/model/status can appear.
- Per-chat actions live in `chat-actions-menu.tsx` (Mark done, Pin, Rename, Merge, Split, Delete) — the single definition for **both** layouts: the inbox row's ⋮, the collapsed rail's right-click menu, and the projects-mode `SidebarItem`. It takes `instance` + `spaceStatus` (not an `InboxEntry`) so projects mode can use it, and derives done/delete-disabled itself. **Mark done renders only when `sidebarLayout === "inbox"`** — Projects mode has no Done section, so the item would take effect with no visible response. Rename is surface-specific: rows edit in place, the rail has no title and opens a dialog, so the menu takes an `onRename` callback.
- The "New" trigger (direct-create when one target project is unambiguous, project-picker menu otherwise) is the shared `NewChatMenu` (`new-chat-menu.tsx`), used by the inbox header and the collapsed rail. Chat-only by default; pass `onCreateSpace` to make it a combined New chat + New space menu (both the inbox header and the collapsed rail do, since the flat layout has no other discoverable home for space creation — the per-project "New Space" is buried in the collapsed "Projects" section). With the space action the trigger always opens a menu, so chat creation costs one extra click even when unambiguous.
- The inbox's rules — review-chat exclusion, closed-space chats counting as done, pinned-first ordering, project filtering — live as pure functions in `app/src/lib/inbox.ts` (tested in `inbox.test.ts`); the hook is a thin `useMemo` wrapper so the logic is testable without mounting the sidebar.
- `ProjectAvatar` falls back to the project's **initial**, not a folder glyph, when there's no scanned favicon — a column of identical folders defeats the point of keying rows by project.
- **The open chat is never hidden**: capped lists (15 active / 20 done, "Show all" to expand) append it when it falls past the cap; the Done section auto-expands when you open a chat that was _already_ done; and the collapsed rail — which lists only active chats — appends the open chat when it's done or past its cap.
- **Marking a chat done never expands the Done section** — a collapsed list jumping open under the cursor is worse than the chat scrolling out of view. The acknowledgement is a pulse on the "Done N" header (`.inbox-done-label` in `sidebar.css`), triggered by ids that were in the active list on the previous render — not by `done.length`, which also jumps when the lists first load. The auto-expand above is suppressed by the same signal: having seen the open chat in the active list means a later move into Done was a transition, not an arrival. Both rules live in `app/src/hooks/use-done-section.ts` (tested in `use-done-section.test.ts`), and `useDoneSectionDisclosure` keeps its per-chat reset, its "saw it active" write, and its expand in **one** effect deliberately — split across effects with narrower deps, switching from one active chat to another reset the flag without re-setting it, so the next mark-done expanded the section (intermittently, depending on which chat you came from).
- The row's model label resolves `providerStatus.effectiveModel` → `stats.model` → `preferredModel` and stops there. Do **not** fall back to a project/global default (it would claim a model the chat never ran), and do **not** call `useProviderModelsMap` for labels — discovery can spawn provider processes, so labels come from the pure `findProviderModelLabel` catalog helper.

**Done chats.** `doneAt` is a **timestamp, not a boolean**: `isChatDone()` (`app/src/lib/utils.ts`) treats a chat as done only while its recency is at or below the marker, so later activity revives it with no server-side clearing. Recency (`getChatRecencyTimestamp`) is the **max** of `lastMessage.timestamp` and `lastActivityAt` — either can lead (tool-only activity bumps `lastActivityAt` without a message), and a fallback chain would strand revived chats in Done. The Done section itself orders by recency alone (pins express "keep in front of me", which done chats no longer need). This is deliberate — there is no single choke point where `lastActivityAt` is bumped, so a push-based revive would leak. Chats in `completed`/`archived` spaces are permanently done regardless of activity. Storage mirrors `pinned` exactly: `done_at` on both session tables, mutated only by `SessionDB.setDone()` (excluded from the upserts' conflict-update), exposed via `POST /api/instances/:id/done`, which works for chats with no live instance.

**Sweeping stale chats.** A backlog is cleared by hand, never by a rule: the inbox renders a "Mark N inactive chats done" row under the active list when `selectStaleInboxEntries` (`app/src/lib/inbox.ts`, cutoff `STALE_CHAT_DONE_DAYS` = 10) finds anything, and a confirm dialog runs it. Two invariants make it safe to repeat:

- **The client picks the chats, the server just writes them.** `POST /api/instances/done-bulk` takes explicit `instanceIds` rather than a cutoff, because the DB row's `last_activity_at` is only half of a chat's recency — the other half is its last transcript message — so a server-side `WHERE last_activity_at < cutoff` would sweep chats the UI still shows as recent. The sweep is scoped to the filtered `active` list, so it marks exactly what the user is looking at, and skips `processing` chats plus any with recency 0 (unknown, not ancient — that's what a just-created chat looks like).
- **Every swept chat gets the sweep's `now`, not its own last activity.** A chat reads as done only while recency ≤ `doneAt`, so stamping anything older would leave part of the sweep still undone.

`InstanceManager.setInstancesDone()` persists via `SessionDB.setDoneBulk()` (one transaction), updates live instances in memory (they override REST summaries in the UI's merge), and emits a single `instances:changed` → one `instance_list` broadcast. Never emit per-chat status for a bulk mutation — a sweep touches hundreds of rows.

### Search

- ⌘K search (`app/src/components/search-dialog.tsx` → `GET /api/search` → `SessionDB.search()`) is **global by default** — never scope it to the route's project implicitly. The dialog offers a per-open project filter dropdown (reset on every open, never persisted); when unfiltered, results from the current route's project get a 2× rank boost (`boostProjectId`) so local results lead without hiding cross-project hits.
- FTS5 `search_index` ranking: weighted bm25 (title ≫ summary/branch > prompts/messages > transcript, weights on `SEARCH_INDEX_COLUMNS`) × 30-day recency decay. Recency is `max(last_message_at, last_activity_at)` (`RECENCY_SQL`), matching the inbox's `getChatRecencyTimestamp` — keep them in sync.
- The **last token is prefix-matched** (`"tok"*`) unless the raw query ends in whitespace (word complete) — as-you-type search must not require whole words.
- Tokens are ANDed; when the strict query matches nothing (and there are 2+ tokens), `search()` retries with **OR and flags results `partial: true`** — the UI renders them under a "Partial matches" heading instead of a dead "No results".
- An **empty query returns recent chats** (`SessionDB.recentChats()`, same `SearchResult` shape with null snippet), so the dialog doubles as a chat switcher. Ordering is **pinned-first, then recency** (matching `compareChatListOrder`); the index carries a `pinned` column and `setPinned()` resyncs the doc, so pin toggles reflect immediately.
- **Projects and active spaces are search results too**, matched client-side in the dialog (name/branch substring) from the cached `projects` + `["spaces", projectId]` queries — no server round-trip; they render as "Projects"/"Spaces" groups above chats and respect the project filter. Space queries are `enabled` only while the dialog is open.
- Adding a column to `SEARCH_INDEX_COLUMNS` is self-migrating: `ensureSearchIndex()` drops any existing table missing a declared column and the index is rebuilt at startup.
- Results whose chat has no registered project are hidden client-side — they can't be navigated to (routes need a `projectId`).

### Spaces

Spaces group multiple concurrent agent chats within a shared git worktree/branch (`Project → Space[] → Chat[]`). Every project has an implicit "main" space (no worktree, default branch). Additional spaces create dedicated worktrees in `<RELAY_HOME>/worktrees/space-<id>/` (defaults to `~/.relay/worktrees/space-<id>/`).

- `SpaceManager` (`server/core/space-manager.ts`) owns space lifecycle: create, list, complete (merge + cleanup), delete (archive + cleanup)
- Each space has a "brief" at `.relay/space-context.md` (git-excluded, seeded on creation). Its **contents** are injected into every chat's bootstrap context (the space-level analog of project custom instructions) via `buildSpaceBootstrapContextBlock` + `extractSpaceContextForInjection` — only when the file has authored content beyond the seed template, and only at session start (new/resumed chats).
- `spaces` table in SQLite with `space_id` FK on `sessions` and `managed_sessions`
- Space completion auto-commits dirty worktrees, merges into the default branch, and removes the worktree; local branch is kept for recoverability
- `MergeMethod` type: `"squash" | "merge-commit"` — passed per-merge via `completeSpace(id, { mergeMethod, squashMessage? })`; default is `"squash"`
- `spaces` table stores merge metadata (`merge_commit`, `merge_method`, `merged_at`, `target_branch`) and remote tracking (`remote_status`, `pr_url`)
- Lifecycle states: `active` → `completed` (merged) or `archived` (closed without merge); completed/archived spaces are read-only in the UI
- UI terminology: "Complete" (action label), "Merged"/"Archived" (status badges), "Archive" (replaces "Delete" in UI)
- Sidebar shows Active spaces → Chats → Closed spaces (collapsed); mini-sidebar shows active only
- REST API: `GET/POST /api/projects/:dir/spaces`, `GET /api/projects/:dir/spaces/all`, `GET/DELETE /api/spaces/:id`, `POST /api/spaces/:id/complete`, `GET /api/spaces/:id/diff`
- WS messages: `create_space`, `complete_space`, `delete_space` (client); `space_created`, `space_completed`, `space_removed`, `space_list` (server)
- `space_list` broadcast includes all spaces (active + closed) so the sidebar can render the closed section
- Non-default spaces render as clickable items in the sidebar; selecting one opens a tab-based view with horizontal tabs per chat
- Non-git projects fall back to flat Chat[] model (spaces require git)
- `pushSpace()` pushes the space branch and optionally creates a PR via `gh pr create` — all git args use `execFileSync` array form to prevent shell injection; persists `remote_status`/`pr_url` on the space

### Git Integration

- `GitStatusBar` component renders below the project header: branch selector, push/pull/fetch buttons, ahead/behind indicators, dirty-state badge
- `server/core/git.ts` provides pure-function git helpers: `listBranches()`, `getAheadBehind()`, `checkoutBranch()`, `gitFetch()`, `gitPull()`, `gitPush()`, `getPrimaryRemote()`
- `getPrimaryRemote(dir)` detects the actual remote name (prefers `origin`, falls back to first listed) — never hardcode `"origin"`
- Remote branch names are stripped of the dynamic remote prefix (not hardcoded `origin/`)
- REST API: `GET /api/projects/:id/branches`, `POST /api/projects/:id/checkout`, `POST /api/projects/:id/git/fetch`, `POST /api/projects/:id/git/pull`, `POST /api/projects/:id/git/push`
- Space push: `POST /api/spaces/:id/push` with optional `{ createPR: true }`

### Project Settings

- Per-project settings stored in `projects` table: `custom_instructions`, `default_space_branch`, `default_provider`, `default_model`
- Custom instructions and task guidance should be delivered as structured session bootstrap context when the provider supports it; avoid rewriting the first user message unless falling back for compatibility
- Default provider/model are used when creating new sessions within the project
- Default space branch determines the base branch when creating new spaces (worktrees)
- Settings page: `/projects/:id/settings` with textarea for instructions, branch picker, provider/model selectors
- `SessionDB` creates the final schema directly; any DB whose `schema_version` does not match the current version is backed up and rebuilt from transcript discovery
- Removing a project writes a tombstone to the `removed_projects` table; `recoverProjectsFromSessionDirectories()` skips tombstoned directories so removed projects don't resurrect from leftover session rows. Only explicit re-registration (`addProject`, including starting a chat in that directory) clears the tombstone

### Provider Version Advisories

- `ProviderCapabilities.versionAdvisory` carries the result of the provider-version probe: installed CLI version vs latest npm-published version, detected install method, and the recommended update command
- Probe runs in `server/core/provider-versions.ts` (pure helpers + `buildVersionAdvisory`); `server/core/provider-registry.ts` caches the result in-memory and refreshes every 30 min
- Provider capabilities may be filtered by the installed version after probing. Codex `writes-only` is exposed only for CLI >= 0.144.0; before the probe resolves, version-gated controls remain hidden.
- Latest-version lookup hits the npm registry with a 1h in-memory cache; `POST /api/providers/recheck-version` force-bypasses the cache (used by the settings "Re-check" button)
- `POST /api/providers/update?provider=<kind>` runs the advisory's update command server-side (`runProviderUpdate` in `provider-registry.ts`): the command is always server-derived from `buildUpdateCommand` (never client-supplied), executed shell-less via `execFile` with a 10-min timeout; concurrent requests per provider share one run, and the advisory is force re-probed afterward. Automatic update is offered only for detected non-manual install methods; manual installs keep a copyable recommendation but are not run server-side.. Automatic update is offered only for detected non-manual install methods; manual installs keep a copyable recommendation but are not run server-side.
- UI surfaces a one-shot sonner toast at app launch via `app/src/components/provider-update-notification.tsx`; dismissals persist per (provider, latestVersion) key in localStorage (`use-dismissed-provider-advisories.ts`)
- The settings page renders a per-provider advisory card inside `ProviderDefaultsRow` with a copy-to-clipboard update command, an "Update now" button (inline confirm step → runs the update via the server), and a manual recheck button

### Claude Plan Rate Limits

- Plan utilization has two SDK sources: live `rate_limit_event` messages mid-session, and the experimental `get_usage` snapshot (SDK ≥ 0.3.169) probed at prewarm, session start, and after each completed turn (throttled, `refreshUsageRateLimits` in `server/core/providers/claude-sdk.ts`). Always feature-detect the snapshot method (`usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET`) — it will be renamed at stabilization.
- Merging is field-level, never whole-window: live events carry `status` (and only sometimes `utilization` — `allowed` events have none), the snapshot carries authoritative `utilization` but no status. An event without utilization must not erase a known percentage, and a snapshot below 100% clears a stale `rejected` (both in `claude-sdk.ts` and in `mergeRateLimitWindows` in `instance-manager.ts`). The CLI replays cached rate-limit status at session start, so a latched `rejected` that snapshots can't override will stick for hours.

### Plan Review Abstraction

- Provider-specific plan output should normalize onto Relay's shared `ExitPlanMode` / `pendingPlan` / `planContent` flow instead of inventing a separate UI path
- Codex `<proposed_plan>...</proposed_plan>` blocks are treated as plan-review events, not plain assistant markdown, in both live app-server streaming and transcript replay

### Codex Process Spawning

- Every `codex app-server` spawn must build its environment with `buildCodexSpawnEnv()` (`server/core/providers/codex-cli.ts`), never raw `process.env`. It inherits the process env and, when unset, injects `CODEX_CODE_MODE_HOST_PATH` pointing at the `codex-code-mode-host` binary bundled inside ChatGPT.app. Codex "code mode" shells out to that helper but it isn't on PATH, so without this injection `turn/start` fails with `failed to spawn code-mode host ...: No such file or directory`. A user-provided `CODEX_CODE_MODE_HOST_PATH` always wins.
- `resolveApprovalPolicy()` maps `full-access` → `never`, `writes-only` → `writes`, and everything else → `on-request`. Codex dropped the old `on-failure` variant; valid values include `untrusted`/`on-request`/`granular`/`never`/`writes` (with `writes` requiring CLI >= 0.144.0).

### Model Discovery

- For **every** provider, the provider-discovered model list is canonical: new models surface in discovery order without a code change. `BUILTIN_PROVIDER_MODELS` (`provider-catalog.ts`) is offline fallback + metadata enrichment only — a new model release must **not** require a catalog bump.
- Claude canonical ids come from the SDK's `resolvedModel` field (with the `[1m]` alias suffix stripped); display-text scraping in `inferClaudeModelIdFromSdkInfo` is a legacy fallback for old CLIs. Label formatting (`formatClaudeModelLabel`) accepts any `claude-<family>-<version>` id — never whitelist family names.
- Both discovery caches re-probe in the background on a 30-min TTL, kicked from the drivers' `getModels` (`refreshSdkDiscoveredModelsIfStale` in `claude-sdk.ts`, `refreshCodexModelsIfStale` in `codex-models.ts`), so a long-running server picks up new models without a restart. This matters because lists change out from under a running server: Anthropic publishes models server-side; Codex lists change when the CLI is updated (including via Relay's own provider-update flow).
- Claude SDK spawns (sessions and discovery probes) prefer the **system-installed** `claude` CLI via `pathToClaudeCodeExecutable` (`resolveClaudeExecutablePath` in `claude-sdk.ts`). The CLI bundled inside the `@anthropic-ai/claude-agent-sdk` package caps flagship alias resolution at whatever it shipped with and only changes on a lockfile bump; the system CLI auto-updates and is covered by the provider-version advisory. Escape hatch: `RELAY_CLAUDE_SDK_USE_BUNDLED_CLI=1` forces the bundled CLI.

### Model Options

`ProviderModelOptions` (`reasoningEffort`, `fastMode`) is the canonical contract for provider-agnostic model tuning. Provider drivers map these to provider-specific session args.

- `InstanceInfo.modelOptions` is canonical
- `model_options_json` column on `managed_sessions` is the canonical storage for provider-agnostic model tuning
- `set_model_options` WS message does sparse merge (omitted = untouched, `null` = clear)
- `ProviderCapabilities` includes control metadata (`reasoningEffortLevels`, `runtimeModes`, `fastModes`) — UI renders labels/descriptions from these, never hardcodes provider-specific text
- Claude `auto` is an environment-dependent runtime mode: expose it only for Bedrock, Vertex, Foundry, or explicit `CLAUDE_CODE_ENABLE_AUTO_MODE` opt-in, and never when user settings contain `disableAutoMode: "disable"`.
- `ReasoningEffort` uses `"max"` as the Relay-canonical highest effort; provider drivers map to native values (e.g. Codex `"xhigh"`); unknown strings pass through
- Mid-session model switches emit a `model_switched` system event (divider in chat + timeline). It's recorded at **message-dispatch time** (`recordModelSwitchOnDispatch`), not when the user picks a model in the UI — only when the resolved model differs from the previous turn's (`instance.lastTurnModel`). So toggling the picker without sending, or switching away and back before sending, produces no divider; the divider always sits directly above the first turn the new model ran. Relay-level events like this never appear in provider transcripts, so they're persisted in the `session_events` table and re-merged into history by `mergeSessionEvents()` on every hydrate/getHistory. `lastTurnModel` is in-memory only, so the first send after a server restart re-establishes the baseline without a divider

### MCP Discovery

- `ProviderMcpServerStatus` is Relay's normalized MCP discovery contract. Keep configured, available-to-chat, and connection/authentication state separate; presence in Provider configuration never proves Chat availability.
- Provider-global MCP state may enrich Chat-reported state, but Chat-reported state is authoritative for availability in that Chat. Empty arrays clear stale snapshots; `undefined` means the Provider supplied no new knowledge.
- Provider-native MCP payload parsing stays in Provider drivers/session initialization. Shared UI consumes normalized enums and `ProviderCapabilities.mcp`, never Provider-name branches or raw status-string parsing.
- Global Settings can add Provider-global MCP servers through `POST /api/providers/:provider/mcp-servers`; Claude supports HTTP/SSE/stdio and Codex supports HTTP/stdio. `server/core/mcp-management.ts` validates inputs and invokes Provider CLIs shelllessly; never accept credentials embedded in URLs or client-supplied commands. Relay intentionally does not remove MCP configuration because Provider discovery does not reliably distinguish user-managed, plugin-owned, and bundled servers.
- Project Settings shows every installed MCP-capable Provider because Provider-global servers still apply to Project Chats. Project-scoped add controls render only when the Provider advertises Project management scope.
- Claude Project discovery merges shared `.mcp.json` configuration with local-scope configuration stored under the Project path in `~/.claude.json`. Reads must return sanitized summaries only: never expose header, argument, or environment values, URL credentials, or query-string secrets.
- Relay does not launch interactive MCP authentication/logout from the server: headless Provider CLI login can block indefinitely. When a server needs authentication, the UI directs the user to the Provider CLI. Live-only reconnect and enable/disable controls do not belong in Global Settings.
- MCP add routes validate the requested transport against `ProviderCapabilities.mcp.management.transports`. Global and Project Settings share the same capability-driven MCP form so their supported fields cannot drift.
- Codex may reference a bearer-token environment variable by name. Relay does not accept or persist token, header, or environment values. Persistent request-timeout and tool-policy settings remain unavailable until the Provider management surfaces expose a safe portable contract.

### Task Tracking

- Tasks stored in `.relay/tasks.json` (Relay-managed snapshot JSON)
- Not every request needs a task. Create a task only when the user asks to create one, pick up a task only when the user asks or the request clearly matches an existing task, and otherwise just do the work without creating a new task. Ask the user if it's unclear whether a request should map to a task.
- Fields: `id` (8-char hex), `title`, `description` (markdown), `status` (open|in_progress|done), `priority` (0-4), `type` (epic|task|bug), `tags` (string[]), `parent` (nullable task ID), `blockedBy` (task ID[]), `createdAt`, `updatedAt` (ISO timestamps)
- `blocked` status auto-derived from unresolved `blockedBy` refs — never set manually
- Create/update/delete: rewrite `.relay/tasks.json` atomically with the new canonical snapshot
- Relay rewrites the canonical snapshot atomically on every write through the API
- Core module: `server/core/task-manager.ts` (pure functions, no server deps)
- API: `GET|POST /api/projects/:id/tasks`, `PATCH|DELETE /api/projects/:id/tasks/:taskId`
- On managed session start, Relay injects an internal message telling the model about the task format

## Common Pitfalls

- **`#` imports**: All imports in `server/` and `cli/` use `#core/` or `#server/` aliases. No relative path navigation (`../`).
- **`.js` extensions**: All `#` imports must use `.js` extensions (ESM + NodeNext resolution).
- **Build before test**: Tests import from `dist/`, not source. A stale build = confusing test failures.
- **`import.meta.dirname`**: `server/http.ts` detects whether it's running from source or `dist/` to compute the project root. Avoid hardcoded `../..` traversals — use the `projectRoot` constant instead.
- **No parameter properties**: Node's native TS type stripping doesn't support `constructor(private x: T)` syntax. Use explicit field declarations + assignment instead. (This is what enables `pnpm dev` to run without tsc.)
