# Workstreams

Status (2026-11-15): problem pinned down, shape agreed (sidebar folder + chip, optionally linked to a directory), not started. Provider folder-access spike done.

## Problem

A Workstream is a **memory mechanism** for a long-running effort, read by two parties: agents and the user.

Concrete case (work machine): a 2-month GraphQL performance effort across the frontend app, interleaved with regular ticket work and other efforts. Its memory lives in a user-owned directory outside any repo: `README` (explains the system), `STATUS`, `DECISIONS`, `BACKLOG`, `tickets/` (docs for complex tickets/spikes), `scripts/`, `reports/`, and a skill (`impact-report`) the model uses for progress reports. Nothing in it belongs in the codebase.

What hurts:

1. **Retrieval (user memory).** Pulling up every chat of the effort means scrolling the sidebar; titles don't say "GraphQL". A common move is resuming a weeks-old chat (usually one ticket ≈ one chat) to check logs/data after its work deployed — it should keep its own context.
2. **Orientation (agent memory).** A new chat doesn't know the directory exists or how it works. Sometimes Claude's own auto-memory points it there; otherwise the user explains it again. Codex has no such fallback.

Constraints:

- An effort is **not a Project**: mostly one repo, but some span frontend + backend services, and some work (Dynatrace) has no repo and runs in a related repo's cwd without editing it.
- Effort directories follow one convention: always `README` + `STATUS`, usually `DECISIONS` + `BACKLOG`, plus whatever else.

Not drivers: coordinating concurrent agents, reporting (the directory's skill already does it), tidiness.

## Shape

One concept, two faces — the pattern ChatGPT and Claude use for Projects (a folder of chats with attached knowledge), except the knowledge is a real directory agents can also write to.

- **In the sidebar it is a folder**: a named, collapsible group listing its chats. Solves retrieval.
- **On a chat it is a tag**: a chip in the chat header. In the Inbox layout a member chat is listed in its folder only, not in the inbox lists; the folder opens itself when you land on one of its chats and shows a badge when one needs you. Chats of a done Workstream return to the inbox lists.
- **Optionally linked to a directory**: when set, member chats get its README injected and access to it. Solves orientation. A Workstream with no directory is just a sidebar folder, and that is a valid, useful state.

Other properties: Account-scoped; spans Projects; no git semantics; lifecycle `active | paused | done` (done hides it; the directory is never touched).

**The directory belongs to the user.** Relay reads it, renders it, grants agents access, and never imposes layout, creates files, moves or deletes anything. Agents follow the directory's own README for how to record progress. History is the directory's own git, if any.

## Decisions

| Question              | Decision                                                                                                                                                                                                      |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Name                  | Workstream (with or without a linked directory — one concept, no separate "tags")                                                                                                                             |
| Sidebar               | Folder: collapsible group of its chats                                                                                                                                                                        |
| On a chat             | Chip in the chat header. In the Inbox layout a member chat lives in its folder only (listing it twice read as clutter, decided 2026-11-15); the Projects layout still lists it under its project with a label |
| Membership            | One Workstream per chat in the UI (folder semantics); model many-to-many                                                                                                                                      |
| Membership source     | Manual first; automatic once a directory is linked (directory access, backfill, inheritance)                                                                                                                  |
| Mid-chat join         | Required                                                                                                                                                                                                      |
| Directory             | Optional, user-chosen, outside Relay; Relay displays it, never owns it                                                                                                                                        |
| Directory conventions | The user's; Relay injects README (+ STATUS) and otherwise follows them                                                                                                                                        |
| Agent updates         | Per the directory's README, at milestones or when asked — never every turn                                                                                                                                    |
| Context               | Every member chat of a directory-linked Workstream, by default                                                                                                                                                |
| Account               | One Account per Workstream                                                                                                                                                                                    |
| Editing in Relay      | Read-only for now                                                                                                                                                                                             |

## Phase 1 — Folders and chips (retrieval)

No directory, no agent involvement. Shippable alone; live with it before building more.

- Create a Workstream with just a name (sidebar "+", or "New workstream…" from a chat's menu).
- Chat menu (`chat-actions-menu.tsx`): Add to / Move to / Remove from Workstream. Works on any chat, any time, including done chats.
- **Sidebar section "Workstreams"** (Inbox layout, above the chat list; also the collapsed rail and mobile overlay): one collapsible group per active Workstream with count + aggregate attention/working badge. Expanded: its chats, pinned-first then recency (`compareChatListOrder`), active ones first, a "Done N" disclosure for the rest — old chats must be reachable, that is the point. Collapsed by default; expansion remembered per browser. An expanded folder shows up to 8 active chats, then "Show all" (same pattern as the Inbox caps); the open chat is never hidden by the cap or by a collapsed folder's Done disclosure. The section is **Inbox layout only** (decided 2026-11-15): each layout has one organizing idea. The Projects layout groups by repo, lists a member chat under its project with the Workstream label, and has no folders; the header chip is a plain label there.
- **Chip** on Inbox rows, chat lists and the chat header; deterministic accent colour (pattern of `getAgentAccent`). Clicking it expands/scrolls to its sidebar folder.
- No Workstream entry in the Inbox filter: the folder is that view (built, then removed with the decision above).
- ⌘K: Workstreams as results; a Workstream filter in the dialog.
- Delegated children and asides follow their parent (they have no nav rows anyway).

Data model (idempotent create, no schema bump; don't reuse dormant `space_id`):

- `workstreams(id, account_id, name, folder_path NULL, status, pinned, created_at, updated_at)`
- `workstream_members(workstream_id, instance_id, source, joined_at, removed_at)` — `source`: `manual | started_inside | inherited | folder_access | backfill`; `removed_at` blocks re-auto-linking. One-per-chat enforced in the API, not the schema.

## Phase 2 — Link a directory (orientation)

- Workstream settings: choose a directory. Settings can also **adopt**: scan a parent directory for subdirectories with a README and offer each as a Workstream.
- **Agent context**, at session start or on the next turn after a chat joins: Workstream name + directory path; `README` inlined (it explains the system); `STATUS` inlined when small, else a pointer; size-capped. Instruction: this chat is part of the effort; follow the README's conventions for reading and recording progress; update memory files at milestones or when asked; find related chats with `chat_list` filtered to this Workstream. No sibling roster injected; no pushes into a running turn.
- **Directory access** (spiked 2026-11-03 against real binaries):
  - Claude: start → `additionalDirectories`; mid-session → `query.applyFlagSettings({ permissions: { additionalDirectories: [dir] } })`. Verified: write outside cwd prompted before, went through after, on that and later turns.
  - Codex: `turn/start` `sandboxPolicy: { type: "workspaceWrite", writableRoots: [dir], … }` ("this turn and subsequent turns"). Verified: blocked before, written after, persists. Relay currently sends only `sandbox` mode (`resolveSandboxMode`), so build the full policy from the runtime mode (`full-access` → `dangerFullAccess`). Unverified: `on-request` approvals; resume (re-send every turn).
  - One provider-neutral driver hook (start option + `setAdditionalDirectories`). Fallback MCP tools for sandboxes without access: `workstream_context`, `workstream_read_file`.
- **Automatic membership**:
  - A chat that reads or writes a file under the directory is linked (`folder_access`) — Relay already sees tool file paths per chat.
  - **Backfill** when a directory is linked: scan existing transcripts (search index / transcript text) for the directory path and offer the matches as a reviewable list — day one shows the past months, not an empty folder.
  - Spin-offs, provider switches inherit.
- **Skills in the directory** (to verify): `impact-report` lives there and the model uses it unprompted. Does Claude load skills from an added directory's `.claude/skills/` (and on a mid-session grant)? Codex equivalent? Fallback: name the skills' location in the context block.

## Phase 3 — Workstream home (only if still wanted)

Full page, read-only: `STATUS` rendered as the lead, README/DECISIONS/BACKLOG tabs, directory browser (Markdown rendered, HTML in a sandboxed frame), all chats newest-first with ticket ids where detectable (`LINK_SOURCES`), New chat button. Also mobile Home destinations. Decide after living with phases 1–2: the sidebar folder plus a link to the directory may be enough.

Later, unscheduled: suggestions for untagged chats, "since your last turn" deltas, overlap warnings.

## History

- Spaces (worktree-scoped chat groups) were removed (`plans/remove-spaces.md`): git coupling, and grouping that needs ceremony went unused. Applied here: no git semantics; creating a Workstream is a name; membership becomes automatic once a directory is linked.
- Delegation covers short-lived "several chats on one problem"; a Workstream is the long-lived layer above it. The Space-style tab strip now belongs to delegation families — Workstreams never render as tabs.
- Critique pass (Fable, 2026-11-03): the directory is the effort's memory and already exists; don't invent a journal format or inject rosters. Kept explicit membership because retrieval needs it.

## Open questions

1. Skills: native loading from an added directory, per provider (spike before phase 2).
2. Backfill matching: directory path in transcript text only, or also the Workstream name?
3. Work machine: single Account there? Any sync tool on the projects directory that could fight agent writes?
