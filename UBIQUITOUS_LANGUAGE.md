# Ubiquitous Language

## Workspace structure

| Term         | Definition                                                                    | Aliases to avoid           |
| ------------ | ----------------------------------------------------------------------------- | -------------------------- |
| **Project**  | A local codebase Relay tracks as the top-level workspace for collaboration.   | Repo, directory, workspace |
| **Checkout** | A working tree of a **Project**: its main directory or a linked **Worktree**. | Copy, clone                |
| **Worktree** | A linked git checkout of a **Project**, outside its main directory.           | Project copy, lane         |
| **Branch**   | A git line of development checked out in a **Checkout**.                      | Workspace, lane            |

## Conversations and execution

| Term                 | Definition                                                                                 | Aliases to avoid               |
| -------------------- | ------------------------------------------------------------------------------------------ | ------------------------------ |
| **Chat**             | A single conversational thread between a user and an agent inside a **Project**.           | Session, tab, thread           |
| **Managed session**  | An agent runtime Relay started and can restore or control directly.                        | Chat, process                  |
| **External session** | An agent runtime Relay discovered but did not start itself.                                | Imported chat, foreign process |
| **Transcript**       | The canonical message history for a **Chat** stored as JSONL on disk.                      | Log, history cache             |
| **Provider**         | An agent platform Relay integrates with, such as Claude or Codex.                          | Backend, driver, model         |
| **Model**            | A provider-specific agent variant selected for a **Chat**.                                 | Provider, engine               |
| **Model options**    | Provider-agnostic tuning choices attached to a **Managed session**.                        | Flags, provider args           |
| **MCP server**       | A Provider-reported Model Context Protocol integration that exposes tools to a **Chat**.   | Plugin, app                    |
| **MCP availability** | Whether the active **Provider** reports an MCP server as loaded for a particular **Chat**. | Configured, installed          |
| **Delegated task**   | Work one **Chat** hands to a child **Chat** through Relay orchestration.                   | Subagent, space                |
| **Read-only chat**   | A **Chat** whose recorded working directory no longer exists; readable, never resumed.     | Archived chat, closed chat     |

## Planning and tasking

| Term                    | Definition                                                                                                    | Aliases to avoid               |
| ----------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| **Task**                | A tracked unit of work with **Project**-wide identity and state in each **Checkout**’s `.relay/tasks/` files. | Ticket, todo, issue            |
| **Archived task**       | A done or cancelled **Task** moved into `.relay/tasks/archive/`.                                              | Deleted task                   |
| **Plan review**         | A structured interaction where the agent proposes a plan for approval or revision.                            | Plain assistant message, notes |
| **Pending plan**        | A plan proposal awaiting user review before execution proceeds.                                               | Draft response, paused chat    |
| **Custom instructions** | Project-specific guidance injected into new managed chats as bootstrap context.                               | First prompt, system message   |

## Relationships

- A **Project** has one main **Checkout** and zero or more **Worktrees**
- A **Chat** belongs to exactly one **Project** and runs in one **Checkout**
- A **Chat** may be backed by zero or one **Managed session**
- A **Managed session** belongs to exactly one **Provider** and uses exactly one **Model**
- An **MCP server** may be configured at Provider level without being available to every **Chat**
- A **Transcript** belongs to exactly one **Chat**
- A **Project** can contain zero or more **Tasks**
- A **Delegated task** runs in a child **Chat** that shares its parent's **Checkout**

## Flagged ambiguities

- `session` was used for both the user-facing conversation and the agent runtime; use **Chat** for the conversation and **Managed session** or **External session** for the runtime.
- `worktree` and `branch` are related but distinct; use **Worktree** for the filesystem checkout and **Branch** for its git ref.
- "Space" was a removed feature (branch-scoped groups of chats); don't use it for **Projects**, **Worktrees**, or groups of **Delegated tasks**.
- `provider` and `model` can blur together; use **Provider** for the integrated platform and **Model** for the selected variant within that platform.
- `transcript` and database records are not the same thing; use **Transcript** only for the canonical JSONL message history, not for cached metadata.
