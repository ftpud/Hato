# Background agents and workspace MCP

Background agents are separate from the existing chatbox. Open **Background agents** from the
right activity sidebar (or show the panel through Layout). Select a workspace and choose New
agent. The panel is a searchable Projects-style tree with provider details, status badges and
activity indicators. Pick a provider, instruction file, skills and MCP servers when creating an
agent. Creating or selecting an agent opens the existing AI chatbox bound to that exact session,
revealing the AI panel if necessary. Use its model picker, transcript, history and composer to
prompt or steer the agent. Chats returns to the regular conversation without stopping the worker.

Providers use the existing ACP profile configuration, but the new runtime does not call the
existing chat ACP controller or store conversations in the chat tables. The adapter must already
be installed and authenticated on the workspace machine. Hato does not install or authenticate
providers implicitly. Model selection becomes available after the provider handshake.

## Runtime tree

```text
agents-panel (desktop UI)
└── persistent-agents (desktop gateway)
    └── local or SSH hatod
        ├── agent-runner
        │   ├── ACP provider processes + protocol controllers
        │   ├── agent-runner SQLite namespace: sessions, messages, queued steering, permissions
        │   └── selected MCP configurations
        └── internal-remote-mcp
            ├── workspace-bound session token
            ├── background agent controls
            ├── terminal read/write controls
            └── selected skills
```

The controller, provider process, transcript writes and MCP endpoint live on the workspace
machine's daemon. Closing the panel, switching workspaces, disconnecting SSH or exiting the
desktop does not stop an accepted turn. The panel refreshes its projection while visible; this
is not the engine driving the agent. A hidden panel does not start a local daemon merely because
a workspace is selected.

Stop agent explicitly terminates that session. A daemon shutdown/crash is different from desktop
disconnection: history remains, active turns become interrupted, and reconnect uses ACP
`session/load` only when the provider supports it. An interrupted turn is never replayed silently.
If the provider cannot reload, create a new agent rather than silently discarding context.

Steering queues a follow-up and cancels the current ACP turn, then sends the queued prompt after
cancellation completes. Queued text is stored on the daemon. Provider tool permission requests
wait while the desktop is absent; Review permission opens the kernel's trusted approval UI.
Workspace MCP does not provide an approval-bypass tool.

## The two MCP surfaces

| Surface | Host and purpose | Desktop absent |
|---|---|---|
| `internal-local-mcp` | Desktop application/module tools through the compatible existing transport | Unavailable |
| `internal-remote-mcp` | Workspace-side agent and terminal tools; normally hosted by hatod | Available with daemon-backed resources |
| `internal-remote-mcp` in standalone local mode | Same workspace tool surface, hosted in the desktop; controls ordinary local terminal handles | Unavailable |

The existing `internal-mcp` plugin remains compatible with the old chatbox. The new local facade
filters out the terminal namespace, putting terminal control on the workspace-side surface.

In the new agent form, Workspace tools enables the daemon-hosted endpoint. Local workspaces
also offer **Workspace tools · local desktop terminals (online only)**, connecting the same server
implementation hosted in the desktop to local PTYs that are not daemon-backed. This does not
make those PTYs survive desktop exit. Desktop tools is a separate optional selection.

To obtain a standalone local endpoint programmatically, use
`persistent-agents.workspaceEndpoint {workspaceId, sessionId, skills}`. The server resolves the
workspace on the desktop and delegates terminal operations to the terminal service's existing
scoped control handlers. Listing/controlling background agents routes through the gateway.

## Workspace tools

- `agents_list`, `agents_history`: workspace-bounded session list and paged history.
- `agents_create`: child worker inheriting the calling agent's provider, workspace, instructions,
  MCP and skill configuration; it cannot widen its permissions through this tool.
- `agents_prompt`: prompt or steer another agent in the same workspace.
- `agents_cancel`, `agents_stop`: cancel a turn or stop an agent.
- `terminals_list`, `terminals_read`, `terminals_write`: discover and control terminals for the
  workspace. Terminal input can execute commands. Daemon terminals are filtered by canonical
  workspace root; standalone mode uses the desktop terminal service's workspace checks.
- `skills_list`, `skills_read`: only the skills selected for that session.

Each loopback connection authenticates with a session token. MCP requests cannot invoke arbitrary
plugin methods. Unknown/out-of-scope agents and terminals, unselected skills and revoked endpoints
are rejected. Public session projections omit provider environment values and MCP credentials.
The stdio proxy runs with Node on the agent's machine; there is no reverse tunnel for daemon-side
workspace tools. Keep Node available in that machine's login PATH.

MCP servers are managed in the separate **MCP servers** panel (plug icon on the right sidebar,
or MCP servers in the agent list). It lists built-in endpoints and lets you add, edit, enable/disable
and remove custom configurations using a command, JSON argument array and optional environment
object. Saved configurations remain available without selecting a workspace; enabled custom
servers appear in the new-agent selection form. Built-in endpoints are informational. Changes
apply to new agents, preserving existing session connections. They execute on the agent's machine. Selected instructions are read from `AGENTS.md`,
`.agents/agents/*.md` or `.claude/agents/*.md`; skills are discovered under `.agents/skills/`.
Only selected files are injected as session context and exposed by the skills tool. This selection
is not an OS sandbox for provider-native tools: those keep their provider permission controls.

## Development and maintenance

Services: `modules/services/{agent-runner,persistent-agents,internal-local-mcp,internal-remote-mcp}`.
Panel: `modules/ui/agents-panel`. Shared contracts: `sdk/persistent-agents.ts`.
The only added native resource operations are generic daemon `pty.read` and `pty.write`; brokered
calls preserve resource-key ownership. Application scoping and workflows stay in TypeScript.

Do not push-replace a running agent runtime to upgrade it: the daemon's plugin replacement path
unloads native resources. The gateway leaves an active installed runtime in place. Stop sessions
before runtime maintenance. New install bounds, and native terminal operations, require rebuilding
and restarting the desktop/older daemons. Do not force-restart a daemon holding user resources.

Verification uses a deterministic ACP fixture, not a paid live provider session:

```sh
npm test
npm run modules:build
cargo check --no-default-features
cargo test
# See driver headers/env reads for fixture paths and isolated daemon/data directories:
tests/integration/run-integration.sh tests/integration/persistent-agents.js /tmp/agents-check
# Run phase 1 then phase 2 against the same data and daemon directories to test desktop exit.
tests/integration/run-integration.sh tests/integration/workspace-mcp.js /tmp/workspace-mcp-check
```

Use `HATO_DAEMON_DIR` to isolate local daemon tests, and `HATO_REMOTE_DAEMON_DIR` plus the SSH
fixture variables in `docs/TESTING.md` for SSH. Driver setup must supply `HATO_T_AGENTS_ROOT`,
`HATO_T_AGENT_FIXTURE`, `HATO_T_NODE`, and (for MCP) `HATO_T_MCP_CLIENT`. Phase 1 starts the
background turn; phase 2 verifies completion after the first desktop process exits.

The list publishes `agents-panel.openChat`; the AI module binds the selected daemon session to
its existing renderer. A narrow `ai.persistentRequest` / `persistent-agents.chatResponse` adapter
routes background actions without changing compiled call grants. `ai.chatOpened` reveals the
chat panel through the layout module. Regular conversations retain their existing backend.
