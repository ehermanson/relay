---
version: 2
id: "ad68f3f3-bcd2-4fc3-a976-f208f7bcff5c"
title: "Markdown formatting in the chat composer"
status: "done"
priority: 2
type: "task"
tags:
  - "composer"
  - "ui"
parent: null
blockedBy: []
createdAt: "2026-11-05T12:44:22.746Z"
updatedAt: "2026-11-05T13:41:32.947Z"
closedAt: "2026-11-05T13:41:32.947Z"
---
Live markdown rendering in the Lexical composer (bold, italic, inline code, bullets, numbered lists, block quotes) plus formatting shortcuts and list continuation on Shift+Enter. The composer value stays the literal markdown string, so drafts, outbox, menus and sent prompts are byte-exact: rendering is decoration only. Native textarea gets the shortcuts and continuation but no rendering.
