---
version: 2
id: "54b94f5a-ebba-4301-b9ab-2eed35ca8dfe"
title: "Codex 0.171.0: clock requests removed from app-server protocol — check connection handling"
status: "open"
priority: 1
type: "task"
tags:
  - "provider-watch"
  - "codex"
  - "bucket-0"
parent: null
blockedBy: []
createdAt: "2026-11-23T14:19:17.683Z"
updatedAt: "2026-11-23T14:19:17.683Z"
closedAt: null
---
Codex 0.171.0 removed client clock request/response rounds from the app-server protocol and made clock reads synchronous, noting this 'may be breaking for clients that relied on the requests.' Relay connects to Codex via the app-server (acp-connection.ts / codex-app-server.ts) and relies on its JSON-RPC notification protocol. If Relay was implicitly relying on clock exchange rounds (e.g. for session initialization timing, timeout management, or protocol handshake), removing them could cause hangs, timeouts, or unexpected behavior in connection setup. Scope: review acp-connection.ts and codex-app-server.ts for any clock-request handling; confirm connection lifecycle is unaffected. Source key: codex/0.171.0/app-server-clock-requests-removed. Release: https://github.com/openai/codex/releases/tag/v0.171.0
