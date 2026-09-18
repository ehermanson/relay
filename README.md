# Relay

Relay gives you a browser UI for the coding agents already running on your machine.

Run Relay on your dev machine, open it from your laptop or phone, and keep up with your local agent chats without staying in the terminal the whole time.

- Watch Claude Code and Codex chats in one place
- Pick up terminal-started chats from the web UI
- Organize work by project, chat, and git-backed space
- Start new chats, switch models, and manage runtime settings
- Review tasks, plans, docs, and project stats alongside the chat
- Reach the same Relay server locally, over Tailscale, or through a tunnel

### Chats

<img src="relay.png" alt="Relay chat view" width="800" />

### Spaces

<img src="relay-space.png" alt="Relay spaces view" width="800" />

## What Relay Is

Relay is a control panel for local coding agents.

It does not give you model access by itself. You still need the provider tools installed on your machine. Relay sits on top of them and gives you a cleaner way to see chats, resume work, and manage projects.

Right now, the main supported providers are:

- Claude Code
- Codex CLI

## A Few Terms

- **Project**: a local codebase you add to Relay
- **Chat**: one conversation with an agent
- **Space**: a git-backed work area inside a project, usually tied to a branch

If you do not use spaces, you can still use Relay just fine with regular chats.

## What You Can Do

- Add existing git repos as projects, or create a new project from Relay
- Start a new chat in a project
- See chats that were started in the terminal and take them over from the UI
- Create spaces for branch-based work, with separate chats inside each space
- Complete a space by merging it, or archive it without merging
- Use built-in git actions like branch switch, fetch, pull, push, and space push/PR
- Change provider, model, reasoning level, and runtime mode when the provider supports it
- Attach photos, documents, and videos to chats; videos support inline playback and files up to 100 MB (playback depends on browser codec support). Agents receive videos as local file attachments.
- Respond to approval requests and other agent prompts from the browser
- Follow delegated work: subagents show up as collapsed cards where they were spawned (name, model when known, status, result) and in an Agents sidecar; agent-to-agent reports are never shown as your own messages
- Start review chats for a branch or for the files changed in a chat
- Browse project tasks, plans, installed skills, docs, and usage stats
- Set global defaults and project-specific instructions
- See which MCP servers are available to a chat and manage supported Provider-global or project-scoped MCP configuration
- Update an installed Relay build from the settings screen
- Open Relay on another device with a QR code, Tailscale address, or tunnel

## Quick Start

### Install

```bash
curl -fsSL https://raw.githubusercontent.com/ehermanson/relay/main/install.sh | bash
relay start
```

Then open `http://localhost:7777`.

The install script clones Relay to `~/.relay/app`, builds it, and links the `relay` command into `~/.local/bin`.

To update later, you can either:

- run the install command again, or
- use **Settings -> General -> Relay Updates** in the UI to update and restart in place

### Manual install

```bash
git clone git@github.com:ehermanson/relay.git
cd relay
pnpm install
pnpm build
pnpm start
```

## Login and Remote Access

Relay can run in open mode or with a shared password.

```bash
# Open mode
relay start

# Password-protected
relay start --password "your-secret"
```

You can also set the password with `RELAY_PASSWORD`.

If you want to open Relay from another device, there are three common options:

- `localhost` for the same machine
- Tailscale for private access across your devices
- `--tunnel` to expose the same Relay server through `cloudflared`

If you use a tunnel, set a password.

The UI also has an **Open On Phone** flow in settings. It can show a QR code, give you a better device-friendly URL, and generate a one-time pairing code when password auth is on.

## Everyday Flow

1. Start Relay.
2. Add a project.
3. Start a chat, or open a chat Relay discovered from your terminal.
4. If you want branch-scoped work, create a space.
5. Use the project pages for tasks, plans, skills, docs, and project-level settings.

## How It Works

Relay runs on your machine next to your coding agents.

It can start and manage its own chats, and it can also discover chats that were started outside Relay in a terminal. The browser UI talks to that same local Relay server, whether you open it on the same machine or from another device.

```text
                  your dev machine

  terminal chats         Relay server          browser UI
  claude / codex   <->   manages chats   <->   laptop / phone / tablet
                              |
                              v
                    projects / spaces / git / tasks / plans
```

Relay keeps chat history on disk, uses SQLite as local app state, and loads full chat detail when you open it.

```text
new chat in Relay
  -> Relay starts provider session
  -> provider writes transcript on disk
  -> Relay tracks it and streams updates to the UI

chat started in terminal
  -> Relay discovers it
  -> UI can observe it
  -> you can take it over from the browser if you want
```

## Project Features

Each project can have:

- Chats
- Spaces
- Tasks stored in `.relay/tasks.json`
- Plans collected from chats
- Project instructions
- Default provider and model settings
- README and project-doc visibility in the UI
- Usage stats grouped by provider and model

Relay keeps history on disk and lazily loads the full chat state when you open it, so the sidebar stays fast even with a larger project.

## Provider Features

Relay asks each provider what it supports and shows the right controls from that.

Depending on the provider, you may see support for:

- Model selection
- Reasoning level
- Runtime mode
- Fast mode
- Approval requests
- User-input prompts
- Session resume
- MCP discovery and management (transport and scope vary by provider)

## Requirements

- Node.js 22+
- `pnpm`
- At least one supported provider installed and signed in

Helpful extras:

- Tailscale for private remote access
- `cloudflared` if you want a public tunnel
- `gh` if you want Relay to create pull requests for pushed spaces

## Configuration

Common environment variables:

| Variable         | Default                  | What it does                                                      |
| ---------------- | ------------------------ | ----------------------------------------------------------------- |
| `RELAY_PASSWORD` | unset                    | Turns on login                                                    |
| `RELAY_HOME`     | `~/.relay`               | Relay state directory (`pnpm dev` defaults to `~/.relay-develop`) |
| `PORT`           | `7777`                   | Server port                                                       |
| `WORKING_DIR`    | current directory        | Default working directory                                         |
| `MAX_PROCESSES`  | `15`                     | Max managed chats                                                 |
| `TUNNEL`         | `false`                  | Starts a Cloudflare tunnel                                        |
| `CLAUDE_DIR`     | `~/.claude`              | Claude data directory                                             |
| `CODEX_DIR`      | `~/.codex`               | Codex data directory                                              |
| `DB_PATH`        | `~/.relay/sessions.db`   | Relay SQLite path                                                 |
| `SESSION_FILE`   | `~/.relay/sessions.json` | Auth session file                                                 |

## Development

```bash
pnpm install
pnpm dev
```

Useful commands:

```bash
pnpm build
pnpm build:server
pnpm typecheck
pnpm test
```

`pnpm dev` runs the server from TypeScript source and the app with Vite. It does not auto-restart the server on file changes; press `r` in the dev process when you want a manual restart.

## Limits

- Relay is not a hosted service
- Relay does not replace provider login or setup
- Auth is single-password, not multi-user
- Data stays on the machine running Relay
