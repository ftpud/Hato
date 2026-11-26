# Hato

An experimental native desktop workspace for projects, files, Git, terminals and AI agents,
locally or over SSH. Its features and interface live in hot-swappable TypeScript plugins
on a Rust kernel. Background agents and workflows run on workspace daemons and can continue
after the desktop disconnects.

## Run from source

For macOS, install Xcode with the Metal toolchain, Rust stable, Node.js 20+, Git and OpenSSH.

```sh
git clone https://github.com/ftpud/Hato.git
cd Hato
npm ci
npm run plugins:setup
npm run dev -- --root .
```

Plugin sources live in the separate `Hato-plugins/` checkout. Development mode rebuilds and
activates module changes while Hato runs. Choose features in Settings → Plugins.
AI providers require an installed, authenticated adapter on the workspace machine.

## Documentation

- [Architecture and source map](ARCHITECTURE.md)
- [Plugins and hot reload](docs/PLUGINS.md)
- [Background agents](docs/PERSISTENT_AGENTS.md) and [workflows](docs/WORKFLOWS.md)
- [Compatibility](docs/COMPATIBILITY.md) and [Windows/WSL](docs/WINDOWS.md)
- [Development](docs/DEVELOPMENT.md) and [testing](docs/TESTING.md)

[Apache License 2.0](LICENSE).
