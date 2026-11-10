# Plugin packages and marketplace

The public repository is https://github.com/ftpud/Hota-plugins. `catalogue.json`
is its index. App code and editable sources remain in Hato; the marketplace contains
prebuilt JS and manifests, exported with `node tools/export-plugins.mjs DESTINATION`
after `npm run modules:build`. Review changes before committing and pushing that repository.
A package groups multiple existing runtime modules without renaming their stable IDs.
Authors choose a free-form `type` used for browser grouping.

Settings → Plugins offers Installed packages, Marketplace, Check for updates and download,
with individual module enable/disable/removal controls below. Fetches pin all files to
one Git commit. Dependency planning checks exact, caret and tilde semver requirements,
rejects cycles and incompatible Hato versions, then downloads manifests and bundles.
Native installation and permission approval remain enforced by the kernel.
New modules stay disabled; existing enabled modules retain their enabled preference.
Install receipts are saved after success. Package installation is sequential, not an
atomic multi-module transaction; an error can leave some modules updated and must be retried.
Updating the requesting manager stores its new seed without unloading the active request;
the browser reports that a restart is needed to load that manager update. Other enabled
modules load their installed updates immediately.

## Review of existing modules

| Package | Bundle policy | Modules / rationale |
| --- | --- | --- |
| foundation | Core | persistence, workspace, projects, files, terminals, workspace-layout, settings, module-dev, explorer, viewer, terminal-panel, projects-panel, left-sidebar, sidebar: startup, storage, navigation and recovery |
| core-acp | Core | acp, ai-sessions, ai, internal-mcp, internal-local-mcp, internal-remote-mcp, mcp-auth, agent-runner: generic protocol/chat and agent bridge |
| git | Core (requested) | git, git-panel, git-branch, git-changes, git-tasks: Git service, panel, branch/status bars and task worktrees |
| claude-acp | Add-on | claude-usage: provider plan bar; depends on generic ACP |
| codex-acp | Add-on | codex-usage: provider plan bar; depends on generic ACP |
| automation | Add-on candidate | workflows, workflow-runner, workflows-panel, persistent-agents, agents-panel |
| remote | Add-on candidate | remote-runtime, remote-panel |

This catalogue records intended packaging, not a completed dependency refactor. Existing
releases still bundle every module. Do not delete add-on sources from the app distribution
yet: workspace/projects/internal MCP have calls into git-tasks, persistent-agents and related
services. Those calls need explicit optional-service handling first. Remote runtime startup
and existing saved workspaces also need migration coverage before removing it from seeds.
Provider-specific defaults, adapter setup, authentication policy, usage refresh and parsing
still live in ACP; they must move behind a provider contribution contract before core-acp
can accurately be called provider-independent. Claude/Codex packages currently group the
existing usage panels, not the full extracted adapter integrations.

## Versioning

`plugins.catalogue.json` is the source catalogue. Bump a package version when publishing
changed artifacts. `coreVersion` currently tracks package.json's 0.1.0 app/module release;
keep them aligned on releases. Supported requirement syntax deliberately excludes wildcards,
OR expressions and prereleases. Built-in packages remain present in the public repository
so they can receive updates separately from an application release.

## Native boundary and activation

Bundled IDs may be overridden by approved installed copies. Removing an override exposes
the bundled copy again on rescan/startup. Install prepares a candidate folder before replacing
the previous folder, and requests permission escalation before loading the new copy.
The kernel still validates capabilities and module calls. Core changes and new Settings
permission bounds require a native rebuild/restart. Bundling TypeScript alone does not
activate the marketplace in an already running app.
