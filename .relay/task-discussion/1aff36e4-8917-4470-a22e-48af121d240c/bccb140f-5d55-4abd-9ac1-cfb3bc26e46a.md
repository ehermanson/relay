---
version: 2
id: "bccb140f-5d55-4abd-9ac1-cfb3bc26e46a"
taskId: "1aff36e4-8917-4470-a22e-48af121d240c"
author: null
replyTo: null
createdAt: "2026-10-29T02:33:04.433Z"
---
Implemented in server/core/orchestration/ + server/routes/mcp.ts. Verified real Codex 0.165 and Claude SDK sessions connect, authenticate with the per-chat token, and list the three tools (no model prompt sent). Not yet exercised: a live model turn calling a tool. Known gap: resumed Codex threads don't get the orchestration developerInstructions (MCP initialize instructions still apply).
