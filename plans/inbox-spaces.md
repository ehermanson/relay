# Inbox and spaces

## Outcome

The inbox mixes standalone chats and named spaces. A named space occupies one row regardless of how many chats it contains. The space view remains the place to switch among those chats.

## Behavior

- Group by resolved space membership, excluding attached review chats. Main/default-space chats remain individual rows. Unknown space metadata must not hide a chat while data loads.
- Include empty named spaces. Active and broken spaces stay in the active inbox even when all their chats are done. Completed/archived spaces appear once in Done, labeled Merged/Archived.
- Sort active destinations by independent pin, then recency (maximum of space activity and member chat recency; creation time supports empty spaces). Done ignores pins. Space pins persist on the server and do not mutate child pins.
- Space rows show project, stable space name, chat count, working count, needs-input count and unread count when present. Use normalized provider-neutral request fields to identify attention; permissions/questions/plans and errors must outrank working status. When an error is present, label the action Needs attention rather than Needs input. A broken space is visibly labeled.
- Clicking a space restores the last visited valid member chat on this browser; otherwise open its most recent eligible chat, or the empty space. Explicit chat links always win. Remember selection on visits from tabs, search, and deep links without starting a stopped managed session.
- Attention is a separate accessible action: one chat opens directly; multiple chats open a compact chooser with names and status. No automatic navigation when new activity arrives. Unread remains per-chat; opening a space never clears siblings.
- Keep one mixed list, no expanded child tree. Keep selection at the space level while switching its chats. The expanded sidebar, mobile drawer, and collapsed rail use the same grouping. Caps retain the current destination, including empty/closed spaces.
- Space actions: independent Pin/Unpin, Rename, Complete, Mark as merged, Archive, subject to existing lifecycle constraints and confirmation dialogs. No Mark done or chat deletion actions on a space row. The stale-chat sweep only touches standalone chats.
- Search continues to expose individual chats and opens them within their space. Projects layout and project overview retain existing behavior.

## Implementation

- `app/src/lib/inbox.ts`: discriminated `InboxEntry` union. Common `id` (namespaced), `dir`, `projectName`, `projectId`, `iconPath`, `done`, `pinned`, `recencyAt`; chat entry `kind: "chat"`, `instance`, optional `space`; space entry `kind: "space"`, `space`, `instances`, `workingCount`, `attentionInstances`. Export `isInboxEntryCurrent(entry, chatId?, spaceId?)` and `capInboxEntries(entries, limit, chatId?, spaceId?, extraEntries?)`. Stale selector returns chat entries only.
- `inbox-space-item.tsx`: shared space row and compact rail variant via `compact?: boolean`, using existing menus, dialogs, unread store and sidebar actions. Props `entry: InboxSpaceEntry`, `isActive: boolean`. Shared routing calls `getInboxSpaceRoute(entry)` from `app/src/lib/space-navigation.ts`.
- `space-navigation.ts`: safe browser-local remembered chat selection, pure valid-member fallback helper, and route builder. Space view records actual selection; index route respects stored selection.
- Add optional `SpaceInfo.pinned`, persistent DB field, API client/server mutation, and `SidebarActions.pinSpace`.
- Integrate union into inbox sidebar, rail, done-transition helpers and tests. Never fabricate an InstanceInfo to represent a space.

## Validation

Regression coverage: grouping/default/unresolved membership, empty/broken/closed spaces, child-done independence, pin/recency order, attention across providers, stale sweep exclusion, current destination retention, remembered/deleted/review chat fallback, unread sibling preservation, single/multiple attention targets. Run build, typecheck, lint, and tests; inspect rendered UI where available. Update AGENTS.md/README for changed navigation.

## Delivered and verified

Implemented the grouped inbox, shared expanded/compact space row, independent space pin persistence, attention chooser (including errors), and remembered chat selection. Updated AGENTS.md and README.md.

Final verification: `NODE_OPTIONS=--no-experimental-webstorage pnpm ci-check` passed (build, typecheck, lint, 959 server tests and 199 app tests). The environment flag avoids a local Node webstorage/jsdom conflict; it changes no product behavior. Browser smoke checks verified real-data grouping, opening a space, remembering a different tab, collapsed-rail grouping and its space action menu. Server mutation behavior and attention keyboard navigation were verified by automated tests. No running Relay server was restarted.
