# Module-contributed internal MCP commands

Modules can publish commands to Hato's existing internal MCP server. No additional
server or wildcard module-RPC permission is needed. Registration, discovery,
routing and user policy live in TypeScript. Provider handlers retain their normal
kernel-enforced capabilities and resource ownership checks.

## Register a provider

```ts
import { exportMcpTools } from "../../../../sdk/mcp";

let mcp;
export default {
  id: "example", moduleApiVersion: 1,
  activate(ctx) {
    mcp = exportMcpTools(ctx, "Example", [{
      name: "status",
      title: "Read example status",
      description: "Return status in the current conversation's workspace.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true },
      async handler(args, scope) {
        // Validate args in your handler. Scope is supplied by the authenticated
        // MCP session, independently of agent-provided arguments.
        return { workspaceId: scope.workspaceId, status: "ready" };
      },
    }]);
  },
  canSwap: async () => ({ ok: mcp.pending() === 0 }),
};
```

A definition includes `name`, `description`, `inputSchema`, an optional `title`,
MCP `annotations`, optional `timeoutMs`, and a `handler`. Command names must begin
with a letter and contain only letters, digits and underscores (up to 64
characters). The server advertises them as `<module-id>__<command-name>`.
Handlers receive `{ workspaceId, conversationId, machineId }` from the authenticated
session. Do not accept an agent argument as a replacement for this scope. Validate
arguments and resolve targets within it. Input schemas describe the interface;
provider handlers remain responsible for domain validation.

Commands are published at `<module-id>.mcp`. The broker discovers active modules,
watches their contributions, and announces MCP tool-list changes. Requests and
responses use kernel-enforced event namespaces and generation IDs, so a provider
does not need broad RPC grants and an activating replacement cannot execute the
old generation's requests. Include `mcp.pending()` in a module's swap guard along
with any other long-running work. Changes to command definitions can be hot loaded.

## User permissions

Settings shows one category per provider, e.g. **Terminal MCP**, containing an
allow/deny toggle per command. New provider commands start denied. Permissions
are stored centrally by `internal-mcp`, keyed by both provider and local command
name, and restored on restart. Denied commands are omitted from `tools/list` and
rejected by `tools/call`, including calls using a previously cached tool name.

Existing module-maintenance tools retain their previous allowed defaults and
native approval requirements. They have individual toggles under **Module tools
MCP**. Revoking permission stops new calls; it does not kill an already running
terminal command. A failed preference save keeps the last confirmed policy.

## Terminal provider

All four commands are contributed by the `terminals` service and apply only to
the authenticated workspace and machine. They target existing terminal tabs;
`list_tabs` returns their stable `key` values and block IDs.

| Command | Arguments | Behavior |
| --- | --- | --- |
| `terminals__list_tabs` | none | List tabs, blocks, active state, launch cwd, machine and shell status. |
| `terminals__tail` | optional `tab`, `lines` (1–500), `cursor` | Read recent output or output after a byte cursor, removing ANSI controls. Defaults to 80 lines, bounded to 64 KiB per read. Reports truncation. |
| `terminals__send` | `text`, optional `tab`, `enter` | Send terminal input; `enter: true` submits a line. Supports Ctrl+C (U+0003) for interrupt. |
| `terminals__run_and_wait_for_answer` | `command`, optional `tab`, `timeoutMs` (100–120000) | Run through `sh`, wait for completion, return output, exit code and cursor. Defaults to 30 seconds. |

When `tab` is omitted, the first active tab is used. Run-and-wait is intended for a
shell prompt, not a foreground editor or other interactive program. It starts a
child shell inheriting the terminal's current directory and environment. Changes
such as `cd` within the command stay in that child; use `send` for interactive
shell state changes. A timeout leaves the command running and keeps the tab
reserved until completion or explicit interrupt. Other blocks remain independent.

The native `ctx.host.pty.read(handle, { cursor?, limitBytes? })` primitive supplies
bounded raw output to the owning module. Its 512 KiB in-memory journal survives
module swaps with the PTY, but not application restarts. Each read is limited to
64 KiB and reports if earlier output was discarded. Terminal command parsing,
completion markers, target selection and policies stay outside Rust.

The initial installation requires rebuilding the native binary and restarting:
the broker needs module-discovery and persistence grants, and PTY output reading
adds a native primitive. Afterwards provider and policy changes can hot reload.
