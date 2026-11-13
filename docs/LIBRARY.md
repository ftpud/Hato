# Library and conversation continuity

The `library` service stores global and per-project skills and agent instruction templates in
its own `library` database namespace under Hato's application data, outside project checkouts.
A project's tasks resolve to the same project collection. Collections belong to the desktop;
they are not automatically copied to SSH hosts or injected into agent prompts.

Install the optional Library package from Settings → Plugins, then open Library from its book button in the left activity bar. Create a Skill (`SKILL.md`) or
Agent (`AGENT.md`), then add relative `.md` and `.sh` paths. Folders are collapsible. Selecting a
file opens it as an Editor tab (`virtual:library-panel/<scope>/<id>/<path>`), with the Editor's
Markdown preview/source toggle, autosave settings and relative links between pages. Saves are
rejected as "Changed elsewhere" when the stored copy changed since it was opened; Overwrite or
Reload resolve it. Right-click entries and files for Add file, Details, Remove and Delete file.
Shell scripts are stored as text and never auto-executed.

Editor tabs for non-workspace documents use the generic protocol in `sdk/virtual-documents.ts`:
the viewer owns tabs and buffers, the providing module owns content and persistence. Save
events carry only a request id; the provider fetches the text with `viewer.virtual.take`, which
answers only the module named in the tab.

The Library contributes `library__list`, `library__read`, `library__write`, and `library__remove`
through Hato's module MCP registry. Enable these commands in Settings and connect Hato MCP
(desktop chats) or Desktop tools (persistent agents). The desktop must be online. Tool names
may receive the MCP client's own namespace prefix. List returns paginated metadata; Read without a path lists file paths.
Read retrieves one file. Write requires `expectedRevision: null` to create, or the last read
revision to edit. Remove requires that revision too. Project scope always comes from the
authenticated connection, so tool arguments cannot choose another project's collection.

Files are limited to 128 KiB of text, entries to 200 files / 1 MiB. Entry root pages cannot
be deleted independently. Updates are serialized and checked against revisions.

## Provider changes

Changing a provider preserves the visible conversation and begins a fresh provider session.
The next prompt includes a one-time excerpt of up to 12 recent original user/assistant messages
with an aggregate text budget of 14,000 characters. Each message is capped at 4,000 characters.
Thoughts, tool output, image data and generated handoffs are excluded. This is a bounded textual
handoff, not a transfer of the provider's private model state. Ordinary turns send only new input.
An expired provider session uses the same recovery path.

For more history, desktop chats expose the conversation-bound `ai-sessions__history` command;
persistent agents expose `agents_history`. Pages are limited to 20 messages / 16,000 text
characters, with a 4,000-character cap per message. History tools need the corresponding MCP
server selected. Persistent-agent history includes tool summaries only with `includeTools`.
Provider session replays do not append duplicate cached transcript messages.

## Context audit

- Desktop ACP sends new prompts, rather than replaying the full transcript each round.
- Persistent-agent instruction paths are deduplicated and checked against an aggregate 128 KiB
  budget. They are sent on the first prompt of a new/configured session.
- Library contents are fetched on demand, never added to all prompts.
- Workflow chatboxes send referenced output excerpts when their values change in that session,
  with an aggregate 16,000-character update budget.
- History tools omit encoded images and reasoning and bound their text output.

Provider-managed context growth, compaction and tool schemas remain the provider's responsibility;
Hato cannot guarantee a fixed context size inside external adapters.

## Build and activation

Build the changed modules and run TypeScript checks/tests. Library is a marketplace plugin
using existing database, UI and MCP contracts; no native change or app restart is required.
Versioned artifacts are prepared under `Hato-plugins/packages/library/0.1.0/`; install both
members with the existing Settings plugin installer and approve their declared permissions.
Existing chat changes can hot reload when idle. Do not replace a daemon with active agents;
update daemon modules after its work finishes. Preparing packages does not publish or activate
them. Screenshots use the snapshot build and disposable data, installing through the real
plugin lifecycle. Never use real user app data for integration fixtures.
