# Visual workflows

Workflows are graphs of blocks joined by connections, ported from HatoPad/VibeEditor. They are
designed in the **Workflows** panel (right activity sidebar) and run on the workspace machine's
daemon (hatod), including local workspaces, so a run continues when the desktop closes or the SSH
link drops. Definitions use the HatoPad JSON shape; HatoPad definitions import through
**Import workflow JSON** where their block types are supported.

## Runtime tree

```text
workflows-panel (UI: list, runs, designer window/inline canvas)
└── workflows (desktop gateway: daemon install/upgrade, provider + MCP resolution, MCP commands)
    └── local or SSH hatod
        ├── workflow-runner   definitions, durable runs, scripts, Run App processes,
        │                     per-session `hato-workflow` MCP endpoint
        ├── agent-runner      one background agent session per AI Agent / Chatbox block
        └── internal-remote-mcp  workspace tools for Terminal Control / Task controls blocks
```

Shared contract and validation: `sdk/workflows.ts`; templates: `sdk/workflow-templates.ts`.
The designer uses the generic native `canvas` node (`kernel/src/ui/canvas.rs`, `CanvasItem` /
`CanvasEdge` in `sdk/types.ts`): modules supply item boxes, content and edges; native code moves
items, drags new connections from an item's port and paints curves.

## Blocks and connections

See `WORKFLOW_REFERENCE` in `sdk/workflows.ts` (also returned by the `workflows__reference` MCP
command). Connections: **follow** (run the target with the output; converging follows join),
**use** (target is a tool of the source AI Agent/Chatbox via `workflow_use_block`) and **path**
(a named route chosen with `workflow_choose_path`; Yes/No Prompts select `yes`/`no`).

Supported block types: start_button, start_input, ai, chatbox, skill, text, markdown, script,
run_app, timer, user_prompt, yes_no_prompt, meeting, terminal_control, task_controls, mcp.
HatoPad's legacy prompt/task/review/verification blocks are reported as unsupported.

The designer reads advertised model and reasoning options from the selected provider. It reuses
existing session metadata where possible; otherwise it briefly connects a disposable session
without sending a prompt and removes that session afterwards. Provider/model changes clear
incompatible selections. Reasoning is applied after model selection at session startup, and
unsupported values fail explicitly. An older agent runtime is upgraded only when no connected
background agents would be interrupted; the designer reports when an upgrade is still needed.

AI and Chatbox sessions appear in **Background agents** and open in the AI chat ("Open chat"
on a block in a run). Provider permission requests pause the block; **Review permission** uses
the trusted approval UI, or enable Autopilot on the block.

## Self-configuration

- **Ask the configurator** (designer, no selection) starts a background agent with the
  `hato-workflow` configurator endpoint (`workflows_list/read/write/validate/reference`) and opens
  it in the AI chat. Writes are revision-checked; the panel reloads saved changes.
- Desktop chats get `workflows__*` commands (list, read, write, validate, reference, catalog,
  run, run_status) from the `workflows` service. Like every module command they start denied:
  enable them under Settings → **Workflows MCP**.

Connection sparks represent recorded payload boundaries, not block activity. A workflow tool
request pulses toward its target; its result (or error) pulses back on the same connection.
Follow/path handoffs pulse forward once. Multiple calls on one edge play in order; polling may
delay their display. Waiting blocks do not keep connections animating. Terminal Control calls through `workflow_use_block` (actions list/read/write) are logged and
pulse on their connection. Direct external MCP/task tools are not observed by the workflow
runner and do not generate a synthetic pulse. Older runs have no transfer records.

Activity logs are separate cards below block details, collapsed by default. Expand a log to
scroll its entries within a fixed-height area. Expanded workflow cards keep their own scrolling
body so reports, chat history and logs stay inside the panel. Chatboxes show live session
status and recent agent activity, including after a run finishes. Meetings use a consistent
participant color for each author label and message-side bar. They also show their attributed transcript,
including when they are used only as tools and remain idle. Terminal Control logs begin with
new calls routed through the block; older direct workspace-tool calls cannot be reconstructed.

Block deletion is confirmed inside the designer, including when it is in a separate window.
The titleless designer has a toolbar drag handle and its own Close button.

Meeting participants automatically publish attributed status messages when they start activity,
go idle, wait for permission/input, fail or stop. These notices are durable room messages,
available through `diff` and `wait`; status polling is not required. They wake only waiters in
the affected room and do not consume any participant's unread cursor. A participant waiting
in the room receives the notice; idle agents are not automatically prompted by announcements.

Meeting `shake` requires `peer_block_id` and a specific nonempty `message` (up to 10,000
characters). The supplied message is delivered to that participant; there is no generic fallback.

Saving never starts a run. Unsaved designer drafts and their undo/redo history stay scoped to
the workspace and are retained when switching workspaces or hot reloading the panel. They are
in-memory state; save a draft to retain it across an application restart.

## Limits and maintenance

- Runs do not survive a daemon restart; interrupted runs are marked failed and keep their
  outputs and sessions. Chatboxes stay usable after a run finishes.
- The gateway pushes a newer `workflow-runner` (by `WORKFLOW_RUNNER_VERSION`) only while it has
  no active runs or Run App processes.
- New install bounds (`grants/first-party.json`) and the canvas primitive need a desktop rebuild
  and restart. Daemons receive `workflow-runner` with its approved permissions on first use.
