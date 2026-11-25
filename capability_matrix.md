# ACP capability matrix

Last checked: **2026-11-26**

Adapter advertisements come from the real `initialize` and `session/new` handshakes captured in the
parent workspace and the isolated live checks on 2026-11-26. Each installed adapter completed a
minimal model prompt and the lifecycle methods it advertises. Login flows were exercised with
deterministic PTY fixtures; existing account authentication was preserved.

| Agent | Adapter version |
| --- | --- |
| Codex | `@agentclientprotocol/codex-acp` 2.10.0 |
| GitHub Copilot | GitHub Copilot CLI 1.0.109 |
| OpenCode | OpenCode CLI 2.4.1 |
| Claude | `@agentclientprotocol/claude-agent-acp` 0.110.0 |

## Legend

- **Advertised:** ✅ yes · — no · **Ext** adapter extension rather than a current official ACP field · **Base** mandatory ACP baseline · **Hato** client capability advertised by Hato · n/a not capability-negotiated.
- **Implemented:** ✅ end-to-end in Hato · ◐ partial, raw-state handling, or live verification still pending · ❌ missing · — not advertised · **Off** intentionally disabled · **Fallback** Hato uses another behavior.

## Desktop matrix

| Capability | Codex advertised | Codex implemented | Copilot advertised | Copilot implemented | OpenCode advertised | OpenCode implemented | Claude advertised | Claude implemented |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| ACP protocol v1 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Text + resource links | Base | ✅ | Base | ✅ | Base | ✅ | Base | ✅ |
| Image prompts | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Audio prompts | — | — | — | — | — | — | — | — |
| Embedded context | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| MCP stdio | Base | ✅ | Base | ✅ | Base | ✅ | Base | ✅ |
| MCP HTTP | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| MCP SSE | — | — | — | — | ✅ | ✅ | ✅ | ✅ |
| MCP `acp` transport | Ext | ❌ | — | — | — | — | Ext | ❌ |
| New/prompt/cancel/update | Base | ✅ | Base | ✅ | Base | ✅ | Base | ✅ |
| Session load | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Session resume | ✅ | ✅ | — | — | ✅ | ✅ | ✅ | ✅ |
| Session list | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Session fork | Ext | ✅ | — | — | Ext | ✅ | Ext | ✅ |
| Session close | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Session delete | ✅ | ✅ | — | — | ✅ | ✅ | ✅ | ✅ |
| Additional directories | ✅ | ✅ | — | — | ✅ | ✅ | ✅ | ✅ |
| System prompt | ✅ | ✅ | — | — | — | — | ✅ | ✅ |
| Title/options/status extensions | Ext | ❌ | — | — | — | — | Ext | ❌ |
| Model selector | ✅ | ✅ | — | — | ✅ | ✅ | ✅ | ✅ |
| Reasoning/effort selector | ✅ | ✅ | — | — | — | — | ✅ | ✅ |
| Mode selector | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Other config options | ✅ | ✅ | ✅ | ✅ | — | — | ✅ | ✅ |
| Boolean config options | Hato | ✅ | Hato | ✅ | Hato | ✅ | Hato | ✅ |
| Steering | ✅ | ✅ | — | Fallback | ✅ | ✅ | ✅ | ✅ |
| Permission requests | Base | ✅ | Base | ✅ | Base | ✅ | Base | ✅ |
| Terminal authentication | — | — | ✅ | ✅¹ | ✅ | ✅¹ | ✅ | ✅¹ |
| Agent-driven authentication | ✅ | ✅ | — | — | — | — | — | — |
| Logout | ✅ | ❌ | ✅ | ❌ | — | — | ✅ | ❌ |
| Auth status extension | Ext | ❌ | — | — | — | — | Ext | ❌ |
| Slash-command catalog | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Context usage updates | n/a | ✅ | n/a | ✅ | n/a | ✅ | n/a | ✅ |
| Cost updates | n/a | ✅ | n/a | ✅ | n/a | ✅ | n/a | ✅ |
| Form elicitation | Hato | ✅ | Hato | ✅ | Hato | ✅ | Hato | ✅ |
| Compaction updates | Off | Off | Off | Off | Off | Off | Off | Off |
| Session notices | — | ❌ | — | ❌ | — | ❌ | — | ❌ |
| Subagent updates | — | ❌ | — | ❌ | — | ❌ | — | ❌ |
| Plan operations | — | ❌ | — | ❌ | — | ❌ | — | ❌ |
| Client filesystem methods | Off | Off | Off | Off | Off | Off | Off | Off |
| Client terminal methods | Off | Off | Off | Off | Off | Off | Off | Off |
| Claude async tasks | — | — | — | — | — | — | Ext | ◐ |
| OpenCode child-session metadata | — | — | — | — | Ext | ◐ | — | — |

## Implemented negotiation and UI behavior

- **Boolean config:** Hato advertises `session.configOptions.boolean`; boolean setters include
  `type: "boolean"` in desktop and background requests.
- **Cost:** ACP `{ amount, currency }` is preserved and included in the context-meter tooltip.
- **Additional directories:** forwarded only after the agent advertises
  `sessionCapabilities.additionalDirectories`; otherwise Hato returns a clear unsupported error.
- **Session listing:** standard cursor pagination only; the non-standard `limit` request field is not
  sent. The Provider Sessions modal appends opaque cursor pages.
- **Reconnect:** `session/resume` is preferred when advertised, with `session/load` fallback. Copilot
  continues to prefer load. Failed resume can fall back to load before a fresh session is created.
- **Replay:** desktop replay is staged and deduplicated by provider session/message ID, with a
  content-occurrence fallback for older persisted transcripts. Background load replay is suppressed
  against its persisted local history. ACP `messageId` boundaries start new transcript messages.
- **Authentication:** agent-driven methods use ACP `authenticate`. Standard and legacy terminal
  methods use the configured provider invocation in a real interactive PTY. A launch preview shows
  command, args, cwd, and environment names before the user confirms. Unsafe startup/lookup/proxy/TLS
  variables and policy-removed credentials are rejected. Input, cancellation, output, and completion
  are scoped to the attempt. Successful login reconnects and initializes the provider.
  ¹ Negotiation is gated on the native `pty.spawn` host feature; older hosts keep terminal login off.
- **Provider Sessions:** list/load/resume/new/fork/close/delete are exposed through `ai-sessions` and
  rendered where advertised. Hato's local transcript is retained when the provider session changes.
- **System prompt:** trusted Hato progress instructions and background instruction-file/skill context
  use `systemPrompt` append when advertised. Dialogue handoffs and model output remain user content.
- **Slash commands:** `available_commands_update` populates clickable composer suggestions with
  descriptions/input hints. `/command args` is sent as an ordinary `session/prompt`.
- **Form elicitation:** flat-object schemas render defaults, required fields, enums, primitive fields,
  and multi-selects. Accept validates content; decline/cancel are distinct. Unknown property types are
  rejected instead of rendered as invented controls.
- **Compaction:** intentionally not advertised. Hato still retains unsolicited raw updates, but does
  not implement the complete ID-addressed timeline/patch/replay contract.

## Advertised session settings

| Agent | Settings returned by `session/new` |
| --- | --- |
| Codex | 10 models, 6 reasoning levels, fast mode, 4 modes, collaboration mode; also 58 legacy models |
| Copilot | 3 modes and `allow_all`; no model or reasoning list over ACP |
| OpenCode | 169 models and 2 modes; no reasoning option |
| Claude | 5 models, 6 effort levels, fast mode, ultracode, 5 modes |

All four advertise image and embedded-context prompts. None advertises audio. Codex, Claude, and
OpenCode advertise steering; Copilot does not, so Hato keeps its cancel-and-queue fallback.

## Background-agent runtime

`services/agent-runner` intentionally remains narrower than desktop chat:

- Implements core turns, permissions, images, MCP, select/boolean config, structured cost, steering,
  resume-by-default with load fallback, Copilot load preference, systemPrompt append, and replay
  suppression/message-ID persistence.
- Implements Claude's async-task extension only for opted-in workflow sessions.
- Does not clone desktop authentication UI, provider-session browser, slash-command UI, or form
  elicitation. It also does not implement additional directories, compaction, notices, or subagents.

## Verification and deployment

- Root suite: **328/328** tests. Plugin suite: **157/157** tests. Both TypeScript checks pass.
- Native: **53/53** library tests and **2/2** architecture tests. Native argv-PTY and SQLite replay
  integration: **7/7** checks. Localhost relay tests require execution outside the network sandbox.
- Live adapters: Codex 2.10.0, Claude ACP 0.110.0, OpenCode 2.4.1, and Copilot 1.0.109 completed
  initialize/new/minimal prompt/list/load/close. Resume, fork of a non-empty session, and delete
  also passed for all three adapters advertising them. Copilot load passed after closing the
  loaded session; requesting load while already loaded correctly returned invalid-params.
- Three representative module-generated UI trees were rendered with the native renderer and
  inspected offscreen: form controls, provider-session browser, and authentication launch preview.
  These are fixture states, not screenshots of the user's running desktop.
- Replay reconciliation builds its complete index inside persistence and atomically inserts missing
  messages beside known anchors. The chat cache remains paginated. Matching consumes occurrences,
  retains actual submitted prompt correlation, and scopes message/tool identity by provider session
  and role. Failed loads discard their staged replay; persistence failures remain retryable.
- Background system instruction and dialogue state are independent. Changed files and MCP/progress
  instructions refresh; startup, operation locks and pending writes prevent unsafe swaps.
- UI native actions carry origin tokens, long handlers return promptly while tracked work continues,
  loads are latest-request-wins, and stale errors/actions cannot target a newly selected session.
- Session IDs/results/content blocks are validated; close/delete not-found is idempotent. Lifecycle
  timeouts cancel outstanding RPC bookkeeping and quarantine the connection until reconnect.
- All module bundles and the native desktop debug binary are built. Modules were exercised in an
  isolated headless instance. The user's desktop was not restarted or activated; **restart with
  the rebuilt native host is required** for terminal authentication.

Remaining intentionally excluded protocol extensions: logout/auth-status/title options, notices,
subagents, plan operations, complete compaction timeline/patch/replay, and desktop-only UI parity
inside the background runtime. They were not part of this implementation request.

## Source locations

- Desktop ACP client: `Hato-plugins/modules/services/acp/src/index.ts`
- Background ACP client: `Hato-plugins/modules/services/agent-runner/src/index.ts`
- Desktop transcript/session service: `Hato-plugins/modules/services/ai-sessions/src/index.ts`
- Desktop UI: `Hato-plugins/modules/ui/ai/src/index.ts`
- Protocol tests: `Hato-plugins/tests/acp-protocol.test.mjs`
- SDK usage/system-prompt helpers: `sdk/context-usage.ts`, `sdk/acp-protocol.ts`
