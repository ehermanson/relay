---
version: 2
id: "02afba7c-494e-4b02-a62a-8fecdccba39d"
title: "Honor CLAUDE_CONFIG_DIR: one config dir for discovery and every Claude spawn"
status: "done"
priority: 1
type: "bug"
tags:
  - "claude"
  - "providers"
parent: null
blockedBy: []
createdAt: "2026-09-25T14:17:59.248Z"
updatedAt: "2026-09-25T14:21:06.951Z"
closedAt: "2026-09-25T14:21:06.951Z"
---
On a machine with two Claude accounts (two config dirs switched via CLAUDE_CONFIG_DIR), Relay paired external terminal sessions using providerDirs.claude (CLAUDE_DIR ?? ~/.claude) but spawned new chats with the server's inherited env, so the transcript root and the CLI's config dir could disagree — terminal chats showed from one account while new chats ran under the other. Fix: resolve the Claude config dir once (CLAUDE_DIR > CLAUDE_CONFIG_DIR > ~/.claude) for providerDirs.claude, and pin CLAUDE_CONFIG_DIR to that dir on every Claude CLI spawn (SDK sessions, prewarm/model probes, legacy process, claude mcp add). Also derive .claude.json and user skills from the same dir. Document in README/CLAUDE.md.
