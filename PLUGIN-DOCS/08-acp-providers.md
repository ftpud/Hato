# 8. ACP agent providers

[← Settings and state](07-settings-and-state.md) · [Index](README.md) · Next: [Publish →](09-publish.md)

Hato talks to coding agents (Claude, Codex, GitHub Copilot…) over the
**Agent Client Protocol (ACP)**: JSON-RPC over the agent process's stdio. Hato is the ACP
*client*. Each agent ships an ACP *adapter* executable (for example `claude-agent-acp`,
`codex-acp`, `copilot --acp --stdio`).

**Adding a new agent is usually a manifest-only plugin.** No Rust and no ACP code: the shared
`acp` service already handles transport, sessions, MCP, models and permissions.

## Who does what

```text
ui/ai (chat panel)
└── services/ai-sessions        conversations, history, trusted permission prompts, adapter installs
    └── services/acp            ACP client: profiles, process spawn, JSON-RPC, sessions, config
        ├── reads contributes.agentProviders from enabled plugins (sdk/agent-providers.ts)
        ├── spawns the adapter on the workspace machine (local or SSH, login-shell PATH)
        ├── services/internal-mcp   Hato's MCP tools exposed to the agent
        └── <provider module>       OPTIONAL: plan-usage parsing (parseLimits / sessionLimits)
```

| Layer | Owns |
|---|---|
| **Provider plugin** (you) | identity, launch command, adapter package, auth policy, optional quota parsing |
| `acp` | everything protocol-level: `initialize`, `session/new` / `session/load`, `session/prompt`, `session/update` streaming, cancel, config options, modes/models, permission requests |
| `ai-sessions` + `ai` | chats, UI, history, approval dialogs |

## Minimal provider (manifest only)

`services/copilot-provider` is the reference. The whole module is:

```ts
// src/index.ts
import type { AppModule } from '@hato/sdk/types';
export default { id: 'myagent-provider', moduleApiVersion: 1 } satisfies AppModule;
```

```json
{
  "schemaVersion": 2,
  "id": "myagent-provider",
  "name": "MyAgent provider",
  "kind": "service",
  "entry": "src/index.ts",
  "moduleApiVersion": 1,
  "dependencies": [],
  "calls": [],
  "capabilities": [],
  "provides": ["ai.provider"],
  "distribution": "marketplace",
  "contributes": {
    "agentProviders": [
      {
        "id": "myagent",
        "name": "MyAgent",
        "profile": {
          "id": "myagent",
          "name": "MyAgent (ACP)",
          "executable": "myagent",
          "args": ["--acp"]
        },
        "adapter": { "pkg": "@vendor/myagent", "bin": "myagent" }
      }
    ]
  },
  "version": "0.1.0",
  "pluginPackage": "myagent-acp",
  "pluginType": "AI providers",
  "description": "MyAgent over ACP stdio."
}
```

Build, install and enable it ([chapter 4](04-build-install-load.md)). The provider then shows up
in the chat's agent picker and in **Manage agents**.

## `agentProviders[]` reference

Validated by `agentProviders()` in `sdk/agent-providers.ts`. Invalid entries are **silently
skipped**, so double-check types.

| Field | Required | Meaning |
|---|---|---|
| `id` | ✓ | provider id, unique across plugins |
| `name` | ✓ | display name |
| `profile.id` | ✓ | default launch profile id, unique across plugins |
| `profile.name` | ✓ | profile display name |
| `profile.executable` | ✓ | command name (resolved on the workspace machine's login-shell `PATH`) or absolute path |
| `profile.args` | ✓ | string array, e.g. `["--acp", "--stdio"]` |
| `adapter.pkg` | ✓ | npm package for **Manage agents → Install/Update** (`npm install -g <pkg>@latest` on the workspace machine) |
| `adapter.bin` | ✓ | binary that package installs |
| `mcpLaunch` | | for agents that take MCP config **on the command line** instead of via ACP `session/new`: `{ flag, stdioType?, tools? }` (Copilot uses `--additional-mcp-config`). Requires Node on the workspace machine. |
| `auth` | | a toggle in Settings that strips env vars before launch, e.g. to prefer a subscription login over an API key: `{ key, field, label, description, default, envRemove[] }` |
| `usageCommand` | | slash command whose output lists plan limits (Claude `/usage`, Codex `/status`). Needs the parsing methods below. |

## Optional: plan-usage (quota) parsing

If you set `usageCommand`, `acp` calls your provider module:

```ts
methods: {
  // After running usageCommand in a throwaway session: text output + raw updates → LimitsSnapshot
  parseLimits(_ctx, a: { text: string; updates: any[] }) { /* … */ },
  // On each live session update: keep the meter current from _meta, or return null
  sessionLimits(_ctx, a: { update: any; previous: LimitsSnapshot | null }) { /* … */ },
}
```

See `services/claude-provider` and `LimitsSnapshot` in `sdk/usage-limits.ts`.

> ⚠️ For this, the **`acp` module must be allowed to call your module**. That means adding
> your id to `acp`'s manifest `calls` and approving `call:<your-id>` for `acp`. Without that,
> calls fail with `module 'acp' is not allowed to call '<id>'`. Standard ACP token and context
> usage (`usage_update`) needs no provider calls, so leave `usageCommand` out unless you need
> plan limits.

## Runtime behaviour your agent should expect

- **Protocol version 1.** Hato sends `initialize` with `clientCapabilities: { fs: { read/write: false }, terminal: false }`.
  The agent must do its own file I/O and processes.
- **Working directory** = workspace root. Over SSH, the adapter runs **on the remote machine**.
- **MCP:** Hato offers its internal MCP server (and user-selected ones) in `session/new` or
  `session/load` as `mcpServers`. HTTP and SSE servers need the matching `mcpCapabilities`.
- **Resume:** if the agent advertises `loadSession`, Hato resumes with `session/load`.
  Otherwise it starts fresh and sends a bounded dialogue handoff.
- **Permissions:** `session/request_permission` goes to a trusted Hato prompt.
- **Handled updates:** `agent_message_chunk`, `agent_thought_chunk`, `user_message_chunk`,
  `tool_call`, `tool_call_update`, `plan`, `available_commands_update`,
  `current_mode_update`, `config_option_update`, `usage_update`.
- **Auth:** if the agent requires authentication, Hato shows its `authMethods`. The user
  authenticates the adapter on that machine and reconnects.
- **Hato never installs agents automatically.** If the executable is missing, the user gets
  "Use Manage agents to install…".

## Custom profiles without a plugin

For a one-off adapter, users can save a **custom ACP profile** (executable + args + env refs)
through Manage agents (`acp.saveProfile`). Write a provider plugin when you want it
installable, shareable, auto-listed, or need `auth`, `mcpLaunch` or quota parsing.

## `acp` service API (for UI plugins)

Methods on `acp` (call with `ctx.modules.call("acp", …)`, which needs `calls: ["acp"]`):
`profiles`, `saveProfile`, `authSettings`, `setAuthSettings`, `detect`, `start`, `state`,
`prompt`, `steer`, `cancel`, `setConfig`, `stop`, `limits`, `adapters`, `installAdapter`
(only through `ai-sessions`).

Events: `acp.update {conversationId, update}`, `acp.status`, `acp.turnEnded`,
`acp.authChanged`, `acp.adaptersChanged`. Published state: `acp.limits`.

Most UI plugins should use `ai-sessions` rather than `acp` directly. `acp` is the transport.

## Checklist

- [ ] `provides: ["ai.provider"]` and a valid `agentProviders[]` entry (unique `id` / `profile.id`)
- [ ] the adapter speaks ACP v1 over stdio with the given `args`
- [ ] the adapter is installed on the workspace machine (Manage agents → Install, or manually)
- [ ] plugin built, installed and **enabled**
- [ ] only if using `usageCommand`: `parseLimits` / `sessionLimits` + `acp` allowed to call you
