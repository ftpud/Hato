# Hato

Hato is a native desktop workspace for projects, files, Git, terminals and AI agents, locally or
over SSH. A small Rust core provides native controls and system access; TypeScript plugins define
the application and can be updated without restarting it. Background agents run on a local or
remote daemon and keep working when the desktop disconnects.

## Run from source

The desktop is currently tested on macOS. Install Xcode with the Metal toolchain, Rust stable,
Node.js 20 or newer, Git and OpenSSH, then run:

```sh
git clone https://github.com/ftpud/Hato.git
cd Hato
npm ci
npm run modules:build
cargo run -- --root .
```

AI providers are optional and installed separately. To use one, install and authenticate its ACP
adapter on the machine where the agent will run.

## Documentation

- [Development and architecture](docs/DEVELOPMENT.md)
- [Plugins and hot reload](docs/PLUGINS.md)
- [Background agents and MCP servers](docs/PERSISTENT_AGENTS.md)
- [Compatibility and prerequisites](docs/COMPATIBILITY.md)
- [Testing](docs/TESTING.md)

## License

[MIT](LICENSE).
