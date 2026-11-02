# Architecture: Hot-Swappable Native Modular Desktop Runtime

**Status:** POC implementation specification  
**Audience:** Codex / implementation agent  
**Target platforms:** macOS, Windows, Linux  
**Priority:** Working end-to-end POC over framework completeness

## 1. Objective

Build a **new, standalone desktop platform** with a small stable native host and replaceable TypeScript UI/behavior modules. This project is **not HatoPad** and must not depend on its code. Git tasks follow the same broad concept: persistent, isolated worktrees under a parent project.

The POC must provide:

1. A **Projects** panel at far left, an expandable persistent tree of local and SSH projects and Git worktree tasks under each project.
2. A file explorer for the selected project's root or selected task worktree; a read-only, syntax-highlighted file viewer; and an **actual interactive local or remote PTY** terminal.
3. An **AI chat panel** implemented as an independently hot-swappable `ai` TypeScript module: classic streaming chat, ACP provider selector (Codex/Claude adapter), model and reasoning selectors, an autopilot/permissions control, and an MCP selector.
4. **Workspace-bound ACP execution**: an ACP agent for a local project or local task executes on the **local computer**, with its working directory set to that project's root or task worktree; an ACP agent for an SSH project or remote task executes **on the same SSH host as the project**, with `cwd` set to that remote root/worktree. **Never silently run remote-project ACP locally or copy the project locally.**
5. A built-in, host-owned **Internal MCP server** providing approved tools and skills to inspect, patch, build, activate, roll back, and diagnose hot-swappable application modules. Local AND remote ACP agents can use it. Third-party MCP profiles appear in a selector, but integrating arbitrary external MCP servers is deferred.
6. **SQLite persistence** for projects, SSH profiles, task/worktree mappings, expanded tree/selection, AI agent configuration, chat/session metadata, and per-workspace UI state.
7. **Transactional, approval-gated module hot-swap**, without Rust host rebuild or restart: an agent can propose source changes, invoke the internal toolchain to build `projects.0002.mjs`, request activation, and see the Projects UI update after user approval without losing the active workspace, terminal, or AI conversation.

Git projects must create **real** task branches + linked Git worktrees on the machine holding the project. Different tasks have distinct working directories, terminal contexts, and AI conversations. A parent project row selects its original checkout; child rows select their worktrees. Project expansion and selection are separate gestures.

**There is no virtual/internal Modules project in the Projects sidebar.** Module source files are host-managed developer resources accessible through restricted Internal MCP tools and ordinary source-code tools *when explicitly authorized*, not registered as user projects.

All application layout and handlers are declared by hot-swappable TypeScript modules. Rust owns native windows/GPUI rendering, SQLite, file-system/SSH/Git/PTY resources, ACP processes and conversations, MCP tool execution and permission enforcement, and module lifecycle. An AI UI module reload must not kill or reset its host-owned ACP process/session.

**POC priority:** a working end-to-end slice across local/SSH project, task worktree, explorer/viewer/terminal, local/remote ACP chat, internal MCP module rebuild/hot-swap, persistence, and failure handling. Favor real thin implementations over mock integrations and a prematurely generic IDE framework.

## 2. Firm technology decisions

| Layer | Choice | Reason |
| --- | --- | --- |
| Native window/rendering | **Rust + GPUI** | Native, GPU-rendered UI without Electron, Chromium, DOM, or a system WebView. |
| Native UI components | **gpui-component / gpui-kit** (compatible release) | Avoid rebuilding source-code rendering, text selection, lists, and layout primitives from scratch. |
| Dynamic module language | **TypeScript**, bundled to JavaScript | Easy to author, inspect, modify, and rebuild automatically. |
| Embedded JS VM | **QuickJS via `rquickjs`** | Small, replaceable runtimes, no Node.js process required at application runtime. |
| Module build | **esbuild** | Fast TS-to-JS bundling and self-contained module artifacts. Node.js is required for builds and *may additionally be required on an ACP target host* by the chosen Codex/Claude adapter. It is not embedded in the UI host. |
| Local terminal process | **`portable-pty`** | Native PTY/ConPTY across macOS, Linux, and Windows. |
| Remote project transport | **`ssh2`** (libssh2) | SSH connection + SFTP listing/reading, remote command execution, and remote PTY channels from the Rust host. |
| Persistent application database | **SQLite via `rusqlite` (`bundled`)** | Small embedded database, no external server or system SQLite installation needed. |
| Git task workspaces | **Git CLI** (locally or via remote SSH execution) | Actual worktrees/branches, not fake copies or isolated `git clone`s. |
| Terminal emulation/view | Prefer a **compatible GPUI terminal component** built on `alacritty_terminal`; otherwise integrate `alacritty_terminal` with a small GPUI renderer | A PTY produces escape sequences; it is not, by itself, a terminal emulator. |
| ACP client | Official Rust `agent-client-protocol` SDK, pinned to compatible release | Negotiate ACP protocol + capabilities; stdio child processes locally or stdio tunneled over SSH remotely. |
| ACP implementations | Configured `@agentclientprotocol/codex-acp`, `@agentclientprotocol/claude-agent-acp` commands | Real separate agents, installed/authenticated on **the machine where the project lives**. Detect availability rather than assuming either is installed. |
| Internal MCP | Host-owned MCP tool server, stdio transport + authenticated remote stdio bridge | Allow both local and SSH agents to call app module lifecycle tools. No third-party MCP execution in the POC. |
| Native concurrency | Rust channels and background tasks/threads | Never run JS, ACP streams, MCP, file I/O, or PTY reads on GPUI's UI thread. |
| Wire format (POC) | Versioned, serializable JSON-like messages | Simple to inspect/debug. Do not send large terminal output or entire documents through the module bus every frame. |

### Version compatibility rule

GPUI and its companion libraries are evolving. **Before writing the implementation**, inspect upstream current examples and choose a **single mutually compatible, pinned** set of GPUI + component + terminal dependencies. Commit `Cargo.lock` and `package-lock.json`. Do not combine arbitrary git `main` dependencies from unrelated forks. The API snippets below describe **our proposed SDK**, not existing GPUI or `rquickjs` functions.

A compatibility problem with a third-party terminal widget is **not** a reason to replace the terminal with a fake command-output panel. Use `portable-pty` plus a proper terminal emulator/grid implementation instead.

## 3. Architecture overview

```text
+----------------------------------------------------------------------------+
|                       LOCAL RUST HOST / GPUI                               |
|                                                                            |
|  Native window, GPUI UI adapter  <--- keyed UI tree / events               |
|             ^                                                              |
|  Module registry + router ---- QuickJS workers:                             |
|                |                 workspace | projects | explorer           |
|                |                 viewer | terminal | ai                    |
|                |                                                           |
|  Core services (host-owned, survive TS module swaps):                      |
|    - SQLite: projects, Git tasks, ACP profiles, chat sessions, UI state    |
|    - Workspaces: LocalFS / SSH SFTP, Git worktrees, documents, PTYs        |
|    - ACP Client/Session Manager + permission broker + transcript cache     |
|    - Internal MCP server: skills, module source, build/swap/rollback        |
|    - Module Builder + versioned artifacts + transactional hot-swap         |
+----------------------------------------------------------------------------+
             | local child stdio                  | SSH stdio channel
             v                                    v
    Local ACP: Codex / Claude           Remote ACP: Codex / Claude
    cwd = local root/worktree           cwd = REMOTE root/worktree
             |                                    |
       internal MCP stdio                remote MCP stdio proxy
             |                                    |
             +--- host MCP tools <--- secure SSH reverse bridge --+
                          (no public listener)
```

### Non-negotiable architectural boundaries

- TypeScript **modules declare UI and handle application events**. They have no direct access to Rust/GPUI types, SQLite, unrestricted OS APIs, or direct references to other JS runtimes.
- Rust **owns real resources**: windows, terminal/document buffers, SSH channels, project/task records, ACP subprocesses and sessions, MCP server, approvals, build pipelines, and state. Resource IDs must never depend on module generation.
- **ACP is project/workspace contextual, not a global process**. Resolving an `activeWorkspaceId` gives the machine, root directory and SSH profile to execute the agent. A task in a remote Git worktree runs the agent in **that remote worktree**.
- The host's Internal MCP is **app-local** even when invoked by an ACP agent on SSH. Remote agents must use an authenticated, explicit bridge back to host services; do not call host localhost from a remote agent as if it were the same machine.
- AI sessions are identified by stable `(workspaceId, agentProfileId, conversationId)` semantics. Switching projects selects the corresponding chat/sessions; it does not re-home an existing agent or mutate its `cwd`.
- Module bus uses logical module IDs, generation-safe callbacks, bounded messages, and resource handles. UI modules never retain raw native pointers.
- Host-owned sensitive actions (`modules.apply_patch`, activation, remote helper provisioning) are checked by a **host-level approval broker** independently of ACP's own permissions/autopilot settings.
- A project path is not a project ID. Resolve opaque `projectId`, `taskId`, and `workspaceId` to local/remote roots; never mix their namespaces.

## 4. POC modules and user experience

Create **six** independently hot-swappable TS modules:

| Module ID | Role | Required behavior |
| --- | --- | --- |
| `workspace` | Main window layout | Declares far-left Projects sidebar, file explorer, source viewer, AI chat pane, bottom terminal and status. Mounts other modules with keyed slots. |
| `projects` | Local / SSH projects and tasks | Expandable project→task tree, add/select projects, create Git worktrees, persistent selection/expansion. **No virtual Modules project.** |
| `explorer` | Files for selected workspace | Directory listing and open-file events; local or remote provider is chosen by host. |
| `viewer` | Source file preview | Native read-only syntax-highlighted control with host-owned document handles. |
| `terminal` | Persistent interactive shell UI | Reattach to host-owned local PTY or SSH PTY matching selected workspace. |
| `ai` | ACP chat and settings | Lists available Codex/Claude ACP configurations on the selected workspace machine; chat transcript/prompt/cancel; dynamic model/reasoning/mode selectors; autopilot policy; Internal MCP toggle/status; tools, approvals, session selection. |

### 4.1 Target layout

```text
+----------------------------------------------------------------------------------------------------+
| Modular Native POC                      Project A / Task 1                         [AI Settings]    |
+----------------------+--------------------+------------------------------+-----------------------+
| PROJECTS             | FILES              | FILE VIEWER                  | AI / ACP              |
| [+ Local] [+ SSH]    | src/               | src/main.ts                  | Agent: [Codex v]      |
|                      |   main.ts          |                              | Model: [dynamic v]    |
| v Project A [local]  |   app.ts           | // syntax highlighted        | Reasoning: [v]        |
|   > Task 1 [git]     | package.json       |                              | Autopilot: [Ask v]    |
|     Task 2 [git]     |                    |                              | MCP: [x] Internal    |
| v Project B [SSH]    |                    |                              | [ ] External (later)  |
|     Task 1 [git]     |                    |                              |-----------------------|
|                      |                    |                              | User: fix sidebar...  |
|                      |                    |                              | AI: I'll inspect...   |
|                      |                    |                              | tool: modules.build   |
|                      |                    |                              | [Approve] [Deny]      |
|                      |                    |                              |-----------------------|
|                      |                    |                              | [Prompt...]    [Send] |
+----------------------+--------------------+------------------------------+-----------------------+
| TERMINAL / Project A / Task 1  (real local PTY or remote SSH PTY)                                  |
| $ pwd                                                                                              |
| .../worktrees/...                                                                                  |
+----------------------------------------------------------------------------------------------------+
| ACP connected [local/remote] · modules: workspace@1 projects@2 ... ai@1 · [Module status]         |
+----------------------------------------------------------------------------------------------------+
```

Tree behavior:

```text
Projects
  v Project A [Local, Git]
      Task 1  [Git worktree]
      Task 2  [Git worktree]
  v Project B [SSH, Git]
      Task 1  [Remote worktree]
  > Project C [Local, non-Git]
```

- Project row selects the original checkout. Task row selects its linked worktree. Chevron expands/collapses without selecting.
- A Git project can create a task; non-Git projects do not show New Task. Project rows and tasks have stable IDs across restarts.
- On a workspace selection change, explorer/viewer/terminal **and AI chat** switch context to the new workspace, preserving old workspace sessions and UI state.
- `AI Settings` configures ACP commands on **the execution machine**: local configuration for local projects, remote agent configuration for projects on the given SSH host. Each project may override the machine default; do not assume local executables exist remotely.
- Agent selector contains only configured/available adapters for the selected target machine; provide configuration, detection, installation hints, and actionable error states. Do not auto-install arbitrary binaries.
- Each session has its own ACP process/session lifecycle. Switching away does not kill a busy session. A user can cancel/close explicitly.
- Model and reasoning selectors are populated from the **agent's advertised ACP capabilities/session config**, not a hardcoded cross-provider list. Disable unsupported controls with explanation. Selection of agent/reasoning must affect a real ACP session.
- Autopilot/permissions choices are **Ask**, **Auto-approve low-risk** and **Autopilot (explicit opt-in)**. These control host permission handling and may map to agent-supplied modes when supported; they do not magically override an ACP adapter or host MCP safety rules. The UI always shows the effective policy.
- MCP selector offers **Internal MCP** (functional, enabled by explicit session selection, on by default for trusted dev POC) and **External MCP (coming later, disabled)**. Never claim third-party MCP support in POC.
- Show streaming assistant/user messages, tools and statuses, errors, approval requests, stop/cancel, and a conversation picker for the current workspace. Avoid hardcoded fake model lists or fabricated assistant answers.

### 4.2 Project / task / workspace semantics

**Project**: persisted named absolute folder on either the local host or one SSH server. Types are exactly `local` and `ssh`; no synthetic project. At first launch seed `--root <path>`/`cwd` as a local project if it is not already registered.

**Task**: a persisted Git branch + linked worktree under a parent project; the worktree exists **on the parent's machine**. Every task is an independently selectable workspace with its own files, terminal and AI sessions. Dirty working changes in the parent checkout are **not** copied by the POC worktree creation flow; warn before creating.

**Workspace** IDs:

- Project root: `project:<projectId>:root`
- Worktree task: `task:<taskId>`

A workspace resolves to an immutable execution context: `{workspaceId, projectId, taskId?, location: local|ssh, machineId, rootAbsolutePath, sshProfileId?}`. `rootAbsolutePath` is understood **on that machine**, never transported to the opposite OS as a local path.

Every FS, Git, terminal and ACP operation is scoped to the correct workspace. For remote tasks all remote operations share the project's SSH identity and remote worktree path.

**Persistence:** selected project/task, tree expansion, explorer directory, file preview, terminal stableKey and AI conversations/settings persist across UI module changes and application restart. Live PTYs and ACP processes need only survive module swaps and workspace switching in the same app process. After full app restart, recover sessions only through actual adapter-supported `session/load` / `session/resume`; otherwise show cached transcript as read-only history and create a new conversation.

### 4.3 Default project seeding

On first launch, register `--root <path>` (or process cwd) once. Restore `activeWorkspaceId` and expansion/view state on subsequent launches. `--data-dir <dir>` overrides host app-data for dev/test. Do not overwrite the persisted tree with CLI defaults on each start.

The `modules/` directory remains a real host-managed source folder for build/watch and restricted module editing, but **must not** be exposed as a project or inserted as a task. The AI reaches it via explicitly selected Internal MCP tools, never by pretending it is part of a remote workspace. An external source editor may still edit it and trigger the watcher.

### 4.4 Minimal cross-module workflow

1. `projects` invokes `ctx.projects.selectWorkspace(workspaceId)`; Rust commits state then emits `workspace.selected` with the exact stable IDs.
2. `explorer`, `viewer`, `terminal`, **and `ai`** react to the same workspace ID. The host resolves the correct local or remote filesystem and execution machine.
3. `explorer` emits `workspace.openFile`; `viewer` opens a host-owned document for that exact workspace/path.
4. `terminal` reattaches to the host-owned PTY for that workspace. `ai` shows the corresponding conversation(s), ACP availability, options, and target machine.
5. In `ai`, the user picks configured Codex/Claude ACP, starts a session, and sends a prompt. The **host** spawns it locally or over the project's SSH connection, passes the workspace path as `cwd`, and streams the protocol updates back into host-owned transcript state.
6. An agent may discover `internal` MCP tools. With required user approvals, it edits a host module through `modules.apply_patch`, invokes `modules.build`, then `modules.activate`; the new UI module is hot-swapped without disturbing ACP/PTY/project resources.
7. On switching back to a workspace, the same UI, terminal, and AI conversation state reappear; moving between a project's root and task worktree **never silently moves an agent session**.

One main native window is sufficient for the POC; architecture must not prevent multiple windows later.

## 5. Proposed module SDK (our own API)

A module is a single ES module exporting a definition with a stable ID and lifecycle hooks. Author in TypeScript, bundle to ESM JavaScript.

```ts
// sdk/types.ts -- conceptual public contract, implement in this repo
export interface AppModule {
  id: string;
  apiVersion: 1;

  activate?(ctx: ModuleContext, previousState?: JsonValue): Promise<void> | void;
  render(ctx: ModuleContext): UiNode;
  onEvent?(ctx: ModuleContext, event: UiEvent): Promise<void> | void;
  deactivate?(ctx: ModuleContext): Promise<void> | void;
  snapshot?(ctx: ModuleContext): JsonValue;

  methods?: Record<string, (ctx: ModuleContext, args: JsonValue) => unknown>;
}
```

The module context is created by the host and exposes only permitted services:

```ts
interface ModuleContext {
  readonly moduleId: string;
  readonly generation: number;
  // UI/modules must use opaque workspace IDs, not ambient root paths.
  readonly activeWorkspaceId: string; // must be a live host-backed getter, not a snapshot

  ui: { invalidate(): void };

  projects: {
    list(): Promise<ProjectSummary[]>;
    active(): Promise<{ workspaceId: string; projectId?: string; taskId?: string }>;
    addLocal(input: { name: string; rootPath: string }): Promise<ProjectSummary>;
    addSsh(input: { name: string; host: string; port?: number;
      username: string; rootPath: string; authProfile?: string }): Promise<ProjectSummary>;
    selectWorkspace(workspaceId: string): Promise<void>;
    setExpanded(projectId: string, expanded: boolean): Promise<void>;
  };

  tasks: {
    list(projectId: string): Promise<TaskSummary[]>;
    create(projectId: string, input: { name: string }): Promise<TaskSummary>;
  };

  ai: {
    availableAgents(workspaceId: string): Promise<AgentProfileSummary[]>;
    configureAgent(profile: AgentProfileInput): Promise<AgentProfileSummary>;
    listSessions(workspaceId: string): Promise<AiSessionSummary[]>;
    createSession(workspaceId: string, profileId: string, options?: {
      enabledMcpIds?: string[]; policy?: "ask" | "safe" | "autopilot";
    }): Promise<AiSessionSummary>;
    sendPrompt(sessionId: string, text: string): Promise<void>;
    cancel(sessionId: string): Promise<void>;
    close(sessionId: string): Promise<void>;
    getTranscript(sessionId: string): Promise<AiMessage[]>;
    getConfigOptions(sessionId: string): Promise<AgentConfigOption[]>;
    setConfigOption(sessionId: string, configId: string, value: JsonValue): Promise<void>;
    setApprovalPolicy(sessionId: string, policy: "ask" | "safe" | "autopilot"): Promise<void>;
    setMcpSelection(sessionId: string, ids: string[]): Promise<{ needsNewSession: boolean }>;
  };

  fs: {
    list(workspaceId: string, relativeDir: string): Promise<FileEntry[]>;
    readText(workspaceId: string, relativePath: string): Promise<{
      text: string; language: string;
    }>;
  };

  documents: {
    open(workspaceId: string, relativePath: string): Promise<{
      id: string; language: string;
    }>;
  };

  terminal: {
    ensureSession(workspaceId: string, stableKey: string): Promise<{ id: string }>;
  };

  modules: {
    call<T = unknown>(targetId: string, method: string, args?: JsonValue): Promise<T>;
  };

  events: {
    emit(topic: string, payload: JsonValue): void;
    on(topic: string, handler: (payload: JsonValue) => void): () => void;
  };

  state: {
    get<T = JsonValue>(key: string): T | undefined;
    set(key: string, value: JsonValue): void;
    watch(key: string, handler: (value: JsonValue) => void): () => void;
  };
}

interface ProjectSummary {
  id: string; name: string; kind: "local" | "ssh";
  isGit: boolean; expanded: boolean; connectionState?: string;
  rootLabel: string; // display-only; not an authorized filesystem handle
}
interface AgentProfileSummary {
  id: string; name: string; kind: "codex" | "claude" | "custom";
  target: "local" | "ssh"; machineId: string;
  available: boolean; diagnostic?: string;
}
interface AgentProfileInput {
  id?: string; name: string; kind: "codex" | "claude" | "custom";
  machineId: string; command: string; args: string[];
  projectOverrideId?: string;
}
interface AiSessionSummary {
  id: string; workspaceId: string; agentProfileId: string;
  providerSessionId?: string; status: string; title: string;
}
interface AgentConfigOption {
  id: string; name: string; category?: string;
  type: "select" | "boolean"; value: JsonValue;
  options?: { value: string; label: string }[];
}
interface AiMessage { kind: string; text?: string; status?: string; timestamp: string; }
interface TaskSummary {
  id: string; projectId: string; workspaceId: string;
  name: string; branch: string; status: "ready" | "missing" | "error";
}
```

These definitions describe the intended *observable semantics*. Adjust callback or Promise plumbing to `rquickjs` constraints while preserving functionality. The SDK must provide useful TypeScript declarations even though the runtime is QuickJS.

### UI primitives (minimum set)

Represent UI with a tagged, serializable, **keyed tree**:

```ts
type UiNode =
  | { type: "column" | "row"; key: string; children: UiNode[]; flex?: number }
  | { type: "split"; key: string; direction: "horizontal" | "vertical";
      ratio?: number; children: [UiNode, UiNode] }
  | { type: "label"; key: string; text: string }
  | { type: "scroll"; key: string; children: UiNode[] }
  | { type: "select"; key: string; value?: string; options: {value: string;label: string}[];
      action: string; disabled?: boolean }
  | { type: "toggle"; key: string; checked: boolean; text: string; action: string;
      disabled?: boolean }
  | { type: "chatTranscript"; key: string; sessionId?: string } // native, host-backed
  | { type: "approvalPanel"; key: string; sessionId?: string }  // host-secured native approval UI
  | { type: "button"; key: string; text: string; action: string }
  | { type: "textInput"; key: string; value: string; placeholder?: string;
      action: string } // useful for Add Project / New Task forms
  | { type: "tree"; key: string; rows: TreeRow[];
      selectAction: string; expandAction: string }
  | { type: "slot"; key: string; module: string }
  | { type: "fileList"; key: string; entries: FileEntry[];
      selectedPath?: string; action: string }
  | { type: "codeViewer"; key: string; documentId?: string;
      readonly: true; language?: string }
  | { type: "terminal"; key: string; sessionId: string };

interface TreeRow {
  key: string; label: string; depth: number; hasChildren: boolean;
  expanded?: boolean; selected?: boolean; kind: "project" | "task";
  badge?: string; // e.g. local, SSH, Git, disconnected
}
```

`UiNode` contains **no JS functions**. Handlers are referenced by string action IDs. The host routes tree-row **selection** as `{action, rowKey}` and expansion as a distinct `{action, rowKey, expanded}` event; text inputs route `{action, value}`, selectors/toggles route `{action, value}`, and buttons route `{action}`. The host rejects unrecognized keys/actions instead of injecting them into JS. **Permission approval/denial is a direct trusted native-host interaction inside `approvalPanel`, never a `ctx.ai.respondPermission` method exposed to mutable TS module code.** The TS `ai` module may declare where to mount the panel, but cannot synthesize approval outcomes. If the AI module is broken or hidden, host chrome must still provide a secure pending-permissions queue. The `activeWorkspaceId` getter (and `ctx.projects.active()`) must return **current host state**, not a frozen value from module activation. The host validates and converts the tree into GPUI elements. The GPUI adapter should preserve native entities associated with stable `(moduleId, nodeKey)` pairs, especially the code viewer and terminal.

**Do not implement a HTML/CSS renderer or a browser DOM.** This is a deliberately small typed UI protocol. Layout styling can start with padding, gaps, flex, and split ratios; extend as needed.

### Example: workspace module

```ts
export default {
  id: "workspace",
  apiVersion: 1,
  render() {
    return {
      type: "column", key: "root", children: [
        { type: "label", key: "title", text: "Modular Native POC" },
        { type: "split", key: "content-and-terminal", direction: "vertical", ratio: 0.76,
          children: [
            { type: "split", key: "main", direction: "horizontal", ratio: 0.18,
              children: [
                { type: "slot", key: "projects", module: "projects" },
                { type: "split", key: "rest", direction: "horizontal", ratio: 0.19,
                  children: [
                    { type: "slot", key: "explorer", module: "explorer" },
                    { type: "split", key: "editor-ai", direction: "horizontal", ratio: 0.61,
                      children: [
                        { type: "slot", key: "viewer", module: "viewer" },
                        { type: "slot", key: "ai", module: "ai" }
                      ] }
                  ] }
              ] },
            { type: "slot", key: "terminal", module: "terminal" }
          ] }
      ]
    };
  }
};
```

This is a **proposed SDK**, not an existing GPUI or `rquickjs` API. Include a host-native `chatTranscript` control because high-frequency ACP message streaming should not rebuild a huge serializable JS tree on every token. The TS `ai` module declares its placement, selectors, handlers, and session selection; the host-native transcript view draws host-owned records and streaming updates.

An AI module refresh or hot-swap must only replace presentation/handlers, never the ACP child process, its stream handles, session ID, transcript cache, or pending permission requests.

## 6. Module-to-module communication

Implement **three minimal primitives**; the fourth, service discovery, can wait.

### 6.1 Request/response RPC

```ts
const current = await ctx.modules.call<string | null>(
  "viewer", "getOpenPath", {}
);
```

- Address modules by **logical ID**, not artifact path or generation.
- The registry routes each **new** call to the current active generation.
- Every request has an ID, source ID, target ID, generation, and timeout.
- Reject calls on timeout, missing module/method, exception, or disposal.
- Responses must settle exactly once. No deadlocks across worker threads.
- Preserve pending old-generation requests until completion or cancel them explicitly with a well-defined error during swap. Choose **cancel-with-`ModuleReplaced`** for POC simplicity.

### 6.2 Publish/subscribe event bus

```ts
// explorer
ctx.events.emit("workspace.openFile", {
  workspaceId: ctx.activeWorkspaceId, relativePath: "src/main.rs"
});

// viewer (registered during activate)
ctx.events.on("workspace.openFile", ({ workspaceId, relativePath }) => {
  // Open an exact workspace-scoped document handle.
});
```

- Events are asynchronous, scoped by module generation, and not guaranteed durable.
- Event callbacks registered by the retired generation must be removed automatically on swap.
- Use topic namespacing and no implicit direct imports.
- For POC, delivery in host-observed event order is sufficient; no distributed guarantees.

### 6.3 Host-owned observable state

```ts
// Host-owned view state is keyed by workspace ID, NOT one global open path.
ctx.state.set(`view:${ctx.activeWorkspaceId}:openPath`, "src/main.rs");
const path = ctx.state.get<string>(`view:${ctx.activeWorkspaceId}:openPath`);
ctx.events.on("workspace.selected", ({ workspaceId }) => {
  // Reattach views and update the active workspace.
});
```

- Use JSON-serializable values only.
- The host stores state independently of modules; replacing a module does not erase it.
- Prefer **single-writer ownership** of keys. The host owns `activeWorkspaceId` and persisted project/task records; the viewer writes only its per-workspace preview state. Explorer requests file changes through the scoped `workspace.openFile` event.
- DB-backed settings, project records, and task records are managed via typed `ctx.projects` / `ctx.tasks` methods, **not arbitrary `ctx.state` keys or SQL from JS**. Host commits selection changes and emits events afterward.
- Watchers associated with old module generations are automatically cancelled.

Do not serialize entire editor contents, terminal screens, or full AI stream transcripts into `ctx.state` on each change. Those are host-owned resources. AI publishes `ai.session.updated`, `ai.stream.updated` (throttled), `ai.permission.requested`, and `ai.connection.changed` notifications keyed by stable workspace/session IDs. Modules may subscribe, but Rust maintains authoritative chat/ACP/approval state.

## 7. Runtime and thread model

GPUI views/entities must only be manipulated on the appropriate GPUI application/UI context. Never call GPUI from a QuickJS worker thread.

Recommended POC model:

1. **One QuickJS runtime/context per active module instance**, hosted on its own worker thread (simple isolation of lifetime and JS execution; optimize later).
2. A Rust host-side registry and bounded channels exchange commands/replies/events with module workers.
3. All QuickJS calls, promise jobs, and callback execution for a particular runtime happen serially on that runtime's worker.
4. `ctx.fs.*`, `ctx.modules.call`, and similar APIs bridge to Rust services asynchronously and resolve JS promises on the owning worker thread.
5. Workers submit **serializable UI snapshots** or invalidations; the UI thread validates them, updates the GPUI view model, and requests repaint.
6. PTY reads and terminal-grid parsing run off the UI thread; the terminal view is updated through safe host notifications. Coalesce bursts and avoid repainting per byte.
7. ACP stdio reads/writes, remote SSH agent channels, permission handling, MCP requests and transcript persistence have dedicated async tasks/workers; they never execute on the GPUI thread or per-token inside QuickJS. ACP packets are framed/parsed on the host, and the AI module renders only host-backed views and low-rate status snapshots.
8. All queues are bounded or backpressured. Avoid synchronous cross-thread waits, especially from UI to a JS worker.

**Important QuickJS detail:** QuickJS is not a Node.js runtime. There is no built-in `fs`, `process`, `require`, Node module resolution, or browser APIs. The host must supply the supported context API and drive the QuickJS pending Promise jobs. Bundle module imports into a single compatible ESM file using esbuild (`platform: "neutral"`, `format: "esm"`, `bundle: true`). Disallow Node built-in imports in the module build.

Failure of a JS callback must be caught, logged with module ID/generation, and rendered as a nonfatal module error instead of taking down the host when possible. In-process QuickJS is **not a hard sandbox** against malicious native/FFI bugs; treat POC modules as trusted local code.

## 8. Native host services

### 8.1 Workspace provider and filesystem service

Introduce a host-owned `WorkspaceProvider` abstraction. `workspaceId` resolves to a specific immutable `{sourceKind, projectId, taskId?, root}` and **filesystem operations are always workspace-scoped**. Minimum operations: `list(workspaceId, relativeDir)`, `readText(workspaceId, relativePath)`, `canonicalRoot`, `spawnTerminal`, and Git-command execution. Actual host-side implementation can split this into filesystem, terminal, and Git traits if simpler; the contract is the important part.

- **Local provider:** native Rust filesystem APIs, rooted in the project directory or task worktree.
- **SSH provider:** SFTP for listing, read, and realpath; SSH exec channels for Git operations; SSH PTY channel for interactive shell, all executed on the **remote** project host. No mirroring an SSH project into local files.

`fs.list(workspaceId, relativeDir)` returns `name`, `relativePath`, `kind`, optional metadata, sorted directories first. `fs.readText` returns bounded text plus detected language. `documents.open` returns a stable host-owned document handle identified by workspace ID + path, **not path alone**. Files sharing a relative filename in different tasks must not share a document buffer.

Enforce path boundaries on local and remote providers: forbid absolute and parent traversal in UI-relative paths and verify resolved paths/symlinks remain under the selected canonical root. For SSH, use SFTP `realpath` checks and never rely on client-side string-prefix checks alone. If remote canonicalization/permissions cannot be verified, fail closed. Hidden files may be shown. Surface permissions/connectivity errors in the explorer/viewer, not as host crashes.

For POC, cap preview at **2 MiB** and show an explanation for oversized/binary/unreadable files. Scan/read asynchronously; never block GPUI. Directory navigation has a Back/Up operation limited to the selected workspace root.

### 8.2 Code viewer service

- Use a native editor/preview control from the chosen compatible GPUI component library in **read-only** mode: selectable, scrollable, copyable with line numbers if supported.
- Syntax highlight at least **Rust, TypeScript/JavaScript, JSON, and Markdown**; plain text fallback for unknown extensions.
- Buffer/document ownership is in Rust; modules pass `documentId` handles, never entire text trees on every render.
- On workspace switches, restore the preview path for that workspace from persistent state; reload its buffer or reattach a cached buffer as appropriate.
- A `viewer` or `workspace` module hot-swap does not reset the selected document or workspace.
- Do **not** implement source editing/saving, LSP, or autocomplete for this POC. Module script modification happens through the approved Internal MCP source tools or external edits, both of which drive the hot-swap pipeline.

### 8.3 Local and remote interactive terminal service

The terminal is **not** a text log plus an input field. Use a real emulator/grid (`alacritty_terminal` or a pinned compatible native GPUI terminal control) and real interactive PTY streams:

- **Local workspace:** `portable-pty` launches user's shell in the selected project root or task worktree.
- **SSH workspace:** a long-lived SSH channel requests a real PTY and launches a remote shell **with `cwd` set to the selected remote project/worktree directory**. Use checked remote command composition; a remote PTY must not silently fall back to a local shell.
- All sessions are registered under `(workspaceId, stableKey)` and **owned by Rust**, never by a TS generation.
- When selecting another project or task, reattach to the existing session for that workspace if alive, otherwise create it. Switching back restores scrollback/emulator state while the app process stays running.
- Terminal input, ANSI colors, Ctrl+C, window resizing, persistent `cd`, and basic interactive commands must work for local and SSH sessions.
- Shell sessions must survive hot-swaps of `projects`, `workspace`, `explorer`, `viewer`, or `terminal`. Module unload **must not** terminate an existing PTY.
- Shutdown cleans up local PTYs and SSH channels. After application restart, terminal UI/workspace selection is restored from SQLite, but the old shell *process* is not promised to survive.

### 8.4 SQLite persistence (required, not optional)

Use `rusqlite` (`bundled`) with **versioned forward-only migrations** in an OS app-data location (`--data-dir` override for development/tests). All DB access runs off the UI/QuickJS threads. Project/task records and AI sessions are **host-owned**, never directly writable by JS via arbitrary SQL.

Minimal schema (illustrative; adjust indexes, foreign keys and migrations during implementation):

```sql
PRAGMA foreign_keys = ON;

CREATE TABLE ssh_profiles (
  id TEXT PRIMARY KEY,
  host TEXT NOT NULL,
  port INTEGER NOT NULL DEFAULT 22,
  username TEXT NOT NULL,
  auth_method TEXT NOT NULL,            -- agent or key-file path
  key_path TEXT                         -- path, not key bytes
);

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('local','ssh')),
  root_path TEXT NOT NULL,              -- path ON project machine
  ssh_profile_id TEXT REFERENCES ssh_profiles(id),
  expanded INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  name TEXT NOT NULL,
  branch TEXT NOT NULL,
  worktree_path TEXT NOT NULL,          -- path ON project machine
  created_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ready',
  UNIQUE(project_id,branch)
);

CREATE TABLE workspace_views (
  workspace_id TEXT PRIMARY KEY,
  explorer_relative_dir TEXT NOT NULL DEFAULT '.',
  preview_relative_path TEXT,
  terminal_key TEXT NOT NULL DEFAULT 'main',
  active_ai_conversation_id TEXT,
  updated_at TEXT NOT NULL
);

-- Agent executable config is scoped to a physical target machine:
-- 'local' or 'ssh:<sshProfileId>'. A project may override the machine default.
CREATE TABLE acp_profiles (
  id TEXT PRIMARY KEY,
  machine_id TEXT NOT NULL,
  project_override_id TEXT REFERENCES projects(id),
  name TEXT NOT NULL,
  provider TEXT NOT NULL,               -- codex / claude / custom
  executable TEXT NOT NULL,             -- resolved on machine_id
  args_json TEXT NOT NULL DEFAULT '[]',
  env_refs_json TEXT NOT NULL DEFAULT '{}', -- secret-store refs only
  enabled INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE ai_conversations (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,           -- root OR exact task
  acp_profile_id TEXT NOT NULL REFERENCES acp_profiles(id),
  agent_session_id TEXT,                -- opaque id returned by ACP
  protocol_version INTEGER,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'offline',
  approval_policy TEXT NOT NULL DEFAULT 'ask',
  mcp_selection_json TEXT NOT NULL DEFAULT '["internal"]',
  selected_config_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Cached display transcript only; not a claim of provider-side resumability.
CREATE TABLE ai_messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES ai_conversations(id),
  sequence INTEGER NOT NULL,
  kind TEXT NOT NULL,                    -- user / assistant / tool / notice
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(conversation_id,sequence)
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- settings.activeWorkspaceId, settings.schemaVersion, etc.
```

Persistence and integrity requirements:

- The **Projects** tree contains only real `local`/`ssh` projects and Git tasks; there is **no** `virtual:modules` row, synthesized entry or special workspace.
- AI chats belong to `workspace_id`, not just a project ID; root and two tasks each have independent conversations, even if using the same ACP profile.
- ACP configuration belongs to the **execution machine** (`local` or specific SSH profile). Project-specific overrides are optional. A local Codex profile is not available to a remote project merely because its executable exists locally.
- Store only **secret references** where possible. Never persist raw API tokens, private-key bytes, agent credentials, auth headers, or ephemeral MCP bridge tokens; use existing agent-local authentication and OS secret storage. Do not include sensitive ACP/MCP payloads in diagnostic logs.
- Persist rendered chat messages with bounded size/retention. Provider-side resume must be negotiated; a cached transcript does not imply a resumable ACP session. When resume is unsupported/unavailable, show cached history as read-only and offer New Conversation.
- Commit coherent changes to project/task/selection metadata transactionally. Filesystem/Git worktree creation cannot be atomically committed with SQLite; report and reconcile partial success safely.
- Unavailable SSH projects/tasks and ACP profiles remain visible with meaningful error state; do not delete records automatically. Do not silently switch execution to localhost after SSH failure.
- Verify a saved task path against `git worktree list --porcelain` on the correct machine before destructive operations. No automatic prune/delete of user changes.
- Use foreign keys, indexes and `PRAGMA user_version` migrations, with smoke tests for reopening existing DBs.

### 8.5 Project service and Git task worktrees

Host methods (conceptual): `projects.list`, `projects.addLocal`, `projects.addSsh`, `projects.selectWorkspace`, `projects.setExpanded`, `tasks.list`, `tasks.create`.

**Project registration:**

1. Validate the local directory or connect/authenticate to SSH and confirm its remote directory exists and is traversable.
2. Detect whether it belongs to a Git working tree using Git CLI (`git -C <root> rev-parse --show-toplevel`); for POC require the configured project root **to equal the repository top-level** for task creation. A non-Git directory is still a valid project, but New Task is disabled.
3. Persist project ID/name/source details; show the project in the tree immediately, and preserve registration on restart.
4. If SSH is temporarily offline later, do not remove the project. A connection retry must recover it.

**Task creation (local and SSH):**

1. Only on a verified Git project with an existing initial commit. Prompt for a task name.
2. Create stable task UUID and generate a unique branch, e.g. `task/<safe-slug>-<short-id>`; validate it with `git check-ref-format --branch` on the correct machine.
3. Choose an **out-of-checkout** worktree path in app-controlled state storage **on the same machine as the Git repo**. Local: OS app-data `worktrees/<projectId>/<taskId>`; remote: e.g. `${HOME}/.local/state/<app-id>/worktrees/<projectId>/<taskId>` or another verified writable **remote** directory. Do not put task worktrees inside the project tree.
4. Execute **real** Git: `git -C <repo> worktree add -b <branch> <worktreePath> HEAD`. Use argv-based local execution and a **single well-tested POSIX shell quoting routine** for remote exec. Never interpolate raw labels/paths into unquoted shell commands.
5. Verify the worktree exists using `git worktree list --porcelain`; save task metadata in SQLite **only after successful creation and verification**. If DB commit fails, report partial creation and offer safe reconciliation; do not silently delete or overwrite the new worktree.
6. Select the new task; explorer, viewer, terminal, and ACP sessions now resolve to that task's worktree. The parent project's main checkout and all other tasks remain unchanged.
7. On startup, reconcile persisted task records with `git worktree list --porcelain` **without** pruning/mutating Git metadata; mark missing/broken tasks visibly.

**Important HatoPad-like behavior:** Tasks are long-lived isolated contexts with independent worktree/branch, selected files, directory, terminal, and UI state. They are **not** just branches selected via `git checkout` in the same directory. For this POC, newly created worktrees begin from the project's `HEAD` and therefore contain **committed content**. If the main checkout has staged, unstaged, or untracked changes, **warn visibly that these are not copied into the new worktree**. Full dirty-state inheritance, indexed/staged-state cloning, untracked-file propagation, and Git merge review are deferred rather than incorrectly advertised as complete. AI/task session history is required for the POC.

Do not implement task deletion in the first POC; removal with uncommitted changes is a separate explicitly confirmed workflow. If an implementation does add deletion, it must detect dirty worktrees and never force-delete or delete branches without user confirmation.

### 8.6 SSH transport: concrete POC requirements

Prefer **`ssh2`/libssh2** in the Rust host because it provides SFTP, exec channels, and PTY channels with one cross-platform library. Confirm compatible versions and toolchain/linking before adopting. For POC, support **remote POSIX hosts (Linux/macOS)** with an SSH server, SFTP subsystem, POSIX shell, and Git installed; remote Windows shells are not required.

- SSH project registration must accept hostname, port (default 22), username, directory, and authentication using **ssh-agent or a configured private-key file**. Never save passphrases/passwords in SQLite. Reuse SSH connections where practical; reconnect on drop with a visible error state and explicit retries.
- Verify SSH server identity against the user's known hosts. Unknown/changed keys must **not** be accepted silently; a manual trust workflow can be documented if POC UI does not implement one.
- SFTP `readdir`, `open/read`, and `realpath` must implement actual remote explorer/viewer operations. Remote task worktrees are accessed through the **same** connection/profile with different remote roots.
- Use remote exec channels for Git commands and capture exit codes + stderr; use remote PTY channels for interactive shells. Remote Git and terminal operations happen on the SSH server, never on a shadow local checkout.
- Remote command arguments (in particular directory names) need correct shell quoting/escaping because SSH exec is not a native remote argv protocol. Never treat string concatenation as safe; write tests with spaces, apostrophes, and shell metacharacters in paths.
- Never hang the UI on SSH or network delays. Use timeouts for one-shot operations and a reconnect/error UX; long-lived terminal channels are not subject to short RPC read timeouts.
- Document required SSH server capabilities and how a developer can exercise the POC against an existing test host. A smoke test or manual demo must **actually browse a remote directory and create/enter a remote task**; merely storing an `ssh://` URI does not pass.

### 8.7 ACP client and workspace-bound execution

ACP is the Agent Client Protocol, **not** the app's module bus. The Rust host is the ACP **client**; Codex/Claude ACP adapters are agent **servers**. Use the official `agent-client-protocol` Rust SDK when it fits the pinned version. ACP uses JSON-RPC over standard input/output and supports capability negotiation. The v1 protocol is the stable baseline for POC; v2 is still evolving, so support it only behind an explicit negotiated compatibility layer when verified with the chosen adapters. Never mix v1 and v2 schemas in one live connection.

Recommended ACP agent implementations (do not use archived `@zed-industries/codex-acp`):

- Codex: https://github.com/agentclientprotocol/codex-acp (published adapter: `@agentclientprotocol/codex-acp`).
- Claude: https://github.com/agentclientprotocol/claude-agent-acp (published adapter: `@agentclientprotocol/claude-agent-acp`).

The adapter **must already be installed and authenticated** on the applicable machine. The user can configure `command`, `args`, and named env secret references per machine/project in AI Settings. Show a check/diagnose action that validates executable availability on the correct machine. Do **not** silently install an agent, run `npx -y` to fetch unexpected code, read the user's other credentials, or use local credentials to impersonate a remote agent.

**Execution resolver (normative):**

```ts
// Host-side conceptual logic, NOT the TypeScript module's implementation.
function resolveAcpTarget(workspaceId: string): AcpTarget {
  const ws = workspaceRegistry.resolve(workspaceId);
  return ws.location === 'local'
    ? { machineId: 'local', transport: 'local-stdio', cwd: ws.rootAbsolutePath }
    : { machineId: `ssh:${ws.sshProfileId}`, transport: 'ssh-stdio',
        sshProfileId: ws.sshProfileId, cwd: ws.rootAbsolutePath };
}
```

For **local** workspaces: launch configured ACP process locally (argv, no shell), pipe stdin/stdout, keep stderr separate for diagnostics, and set `cwd` to the local project root or worktree. Use `initialize`, session creation, prompts, notifications, permission callbacks, cancellation, close, and actual session settings as supported by the connected agent.

For **SSH** workspaces: use the project's verified SSH identity to open a **remote exec channel** running the configured ACP command on the remote machine; pipe the command's stdin/stdout bidirectionally as the ACP stdio stream. Set `cwd` on the remote side using safely quoted POSIX shell context (SSH exec normally sends a shell command string, not argv), and pass the **remote** absolute root/worktree in ACP `session/new.cwd`. Stderr must be captured separately so it cannot corrupt JSON-RPC framing. Handle dropped connections, exit codes, authentication prompts, and restart. Use **the same SSH host/profile** as the project; never fall back to localhost.

The host may reuse SSH transport infrastructure but the long-lived ACP child/channel must be **independent of the terminal PTY**. An ACP JSON-RPC channel is **not a PTY**: ANSI/echo and shell banners corrupt its stdio stream. Project terminal lives in its own SSH PTY channel.

If a profile is not installed on that target machine, the AI panel displays `Unavailable on <machine>` with setup guidance. Do not claim a remote agent is running when it is not.

**Session ownership and routing**:

- `AiSession`/conversation has a stable host ID, `workspaceId`, configured `machineId`, `acpProfileId`, opaque provider `sessionId`, connection/foreground state, transcript, and permission queue.
- A new conversation for a task uses **that task's worktree path as `cwd`**, not the base project directory. Existing conversations never change cwd or target machine when a different workspace becomes active.
- Changing selected workspace merely selects its existing chat/conversations and agent availability. Active background sessions may continue on their original target (with clear UI indication); they must not leak updates into the newly selected workspace.
- In-process QuickJS `ai` module reload cannot kill a running ACP process or remove a pending permission request. On host app restart, use session resume/load **only when actually advertised**; cache history independently.
- The host must handle streaming assistant messages, tool calls, permission requests, mode/model/config updates, cancellation, authentication errors and session closure. Every call has timeouts/correlation IDs; process start/reconnect never blocks UI.

### 8.8 ACP chat controls: agent / model / reasoning / autopilot / MCP

The `ai` module builds a classic chat interface; the host `AiManager` owns the protocol. Minimum host services are the `ctx.ai.*` methods from Section 5 and capability change events from Section 6.

**Agent:** choose a configured Codex/Claude adapter **available on the workspace machine**. Display agent, `local`/`SSH` target, remote hostname label, worktree cwd, connection state. A project-scoped profile can override the machine-level default. Switching the agent creates/selects a distinct conversation; it must not overwrite the old provider session.

**Model & reasoning:** derive selectors from the connected agent's advertised session configuration or model capabilities. v1 and v2 may expose different optional fields/methods; implement an explicit adapter normalization layer rather than assuming `session/set_mode` and `session/set_config_option` are interchangeable. In v2, model/reasoning/mode are session `configOptions` with categories `model`, `thought_level`, and `mode`; changes go through `session/set_config_option`. In v1, use supported v1 model/config/mode APIs, otherwise disable only that unsupported control and clearly explain why. Do **not** invent model names or 'reasoning levels' absent from the agent. Handle dynamic config option updates.

**Autopilot:** a **session-scoped user-approved host policy**, separate from provider-specific execution/approval modes:

| UI value | Host permission handling |
| --- | --- |
| `Ask` | Require human approval for actionable requests that need authorization. |
| `Safe auto` | Automatically allow explicitly classified low-risk, read-only operations where the agent/API allows it. |
| `Autopilot` | Opt-in per conversation; may automatically handle ordinary workspace operations according to explicit policy/agent capabilities, with clear ongoing indication and Stop/Cancel. Never silently override adapter restrictions. |

**Never** allow any autopilot policy, mutable TS UI callback, or file watcher to bypass host approval for *local application self-modification* via Internal MCP (module source writes, activating new code, modifying MCP policy, or provisioning remote bridge code). Deny or ask according to immutable host policy; POC defaults to **Ask** for source changes and activation. `modules.build` and read-only tools may be auto-approved if configured. Avoid conflating 'reasoning effort' with autopilot.

**MCP selector:** UI displays `Internal MCP` (available if bridge ready; functional) and an `External MCP` placeholder (disabled with `not implemented`). The MCP selection is stored per conversation. On `session/new` and supported load/resume, supply only checked MCP servers in the agent-compatible transport format. Some agents cannot dynamically reconfigure MCP servers in an existing session: on toggle, prompt the user to **start a new session or reconnect** instead of pretending that the active session changed. Show actual connectivity/status, including a clear failure indicator if the remote bridge is absent.

**Chat behavior:** user text input, Enter-to-send/multiline behavior, streaming assistant response, tool call timeline, live cancellation, error/retry messages, pending permission approve/deny, conversation picker and persistable transcript. Use native host-backed `chatTranscript` to render high-rate updates, and expose low-frequency status events to QuickJS. Never fabricate replies or treat terminal text as ACP assistant messages.

### 8.9 Internal MCP: real tools, skills, and module self-patching

**An actual MCP server** runs as a trusted host subsystem, distinct from ACP and the module bus. It implements MCP `initialize`, `tools/list`, `tools/call`, and optionally `resources/list` + `resources/read` for built-in skill instructions. ACP agents connect by configured MCP stdio subprocess. Host routes every tool to an allowlisted service; tools cannot directly access Rust/GPUI handles or arbitrary files. Internal MCP tool calls are **not** `ctx.modules.call` invocations; they cross an independent validated MCP boundary.

Minimum tools (names illustrative, keep stable in POC):

| Tool | Purpose | Permission |
| --- | --- | --- |
| `modules.list` | List IDs, active versions, build diagnostics and allowed source roots. | Read-only |
| `modules.describe` | Module manifest, dependencies, active generation and public methods. | Read-only |
| `modules.read_source` | Read one file below approved `modules/<id>/src/**` or manifest. | Read-only |
| `modules.apply_patch` | Apply a **bounded validated patch** to an allowlisted module source file. Include expected content hash/revision; reject stale conflicts. | **Host approval required** |
| `modules.build` | Rebuild a single module to a unique immutable version; return diagnostics/artifact ID, **no activation**. | Build permission; default read/safe |
| `modules.activate` | Stage/validate then atomically switch to a built artifact, report old/new generations. | **Host approval required** |
| `modules.rollback` | Restore previous known-good generation, without destroying host resources. | **Host approval required** |
| `modules.status` | Query ongoing build/swap status, errors and last good version. | Read-only |
| `skills.list` | Enumerate bundled AI development skills. | Read-only |
| `skills.read` | Read a named skill's Markdown instructions and examples. | Read-only |

Optional additional service `modules.diff` can preview the exact patch. **Do not** add unrestricted `shell.exec`, arbitrary file writes, unrestricted plugin installs, or raw SQLite queries to Internal MCP in the POC.

Ship **real Markdown skills** in `skills/`:

- `inspect-module/SKILL.md` — discover existing modules, source/schema and versioned artifacts safely.
- `modify-ui-module/SKILL.md` — how to apply a constrained UI source patch and understand keyed UI primitives.
- `build-and-hot-swap/SKILL.md` — explicit `read → patch → build → inspect diagnostics → activate → verify → rollback on failure` workflow.
- `recover-module/SKILL.md` — revert/rollback when a bad UI module is activated; no Rust host restart required.

Each skill has a clear identifier, description, executable tool sequence and constraints. Expose skill names via MCP tools or MCP resources; give agent a short discovery instruction via a trusted context mechanism **only if the chosen ACP version/adapter supports it**, otherwise document accessible MCP resources and a user-invocable chat command. Do not pretend MCP resource exposure automatically causes every model to discover or execute a skill. Skill files are app resources, **not Projects sidebar items**.

**Module source protection / anti-race**:

1. Restrict files to canonical paths within the configured source tree (`modules/<id>/src/**`, allowed manifest only). Deny symlink escapes, `../`, `.runtime` artifacts, database, credential files, or arbitrary local/remote paths.
2. `apply_patch` requires the module ID, relative file path, expected SHA-256 (or source revision), and patch. Validate size/file type/expected revision and display precise diff in a trusted **host-owned** approval UI.
3. Build is performed by the existing host module builder; it creates `id.NNNN.mjs` **only after success** and cannot implicitly activate a partially written candidate. Supply compiler errors to the agent.
4. Activation runs existing transactional swap (Section 9) and must be approved by the host outside the agent's claimed permission/autopilot policy.
5. If building or staging fails, keep active generation. Expose diagnostics to the AI and preserve the chat so it can propose a fix.
6. If post-commit validation fails, expose manual rollback and best-effort automatic recovery where safe. Never claim rollback can undo external side effects.
7. An AI call that reloads its **own `ai` module** must not destroy the call's MCP/ACP transport or native host state; the UI reattaches on the next GPUI frame.

### 8.10 Remote Internal MCP bridge (required POC path)

**Problem:** The actual Rust host and its Internal MCP live on the user's desktop. For an SSH project, the ACP agent runs remotely. An MCP stdio server launched by that remote agent also runs **remotely**; a remote process cannot simply invoke the desktop host's local Unix socket or `127.0.0.1` without a tunnel. Design the bridge explicitly.

**Recommended pragmatic POC path: remote stdio proxy + SSH reverse port forward** (other equivalent, secure transports are fine, but no fake tools):

1. The Rust host runs an authenticated, session-scoped Internal MCP forwarding endpoint bound **only to desktop loopback**. It owns tools, source trees, approvals, and audit logging; it is not Internet-facing.
2. The host establishes an **SSH reverse-forwarded loopback port** on the project's SSH server pointing back to the host's loopback endpoint. Verify `AllowTcpForwarding` and remote port binding. If forwarding is unsupported, show a clear error and do not claim remote MCP is connected.
3. The host can deploy a **versioned, hash-verified minimal stdio MCP proxy** to a user-owned remote cache directory over SFTP with explicit approval. For a lightweight POC, it may be a pinned Python 3 script requiring Python 3 on the remote POSIX host; document this prerequisite. Use a safer standalone packaged helper later. No `curl | sh`, automatic arbitrary package installation, or unverified source on remote.
4. The remote agent's `mcpServers` contains a **remote executable path** for that remote stdio proxy. It speaks MCP framing to the agent over stdin/stdout and relays authenticated MCP messages through the remote loopback forward. The desktop endpoint checks the short-lived session binding/token on **every** tool call, so arbitrary remote loopback users cannot invoke host module tools.
5. The bridge uses separate SSH channels/processes from the ACP stdio agent and remote PTY. Never run an MCP stdio proxy on a PTY. Clean up the forward and revoke credentials when the session ends or remote SSH disconnects.

For local agents, use an app-provided `--internal-mcp-stdio` subprocess endpoint or a local stdio bridge to the same host MCP tools; no network listener is required for the local path. Pass secrets through protected process IPC/environment, **not** command-line arguments, logs or SQLite. If relying on OpenSSH `ssh -R` for the reverse forward, document its availability on the desktop OS separately from `ssh2`/SFTP project transport; do not claim `ssh2` implements unsupported forwarding operations without verifying its APIs.

Security boundaries:

- SSH server identity must be verified; reverse forwarded services bind loopback-only. Local MCP HTTP/relay endpoints validate Origin where applicable and enforce authentication. Tokens are short-lived, unguessable, tied to session and tool scopes, and never stored in transcripts.
- The agent's execution scope remains the remote project/task. Access to host module source happens **only** through Internal MCP's explicitly permissioned tools; do not grant a general local filesystem mount into a remote agent session.
- A remote SSH agent can request host source modifications, but **cannot** silently write to the desktop project/repo or approve its own elevation. The host independently authorizes source changes and activations.
- An SSH drop closes/invalidates the bridge; do not leak listener ports or keep remote host access open indefinitely. The UI should distinguish `Agent connected` vs `Internal MCP bridge connected`.
- If external MCP support is not implemented, do not try to tunnel or execute third-party MCP configs. The selector entry is visibly disabled.

## 9. Build, versions, and hot-swap

### 9.1 Artifact layout

Example:

```text
modules/explorer/src/index.ts
modules/explorer/module.json

.runtime/modules/explorer/explorer.0001.mjs
.runtime/modules/explorer/explorer.0002.mjs
.runtime/modules/explorer/active.json
```

`module.json` contains at least:

```json
{
  "id": "explorer",
  "entry": "src/index.ts",
  "apiVersion": 1
}
```

Version numbers are **per module, monotonically increasing for successful builds**. The module's logical identity (`explorer`) never changes. The host should keep the previous known-good generation for rollback. Artifacts are immutable once published; build into a temp file and atomically rename, then publish the version metadata. For portability, use uniquely named versioned destinations instead of overwriting loaded files.

### 9.2 Watch and compile

In development mode:

1. Watch `modules/<id>/src/**` and the module's manifest with a debounce (e.g. 150–300 ms).
2. Invoke esbuild for the changed module only, on a background worker/process.
3. Report build diagnostics in the status area and logs.
4. On successful compilation, write `.runtime/modules/<id>/<id>.NNNN.mjs` and **stage/validate** the candidate, but **do not automatically activate it** in the default POC. A visible trusted-host operator action (or approved Internal MCP `modules.activate` request) commits the change. This prevents a file-watcher race from bypassing required approval after an AI applies a source patch.
5. On build failure, **retain the active module and running app**, show an error, and continue watching.
6. Do not accidentally activate an older build that completed after a newer request; assign an input revision/build sequence and reject stale results.

Provide an explicit **Build/Stage** and **Activate** host-owned operator action or shortcut. An optional `--auto-activate-trusted-local-edits` development mode may exist, but must be OFF by default and clearly warn that external agent/tool writes to the same checkout are not distinguishable purely by file watching. Do not add a generic unapproved `ctx.modules.reload()` ability to mutable TS code.

### 9.3 Transactional swap state machine

```text
ACTIVE vN
   |
   +--> BUILD candidate vN+1
             |
             +-- build error ------------> KEEP ACTIVE vN
             |
             v
          STAGE new QuickJS worker
             |
             +-- load/activate/render error --> DISCARD; KEEP vN
             |
             v
          VALIDATE module ID, API, UI tree,
                   available capability permissions
             |
             v
          COMMIT at a UI update boundary
             |  - install new generation in router
             |  - replace this module's keyed UI subtree
             |  - invalidate/cancel stale event deliveries
             v
          RETIRE vN
             |  - stop old subscriptions
             |  - cancel old pending work with ModuleReplaced
             |  - run bounded deactivate/cleanup
             |  - destroy old QuickJS context/runtime
             v
          ACTIVE vN+1
```

For each generation track `moduleId`, `generation`, `worker`, subscriptions, pending RPC IDs, state snapshot, and mounted UI subtree(s). Capture a small optional `snapshot()` from vN and pass it to vN+1's `activate()` (with an explicit state schema version if necessary). **Host-owned state must survive even when snapshot hooks are absent or fail.**

A swap must be all-or-nothing for routing and the UI subtree: do not briefly route new events to the old worker while rendering the new tree. Use a monotonically increasing generation tag on every event/request. Drop stale UI actions.

Rollback guarantees should be explicit:

- **Guaranteed:** compilation/activation/render failures before commit leave vN active.
- **Best effort:** post-commit runtime failures can roll back to retained vN when still available.
- **Not guaranteed:** external side effects (file writes, terminal commands, network) are irreversible; do not imply otherwise.

### 9.4 Lifetime rules

- Module-owned subscriptions, timers/callbacks, and pending RPC requests are generation-scoped.
- Host-owned documents, terminal sessions, **SQLite project/task registry**, SSH sessions, workspace mappings, **ACP connections, chat conversations, internal MCP server, bridge endpoints**, pending approval requests, and persistent state survive a module generation replacement.
- `projects` module reload must **not** reconnect all SSH sessions, recreate task worktrees, or reset the selected workspace. `ai` reload must **not** restart ACP or MCP sessions. Both only re-render/reattach to host-owned state.
- Active shell/ACP session handles are keyed by stable `workspaceId` and independent host-owned conversation ID, never TS module generation or project name.
- A new worker starts with fresh JS globals. No direct JS object references cross runtimes.
- Only the manager may destroy runtimes; never destroy the currently executing JS runtime in the middle of `reloadSelf()` or an event handler. Queue reload after callback completion.
- A failed module cannot wedge the UI thread; at minimum implement execution timeout/interrupt or a bounded callback policy where the chosen QuickJS binding allows it. Document the limitations of in-process failure isolation.

## 10. Source tree proposal

```text
.
├── architecture.md
├── Cargo.toml
├── Cargo.lock
├── package.json                  # esbuild, TypeScript module build tooling
├── package-lock.json
├── README.md
├── crates/
│   ├── app/                      # GPUI desktop bootstrap + CLI
│   ├── host/                     # module registry, RPC/events/state, hot-swap
│   ├── js_runtime/               # QuickJS module workers/typed bridge
│   ├── ui_protocol/              # keyed UI/AI control schema
│   ├── ui_gpui/                  # native GPUI views/chat/terminal
│   ├── persistence/              # SQLite migrations/project/task/AI history
│   ├── workspaces/               # local/SSH filesystem/workspace resolution
│   ├── git_host/                 # local/SSH Git worktree tasks
│   ├── terminal_host/            # local PTY/SSH PTY and emulator
│   ├── acp_host/                 # ACP process/session transports and protocol
│   ├── mcp_host/                 # Internal MCP server, permissions, skills
│   └── remote_bridge/           # SSH reverse tunnel + proxy provisioning
├── sdk/src/                     # TypeScript module SDK; no Node APIs
├── modules/
│   ├── workspace/
│   ├── projects/
│   ├── explorer/
│   ├── viewer/
│   ├── terminal/
│   └── ai/                        # chat, settings, model/reasoning/MCP UI
├── skills/
│   ├── inspect-module/SKILL.md
│   ├── modify-ui-module/SKILL.md
│   ├── build-and-hot-swap/SKILL.md
│   └── recover-module/SKILL.md
├── remote/
│   └── mcp_stdio_proxy.py         # versioned, hash-verified, Python 3 POC helper
├── scripts/
│   ├── build-modules.mjs
│   └── dev.mjs
└── .runtime/                      # ignored build artifacts, NOT the DB
```

This is a *logical decomposition*, not a requirement to create 13 tiny crates before a functional POC. One or a few Rust crates are acceptable as long as component/ownership boundaries are respected. Do not expose `modules/` or `skills/` as a fake project; they are internal resources. Keep SQLite outside the repository unless overridden with `--data-dir` for tests.

## 11. Minimal developer experience

Provide a one-command launch after documented prerequisites:

```bash
npm install
npm run dev -- --root . --data-dir ./.dev-data
```

`npm run dev` must:

1. Build all **six** TS UI modules with esbuild.
2. Start Rust/GPUI (`cargo run`) with `--root` and `--data-dir`.
3. Run SQLite migrations and register the initial local project once.
4. Restore the project/task tree, active workspace, explorer/viewer/terminal state, and AI conversations/profile settings.
5. Show a usable AI panel with `Configure ACP`, available agent selection for the **current machine**, MCP selector and agent-status diagnostics.
6. Watch TS module sources and support manual rebuild/hot-swap. **Do not** bootstrap a virtual Modules project.

Other commands: `npm run build:modules`, a documented headless `cargo test` suite, and a `--modules-root <path>` override for the host build tooling / Internal MCP allowlisted source tree. The POC host can launch precompiled TS modules without an embedded Node.js runtime. Building TS requires Node/esbuild; running a particular ACP agent **may also require Node installed on its target machine**, depending on its adapter. The application should show prerequisites instead of secretly installing them.

Document platform-specific Rust/GPUI build dependencies, libssh2/openssl or system linking, Git, local/remote ACP adapter installation/auth, SSH known-hosts setup, and remote POSIX requirements (**SFTP + Git + shell**, plus **Python 3 and permitted SSH reverse-forwarding** for the POC Internal MCP bridge). The supported desktop targets are macOS, Windows and Linux, but report **actually verified** OSes and SSH hosts. Avoid claiming zero-dependency builds.

Use local sample project as the instant offline demo: even without configured ACP, the Projects/explorer/viewer/terminal UI must work. Once an adapter is configured, send a **real** prompt, not an echo stub. For SSH testing, connect to a real controlled POSIX test host; missing infrastructure must be described as a test limitation, not implemented with mocks disguised as remote support.

## 12. Implementation plan for Codex

Implement a **vertical slice** in the following order. Each milestone must compile and remain demonstrable. Do not replace requirements with text-only mocks; a partial real implementation with explicit gaps is better than claiming completion.

### Milestone A — GPUI, module protocol and SQLite

- GPUI app window; keyed `column`, `row`, `split`, `slot`, labels, buttons, inputs, tree, selects/toggles, and host-backed chat placeholder component.
- Create SQLite DB/migrations; seed a local project from `--root`; persist project/task selection and AI profile/session schema.
- Temporary hardcoded UI is permitted only during bootstrap and must be removed when TS modules run.

### Milestone B — Six hot-swappable TS modules

- Initialize independent QuickJS module workers, lifecycle/hooks, RPC/event bus/state, and render native UI from keyed module declarations.
- `workspace` composes `projects`, `explorer`, `viewer`, `terminal`, **`ai`**. Project tree is expandable; selection is stored by host.
- No virtual Modules project. Use actual `modules/` files only for build/watch and trusted toolchain.

### Milestone C — Real local filesystem, viewer and PTY

- Scoped file listing, bounded reads, syntax-highlighted read-only GPUI viewer, and native PTY with terminal emulation.
- Workspace switching restores open file/scroll/terminal. Verify `pwd`, `cd`, ANSI, Ctrl+C, resize.

### Milestone D — Real local Git tasks

- Git detection, Create Task, actual `git worktree add -b`, DB persistence and worktree verification.
- Two worktree tasks can exist simultaneously without mutating parent checkout. Warn that uncommitted/untracked parent changes aren't copied.

### Milestone E — Real SSH project / worktree / terminal

- Known-host-verified SSH, remote SFTP listing/reading, remote PTY, and remote Git worktree creation.
- Confirm all paths and terminal `pwd` belong to the **remote** project/task; handle disconnect/reconnect without deleting metadata.

### Milestone F — Project-scoped local ACP chat

- Implement the **host-owned ACP client** using a real locally installed Codex or Claude ACP adapter (configured executable/args). Stream user/assistant/tool messages, handle permission requests, cancel, errors and session IDs.
- Drive `ai` module selectors from negotiated capabilities, not fake values; prove at least one real model and reasoning control **if the chosen adapter advertises them**, or document missing capability and test an adapter that does.
- Bind sessions to the local project/task `cwd`. Create separate conversations for Task 1 and Task 2; switch away/back without losing in-process sessions. Persist transcript and profile in SQLite.

### Milestone G — Remote ACP follows SSH workspace

- For remote project/task use SSH **exec stdio** to start the actual configured ACP adapter on the **same remote machine** and set remote cwd correctly. Stderr is separate; ACP channel has no PTY.
- Prove the remote agent sees the remote task worktree (e.g. by asking for cwd or reading a uniquely remote file) and never launches a local replacement.
- Show explicit not-installed, auth and SSH-drop errors. Local agent configs must not be reused for remote machines unless expressly configured there.

### Milestone H — Internal MCP & AI self-patching

- Implement a real Internal MCP server/stdio adapter with working `modules.list/describe/read_source/apply_patch/build/activate/rollback/status` and `skills.list/read` capabilities.
- Create real skill Markdown files. Expose them as discoverable tools/resources and document how users/agents invoke them.
- Local ACP: attach Internal MCP via agent-supported `mcpServers` on `session/new`; verify agent successfully calls `modules.list`.
- Remote ACP: deploy hash-verified stdio helper with approval; set up SSH reverse forwarding to authenticated desktop MCP endpoint; attach remote MCP proxy in remote `session/new` and verify it calls **host** tools.
- Internal MCP source patch and activation use a trusted **host-owned human approval** UI, regardless of autopilot. Build candidate + diagnostics and hot-swap `projects` module with no Rust rebuild.
- Verify an invalid patch/build/activation doesn't kill previous working module, chat/agent, selected task, or PTY. Test self-reloading `ai` without killing its current ACP session.

### Milestone I — Polish, failure tests and documentation

- Finish chat selectors: agent, model, reasoning, ACP agent mode if supported, autopilot/approval policy, Internal MCP functional toggle, external MCP disabled placeholder, conversation picker and cancel.
- Proper persistent transcript, outstanding approvals and errors; connection diagnostics and privilege separation.
- Tests for DB migrations, SSH path quoting, workspace-target matching, ACP JSON-RPC framing, MCP auth/bridge, module scope checks, generation-safe hot-swap, and rollback.
- README with exact local and remote setup, smoke tests, real provider versions, supported features, and candid unverified items. Do not use proprietary HatoPad code.

## 13. Acceptance criteria (must pass)

### Core UI, Git projects, and persistence

- [ ] `npm run dev -- --root <directory> --data-dir <dir>` opens a genuine GPUI desktop window.
- [ ] Layout, Projects tree, explorer, viewer, terminal and **AI panel** are driven by independently replaceable TS modules, not hardcoded in the Rust host.
- [ ] Far-left Projects tree shows only **real local and SSH projects and their task worktrees**; there is **no virtual Modules project**.
- [ ] Project and task selection are distinct from expand/collapse. Project row points to original checkout; task row points to own Git worktree.
- [ ] Project creation (local/SSH) persists; non-Git project remains browseable and cannot create task.
- [ ] Two local tasks have separate Git branches/worktrees; two remote tasks have independent **remote** worktrees, not local mirrors.
- [ ] Files are listed on the selected machine and the read-only source viewer highlights TS/JS, Rust, JSON and Markdown.
- [ ] Local and remote terminal are real interactive PTYs; `pwd`, `cd`, ANSI colors, Ctrl+C and resizing work in the right root/worktree.
- [ ] SQLite restores project/task selection, expansion, last file and chat metadata after host app restart.

### AI chat and ACP execution topology

- [ ] `ai` panel has usable prompt input, streamed user/assistant output, tool timeline, errors, cancel and session picker.
- [ ] Codex and Claude have configurable ACP adapter executable/arguments and availability diagnostics **per machine**; selecting one launches the actual agent, not a simulated response. Demonstrate one real installed adapter end-to-end; prove connection settings for the second are supported.
- [ ] Agent selector is scoped to the active project/task execution machine, with project override support. Missing remote executable displays unavailable, **never** falls back to local.
- [ ] Local project ACP runs locally with `cwd` local project root; local Task 1 ACP uses Task 1 worktree, Task 2 uses Task 2 worktree.
- [ ] SSH project ACP runs **on the project's SSH host** and sees remote root; SSH task ACP runs on the **remote task worktree**. Remote agent connection uses SSH stdio **not** a PTY.
- [ ] Chat sessions stay bound to their original workspace and machine across switches; no 're-home' to a new workspace; module hot-swaps do not kill live ACP connections.
- [ ] Model, reasoning and optional agent mode controls come from advertised ACP config/capabilities and send **real** supported config changes; unsupported controls are visibly unavailable. Dynamic updates refresh selectors.
- [ ] Autopilot/permissions policy is visible, user-controlled and per conversation. Built-in module-write/activation approvals remain host-enforced in every mode.
- [ ] Chat transcripts and metadata persist. Provider session reattachment after app restart only occurs if supported; cached history is honestly distinguished.

### Internal MCP and hot-swap

- [ ] MCP selector has **functional Internal MCP** and clearly disabled/not-yet-implemented third-party MCP entries.
- [ ] Internal MCP is a real MCP server: `tools/list`, `tools/call` work with Codex or Claude ACP, not a fake in-app API.
- [ ] Built-in skills are actual Markdown files, can be discovered/read through MCP and contain a reproducible patch→build→activate→verify→rollback workflow.
- [ ] Local ACP can call Internal MCP to inspect modules and invoke a real build.
- [ ] Remote ACP over SSH can call **the same desktop host's Internal MCP** through an authenticated, loopback-only tunnel/proxy; no open public host endpoint and no remote-local filesystem confusion.
- [ ] Agent can propose a validated patch to `modules/projects/src/index.ts`; trusted host UI requests user approval, applies it, builds `projects.0002.mjs`, asks approval to activate, and hot-swaps the sidebar **without restarting Rust**.
- [ ] Agent can diagnose a build failure and keep `projects.0001` active; activation errors keep prior module, and rollback tool can restore previous version.
- [ ] `ai` module hot-swap reattaches to running ACP conversation, preserved transcript, and in-flight permission request. Terminal/editor/project selection are unaffected.
- [ ] MCP access is scoped to module source allowlist. Secret files/`../`/symlink escapes, unauthorized remote bridge access, or unauthenticated tool invocations are rejected.

### Performance and reliability

- [ ] JS/ACP/MCP/SQLite/SSH/Git/PTY I/O never blocks GPUI UI thread.
- [ ] Module RPC/events, stale generation cancellation, error messages and resource ownership are tested.
- [ ] Build/reload source watcher works even when user is focused on a normal project or chat.
- [ ] Clean-checkout setup commands and real platform/provider tests are documented; no untested host OS or unavailable remote environment is claimed verified.

### Suggested automated and manual tests

1. **Module/UI SDK:** invalid keyed trees, duplicate keys, slot cycles, invalid action IDs, stale worker generations and reload recovery.
2. **SQLite:** fresh and upgraded schema; local/SSH profiles, tasks and conversations persist across restart; secret values never stored.
3. **Git:** temp repo with commit, two tasks, distinct worktrees, verified `git worktree list --porcelain`; dirty parent warning.
4. **Workspace isolation:** same relative path in two tasks maps to different files; terminal and ACP session IDs are different.
5. **Local/remote filesystem:** traversal and symlink escapes rejected; remote paths with quotes/spaces; unknown SSH host key rejected.
6. **Real SSH:** SFTP explorer, remote file preview, remote PTY and Git task worktree verified on remote server.
7. **Local ACP:** use an actual Codex/Claude ACP adapter (can be supplied/tested via env), create session in local project/task cwd, stream output, cancel, permission handling.
8. **Remote ACP:** establish agent stdio channel on target SSH host and verify unique remote marker file/cwd; disconnect midstream and show recovery state, never local fallback.
9. **MCP tools:** `initialize`, `tools/list`, `tools/call`, version conflict, source-root isolation, build failure, and approval/denial.
10. **MCP remote bridge:** run remote stdio proxy via SSH with loopback reverse forward; valid session token allows read-only MCP; absent/wrong token rejected; tunnel closed on disconnect.
11. **Hot-swap:** ACP-controlled valid patch to Projects UI triggers versioned module activation; invalid candidate leaves old UI; `ai` reload preserves chat and permissions.
12. **Capabilities:** unsupported model/reasoning config disabled rather than fabricated; MCP toggle only takes effect through supported reconnect/new session.

## 14. Explicit non-goals for POC

- No Electron, Chromium, HTML, browser DOM, system WebView or Node.js embedded as the host UI runtime.
- No dynamic native Rust DLL hot-reload or arbitrary Rust plugins; hot-swap only TS/QuickJS modules.
- No in-app source editing in the **read-only** viewer, LSP, autocomplete, arbitrary new native UI widgets or complete IDE parity.
- No fake virtual Modules project. `modules/` and skills remain internal resources for build/tools, not normal Projects tree entries.
- No third-party MCP execution/installation/management in this POC: show the future selector entries **disabled**. Internal MCP is mandatory and real.
- No automatic installation/authentication of Claude/Codex ACP or SSH helper software without user consent. No credential syncing between local desktop and remote SSH host.
- No automatic unsafe approval bypass of self-patching tools, no arbitrary-agent shell tool inside Internal MCP.
- No copying the user's local Git dirty/staged/untracked state into new worktrees. No automatic Git task delete/prune or advanced merge/review UI.
- No remote Windows SSH host support in POC; POSIX SSH remotes only. Desktop clients still target macOS/Windows/Linux.
- No production multiuser service, untrusted plugin security guarantees, cloud relay, general agent marketplace, autonomous recurring jobs or unattended remote bootstrap.
- No claim of tested cross-platform ACP support without real test evidence; a local and remote demo can be achieved with the test host platform(s) available to the implementer.

## 15. Design choices and trade-offs

**QuickJS vs Node in host:** QuickJS supports tiny, independent TS-to-JS modules without shipping Chromium/Node as UI runtime. ACP adapters may still be Node-based executables running **as external agent processes on the selected project's machine**. Keep these different roles explicit.

**Why GPUI + Rust?** Small native UI host, native controls and device rendering; a typed, keyed UI protocol keeps all replaceable UI composition and handlers in TS. Rust owns resource lifetimes so reloading TS doesn't close PTYs/agents or corrupt SQLite.

**Why real per-workspace ACP?** An agent's filesystem tools, Git commands, sandbox and credentials must operate against the same actual tree the explorer and terminal display. An SSH project is not a local path alias. Persisting task-bound conversations avoids cross-branch file-context confusion.

**Why real MCP?** Agent adapters already implement MCP client integration for tools. Exposing module builds through a legitimate MCP server avoids custom provider-specific ACP extensions and works with both local and remote agents when correctly bridged.

**Why is the remote MCP bridge required?** The ACP stdio process resides remotely; its stdio MCP subprocess is remote too. Local host tools cannot be reached via remote `127.0.0.1` without explicitly configured authenticated forwarding. A reverse SSH loopback forward + stdio relay is feasible for POC and fails closed when unavailable.

**Why no virtual Modules project?** Agent-assisted development uses a dedicated host toolchain with restricted module source access and mandatory approvals. Polluting normal user project/task list with app internals blurs remote/local filesystem boundaries and risks accidental writes.

**Why a host-owned chat transcript and approval broker?** ACP can stream many updates and request long-lived permissions. Keeping these on Rust side avoids throwing them away when the `ai` QuickJS runtime is replaced; host permission decisions must not be delegated to mutable TS modules or the model itself.

**Why SQLite?** Project/task mappings, ACP profile settings, chat metadata and UI context are durable queryable records. Avoid storing secrets or claiming provider-side history merely because the host cached a transcript.

**Why Git worktrees?** Every task gets a persistent branch and independent filesystem/PTY/ACP workspace. Task creation runs on the project's machine and never switches the parent repository checkout.

**Known complexity:** GPUI component integration, QuickJS async job scheduling, native terminal emulation, ACP v1/v2 protocol differences, SSH stdio process management, remote MCP bridge security, and safe host-owned tool approvals. Prefer a real, narrow end-to-end POC over untested broad abstractions.

## 16. Instructions to the implementation agent

1. **Implement the actual POC**, not a rewrite of this design. Create code, modules, scripts, skills, migrations, automated tests and README.
2. Begin by verifying and pinning GPUI, GPUI component/terminal, `rquickjs`, the ACP Rust SDK, adapter versions and MCP SDK/transport versions. Keep `Cargo.lock` and `package-lock.json` committed.
3. Treat ACP v1 as stable baseline and ACP v2 as explicitly negotiated/protocol-versioned optional support. Implement only features the connected adapter actually advertises. Never invent model/reasoning options or fake transcripts.
4. Preserve the **execution rule above all else**: local project/task → local ACP/cwd; SSH project/task → ACP/cwd on same remote SSH machine. Fail clearly if adapter not installed/authenticated remotely; no silent local fallback.
5. Keep TS `ai` module, ACP host process/session, and Internal MCP host service as **three distinct boundaries**. Chat module hot-swap must not terminate a real conversation or revoke queued permissions. Implement no fake `ai` replies.
6. Implement project/task tree, SQLite, local/remote FS, viewer, terminal and Git worktrees first, then local ACP, remote ACP, local MCP and remote MCP, then final self-edit demo.
7. Keep `modules/` out of the Projects sidebar. It is host-owned source accessible via allowlisted Internal MCP and external dev tools; skills are also internal MCP resources.
8. Build a real secure module toolchain: user-approved patch and activation; immutable compiled candidates; validation; stale generation handling; rollback; clear diagnostics. Autopilot must never bypass these host-enforced checks.
9. Use a real SSH POSIX host for the remote tests. If no remote host or adapter credentials are available, implement the real paths, test them as far as practical, and report the exact unverified acceptance criteria. Never simulate a remote ACP and describe it as verified.
10. Demonstration steps in README must include:
    - (a) Local Git Project → Task 1 / Task 2, explore files, switch PTY and switch chat context.
    - (b) SSH Git Project → remote Task 1, remote source preview/PTY, and **remote ACP chat working in remote task cwd**.
    - (c) AI agent (local) reads `build-and-hot-swap` skill via Internal MCP; inspects `projects` module, proposes a code patch, receives host approval, builds/activates the new version and updates UI without Rust restart.
    - (d) Repeat Internal MCP `modules.list`/read or build from a **remote ACP agent over the tunnel**, proving it operated on the desktop host's modules, not an imaginary remote copy.
    - (e) Reload `ai` TypeScript module, confirm same active ACP session/transcript; introduce a bad `projects` candidate, show rollback/retained UI.
11. Finish with actual commands, agent installation examples for local and remote machines, required OpenSSH forwarding/Python3 flags, known limitations, test output, and verified OSes. Don't alter or import any HatoPad code.
12. If a deliverable cannot be completed, leave a precise `TODO`, report which criterion fails, and keep the rest of the POC running. Never silently downgrade live components to static mocks.

## 17. Reference implementations and documentation

Use real published APIs and confirm pinned compatible revisions before coding:

- GPUI source and examples: https://github.com/zed-industries/zed/tree/main/crates/gpui
- GPUI Kit / source editor component: https://github.com/longbridge/gpui-kit
- `rquickjs` Rust binding: https://docs.rs/rquickjs/latest/rquickjs/
- PTY and terminal: https://docs.rs/portable-pty/latest/portable_pty/ and https://github.com/alacritty/alacritty/tree/master/alacritty_terminal
- Rust SSH2/SFTP: https://docs.rs/ssh2/latest/ssh2/
- SQLite: https://docs.rs/rusqlite/latest/rusqlite/
- Git worktrees: https://git-scm.com/docs/git-worktree
- esbuild: https://esbuild.github.io/
- ACP official protocol and schemas: https://agentclientprotocol.com/ and https://github.com/agentclientprotocol/agent-client-protocol
- ACP official Rust SDK: https://github.com/agentclientprotocol/rust-sdk
- ACP v1 session setup: https://github.com/agentclientprotocol/agent-client-protocol/blob/main/docs/protocol/v1/session-setup.mdx
- ACP v2 migration (DRAFT / opt-in): https://github.com/agentclientprotocol/agent-client-protocol/blob/main/docs/protocol/v2/migration.mdx
- Codex ACP adapter (current upstream): https://github.com/agentclientprotocol/codex-acp
- Claude ACP adapter (current upstream): https://github.com/agentclientprotocol/claude-agent-acp
- MCP protocol and transport specification: https://modelcontextprotocol.io/specification
- MCP Rust SDK `rmcp` (verify exact compatibility): https://github.com/modelcontextprotocol/rust-sdk
- OpenSSH forwarding semantics: https://man.openbsd.org/ssh#R

**Compatibility caution:** ACP v2 is evolving and native MCP-over-ACP features may still be unstable. The POC must use the **conventional agent-supplied MCP server configuration over stdio** and not depend on experimental MCP-over-ACP support. For `mcpServers` request format, adapt to the negotiated ACP protocol version and advertised transports. The internal MCP bridge is not a new ACP protocol feature.

---

**Definition of success:** A small, native desktop platform where every visible window/panel is composed by replaceable TypeScript modules. A persistent Projects sidebar presents local/SSH project roots and Git task worktrees. Explorer, highlighted source preview, terminal and **ACP AI chat** all operate in the same *selected workspace* on its actual machine: local ACP for local workspaces, **remote ACP on the same SSH host** for remote workspaces. The host-owned, real Internal MCP exposes discoverable toolchain skills and approved module source/build/swap/rollback tools to either agent over secure transports. An agent can patch and activate `projects.0002.mjs` without restarting Rust or losing project/task state, live PTY, or ACP chat. No virtual Modules project and no fake remote execution.
