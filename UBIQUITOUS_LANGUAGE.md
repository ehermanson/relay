# Ubiquitous Language

## Workspace structure

| Term             | Definition                                                                         | Aliases to avoid              |
| ---------------- | ---------------------------------------------------------------------------------- | ----------------------------- |
| **Project**      | A local codebase Relay tracks as the top-level workspace for collaboration.        | Repo, directory, workspace    |
| **Space**        | A branch-scoped collaboration area inside a **Project** that groups related chats. | Worktree, lane, branch        |
| **Main space**   | The implicit default **Space** for a **Project** on its default branch.            | Default workspace, root space |
| **Closed space** | A **Space** that is no longer active because it was completed or archived.         | Deleted space, old branch     |
| **Worktree**     | A git checkout backing a non-default **Space**.                                    | Space, project copy           |
| **Branch**       | A git line of development associated with a **Space** or **Project**.              | Workspace, lane               |

## Conversations and execution

| Term                 | Definition                                                                                    | Aliases to avoid               |
| -------------------- | --------------------------------------------------------------------------------------------- | ------------------------------ |
| **Chat**             | A single conversational thread between a user and an agent inside a **Space** or **Project**. | Session, tab, thread           |
| **Managed session**  | An agent runtime Relay started and can restore or control directly.                           | Chat, process                  |
| **External session** | An agent runtime Relay discovered but did not start itself.                                   | Imported chat, foreign process |
| **Transcript**       | The canonical message history for a **Chat** stored as JSONL on disk.                         | Log, history cache             |
| **Provider**         | An agent platform Relay integrates with, such as Claude or Codex.                             | Backend, driver, model         |
| **Model**            | A provider-specific agent variant selected for a **Chat**.                                    | Provider, engine               |
| **Model options**    | Provider-agnostic tuning choices attached to a **Managed session**.                           | Flags, provider args           |
| **MCP server**       | A Provider-reported Model Context Protocol integration that exposes tools to a **Chat**.      | Plugin, app                    |
| **MCP availability** | Whether the active **Provider** reports an MCP server as loaded for a particular **Chat**.    | Configured, installed          |

## Planning and tasking

| Term                    | Definition                                                                                                 | Aliases to avoid               |
| ----------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------ |
| **Task**                | A tracked unit of work with **Project**-wide identity and state in each **Space**’s `.relay/tasks/` files. | Ticket, todo, issue            |
| **Plan review**         | A structured interaction where the agent proposes a plan for approval or revision.                         | Plain assistant message, notes |
| **Pending plan**        | A plan proposal awaiting user review before execution proceeds.                                            | Draft response, paused chat    |
| **Custom instructions** | Project-specific guidance injected into new managed chats as bootstrap context.                            | First prompt, system message   |

## Space lifecycle

| Term                 | Definition                                                                        | Aliases to avoid               |
| -------------------- | --------------------------------------------------------------------------------- | ------------------------------ |
| **Active space**     | A **Space** that can still receive new chats and work.                            | Open branch, live worktree     |
| **Complete a space** | Finalize an **Active space** by merging it into the target branch and closing it. | Delete, close, finish branch   |
| **Completed space**  | A **Closed space** whose branch changes were merged.                              | Archived space, deleted space  |
| **Archive a space**  | Close a **Space** without merging its changes.                                    | Delete, complete               |
| **Archived space**   | A **Closed space** kept for history without a merge.                              | Deleted space, completed space |
| **Push a space**     | Publish a space branch to its remote and optionally create a pull request.        | Sync, ship                     |
| **Pull request**     | A remote code review request created from a pushed **Space** branch.              | Merge, branch                  |

## Relationships

- A **Project** contains one **Main space** and zero or more additional **Spaces**
- An **Active space** belongs to exactly one **Project**
- A non-default **Space** is backed by exactly one **Worktree**
- A **Space** contains one or more **Chats**
- A **Chat** may be backed by zero or one **Managed session**
- A **Managed session** belongs to exactly one **Provider** and uses exactly one **Model**
- An **MCP server** may be configured at Provider level without being available to every **Chat**
- A **Transcript** belongs to exactly one **Chat**
- A **Project** can contain zero or more **Tasks**
- Completing a **Space** produces one merged branch outcome; archiving a **Space** produces none

## Flagged ambiguities

- `session` was used for both the user-facing conversation and the agent runtime; use **Chat** for the conversation and **Managed session** or **External session** for the runtime.
- `space`, `worktree`, and `branch` are related but distinct; use **Space** for the collaboration unit, **Worktree** for its filesystem checkout, and **Branch** for its git ref.
- `complete`, `archive`, and `delete` were at risk of collapsing into one action; use **complete** only for merge-and-close, **archive** only for close-without-merge, and avoid `delete` in product language.
- `provider` and `model` can blur together; use **Provider** for the integrated platform and **Model** for the selected variant within that platform.
- `transcript` and database records are not the same thing; use **Transcript** only for the canonical JSONL message history, not for cached metadata.
