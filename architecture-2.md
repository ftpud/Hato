# Architecture: Self-Modifying Native Desktop Platform (Microkernel Edition)

**Status:** Implementation specification for a proof of concept (POC)  
**Audience:** Codex or another coding agent implementing this repository  
**Platform goal:** macOS, Windows, Linux desktop; SSH targets are POSIX systems in the POC  
**Guiding principle:** Compile the native Rust kernel rarely. Evolve the application by rebuilding and hot-swapping TypeScript modules.  
**Priority:** Demonstrate the complete working vertical slice, not a generic IDE or a plugin marketplace.

> **IMPORTANT:** This is a completely new project. It is not HatoPad and must not import its code. Its Git tasks resemble HatoPad's *concept* of a persistent branch plus linked worktree, but are implemented independently. This file supersedes the previous thick-host architecture, including all statements that placed Projects, Git, SSH policy, ACP, conversations, or MCP business logic inside Rust.

## 1. Product requirements and mandatory POC

Build a compact **native GPU-rendered, modular desktop application**. The user can add a local or SSH project, select its root or a Git task/worktree, browse and view files with syntax highlighting, use an interactive shell, and chat with an ACP agent (Codex or Claude) running on the **same computer that holds that workspace**. The agent may use an internal MCP toolchain to inspect, patch, compile, replace, and roll back application modules.

The POC MUST implement all of the following, without fake demos:

1. **Left Projects panel:** expandable/persistent tree of real projects with nested task worktrees. Clicking a chevron expands/collapses; clicking a row changes workspace selection.
2. **Local and SSH projects:** project points to an absolute local directory or absolute remote directory associated with an SSH profile. The active workspace determines where filesystem, Git, terminal, and ACP operations execute.
3. **Git tasks:** if a project root is a real Git working tree, create a task as its own branch and real linked `git worktree`; remote projects create worktrees **on the remote machine**. Parent project selects its main checkout; task selects its worktree.
4. **File explorer + syntax-highlighted viewer:** list folders under active workspace root, navigate subfolders, open text files in a native read-only code viewer, and preserve selected file/scroll context when reasonable.
5. **Real terminal:** local PTY or remote SSH PTY, with an actual terminal emulator (ANSI escape codes, cursor, resize, colors). Its process/session survives a TypeScript UI or business-service reload.
6. **AI module:** conventional streaming chat, agent profile selector (Codex/Claude/custom ACP command), model, reasoning, agent mode and approval/autopilot selectors, plus an MCP selector. Provide actual agent streams and permissions; never fabricate a model list or AI responses.
7. **Workspace-bound ACP:** local workspace => local ACP process in the corresponding `cwd`; SSH workspace => ACP process on that same SSH server in the corresponding remote root/worktree. No silent local fallback or implicit clone.
8. **Internal MCP:** a **hot-swappable TypeScript service**, not a Rust implementation of MCP. It offers authenticated, permission-checked tools/skills to inspect module status, view allowed module source, apply patches, build, activate, roll back, and fetch diagnostics. Expose to local and remote ACP clients. Show third-party MCP entries as disabled/coming later.
9. **SQLite persistence:** projects, tasks, SSH profile metadata, expanded tree, selected workspace, per-workspace view state, agent profile configuration and chat history. SQLite driver is Rust; all schema, queries, migrations and business rules are in TS services.
10. **Demonstrable self-modification:** edit e.g. `modules/ui/projects/src/index.ts`, build a versioned `projects.0002.mjs`, load it, swap its active implementation, observe a changed native UI **without rebuilding or restarting the Rust kernel**. Roll back on failures. Demonstrate a service-module swap as well, not only UI swaps.
11. **User control:** module source modification and activation through AI tools require a clear trusted approval path. A malformed or hostile JS module must not gain unrestricted OS access merely by importing a package or claiming to be a trusted module.

**Removed requirement:** There is **no virtual “Modules (internal)” project** in the Projects panel. Installed module source is host-managed developer content accessed through explicitly allowed Internal MCP tools or external editors. The AI module is a normal panel/module, not a project.

**No cheating:** A terminal is not a text log with a command textbox; an SSH project is not an SFTP-only mock; Git tasks are not copies or checkouts in the same directory; an ACP chat is not a plain LLM HTTP chat; a simulated `reloadSelf()` is not a successful module replacement.

## 2. Microkernel contract: what stays in Rust

### 2.1 The only native responsibilities

Rust supplies *primitives and resource lifetimes*, NOT application semantics:

| Native area | Rust implements | Rust explicitly does NOT implement |
| --- | --- | --- |
| Window / GPU UI | GPUI event loop, window creation, renderer for generic keyed UI schema, native text controls, syntax-highlighted editor/viewer, terminal grid renderer, input, focus, accessibility where practical | Project tree rules, chat UI business logic, workspace actions, Git task semantics |
| Dynamic runtime | QuickJS runtime workers, JS-to-Rust bridge, scoped module loader, module registry, build artifact loader, generation router, transaction-like swap state machine | Application module code, ACP provider code, business service implementations |
| Capability broker | Typed, permissioned operations for local/remote files, process/stdio, PTY, SSH/SFTP/channels/forwarding, SQLite, timers, module artifacts, bounded streams, source grants | How projects, branches, sessions, chats or MCP tools are modeled |
| Resource registry | Opaque stable handles for windows, documents, PTYs, streams, child processes, sockets, SSH connections and SQLite connections | The meaning of a particular project/task/conversation |
| Trusted approval chrome | Native permission dialogs/queue, user-driven approval tokens, audit log, immutable upper bounds on grants | Autopilot policy interpretation as a substitute for actual approval |
| Safety / recovery | Capability checks on every host operation, quotas, watchdogs, module-generation disposal, crash recovery, safe-mode UI, rollback support | Git workflow policy, ACP/MCP JSON-RPC protocol or tool descriptions |

**Rule:** A change that affects *only* projects, tasks, SSH workflow, Git commands, ACP logic, MCP tools, chat behavior, data schemas, layout, or button handlers MUST be implementable by swapping TypeScript services or UI modules. Adding a new native rendering primitive, changing GPUI/QuickJS bindings, or adding an entirely new OS facility MAY require Rust recompilation.

The kernel can internally use Rust libraries for GPUI, SQLite, libssh2/SSH, PTYs, terminal emulation and syntax highlighting. Using a native library does not mean its *application-specific logic* belongs in the kernel.

### 2.2 Target layering

```text
+---------------------------------------------------------------------------------+
|   RUST MICROKERNEL (stable, minimal application knowledge)                      |
| GPUI + native controls       QuickJS worker supervisor    Module swap/rollback  |
| Resource/handle registry     Capability broker            Trusted approvals     |
| Native adapters: FS/process/PTY/SSH/SQLite/streams/timers + native drawing       |
+------------------------------+--------------------------------------------------+
                               | versioned host ABI (typed messages + handles)
+------------------------------v--------------------------------------------------+
|   HOT-SWAPPABLE TYPESCRIPT SERVICE MODULES (NO Node APIs assumed)               |
| persistence | workspace | projects | git-tasks | files | terminals               |
| acp | ai-sessions | internal-mcp | module-dev                                 |
|      ^                  ^                      ^                               |
|      +---------- RPC / events / state bus -----+                               |
+------------------------------+--------------------------------------------------+
                               | stable service contracts, opaque resource IDs
+------------------------------v--------------------------------------------------+
|   HOT-SWAPPABLE TYPESCRIPT UI MODULES                                            |
| workspace-layout | projects-panel | explorer | viewer | terminal-panel | ai       |
| Each returns a keyed UI tree; native GPUI renders it and dispatches typed events |
+---------------------------------------------------------------------------------+
      | local process/stdio | SSH process/stdio + PTY | internal MCP bridge
      v                     v                           v
   local ACP         remote ACP on SSH host      local Internal MCP TS service
   local Git             remote Git               (also reachable by remote ACP)
```

Services may call other services only via the registry. A UI module cannot import another live module's implementation. No application component is pinned to a concrete artifact version; it references a stable logical service/module ID.

### 2.3 Explicitly excluded from the kernel

- `Project`, `Task`, `Workspace`, `ACPConversation`, `GitRepository`, `McpTool` as Rust domain structs.
- Hardcoded SQL DDL for projects, tasks or conversations.
- Git task names, branch naming policy, `git worktree add` orchestration.
- ACP JSON-RPC schemas, model/reasoning selection or provider-specific commands.
- MCP tool registration, skill contents, project business permissions or prompt logic.
- JSON-rendered project entries, explorer navigation semantics, chat transcript composition.

Native primitives can accept **generic** descriptors and validated handles, but not specialized `createTask`, `openProject` or `startCodex` calls.

## 3. Technology decisions and compatibility

| Component | Default choice | Notes |
| --- | --- | --- |
| GPU desktop framework | **GPUI**, Rust | No Electron, Chromium, WebView, HTML or CSS runtime. Pin one tested revision. |
| Native widgets | **gpui-component / gpui-kit**, compatible with pinned GPUI | Use native `Editor` for highlighted viewer; verify compatibility and language support. |
| JS runtime | **QuickJS via `rquickjs`** | One isolated runtime or worker per module generation; no shared JS globals across modules. |
| TS build | **esbuild** | Development/build tool, not required to run already built modules. Build each module to ESM `.mjs`. |
| SQLite primitive | **`rusqlite` bundled**, namespace-isolated connections | TS services own schema/migrations and access via parameterized host calls. |
| Native local PTY | **`portable-pty`** | Persist independent of UI/service generation. |
| Terminal emulator | `alacritty_terminal` or verified GPUI terminal component | PTY bytes must be parsed and rendered as a terminal, not raw text. |
| Native SSH | A pinned compatible **`ssh2`** / libssh2 implementation or equivalent | SFTP, `exec` stdio, PTY, reverse loopback forwarding. POC remote OS: POSIX. |
| Git | **System Git CLI** | Command sequence and validation in TS `git-tasks`; local/remote process execution through host broker. |
| ACP | **Implement current `agentclientprotocol.com` ACP client in TS**, over generic stream primitives | Use live protocol negotiation; adapter commands available on workspace machine. Do not confuse with other similarly named ACP projects. |
| MCP | **TS Internal MCP server** speaking an interoperable MCP version | Host provides stream/tunnel plumbing and approval; tool definitions live in TS. |
| Persistence of runtime state | TS service-owned SQLite databases + host-owned opaque resource handles | No host-owned domain database tables. |

**QuickJS is not Node.js.** Do not use `node:fs`, Node streams, process globals, `Buffer`, npm modules requiring Node built-ins, or platform-native npm addons *inside* JS modules. TS compilation via esbuild does not add Node APIs. Expose a small typed `ctx.host` capability SDK instead. Node.js may be needed for *build tools* and for *external ACP adapters* installed locally/remotely, but is not embedded in the app.

**GPUI caution:** its public API is evolving and `gpui-kit` and GPUI version combinations can break. Inspect current upstream examples before implementation, select one supported revision, and pin Cargo.lock and package-lock. Cross-platform target is a goal; prove the host development platform first and do not pretend all three OS targets have been tested. The POC accepts remote Linux/macOS SSH hosts; remote Windows over SSH is deferred.

Reference documentation (inspect again before coding):

- GPUI: https://github.com/zed-industries/zed/tree/main/crates/gpui
- GPUI component/editor: https://github.com/longbridge/gpui-component
- QuickJS Rust bridge: https://docs.rs/rquickjs/latest/rquickjs/
- Portable PTY: https://docs.rs/portable-pty/latest/portable_pty/
- ACP: https://agentclientprotocol.com/
- MCP: https://modelcontextprotocol.io/specification/

## 4. Module taxonomy and package structure

All modules are authored in TypeScript and compiled into standalone versioned JS bundles. Two kinds have the same lifecycle but different capabilities:

- **`service`:** owns application behavior; exports methods and subscriptions, does not need to render a UI. May maintain state in its own SQLite namespace.
- **`ui`:** exports `render(ctx): UiNode` and UI event handlers. Uses services; should not orchestrate low-level system resources directly.

Recommended modules and dependencies:

| ID | Kind | Responsibility |
| --- | --- | --- |
| `persistence` | service | Typed persistence helpers, migrations and ordinary settings; can be split into per-service DB owners later. |
| `workspace` | service | Active workspace selection, per-workspace state, machine/location resolution. |
| `projects` | service | Project registration, SSH profile association, expansion and project listing, validated project roots. |
| `git-tasks` | service | Git discovery, branch names, real local/remote worktrees, task registration and reconciliation. |
| `files` | service | Workspace-scoped file listing, navigation, reading, host document handle creation. |
| `terminals` | service | Attach/create local or remote PTYs for stable workspace keys, terminal metadata. |
| `acp` | service | Agent profiles, ACP local/remote transports, initialization, capabilities, sessions, modes and config. |
| `ai-sessions` | service | Conversation state, transcript persistence, streaming projection, session selection, approval policy. |
| `internal-mcp` | service | Real MCP server and internal tool registrations/skills, local+remote endpoint behavior. |
| `module-dev` | service | Allowed source browse/patch workflow, module build orchestration, activate/rollback API; delegates actual binary artifact swap to kernel. |
| `workspace-layout` | ui | Main window composition, draggable panes/slots. |
| `projects-panel` | ui | Left tree of projects/tasks + Add Project/New Task controls. |
| `explorer` | ui | Navigate current workspace directory, open files. |
| `viewer` | ui | Native syntax-highlighted read-only file viewer. |
| `terminal-panel` | ui | Native terminal widget bound to stable PTY handle. |
| `ai` | ui | ACP conversation, model/reasoning/autopilot/MCP selections and tool status. |

A small `bootstrap` JS service can wire first-launch defaults. **No Rust `ProjectManager`, `GitManager`, `ACPManager`, `McpServer`, or `ConversationManager` exists.**

A module's manifest is a **static, pre-read, separately validated descriptor**. It is not permissioned merely because executable JS exports it:

```json
{
  "schemaVersion": 1,
  "id": "git-tasks",
  "kind": "service",
  "entry": "src/index.ts",
  "moduleApiVersion": 1,
  "dependencies": ["workspace", "projects", "persistence"],
  "capabilities": ["process.workspace.git", "db:git-tasks", "events.publish"],
  "stateVersion": 1
}
```

An approved installation record (not the module's mutable JS) grants the capability set. A new manifest asking for additional capabilities requires a trusted host approval. Existing grants are an upper bound: a runtime cannot grant itself more power by patching its manifest. Ship first-party manifests/grants with the POC and keep them inspectable.

## 5. Low-level host ABI (the boundary that must remain stable)

The only application-visible native interface is a **versioned capability bridge**. Avoid exposing internal Rust structs or pointers; return opaque handle IDs.

Conceptual SDK (we must implement this; these are NOT existing GPUI/rquickjs functions):

```ts
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Handle = string;                  // opaque; owned by Rust
// The machine is explicit on EVERY process and PTY request. No ambient local fallback.
type ExecutionTarget =
  | { kind: "local" }
  | { kind: "ssh"; connection: Handle; machineId: string };
type SpawnRequest = {
  target: ExecutionTarget; executable: string; args: string[];
  cwd: string; envRefs?: Record<string, string>;
  stdio: "pipe" | "inherit";
};
type PtyRequest = {
  target: ExecutionTarget; cwd: string; shell?: string;
  columns: number; rows: number; envRefs?: Record<string, string>;
};
// Additional FileEntry, SqlStatement, PtyRequest result etc. types live in sdk/types.ts.
interface NativeHost {
  readonly abiVersion: 1;
  // Resource-specific grants are checked for every call.
  capabilities: {
    request(req: CapabilityRequest): Promise<Handle>; // may require native approval
    release(grantId: Handle): Promise<void>;
  };
  fs: {
    stat(grant: Handle, path: string): Promise<FileStat>;
    list(grant: Handle, path: string): Promise<FileEntry[]>;
    read(grant: Handle, path: string, limitBytes?: number): Promise<Uint8Array>;
    writeAtomic(grant: Handle, path: string, data: Uint8Array): Promise<void>;
  };
  process: {
    spawn(grant: Handle, request: SpawnRequest): Promise<Handle>;
    write(handle: Handle, bytes: Uint8Array): Promise<void>;
    closeStdin(handle: Handle): Promise<void>;
    terminate(handle: Handle, signal?: string): Promise<void>;
    wait(handle: Handle): Promise<ExitStatus>;
  };
  pty: {
    open(grant: Handle, req: PtyRequest): Promise<Handle>;
    write(pty: Handle, bytes: Uint8Array): Promise<void>;
    resize(pty: Handle, columns: number, rows: number): Promise<void>;
    close(pty: Handle): Promise<void>;
  };
  ssh: {
    connect(grant: Handle, profile: SshConnectionOptions): Promise<Handle>;
    sftp(grant: Handle, connection: Handle): Promise<Handle>;
    forwardLoopback(grant: Handle, connection: Handle, request: ForwardRequest): Promise<Handle>;
  };
  db: {
    openNamespace(grant: Handle, namespace: string): Promise<Handle>;
    query(db: Handle, sql: string, params?: Json[]): Promise<Json[]>;
    exec(db: Handle, sql: string, params?: Json[]): Promise<{ changes: number }>;
    transaction(db: Handle, statements: SqlStatement[]): Promise<void>;
  };
  streams: {
    subscribe(handle: Handle, opts?: { highWaterMark?: number }): AsyncIterable<ByteChunk>;
    unsubscribe(handle: Handle): Promise<void>;
  };
  resources: {
    retainForWorkspace(handle: Handle, stableKey: string): Promise<void>;
    lookup(stableKey: string): Promise<Handle | null>;
    info(handle: Handle): Promise<ResourceInfo>;
  };
  modules: {
    stageArtifact(grant: Handle, id: string, artifactPath: string): Promise<StagedModule>;
    activate(grant: Handle, id: string, stageId: string): Promise<SwapResult>;
    rollback(grant: Handle, id: string): Promise<SwapResult>;
    list(): Promise<ModuleGeneration[]>;
  };
  ui: {
    invalidate(moduleId: string): void;
    // Optional: host-owned document handle and surface state, keyed by workspace.
    documentOpen(grant: Handle, workspaceKey: string, data: Uint8Array, language: string): Promise<Handle>;
  };
}
```

Exact Rust implementation may change the shapes to fit QuickJS/Rust concurrency. Required semantics are stable capabilities, handle identity, subscription/stream backpressure, structured errors and no project-specific API. Treat native resources as **leased handles** with an explicit owner, lifetime, scope and refcount; handles must be unforgeable and checked by kernel, not trusted merely because they are strings.

### 5.1 Capabilities and execution location

Define a generic host-side **resource scope** such as a permitted local root, verified remote connection/root, trusted build source area, or specific child process/PTY. A workspace service resolves a project/task to that scope and requests scoped grants. The OS-level permission scope is brokered by Rust; the **meaning** of project/task is implemented by TS.

Requirements:

- A remote root is **not** a local absolute path. File, process, terminal and agent access for SSH workspace must use the same **remote machine identity** and remote root/worktree.
- The host verifies `ExecutionTarget` against the native grant. A remote target must carry a live SSH connection handle with the approved `machineId`; a missing/disconnected handle is an error. `target: local` is NEVER substituted for a failed SSH target.
- Spawn requests use `{ executable, args, cwd, envRefs }`, not string interpolation, for local execution. For SSH remote shell execution, centrally provide an audited quoting/exec adapter for POSIX; never concatenate unsanitized user text into shell source.
- A project-bound process grant cannot silently fall back to the local machine when the SSH connection is unavailable.
- Prefer narrowly scoped grants. `fs.read` under an authorized project root is distinct from a grant allowing `modules/` source edits. The native broker may allow trusted user-explicit exceptions; do not grant modules unrestricted system-wide filesystem access by default.
- A shell or general-purpose coding ACP agent is intentionally powerful **within its approved workspace**. The application must explain that limitation and not claim a perfect sandbox.
- A module cannot authorize its own privileged operations. Native approval results are issued by trusted GPUI chrome, bound to operation + module generation + scope + expiry, not returned by mutable TS UI code.
- Do not expose raw SQLite databases or credentials across module boundaries. A namespace must map to its own database file (or enforce isolation structurally, not with fragile SQL string inspection); for POC the `persistence` module may own the project/task schema and delegate typed CRUD to other modules.
- Long-running streams/byte buffers must not require JSON serialization for every terminal character or ACP token. Use bounded binary stream handles and coalesced UI updates.

### 5.2 Threading and QuickJS specifics

- GPUI code executes on its UI thread. All blocking filesystem, Git, database, SSH, process/PTY, and agent I/O is asynchronous/off-thread.
- Each module generation has its **own QuickJS runtime**, with an explicit event loop/message pump. QuickJS contexts/runtimes are **not freely thread-safe**; schedule all invocations on the owning worker and carefully pump pending JS jobs/Promise continuations. `rquickjs` async support may help but is not an automatic scheduler.
- Never await a host operation while holding a synchronous runtime lock that blocks the completion callback.
- Limit script CPU/time, memory and queue depth; cancel/tombstone operations originating from retired generations. Native UI stays responsive when a JS module hangs or throws.
- For native widgets, keep document/terminal buffer and input state in Rust entities keyed by stable `(workspaceId, controlKey)`, not the transient module generation ID. High-frequency input does not cross JS for every keypress.

## 6. Application module SDK and communication

Use one stable logical module ID even as its artifact generation changes. Modules talk via a generic broker; never import another module at runtime.

```ts
interface ModuleContext {
  readonly moduleId: string;
  readonly generation: number;
  readonly host: NativeHost; // contains only granted/visible native capabilities
  modules: {
    call<T = Json>(id: string, method: string, args?: Json, opts?: { timeoutMs?: number }): Promise<T>;
  };
  events: {
    emit(topic: string, payload: Json): void;
    on(topic: string, listener: (payload: Json) => void): () => void;
  };
  state: {
    get<T = Json>(key: string): T | undefined;
    set(key: string, value: Json): void;
    watch(key: string, listener: (value: Json) => void): () => void;
  };
  ui: { invalidate(): void };
}

interface AppModule {
  id: string;
  moduleApiVersion: 1;
  activate?(ctx: ModuleContext, previousState?: Json): Promise<void> | void;
  deactivate?(ctx: ModuleContext): Promise<void> | void;
  snapshot?(ctx: ModuleContext): Promise<Json> | Json;
  render?(ctx: ModuleContext): UiNode;
  onEvent?(ctx: ModuleContext, event: UiEvent): Promise<void> | void;
  methods?: Record<string, (ctx: ModuleContext, args: Json) => Promise<Json> | Json>;
}
```

### 6.1 RPC, event bus and shared state

- `ctx.modules.call("projects", "list")` = point-to-point RPC routed to the **currently active** `projects` generation; route with request IDs, timeouts, cancellation and bounded queues.
- `ctx.events.emit("workspace.selected", { workspaceId })` = one-to-many non-durable event, namespaces/permissions enforced. Subscriptions registered in old generation are cancelled on unload. Events arriving during swap are queued for the target module or handled according to an explicit per-topic backpressure rule.
- `ctx.state.get/set/watch()` = small host-maintained observable **ephemeral UI state** with ownership/namespace rules. Do not make it the authoritative database. Long-term project/task/chat data stays in TS service SQLite namespaces.
- Service discovery is optional for POC; add it later without changing the primitive bus protocol.

Service API ownership example:

```ts
// UI -> projects service -> persistence + native capability broker
const tree = await ctx.modules.call("projects", "tree", {});
await ctx.modules.call("workspace", "select", { workspaceId: "task:..." });

// files is independent of the UI and uses workspace descriptors from workspace service
const entries = await ctx.modules.call("files", "list", { workspaceId, relativeDir: "." });
```

Operations are bound to workspace IDs, not implicit ambient cwd. For every remote operation, verify that the machine/grant matches the intended workspace. Do not let a caller forge a different workspace by simply submitting an arbitrary absolute path.

### 6.2 Typed, native, keyed UI protocol

The GPUI renderer accepts a *serializable* UI tree. JS code declares structure and actions, while the kernel retains native control state. Start with:

- `row`, `column`, `split`, `scroll`, `tabs`, `slot`, `label`, `button`, `textInput`, `select`, `toggle`, `tree`, `fileList`, `status`, `progress`;
- host-native `codeViewer`/`editor` with syntax highlighting, `terminal` emulator, `chatTranscript`/log stream, and `approvalPanel` placeholder;
- keys for each element and stable action IDs (never function pointers in serialized UI).

Example:

```ts
export default {
  id: "projects-panel",
  moduleApiVersion: 1,
  async activate(ctx) { ctx.events.on("projects.changed", () => ctx.ui.invalidate()); },
  render(ctx) {
    return {
      type: "column", key: "projects-root", children: [
        { type: "label", key: "title", text: "Projects" },
        { type: "button", key: "add-local", text: "+ Local", action: "addLocal" },
        { type: "button", key: "add-ssh", text: "+ SSH", action: "addSsh" },
        { type: "tree", key: "tree", rows: ctx.state.get("projects-panel.tree") || [],
          selectAction: "selectWorkspace", expandAction: "toggleExpanded" }
      ]
    };
  },
  async onEvent(ctx, event) {
    if (event.action === "selectWorkspace") {
      await ctx.modules.call("workspace", "select", { workspaceId: event.rowKey });
    }
  }
};
```

This is a **proposed application SDK**, not a currently existing third-party API. The actual render API may require view models instead of synchronous state fetches; do not block the GPUI frame waiting for JS RPC. JS asynchronously resolves view state, caches it, and invalidates on change. `slot` composition should continue rendering other modules if one module fails.

**Trusted UI rule:** module-generated `approvalPanel` may show pending requests, but click-to-approve must be implemented in kernel-controlled chrome with an unforgeable user gesture. A TS module cannot synthesize approvals or hide an outstanding security decision permanently.

## 7. UI / product behavior and workspace model

### 7.1 Target main window

```text
+---------------------------------------------------------------------------------------------------+
|  Native Modular App                     Project A / Task 1                  [Settings]            |
+----------------------+-------------------+---------------------------+------------------------+
| PROJECTS             | FILES             | SOURCE VIEWER             | AI / ACP               |
| [+Local] [+SSH]      | src/              | src/main.ts               | Agent: [Codex v]       |
|                      |  main.ts          | 1 const x = ...           | Model: [dynamic v]     |
| v Project A [Local]  |  index.ts         | 2 ...                     | Reasoning: [dynamic v] |
|   Task 1             | package.json      |                           | Mode: [dynamic v]      |
|   Task 2             |                   |                           | Policy: [Ask v]        |
| v Project B [SSH]    |                   |                           | MCP: [x] Internal      |
|   Task 1             |                   |                           | [ ] External (later)   |
| > Project C [Local]  |                   |                           |------------------------|
|                      |                   |                           | Chat + streaming tools |
|                      |                   |                           | + approval requests    |
|                      |                   |                           | [Prompt]       [Send]  |
+----------------------+-------------------+---------------------------+------------------------+
| TERMINAL  [Project A / Task 1]                                                                [x] |
| $ pwd                                                                                             |
| /.../worktrees/task-1                                                                            |
+---------------------------------------------------------------------------------------------------+
| Active workspace · Agent location: local/ssh · modules: projects-panel@0002 ... · [Diagnostics]    |
+---------------------------------------------------------------------------------------------------+
```

Tree sample:

```text
Projects
  v Project A  [Local / Git]
      Task 1   [worktree]
      Task 2   [worktree]
  v Project B  [SSH / Git]
      Task 1   [remote worktree]
  > Project C  [Local / non-Git]
```

- Selecting a project row opens the original checkout. Selecting a task opens that task's linked worktree. Expansion is a separate event and persisted.
- Non-Git projects are still usable; they simply have no New Git Task action.
- Switching workspace changes file/terminal/ACP context **without deleting previous conversations or closing other workspace PTYs**. Selected workspace, explorer directory, selected file, tree expansion, split geometry and active conversation persist.
- First launch: register `--root <path>` or the process cwd as a local project if no project exists. On later launches, restore previous selection rather than re-seeding duplicates.
- A modal Add SSH project flow captures hostname, user, port, approved authentication reference, and absolute remote path. Never store raw SSH private keys in SQLite.

### 7.2 Workspace contracts

```ts
type WorkspaceDescriptor = {
  id: string;                        // project:<uuid>:root or task:<uuid>
  projectId: string;
  taskId?: string;
  location: "local" | "ssh";
  machineId: string;                // local or ssh:<profileId>
  rootAbsolutePath: string;         // path ON that machine
  connectionRef?: string;           // opaque SSH profile ref, no credentials
};
```

`workspace` is the sole service authorized to resolve an active workspace descriptor. `projects` and `git-tasks` own the persistent metadata, but the **kernel does not parse or construct WorkspaceDescriptor**. The kernel validates each requested capability against the approved concrete path/machine scope. Avoid cyclic RPC dependencies during module activation: services may resolve dependencies lazily after all modules load.

## 8. Persistence: SQLite driver in Rust, schema in TS

There must be **no app domain migrations compiled into Rust**. Rust only provides SQLite opening, parameterized queries, transactions, and durable namespace isolation. The first-party `persistence` TS service owns user-facing domain schema/migrations, with versioned migration scripts committed to source control. Example migration:

```sql
-- modules/services/persistence/migrations/001_init.sql
CREATE TABLE IF NOT EXISTS ssh_profiles (
  id TEXT PRIMARY KEY, host TEXT NOT NULL, port INTEGER NOT NULL,
  username TEXT NOT NULL, auth_ref TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY, name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('local','ssh')),
  root_path TEXT NOT NULL, ssh_profile_id TEXT,
  expanded INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL,
  name TEXT NOT NULL, branch TEXT NOT NULL,
  worktree_path TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'ready',
  created_at TEXT NOT NULL,
  UNIQUE(project_id, branch)
);
CREATE TABLE IF NOT EXISTS workspace_views (
  workspace_id TEXT PRIMARY KEY,
  explorer_relative_dir TEXT NOT NULL DEFAULT '.',
  preview_relative_path TEXT, terminal_key TEXT NOT NULL DEFAULT 'main',
  active_conversation_id TEXT, ui_state_json TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS acp_profiles (
  id TEXT PRIMARY KEY, machine_id TEXT NOT NULL,
  project_override_id TEXT, provider TEXT NOT NULL,
  name TEXT NOT NULL, executable TEXT NOT NULL,
  args_json TEXT NOT NULL DEFAULT '[]', env_refs_json TEXT NOT NULL DEFAULT '{}',
  enabled INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS ai_conversations (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL,
  acp_profile_id TEXT NOT NULL, provider_session_id TEXT,
  title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'offline',
  approval_policy TEXT NOT NULL DEFAULT 'ask',
  mcp_selection_json TEXT NOT NULL DEFAULT '["internal"]',
  config_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ai_messages (
  id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL,
  sequence INTEGER NOT NULL, kind TEXT NOT NULL,
  payload_json TEXT NOT NULL, created_at TEXT NOT NULL,
  UNIQUE(conversation_id, sequence)
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL);
```

The TS `persistence` service must enable foreign keys, add suitable indexes, handle migrations transactionally, and not accept raw SQL from arbitrary UI modules. `persistence` owns this one app database for POC; other services call its typed methods. Later, independent services may own distinct database namespaces. Never expose unscoped `db.openNamespace` to an unapproved module, and never parse SQL strings as the *only* isolation mechanism. The DB can be reopened by a new persistence module generation using a stable kernel connection handle; in-flight transactions must finish or be explicitly aborted before swap.

**Important lifecycle:** persistent records survive full app restart. Live PTY and ACP child process handles only need to survive JS module reloads while the native process remains running. After full restart, ACP resume is attempted only if the agent actually supports it; otherwise cached history remains readable and a new ACP conversation can be created. SSH project offline state must never delete its saved project/task records.

## 9. Business services in TS: exact behavior

### 9.1 Projects, workspaces and Git tasks

`projects` stores local and SSH project metadata using `persistence`, requests native path/connectivity grants, and checks `git -C <root> rev-parse --show-toplevel` through the process broker. For the POC, Git task creation requires the configured project root to equal the repository top level and requires at least one commit.

`git-tasks.create({ projectId, name })`:

1. Ask `projects` to resolve the authorized machine/root and verify it is a Git project.
2. Allocate a stable task UUID. Construct a safe unique branch `task/<slug>-<short-id>`. Validate with `git check-ref-format --branch` on the project machine.
3. Choose a **worktree outside the original checkout**, on the same machine. Local: an app-data `worktrees/<projectId>/<taskId>` directory; remote: approved `${HOME}/.local/state/<app>/worktrees/<projectId>/<taskId>` or equivalent remote path.
4. Execute `git -C <root> worktree add -b <branch> <path> HEAD` on the correct machine. Use argv local and correctly quoted remote POSIX execution; do not pass interpolated project names through an unchecked shell.
5. Verify `git worktree list --porcelain`. Persist task metadata only after success; if persistence fails, surface a reconcile action and do NOT silently delete created user work.
6. Select the new task workspace, which has distinct files, terminal, ACP sessions and UI state.
7. On start or reconnect, reconcile stored task records to the actual Git worktree list, mark missing worktrees, and do not automatically prune/delete.

If parent checkout has uncommitted or untracked changes, explicitly warn that `git worktree add ... HEAD` does **not** copy them. Worktrees have committed state only. Deleting worktrees/branches and copying dirty state are outside the POC. Non-Git projects remain valid workspaces.

### 9.2 Files and native viewer

`files` receives `workspaceId` and workspace-relative paths, resolves them via `workspace`, requests *scoped* host FS/SFTP access, and returns file entries or a native document handle. Enforce limits on read size, handle binary/non-UTF8 files gracefully, and prevent traversal outside the approved root (including symlink/realpath escape unless specifically approved). The `viewer` TS UI only renders a `codeViewer` node backed by a Rust document handle; syntax highlighting and scroll/caret rendering remain native. POC viewer is read-only.

### 9.3 Terminal service

`terminals` maps `(workspaceId, stableKey)` to an opaque PTY handle: for a local workspace, start a real local shell with working directory at the root/worktree; for SSH workspace, open an SSH PTY and remote shell in the same directory. The **kernel owns the handle and emulator buffer**; `terminals` owns the interpretation of which workspace is selected and when to create/reattach. `terminal-panel` only mounts the `terminal` native control. Support input, output, resize, ANSI/VT sequences and command exit; a TS hot-swap must not kill the PTY. A native process exit should produce a visible terminal error/exit state, not be silently restarted into the wrong directory.

### 9.4 ACP: client implementation in replaceable TS

`acp` is a first-party **service module** implementing the official Agent Client Protocol (JSON-RPC over byte-stream transports) and provider adapters. Only raw process/SSH stdio transport and stream handles are native. Agent protocol, negotiation, sessions, prompts, updates, cancellation, model/reasoning/mode selection and provider quirks are implemented in TS.

An agent profile is scoped to `machineId` (`local` or `ssh:<profileId>`), optionally with a project override. Profile commands/args are interpreted on that machine. Never assume a locally installed `codex` executable exists on the SSH server.

For each conversation:

1. Ask `workspace` for `workspaceId`, `machineId` and `rootAbsolutePath`.
2. Resolve an available configured ACP profile on the **same machine**. Detect command presence and authentication state; report installation/authentication errors clearly. Do not auto-install an arbitrary agent.
3. Start ACP adapter with `cwd` = exact project root or Git worktree. Local => native child process. SSH => remote process over SSH stdio in remote cwd (not local child process). ACP framing remains in TS over generic `streams`.
4. Initialize ACP, negotiate protocol/capabilities, open a session, forward user prompt and stream partial messages, tools, errors, usage/state updates if supported. Persist transcript via `ai-sessions` and its typed persistence API.
5. Populate agent/model/reasoning/mode selectors from actual agent-advertised session configurations; disable unsupported controls with a reason. Different providers have different sets of options. Selection must result in real protocol updates when the agent supports them.
6. On workspace switch, do NOT migrate an existing session to a different machine/cwd. Keep it attached to its original workspace; show the correct existing conversation or start a new one for the newly selected workspace.
7. On `acp` or `ai` module hot-swap, preserve native process + stdio handles, pending transcript, session routing metadata and permission queue. If a breaking ACP parser state cannot be migrated, defer swap while active, drain/checkpoint it or reconnect explicitly; never pretend an active protocol session can always be reconstituted from a stream at arbitrary byte offsets.

**ACP implementation note:** read the current `agentclientprotocol.com` specification before coding. Its `session/new`, `session/prompt`, session config options, modes and MCP integration are version/capability-dependent. Do not hardcode a mythical universal `reasoning` parameter. Integrations should use known-compatible Codex/Claude ACP adapters *installed and authenticated on the workspace machine*; a direct SDK or proprietary API is not a substitute for ACP.

### 9.5 AI chat, autopilot and permissions

The `ai-sessions` service owns conversation records and requested policy. The `ai` UI owns layout and control handlers, not native approval authority. Provide:

- conversation picker for current workspace; streaming user/assistant/tool messages and status;
- select configured ACP agent, advertised model, reasoning level and agent mode;
- **Ask** (default), **Auto-approve low-risk**, **Autopilot** (explicit opt-in); show effective policy and rejected actions;
- internal MCP toggle (working) and disabled external MCP placeholders;
- cancel prompt/session and errors with provider/host diagnostics.

Autopilot is **not** permission to bypass kernel policy. In particular, operations to patch, build/activate or roll back application modules via Internal MCP require a fresh explicit trusted native approval in the POC, even when autopilot is selected. Host approval cannot be synthesized by a module or agent. For read-only diagnostics, a separately approved grant may allow automatic operations. Tool success is acknowledged only after actual operation succeeds.

### 9.6 Internal MCP: swappable TS service, privileged kernel broker

`internal-mcp` implements an actual MCP server in TS and registers *tools and skills* discovered by a configured ACP adapter. The tool definitions, argument validation, prompts/skill descriptions, policies and dispatch live in TS. The kernel implements ONLY byte-stream/socket piping and approval enforcement.

Required tools (logical names; actual MCP tool names can be namespaced):

| MCP tool | Behavior | Approval |
| --- | --- | --- |
| `modules.list` | Active/staged/generations/versions, health | read grant |
| `modules.describe` | Module manifest, contracts, dependencies, diagnostics | read grant |
| `modules.read_source` | Read allowlisted module source paths | read source grant |
| `modules.apply_patch` | Apply a validated diff to allowlisted module sources; make a backup | explicit native approval |
| `modules.build` | Trigger esbuild versioned artifact, return compiler diagnostics | explicit native approval for AI-initiated build |
| `modules.activate` | Stage/check/swap one built module generation | explicit native approval |
| `modules.rollback` | Switch back to prior healthy generation | explicit native approval |
| `modules.logs` | Bounded module-specific logs, redact secrets | read grant |

Skills are versioned Markdown/metadata files maintained by the `internal-mcp` service, for example `inspect-module`, `patch-module`, `build-and-test-module`, `activate-and-verify`, `rollback-module`. The MCP service may advertise skills via its own resources/prompts/tools or another agent-compatible mechanism after probing adapter support; do not claim a generic ACP agent understands a nonstandard skill feature merely because the files exist. A tool may return skill text explicitly.

The `module-dev` TS service implements the source patching/build policy and uses the kernel's **generic** permissioned file/process and module-stage primitives. It invokes esbuild via an approved local process executable, reads diagnostics, performs integrity checks, and then requests kernel atomically swap generations. The kernel need not understand TypeScript or esbuild; it only understands a module artifact, static manifest, approved grants and lifecycle.

Never let an AI replace the kernel binary or its native approval implementation as part of this POC. The internal MCP server itself can be hot-swapped, but the resource/transport bridge must keep existing request streams safe and explicitly reject/resume any incompatible in-flight request.

### 9.7 Remote Internal MCP bridge (must work)

Remote agents run on the remote workspace machine, but the local app's Internal MCP is a local TS service. A remote agent **cannot use the remote host's `localhost` to reach the desktop machine**. Build a genuinely functional bridge:

1. The Rust SSH primitive establishes a **loopback-only SSH reverse forwarding** channel (`remote 127.0.0.1:<ephemeral> -> local 127.0.0.1:<ephemeral>`) with scoped, short-lived capability; do not expose a public listener.
2. The TS `internal-mcp` service serves authenticated MCP requests on the local end (or over a kernel-owned loopback byte-stream bridge). Do not expose an unauthenticated MCP port.
3. Deploy a **small versioned remote stdio-to-loopback proxy** to an app-controlled remote path through SFTP, with user consent. For POC a tiny Node.js script is acceptable on remote hosts where the ACP adapter already requires Node; otherwise document and check a different compatible remote runtime. The proxy itself only forwards framed MCP messages, not application-specific tool logic.
4. When starting remote ACP, provide that proxy as the MCP server command in the agent's actually supported MCP configuration; pass a one-use/session-scoped secret through an appropriately protected mechanism. Ensure local internal tool grants remain bound to this agent session/workspace, not arbitrary SSH clients.
5. Close/revoke tunnel and secret when session ends; enforce tool allowlist and native confirmations on the local machine. Handle port collisions, reconnection and stale proxy cleanup explicitly.
6. Test with a real SSH host and real ACP-compatible adapter; if the adapter does not support the required MCP transport/configuration, report **unsupported** rather than claiming success. Never silently run the remote project agent locally.

If stdio bridging is easier to implement without TCP (e.g., SSH channel multiplexing), it is an acceptable alternative as long as it is interoperable with the adapter's MCP requirements, scoped to the target SSH machine and does not expose the local MCP to untrusted networks.

## 10. Self-modification, module versioning and hot-swap

### 10.1 Storage layout

```text
modules/
  services/
    workspace/{manifest.json,src/index.ts}
    persistence/{manifest.json,src/index.ts,migrations/001_init.sql}
    projects/{manifest.json,src/index.ts}
    git-tasks/{manifest.json,src/index.ts}
    files/{manifest.json,src/index.ts}
    terminals/{manifest.json,src/index.ts}
    acp/{manifest.json,src/index.ts}
    ai-sessions/{manifest.json,src/index.ts}
    internal-mcp/{manifest.json,src/index.ts,skills/}
    module-dev/{manifest.json,src/index.ts}
  ui/
    workspace-layout/{manifest.json,src/index.ts}
    projects-panel/{manifest.json,src/index.ts}
    explorer/{manifest.json,src/index.ts}
    viewer/{manifest.json,src/index.ts}
    terminal-panel/{manifest.json,src/index.ts}
    ai/{manifest.json,src/index.ts}
.sdk/
  types.ts
runtime-data/                  # ignored; user data location normally OS app-data
  artifacts/projects-panel/0001.mjs
  artifacts/projects-panel/0002.mjs
  module-registry.json
  sqlite/persistence.db
  logs/
```

Use a deterministic version numbering scheme per logical module, with content hashes for integrity. Build to staging before activation. Never overwrite a currently running version in place.

### 10.2 Swap protocol

```text
source edited
   -> build into NEW artifact (do not overwrite active)
   -> validate manifest, ABI, dependency contracts, capability grants
   -> start staged QuickJS worker / evaluate module
   -> restore candidate state + run init/healthcheck
   -> fence incoming actions / snapshot active state
   -> atomic generation route switch (UI + RPC + events)
   -> resume queued operations and verify health
   -> drain/retire old worker; retain old artifact for rollback
```

Mandatory guarantees:

- Changes to TypeScript source/logic/layout/ACP/MCP tools do NOT rebuild Rust.
- The newly staged generation cannot acquire additional native permissions without trusted user approval.
- Old events/callbacks cannot mutate the new module's state after swap. Generation IDs tag events, timers, subscriptions and outstanding RPC operations.
- Resource ownership is independent of JS generation: a shell, document buffer, process, SSH session and UI window remain available via stable handles. **A module must not close resource handles it does not own**; retiring one generation must release only its own subscriptions/leases, not shared resources still referenced elsewhere.
- On failed build/evaluation/init/state migration/healthcheck, retain the previous active version and show diagnostics. If new version fails after promotion, allow a safe rollback; automatic rollback may be triggered by a bounded smoke/health test, never hide the error.
- Module snapshot is small versioned JSON; durable source of truth is SQLite service data or native handle state. A service upgrade can include a schema migration, but destructive/irreversible migrations must be staged carefully and may require a full safe backup/explicit maintenance action. A module swap is not a magical transactional rollback of filesystem or database side effects.
- If a service cannot safely swap mid-flight (particularly ACP protocol parsers or persistence migrations), it must **defer activation**, drain requests or perform a controlled per-service restart. The Rust window remains open. Do not promise seamless swap of arbitrary active operations.
- Revert to last-known-good signed/hashed artifact if required for recovery; keep a bootable safe-mode UI if application modules fail.

Version routing rules:

- Public address is `moduleId` or a stable service contract; private generation is `moduleId@0002`.
- New RPCs after cutover target `@0002`; in-flight RPCs to `@0001` finish within a deadline or are cancelled with an explicit retryable error.
- Event subscribers from `@0001` are removed on retirement. Durable state remains in service database, not leaked VM globals.
- A project click or AI permission decision MUST not be delivered twice during cutover.

### 10.3 Simple example of self-patching

1. User asks the ACP agent: “Add a refresh button above the Projects tree.”
2. ACP discovers Internal MCP `modules.describe`/`modules.read_source` and examines `projects-panel`.
3. Agent proposes a diff using `modules.apply_patch`. Native approval shows exact module, paths, changed lines and requested capabilities.
4. On approval, `module-dev` applies patch, builds `projects-panel.0002.mjs`, and performs validation.
5. Agent calls `modules.activate`; after a second explicit approval, kernel activates it. Existing workspace selection, PTY and AI session remain intact.
6. The new refresh button becomes visible and works; `modules.rollback` restores the previous UI version. No Rust recompile or app restart.

Also demo swapping one **service**: change `projects` sorting or tree-label construction in TS; rebuild/activate it and observe new behavior without changing the persistent project/task database.

## 11. Security and trust model

This design lets agents modify executable application code; it must be honest about risk.

1. **Trust boundary is the Rust capability broker**, not QuickJS isolation alone. Separate VMs protect module state/lifecycle, but native host APIs are the real authority. QuickJS by itself is not a strong sandbox for untrusted adversarial code with broadly granted host APIs.
2. Module manifest is untrusted metadata. Trusted install/grant registry is protected by the host; a module cannot rewrite or self-approve its grant record.
3. Source patching, module builds, new native permissions and activation require real user authorization in a GPUI/kernel-controlled interface; autopilot does not bypass them in the POC.
4. Commands use argv and vetted remote shell quoting. Do not use arbitrary `shell -c` from interpolated untrusted strings in service code. A terminal is separately user-authorized to run a shell.
5. Verify remote SSH host identity; prefer SSH agent and key-file references, avoid passwords/secret bytes stored in SQLite, redact all access tokens and MCP bridge secrets in logs.
6. Prevent a JS service from reading other services' databases via generic DB handles; enforce namespace by separate database file and scoped grants.
7. Restrict workspace paths via canonicalized roots and handle symlinks/path traversal; authorize access to module source separately from project files.
8. Put timeouts, memory limits and bounded queues around QuickJS, native processes and IPC; close leases at retirement. Network listeners are loopback-only and authenticated.
9. A remote agent receiving the internal MCP bridge does not gain unrestricted local filesystem access. Module tools operate on explicitly allowlisted source roots with per-operation approvals.
10. Log module generation, tool/operation ID, result and approver status, but not secrets or full ACP prompts by default. Expose clear errors rather than swallowing failures.

## 12. Development and build experience

A fresh checkout should be reproducible with familiar commands. Final instructions must be tailored to actual platform dependencies, not invented successes.

```sh
# Example developer flow (scripts must be implemented in this repository)
npm ci
npm run modules:build
cargo run -- --root .

# In a second shell, incremental module development
npm run modules:watch

# Unit/integration testing
cargo test
npm test
```

Do not require an embedded Node runtime for normal app startup after artifacts are built. For source build/development, Node/npm/esbuild are allowed. Do not download private dependencies from arbitrary sources at runtime. `--data-dir` selects isolated app state for POC tests; document external prerequisites for native GPUI libs, Git, ACP adapters, SSH host and remote Node helper where applicable.

**Performance goals (not promises):** keep startup and idle footprint small, never run heavy work on the GPUI thread, benchmark cold/warm startup and idle RAM, and report actual measurements on the development machine. Prefer an incremental module build over Rust rebuild. Do not claim a numerical memory target without measurement.

## 13. Implementation milestones: strict order for Codex

Do not attempt to implement everything in one enormous untested commit. At the end of every milestone, compile/run and demonstrate its acceptance checks. Where external prerequisites are missing (SSH server or ACP CLI), provide a clearly documented real integration test command and report it unverified until executed — do **not** replace it with a mock in the final POC.

### M0 — Pin GPUI + verify native prerequisites

- Inspect upstream GPUI and matching `gpui-component` versions; pin dependencies and lockfiles.
- Launch one native window on the development OS.
- Check a syntax-highlighted read-only editor and an actual terminal-grid component; document selected libraries and known platform limitations.

### M1 — Rust microkernel and QuickJS SDK

- Implement module manifest loader, single-runtime-per-module-worker, typed bridge, event loop, RPC and keyed declarative GPUI adapter.
- Provide generic capability handles, immutable grant upper bounds, native approval chrome, recovery/logging and a JS module loader.
- Prove that a TS UI change becomes visible without restarting Rust.
- **Architectural gate:** Rust source must contain no project/task/ACP/MCP domain logic. Verify explicitly before proceeding.

### M2 — Persistence + workspace + project UI in TS

- Build TS `persistence`, `workspace`, `projects`, `workspace-layout`, `projects-panel` with actual SQLite schema/migrations and typed persistence access.
- Launch with `--root`, add second local project, tree expand/select, restart and recover state.
- Demonstrate replacing the projects-panel module and one projects service method.

### M3 — Files + syntax viewer + real local PTY

- Implement TS `files`, `terminals`, `explorer`, `viewer`, `terminal-panel`; real native handles for viewer and PTY.
- Navigate folders and syntax-highlight a real source file, run shell commands, resize terminal.
- Hot-swap UI module without losing terminal process and workspace context.

### M4 — Local Git tasks

- Implement `git-tasks` in TS, creating real branches/worktrees using local process capability.
- Validate clean and dirty main checkouts, real `git worktree list`, switching root/task, and persisted task metadata.

### M5 — SSH projects and remote task contexts

- Configure/validate SSH profile; SFTP file browsing, remote syntax viewer, SSH PTY.
- Create remote Git task/worktree **on the remote host** and verify cwd and task isolation.
- Reconnect after temporary disconnection; no silent local fallback.

### M6 — Local ACP + AI UI

- TS `acp` and `ai-sessions`, UI `ai`: real compatible Codex or Claude ACP command available locally, streaming, cancel, session list and negotiated config selectors.
- Implement native approval chrome and separate display state from the running process.
- Test switching from project root to task without reusing wrong cwd/session.

### M7 — SSH ACP

- Start ACP process via remote SSH stdio on selected remote root/worktree, verify `cwd`/machine in real logs/diagnostic command.
- Chat streams to native AI panel; no cloned project and no local execution fallback.

### M8 — Internal MCP, skills and remote MCP bridge

- TS `internal-mcp` implements real MCP over a local adapter; TS `module-dev` implements module source/patch/build policy.
- Wire trusted native approval to specific tool invocations.
- Test an actual local ACP discovering and invoking `modules.list` and proposing a module change.
- Implement and test protected SSH reverse bridge to remote ACP and local module tools.
- Prove remote ACP can patch/build/activate a local UI module with native user approvals.

### M9 — Robust hot-swap, rollback, documentation

- Swap service and UI modules transactionally with generation fencing, test failure before/after cutover and preserve PTY and AI process resources.
- Tests for two projects, multiple tasks, SSH offline case, broken module artifact, revoked grant, stale listeners and DB reopen.
- Update README with setup, compatibility matrix, example module contracts, limitations and real measured runtime stats.

## 14. Acceptance criteria

A working POC must pass **all** the following; report missing prerequisites as blockers, not passes.

### Native and microkernel

- [ ] Runs a real GPUI native window, not Chromium/WebView/Electron.
- [ ] Rust kernel contains no project/task/Git/ACP/MCP *business logic*. Its DB interface is generic, and app SQL migrations are in TS.
- [ ] TS module `projects-panel.0001` builds and loads at startup.
- [ ] Editing TS renders a changed keyed UI and swaps `projects-panel.0002` **without Cargo recompile or application restart**.
- [ ] A TS **service** `projects` method can be swapped without kernel recompile and existing records are retained.
- [ ] Kernel broker denies ungranted capabilities even if a module requests them or changes its manifest.

### Projects, files, Git, terminal, persistence

- [ ] Projects left panel displays local/SSH projects with expandable Git task children; click-to-select is different from expand/collapse.
- [ ] Register at least two local projects, at least one SSH project and a non-Git project, and persist across restart.
- [ ] Create two different task worktrees in a local Git project and one worktree in an SSH Git project. `git worktree list --porcelain` confirms them on correct machines.
- [ ] Select parent root vs each task and observe correct explorer, source viewer, terminal cwd and session context.
- [ ] Open real `.ts`, `.rs` or other recognized source file with legible syntax highlighting; handle non-text files sensibly.
- [ ] Local terminal and remote terminal are interactive PTYs (colors, resize, running commands), not command-output mocks.
- [ ] After UI/service hot-swap, an existing PTY continues running and is reattached.
- [ ] After restarting the desktop app, project/task tree and per-workspace selections restore (live process resources need not survive full restart).

### ACP, AI chat, MCP

- [ ] ACP selection uses configured/available real Codex or Claude adapters, with model/reasoning/modes read from advertised capabilities; unsupported selectors correctly disabled.
- [ ] Local project/task session launches ACP **locally** with exact workspace root as `cwd`.
- [ ] SSH project/task session launches ACP **remotely** through the selected project's SSH identity with exact remote root/worktree as `cwd`.
- [ ] Chat streams real messages and tool statuses and allows cancellation and policy selection.
- [ ] Independent conversations belong to each project-root/task workspace and persist as displayable cached history.
- [ ] Agent tools discover a real internal MCP with `modules.list`, `modules.apply_patch`, `modules.build`, `modules.activate`, and `modules.rollback` (plus diagnostics).
- [ ] AI-initiated module modification and activation require explicit, trusted native user approval even with Autopilot enabled.
- [ ] Remote ACP reaches **local** Internal MCP through authenticated SSH bridge and can propose/activate a local module patch with user approvals.
- [ ] External MCP selector exists but is clearly unavailable for POC; no claim of supported third-party MCP servers.

### Reliability / validation

- [ ] Invalid TS build does not replace active module; diagnostics are visible and previous version remains usable.
- [ ] Invalid runtime activation fails safely, and a last-known-good generation can be restored.
- [ ] Replacing `ai` UI module does not terminate ACP process or erase conversation; replacing `acp` service while a session is busy is either safely transferred or explicitly deferred.
- [ ] Module listeners/timers are not duplicated after repeated swaps; aborted/expired streams release resources.
- [ ] SSH failure never silently changes a remote operation into a local one.
- [ ] Source patch attempts outside the allowlisted module source root are denied.
- [ ] Cargo/TS tests and required integration flows are documented, with passes/fails based on actual execution.

## 15. Testing approach

- **Rust:** capability broker, manifest/grant enforcement, UI node validation, resource leases, swap state machine, generation ID routing, timer/stream cleanup, and startup safe mode.
- **TS:** workspace resolution, project metadata, Git commands and quoting, file path validation, DB migrations, ACP JSON-RPC framing and config parsing, MCP tool validation, AI conversation state, render tree composition.
- **Integration:** temp Git repos (`git init`, commit, `worktree add`), isolated `--data-dir`, local PTY running a long command, real local ACP, real SSH test host and remote MCP. Use synthetic ACP fixture only for unit tests, not as proof of real agent interoperability.
- **Failure injection:** TS syntax error, runtime throw on activate, hung JS event handler, DB locked, remote SSH disconnect, stale capability, invalid MCP token, module swap mid-RPC, terminal module reload while shell remains active.
- **Performance:** startup timing, idle memory, module rebuild latency, module swap latency, and UI responsiveness during Git/SSH/ACP work. Report measured values, not assumptions.

## 16. Explicit non-goals

- Full IDE/editor capabilities (editing/saving files, LSP, debugger, Git diff UI, terminals multiplexing beyond basic reuse).
- Native plugin code loading/ABI-stable Rust DLL hot-reloading. All hot-swappable modules are JS/TS.
- Arbitrary third-party MCP installation/management. Show selector placeholder only.
- Runtime compilation or hot-replacement of the Rust microkernel itself.
- Copying staged/unstaged/untracked dirty state into a newly created task worktree.
- Worktree/task deletion, merges, complex branch management, SSH remote Windows shells.
- Exact platform-independent memory/binary size guarantees; measure instead.
- Automatically installing or authenticating Claude/Codex ACP adapters or downloading unknown binaries.

## 17. Instructions to the coding agent

1. **Treat this document as requirements, not runnable implementation.** The TS examples and host SDK are interfaces to implement and refine, not existing library functions.
2. **Start with verifying dependencies and completing M0–M1.** Do not generate 50 fake source files with TODO handlers and call it a POC.
3. **Keep the kernel generic.** If a Rust function starts looking like `createGitTask`, `startClaude`, `createProject`, `saveConversation`, or `mcpModulesBuild`, move its implementation into TS and expose only the necessary native primitive.
4. **Do not compromise execution locality.** Local and SSH workspace machine identity is part of every file/terminal/Git/ACP request.
5. **Do not overengineer:** one GPUI window, compact core UI schema, one persistence TS service/database, short direct RPC and observable state are sufficient for the first iteration. Implement the whole specified flow before designing an extension marketplace.
6. **Keep the app usable during errors.** Module build failures, remote SSH failures, unavailable ACP adapters and absent MCP support must give actionable errors and maintain old active functionality.
7. **Prefer independently testable services.** Put project, Git, ACP, MCP and module-dev business logic in TS even if a Rust implementation seems quicker in the short term.
8. **Run and document actual tests** after milestones. Do not claim “remote ACP works” unless it was tested against a real SSH machine and adapter.
9. **Report any architecture violation**, including a forced Rust business subsystem, extra native API surface, or unsafe broad grant, with rationale and an alternative. Do not silently change the microkernel boundary.
10. The final demo must show: launch app -> open local or SSH Git project -> create/select task -> inspect file -> use real terminal -> start ACP on correct machine -> ask AI to patch a UI module via Internal MCP -> approve -> rebuild/swap -> observe new UI without native restart -> roll back.

**Definition of done:** The application is useful as a local/remote project shell and demonstrates that its interface, business logic, ACP integration and internal MCP evolve through **TypeScript module replacement**, while a small trusted Rust kernel continues hosting persistent native resources.
