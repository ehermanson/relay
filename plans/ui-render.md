# ui_render: native UI views from agents

An agent describes a view as a JSON tree, and Relay renders it with its own React components directly in the chat (no iframe). Complements `html_render`, which stays the freeform escape hatch for charts, diagrams and custom visuals.

## Decisions

- Views belong to the chat that created them. Other chats, delegated children included, can't update them (v1).
- An updated view keeps only its current state. No history of earlier states.
- A click on an action is the user's own message, so it may revive a done chat (unlike agent wakes and `chat_send`).
- One answer per view: a view holds at most one `actions` or `choice`. A second question is a second view.
- An agent update clears the view's answer.

## Tool contract

```jsonc
ui_render({
  id?: "deploy-status",   // reusing an id replaces that view in place
  title: "Release checklist",
  root: { type: "stack", children: [ … ] }
})
```

Returns `{ shown: true, id, updated, next }`. An `id` that doesn't exist yet in the chat creates the view; one that exists replaces its spec.

## Node types

| Group           | Nodes                                                                   | Built from                  |
| --------------- | ----------------------------------------------------------------------- | --------------------------- |
| Layout          | `stack` (direction, gap), `section` (title, collapsible)                | flex                        |
| Content         | `text` (markdown)                                                       | `MarkdownContent`           |
| Data            | `metrics`, `table` (sortable, `maxRows`), `list` (status, detail, link) | `AgentStatusBadge` tones    |
| Code            | `code` (lang, filename), `diff` (path, patch)                           | highlighter, diff viewer    |
| Navigation      | `tabs`                                                                  | ui tabs                     |
| References      | `chat-link`, `file`                                                     | `ChatLinkChip`, `/api/file` |
| Input (phase 2) | `actions`, `choice` (single or multi + submit)                          | Button                      |

Cells and list items take a string or `{ text, tone?, href? }`. `tone`: `neutral | success | warning | error | info | accent`.

## Actions (phase 2)

- A click sends the action's `reply` text as an ordinary human message into the chat. It queues when the chat is busy, and may revive a done chat.
- The `reply` text is shown before clicking ("Sends: …"), so a label can't hide what is sent.
- One answer per view. The answer is stored on the view itself (`response: { actionId, values?, reply, at }` in its session event); the view then shows the chosen option and disables the rest, on every device and after reload.
- Actions never call tools or reach other chats. Provider questions and plan review keep their own flow.

## Storage and replay

- The spec lives in a `ui_render` system event payload in `session_events` (256 KB cap). No files.
- Same delivery path as `html_render`, so Codex code-mode calls work and replay matches live.
- An update with the same `id` rewrites that view's session event in place (it keeps its timestamp, so it never moves); live, the reducer replaces the existing card.
- `chat_read` returns a text summary of each view (title, metrics, table as text, list items).

## Validation

- `server/core/ui-render.ts`, fs-free, shared as `@shared/ui-render`. One strict validator for publish and client replay (malformed views are dropped on replay).
- Errors name the exact path, e.g. `root.children[2].rows[4].state: expected string or {text, tone}`, and return as `invalid_request`.
- Limits: depth 8, 500 nodes, 200 table rows, 20 KB per text block, 256 KB per spec.
- No raw HTML. Links are http(s) or `relay://chat` only, through `transformUrl`.
- Specs carry a `version`. Unknown node types render as an "Unsupported block" placeholder.

## UI

- `UiRenderCard` with a `type → component` registry; each renderer composes existing primitives.
- Mobile: tables and tabs scroll horizontally, metrics wrap, type ladder and 40px touch targets apply.
- Every node type gets a `/sandbox` scene before it's exposed to agents.

## Agent guidance

- Markdown: prose and small tables.
- `ui_render`: structured status, comparisons, checklists, choices; anything that updates.
- `html_render`: charts, diagrams, custom visuals.

Compact schema catalogue in the tool description; move to `relay_capabilities` if it grows too long.

## Phases

1. Read-only nodes and update in place.
2. `actions` and `choice`, with recorded responses.
3. Simple charts (bar, line, sparkline on `--chart-*`), maybe form inputs.
