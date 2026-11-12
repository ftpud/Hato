# Hato

Hato is an **experimental, plugin-driven native desktop workspace** for projects, files, Git,
terminals and AI agents, locally or over SSH. It is a workspace you can reshape while it runs:
application features and UI live in editable TypeScript plugins on top of a small Rust core.

The project is evolving quickly. Expect rough edges and changing APIs as the architecture and
workflows develop.

## Built to be rewritten and extended

- **Plugins define the application.** Projects, files, Git, terminals, AI workflows, panels and
  layout are composed from service and UI plugins. The Rust core provides reusable native
  controls, system access, resource management and permission enforcement.
- **Hot-rewritable behavior and UI.** Edit, build and activate TypeScript plugins while Hato is
  running, without rebuilding the native app or restarting it. Add or replace workflows, panels
  and presentation through plugin contracts. Native core changes require a rebuild and relaunch.
- **An internal MCP for evolving Hato.** Connected AI agents can inspect existing modules, patch
  their source, build and stage changes, activate them, verify the result and roll back through
  Hato's internal Model Context Protocol (MCP) server. Module maintenance mutations require native
  user approval. New plugins can extend the application through manifests and runnable JavaScript
  bundles installed in Settings → Plugins, where their permissions are approved before use.
- **Agents that keep working.** Background agents run on a local or remote daemon and continue
  when the desktop disconnects.

See [plugins and hot reload](docs/PLUGINS.md), including the internal MCP self-configuration
workflow, for the extension model and its current boundaries.

<img width="1582" height="948" alt="image" src="https://github.com/user-attachments/assets/8ac7c1a6-00c5-4b30-8d70-f4d7a1c9fdac" />


## Run from source

The desktop is currently tested on macOS (Apple silicon and Intel). Install Xcode with the Metal
toolchain, Rust stable, Node.js 20 or newer, Git and OpenSSH, then run:

```sh
git clone https://github.com/ftpud/Hato.git
cd Hato
npm ci
npm run plugins:setup
npm run dev -- --root .
```

Plugin sources live only in the separate `Hato-plugins/` checkout. `npm run dev` builds and
watches them, activating TypeScript changes without restarting the app. Packaged applications
install their pinned initial plugin set on first launch and keep it in app data for offline use.
See [the runtime migration guide](docs/PLUGIN_RUNTIME.md) for updates and publishing.

Source launches use the same Dock and app-switcher icon as the packaged macOS app.

AI providers are optional and installed separately. To use one, install and authenticate its ACP
adapter on the machine where the agent will run.

## Documentation

- [Development and architecture](docs/DEVELOPMENT.md)
- [Plugins and hot reload](docs/PLUGINS.md)
- [Background agents and MCP servers](docs/PERSISTENT_AGENTS.md)
- [Compatibility and prerequisites](docs/COMPATIBILITY.md)
- [Testing](docs/TESTING.md)

## Panels at a glance

- **Git branch** in the top panel shows the current branch. Search Local/Remote branches, check out a branch, or create one from HEAD or a selected branch. Checkout preserves local edits and respects other worktrees. Move or hide the widget through Layout.
- **Git changes** lists modified files; click one to open its diff in the viewer.
- **Latest changes** shows every uncommitted change as one live diff, without tabs.

## License

[Apache License 2.0](LICENSE).

On Windows, the app window runs natively and projects live in WSL or on Linux hosts: see [docs/WINDOWS.md](docs/WINDOWS.md).
