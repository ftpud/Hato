// Hato module SDK types (moduleApiVersion 1, host ABI 1).
// This file describes the ModuleContext the kernel prelude provides inside every module
// generation's private QuickJS runtime. There are NO Node APIs: all privileged work goes through
// `ctx.host`, a capability broker implemented by the Rust kernel.

import type { SyntaxPalette } from "./syntax-schemes";
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
/** Opaque, kernel-owned handle. Unforgeable: the kernel checks kind and owning module on every use. */
export type Handle = string;

export type ExecutionTarget =
  | { kind: "local" }
  | { kind: "ssh"; connection: Handle; machineId: string };

export interface HostError extends Error { code: string }

export interface ScopeGrantRequest {
  kind: "fs" | "process" | "pty" | "source" | "build";
  /** Absolute root ON the target machine (ignored for source/build). */
  root?: string;
  target?: ExecutionTarget;
  write?: boolean;
  purpose?: string;
}
export interface ScopeGrant { grant: Handle; root: string; machineId: string; kind: string; write: boolean }

export interface FileEntry { name: string; kind: "dir" | "file" | "symlink" | "other"; size: number; symlink: boolean }
export interface FileStat { kind: string; size: number; mtime: number | null; path: string }
export interface FileRead { path: string; binary: boolean; size: number; truncated: boolean; text?: string; base64?: string }

export interface SpawnRequest {
  target?: ExecutionTarget;
  executable: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  /** Names removed from the inherited environment (local) / via `env -u` (remote). */
  envRemove?: string[];
  /** Remote only: run through the user's login shell so PATH from profile files applies. */
  loginShell?: boolean;
  /** Keep the process in the target machine's daemon (needs `remote.daemon` and `daemon.ensure`):
   *  it survives disconnects/app restarts, output is buffered while detached, and spawning the
   *  same key again reattaches instead of starting a new process. Keys are per module. */
  persist?: { key: string };
}
export interface RunResult { code: number | null; signal: number | null; stdout: string; stderr: string; truncated: boolean }
export interface PtyRequest { target?: ExecutionTarget; cwd: string; shell?: string; columns: number; rows: number; env?: Record<string, string>;
  /** Keep the shell in the target machine's daemon; opening the same key again reattaches. */ persist?: { key: string } }

export type DaemonTarget = { kind: "local" } | { kind: "ssh"; connection: Handle };
export interface DaemonStatus { machineId: string; bin: string; dir: string; status: any }
export interface DaemonResources { ptys: { key: string; cwd: string; exit: string | null; attached: boolean; title?: string }[];
  procs: { key: string; pid: number; command: string; exit: any; attached: boolean; bufferedBytes: number; droppedBytes: number }[] }

/** `transport: "wsl"` (Windows only): `host` is a WSL distribution, reached without SSH.
 *  `auth: "password"`: the kernel asks natively when connecting; modules never see the password. */
export interface SshProfileSpec { profileId: string; host: string; port: number; user: string; identityFile?: string | null; transport?: "ssh" | "wsl"; auth?: "password" }
export interface SqlStatement { sql: string; params?: Json[] }

export interface StreamSubscription { subId: string; close(): Promise<void> }
export interface StreamOptions { channel?: "stdout" | "stderr"; encoding?: "utf8" | "base64"; highWaterMark?: number }

export interface HttpRequest { url: string; method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS"; headers?: Record<string, string>; body?: string; timeoutMs?: number; maxBytes?: number }
/** Header names are lowercase; repeated headers are joined with ", ". */
export interface HttpResponse { status: number; headers: Record<string, string>; body: string }

export interface ApprovalOption { id: string; label: string; kind?: "allow" | "deny" | "neutral" }

export interface NativeHost {
  readonly abiVersion: 1;
  env: { info(): EnvInfo };
  capabilities: {
    request(req: ScopeGrantRequest): Promise<ScopeGrant>;
    release(grant: Handle): Promise<void>;
  };
  fs: {
    /** OS notifications as a process stream: stdout lines `ready` / `changed`.
     * Release with resources.release. SSH requires remote.daemon and a matching daemon build. */
    watch(grant: Handle, path: string, opts?: { recursive?: boolean }): Promise<{ handle: Handle }>;
    stat(grant: Handle, path: string): Promise<FileStat>;
    list(grant: Handle, path: string): Promise<{ path: string; entries: FileEntry[] }>;
    realpath(grant: Handle, path: string): Promise<string>;
    read(grant: Handle, path: string, limitBytes?: number): Promise<FileRead>;
    writeAtomic(grant: Handle, path: string, text: string, opts?: { reason?: string; mode?: number }): Promise<{ path: string; bytes: number }>;
    mkdir(grant: Handle, path: string): Promise<{ path: string }>;
  };
  process: {
    spawn(grant: Handle, request: SpawnRequest): Promise<{ handle: Handle; pid: number; machineId: string }>;
    run(grant: Handle, request: SpawnRequest, opts?: { timeoutMs?: number; limitBytes?: number; stdin?: string }): Promise<RunResult>;
    write(handle: Handle, text: string): Promise<void>;
    closeStdin(handle: Handle): Promise<void>;
    terminate(handle: Handle, signal?: string): Promise<void>;
    wait(handle: Handle): Promise<{ code: number | null; signal: number | null } | null>;
    info(handle: Handle): Promise<Json>;
  };
  pty: {
    open(grant: Handle, req: PtyRequest): Promise<{ handle: Handle; machineId: string; cwd: string }>;
    write(pty: Handle, text: string): Promise<void>;
    resize(pty: Handle, columns: number, rows: number): Promise<void>;
    close(pty: Handle): Promise<void>;
    read(pty: Handle, opts?: { cursor?: number; limitBytes?: number }): Promise<{ text: string; cursor: number; endCursor: number; truncated: boolean; exit: string | null }>;
    info(pty: Handle): Promise<{ machineId: string; cwd: string; columns: number; rows: number; exit: string | null; screen: string }>;
  };
  ssh: {
    /** `interactive`: a user gesture, so a password profile may prompt. Otherwise it fails with ENEEDAUTH until connected. */
    connect(profile: SshProfileSpec, options?: { interactive?: boolean }): Promise<{ connection: Handle; machineId: string; home: string | null }>;
    /** Installed WSL distributions, the default first. Empty off Windows. */
    wslDistributions(): Promise<string[]>;
    status(connection: Handle): Promise<{ alive: boolean; machineId: string; lastError: string | null }>;
    disconnect(connection: Handle): Promise<void>;
    forwardLoopback(connection: Handle, request: { listener: Handle }): Promise<{ handle: Handle; remotePort: number; localPort: number }>;
    localForward(connection: Handle, request: { localPort: number; remoteHost: string; remotePort: number }): Promise<{ handle: Handle; localPort: number }>;
    cancelForward(handle: Handle): Promise<void>;
  };
  net: {
    /** Accept loopback TCP connections; `port` 0/omitted picks a free port. Needs `net.loopback`. */
    listenLoopback(opts?: { port?: number }): Promise<{ handle: Handle; port: number }>;
    /** Outbound HTTP (`net.fetch`): https anywhere, plain http only to loopback. Redirects are
     *  returned (3xx + location), not followed. Body is UTF-8 text, capped by `maxBytes` (≤ 8 MiB). */
    fetch(request: HttpRequest): Promise<HttpResponse>;
    write(handle: Handle, text: string): Promise<void>;
    close(handle: Handle): Promise<void>;
  };
  db: {
    openNamespace(namespace: string): Promise<Handle>;
    query<T = Record<string, Json>>(db: Handle, sql: string, params?: Json[]): Promise<T[]>;
    exec(db: Handle, sql: string, params?: Json[]): Promise<{ changes: number; lastInsertRowid?: number }>;
    transaction(db: Handle, statements: SqlStatement[]): Promise<{ changes: number }>;
  };
  streams: {
    listen(handle: Handle, opts: StreamOptions | undefined, onData: (chunk: string) => void, onEnd?: (err: HostError | null) => void): Promise<StreamSubscription>;
    subscribe(handle: Handle, opts?: StreamOptions): AsyncIterable<string>;
    unsubscribe(subId: string): Promise<void>;
  };
  resources: {
    retainForWorkspace(handle: Handle, stableKey: string): Promise<void>;
    lookup(stableKey: string): Promise<Handle | null>;
    info(handle: Handle): Promise<Json>;
    release(handle: Handle): Promise<void>;
  };
  modules: {
    list(): Promise<ModuleStatus[]>;
    describe(id: string): Promise<Json>;
    logs(id: string, limit?: number): Promise<Json[]>;
    stageArtifact(id: string, code: string): Promise<{ stageId: string; id: string; version: number; label: string; sha256: string }>;
    /** `force` skips the active generation's `canSwap` veto; the native approval warns about this. */
    activate(id: string, stageId: string, opts?: { force?: boolean }): Promise<{ ok: boolean; version: number; label: string; previous: string | null; swapMs: number }>;
    rollback(id: string, opts?: { toVersion?: number; force?: boolean }): Promise<{ ok: boolean; version: number; label: string; previous: string | null }>;
    discard(stageId: string): Promise<void>;
    sourceInfo(): Promise<{ repoRoot: string; sdkRoot: string; modulesRoot: string; buildTool: string | null }>;
  };
  /** Remote runtime (`hato daemon`): holds terminals/processes across disconnects and hosts
   *  plugins on the workspace machine. Requires the `remote.daemon` capability. */
  daemon: {
    /** Install (upload) if needed and start the daemon on that machine. */
    ensure(target?: DaemonTarget): Promise<DaemonStatus>;
    status(target?: DaemonTarget): Promise<DaemonStatus | null>;
    /** hello/status, resources.list (own resources only), pty.kill/proc.kill/proc.closeStdin {key},
     *  plugins.list, plugins.push {id} (locally installed + approved plugins only),
     *  plugins.enable/disable {id}, pty.read/write {key, cursor?/text}, modules.call {target, method, args}. */
    request<T = any>(target: DaemonTarget | undefined, op: string, args?: object): Promise<T>;
  };
  /** Every module is a plugin. Listing is open to all modules; mutations need `plugins.manage`
   *  and anything that widens trust (install, new capabilities/calls) needs a native approval. */
  plugins: {
    list(): Promise<{ plugins: PluginInfo[]; root: string | null; rootOverride: string | null }>;
    /** Enabled plugins implementing a contract (e.g. "shell.root"). */
    providers(contract: string): Promise<string[]>;
    /** Enabled plugins that would break if `id` were disabled. */
    dependents(id: string): Promise<string[]>;
    enable(id: string): Promise<{ id: string; enabled: true; active: boolean; error: string | null }>;
    /** Fails with EDEPENDENTS unless `cascade` (then dependents are disabled too). */
    disable(id: string, opts?: { cascade?: boolean }): Promise<{ disabled: string[] }>;
    /** Pin the window root to a plugin providing "shell.root" (null = automatic). */
    setRoot(id: string | null): Promise<void>;
    /** Copy a local plugin folder into the kernel-owned plugins dir (stays disabled). */
    install(path: string): Promise<{ id: string; enabled: boolean; dir: string; pendingRestart?: boolean; pendingActivation?: boolean }>;
    /** Reinstall the previous healthy artifact, including deferred live self replacement. */
    rollback(id: string): Promise<{ id: string; pendingActivation?: boolean }>;
    /** Validate a prepared set, approve once, update live, and restore prior versions on failure. */
    installMany(paths: string[]): Promise<{ plugins: { id: string; pendingActivation?: boolean }[] }>;
    uninstall(id: string): Promise<{ id: string; uninstalled: true; disabled: string[] }>;
    /** Pick up plugin folders added on disk. */
    rescan(): Promise<{ added: string[] }>;
  };
  approvals: {
    request(req: { title: string; detail?: string; options?: ApprovalOption[]; operation?: string; timeoutMs?: number }): Promise<{ optionId: string | null; expired?: boolean }>;
  };
  ui: {
    invalidate(moduleId?: string): void;
    documentOpen(workspaceKey: string, text: string, language: string, opts?: { path?: string }): Promise<Handle>;
    pickFolder(): Promise<string | null>;
    /** Open an http(s) URL in the system browser (`ui.openUrl`). */
    openUrl(url: string): Promise<void>;
    toast(level: "info" | "warn" | "error", text: string): void;
  };
}

export interface EnvInfo {
  abiVersion: 1; appName: string; platform: string; arch: string; home: string | null;
  dataDir: string; sharedDir: string; initialRoot: string | null; repoRoot: string; uptimeMs: number; headless: boolean;
}

export interface ModuleStatus {
  id: string; kind: "service" | "ui";
  active: { version: number; generation: number; label: string; sha256: string; capabilities: string[] } | null;
  /** Imported seed build (the supplied baseline for this runtime). Absent on older kernels. */
  seedVersion?: number | null;
  lastKnownGood: number | null; previous: number[];
  versions: { version: number; sha256: string; created: string; origin: string; status: string; note: string }[];
  generations: { generation: number; version: number; status: string; inflight: number; errors: number; subscriptions: number }[];
  lastError: string | null; fenced: boolean;
}

export interface PluginInfo {
  id: string; name: string; kind: "service" | "ui"; description: string;
  /** "builtin" ships with the app; "user" lives in the data dir's plugins folder. */
  source: "builtin" | "user";
  enabled: boolean;
  /** Active generation label, e.g. "ai@0003". */
  active: string | null;
  provides: string[]; requires: string[]; dependencies: string[];
  runsOn: "ui" | "workspace" | "either";
  capabilities: string[]; calls: string[];
  /** Capabilities / `call:<id>` entries enabling would have to approve. */
  pendingApprovals: string[];
  /** Module-interpreted contributions from the manifest (see sdk/plugins.ts). */
  contributes: any;
  metadata?: Record<string, Json>;
  canRollback?: boolean;
  lastError: string | null;
  dir: string | null;
}

export interface ModuleContext {
  readonly moduleId: string;
  readonly generation: number;
  readonly version: number;
  readonly host: NativeHost;
  modules: { call<T = any>(id: string, method: string, args?: Json | object, opts?: { timeoutMs?: number }): Promise<T> };
  events: { emit(topic: string, payload?: Json | object): void; on(topic: string, listener: (payload: any) => void): () => void };
  state: { get<T = Json>(key: string): T | undefined; set(key: string, value: Json | object): void; watch(key: string, listener: (value: any) => void): () => void };
  ui: { invalidate(): void };
  log: Console;
}

export interface CallMeta { caller: string }

export interface AppModule {
  id: string;
  moduleApiVersion: 1;
  activate?(ctx: ModuleContext, previousState?: any): Promise<void> | void;
  deactivate?(ctx: ModuleContext): Promise<void> | void;
  snapshot?(ctx: ModuleContext): Promise<Json | object> | Json | object;
  /** Return { ok: false, reason } to defer a hot swap (e.g. while a protocol session is busy). */
  canSwap?(ctx: ModuleContext): Promise<{ ok: boolean; reason?: string }> | { ok: boolean; reason?: string };
  render?(ctx: ModuleContext): UiNode | Promise<UiNode>;
  onEvent?(ctx: ModuleContext, event: UiEvent): Promise<void> | void;
  methods?: Record<string, (ctx: ModuleContext, args: any, meta: CallMeta) => any>;
}

// ---- Keyed UI protocol ---------------------------------------------------------------------------
export interface UiEvent {
  action: string;
  key: string;
  /** Row key for tree/fileList; selected value for select/toggle/tabs. */
  rowKey?: string;
  value?: Json;
  /** Current text of every textInput in this module's tree (read natively at event time). */
  inputs: Record<string, string>;
}

/** A color: `#rrggbb` / `#rrggbbaa`, a token from the theme node's palette (e.g. "surface"), or a
 *  semantic name: background, text, muted, raised, panel, border, primary, primaryText, selection,
 *  hover, danger, warning, success, info, transparent. */
export type UiColor = string;
/** Generic presentation applied by the renderer to boxes, buttons and text. Numbers are px and are
 *  clamped natively. There are no named presets: share styles as data (see sdk/chat-style.ts). */
export interface UiStyle {
  background?: UiColor; color?: UiColor; borderColor?: UiColor;
  borderWidth?: number; borderTop?: number; borderBottom?: number; borderLeft?: number; borderRight?: number;
  radius?: number; padding?: number; paddingX?: number; paddingY?: number; gap?: number;
  width?: number; height?: number; minHeight?: number; maxWidth?: number; fullWidth?: boolean; noShrink?: boolean; wrap?: boolean;
  fontWeight?: number; fontSize?: number; lineHeight?: number; font?: "ui" | "mono"; italic?: boolean;
  justify?: "start" | "center" | "end" | "between"; shadow?: "sm" | "md" | "lg"; opacity?: number;
  /** "relative" makes this box the positioning parent of popovers inside it. */ position?: "relative";
}
interface Base { /** Drag this region to move its native window. Use a dedicated noninteractive handle. */ windowDrag?: boolean; style?: UiStyle; key: string; grow?: boolean; width?: number; height?: number; /** Cap height (px); the node may shrink below it and should scroll. */ maxHeight?: number; minWidth?: number; padding?: number; gap?: number; bg?: "panel" | "muted" | "accent" | "none"; border?: boolean; borderSide?: "left" | "right"; tooltip?: string }
/** A canvas item: fixed box with ordinary child nodes. `port` shows a connection handle on its right edge. */
export interface CanvasItem { key: string; x: number; y: number; width: number; height: number; port?: boolean; style?: UiStyle;
  /** Breathing glow ring in this color (e.g. a running step). */ pulse?: UiColor; children: UiNode[] }
/** A painted connector between two canvas item keys. Sides default to right → left. */
export interface CanvasEdge { key: string; from: string; to: string; fromSide?: "left" | "right" | "top" | "bottom"; toSide?: "left" | "right" | "top" | "bottom";
  /** Optional Bezier handle length in canvas pixels; compact graphs can use shorter curves. */ curveOffset?: number;
  color?: UiColor; width?: number; dashed?: boolean; arrow?: boolean; label?: string;
  /** A spark travels along the connection (e.g. data in flight). */ active?: boolean; sparkColor?: UiColor }
export type UiNode =
  /** Window-wide theme (normally from the root plugin). `mode` is the appearance preference;
   *  `terminal` overrides the 16 ANSI colors; `chrome` configures kernel chrome such as toasts. */
  | (Base & { type: "theme"; controls?: { listRowHeight?: number; stripedRows?: boolean; rowDividers?: boolean }; /** Palette `textSelection` independently styles selected text; defaults to `selection`. */ palette: { light: Record<string, string>; dark: Record<string, string> }; mode?: "light" | "dark";
      /** Runtime application icon (macOS Dock and app switcher), including unbundled source launches. */ applicationIcon?: ImageAttachment;
      typography?: { fontFamily?: string; monoFontFamily?: string; fontSize?: number; monoFontSize?: number; fontWeight?: number };
      terminal?: { light?: string[]; dark?: string[] };
      /** Syntax color scheme per appearance (see sdk/syntax-schemes.ts); omit for built-in colors. */
      syntax?: { light?: SyntaxPalette; dark?: SyntaxPalette };
      chrome?: { toasts?: { position?: "bottom-right" | "bottom-left" | "top-right" | "top-left"; width?: number; durationMs?: number; max?: number } } })
  | (Base & { type: "titleBar"; children: UiNode[] })
  | (Base & { type: "row" | "column"; children: UiNode[]; /** Embedded wallpaper, cover-cropped behind children. */ backgroundImage?: ImageAttachment;
      /** Applies only to the wallpaper; foreground children retain full opacity. Defaults: opacity 1, scale 1. */
      backgroundImageStyle?: { opacity?: number; /** Centered zoom, clamped to 1–4. */ scale?: number;
        /** Fixed artwork width in px, preserving its aspect ratio independently of container height. Otherwise cover-fit. */ width?: number;
        /** Fixed offsets from the container's top-left in px; override centering on each axis. */ left?: number; top?: number;
        /** Horizontal shift as a fraction of the container width, clamped to -1–1. Negative moves left. */ offsetX?: number };
      align?: "start" | "center" | "end" | "stretch"; wrap?: boolean; scroll?: boolean })
  | (Base & { type: "split"; direction: "horizontal" | "vertical"; sizes?: number[]; children: UiNode[];
      /** Fixed size in px per child (null = flexible). */ fixed?: (number | null)[]; minSize?: number; resizable?: boolean;
      /** Fired once when a divider drag ends: value {sizes}. */ resizeAction?: string;
      /** Fired when a divider is dragged past a collapsible child's minimum: value {index}. */ collapseAction?: string; collapsible?: boolean[] })
  /** Native drag source. A click (no movement) fires clickAction with `payload`. */
  | (Base & { type: "dragHandle"; payload: Json; label?: string; clickAction?: string; children?: UiNode[] })
  /** Native drop target; on drop fires `action` with {payload, region, zone}. */
  /** Scrollable surface of absolutely positioned items (content px) joined by painted connectors.
   *  Native code moves items and drags new connections; one event fires when a gesture ends:
   *  `moveAction` {key,x,y}; `selectAction` {key} (click without moving); `connectAction` {from,to}
   *  from an item's port onto another item ({from,to:null,x,y} on empty space); `edgeAction` {key}
   *  from an edge label chip; `clickAction` {x,y} on empty space. `grid` draws guide lines (px).
   *  Without `moveAction` the canvas is a read-only view (clicks still select); `height` fixes its size. */
  | (Base & { type: "canvas"; items: CanvasItem[]; edges?: CanvasEdge[]; contentWidth?: number; contentHeight?: number; grid?: number; /** Space past the last item (px, default 240). */ margin?: number;
      moveAction?: string; selectAction?: string; connectAction?: string; edgeAction?: string; clickAction?: string })
  | (Base & { type: "dropZone"; action: string; regions?: ("left" | "right" | "top" | "bottom" | "center")[]; children: UiNode[] })
  /** Panel floating inside the main window; native move/resize; fires moveAction {x,y,width,height}. */
  | (Base & { type: "floating"; x: number; y: number; width: number; height: number; title?: string; moveAction?: string; children: UiNode[] })
  /** A real OS window rendering `children`; closing it fires closeAction {width,height}. */
  | (Base & { type: "window"; /** Set false to omit native titlebar chrome. */ titlebar?: boolean; title?: string; width?: number; height?: number; closeAction?: string; children: UiNode[] })
  | (Base & { type: "scroll"; children: UiNode[] })
  | (Base & { type: "tabs"; tabs: { key: string; label: string }[]; active: string; action: string; children: UiNode[] })
  | (Base & { type: "slot"; module: string })
  /** Button-anchored popup rendered outside clipped toolbars/panels. Escape/outside click send action=false. */
  | (Base & { type: "dropdown"; text: string; iconSvg?: string; open: boolean; action: string; disabled?: boolean; variant?: "primary" | "ghost" | "danger" | "default";
      menuWidth?: number; maxHeight?: number; children: UiNode[] })
  | (Base & { type: "label"; text: string; size?: "xs" | "sm" | "md" | "lg"; weight?: "normal" | "medium" | "semibold" | "bold"; /** "default" or any UiColor. */ color?: UiColor; mono?: boolean; wrap?: boolean; /** Let the user select and copy the text. */ selectable?: boolean })
  | (Base & { type: "button"; text: string; /** Inline SVG drawing, bundled and hot reloaded with the module (see sdk/ui-icons.ts). */ iconSvg?: string; iconSize?: number; iconColor?: UiColor; /** Compact count overlay on the button. Empty or absent hides it. */ badge?: string; action: string; variant?: "primary" | "ghost" | "danger" | "default"; disabled?: boolean; value?: Json; small?: boolean;
      /** Copied to the clipboard natively on click (no round trip); `action` may be "". */ copyText?: string; /** Secondary mouse gestures use the same value as action. */ doubleClickAction?: string; middleClickAction?: string; contextAction?: string; contextMenu?: { text: string; action: string; value?: Json; disabled?: boolean }[] })
  | (Base & { type: "textInput"; placeholder?: string; value?: string; submitAction?: string; changeAction?: string; /** Inline SVG shown before single-line input text. */ prefixSvg?: string; pasteImageAction?: string; /** Limits for pasted pictures. */ maxFiles?: number; maxBytes?: number; secret?: boolean; multiline?: boolean; /** Fill the available height instead of using a fixed row count. */ fillHeight?: boolean; rows?: number; rowHeight?: number; disabled?: boolean })
  | (Base & { type: "select"; options: { value: string; label: string; disabled?: boolean }[]; value: string | null; action: string; disabled?: boolean; placeholder?: string; label?: string; disabledReason?: string; /** Style of the dropdown button itself (`style` styles its wrapper). */ buttonStyle?: UiStyle })
  | (Base & { type: "choice"; text: string; description?: string; disabled?: boolean; selected?: boolean; action: string; value: string; /** Glyph shown when selected (default ✓). */ mark?: string })
  | (Base & { type: "switch"; label: string; checked: boolean; action: string; disabled?: boolean; /** Track color when on. */ accent?: UiColor })
  /** Click-outside-to-close overlay. Anchored from `top` (default 52), or upward from `bottom`
   *  (content height then, unless `heightFraction` is set). */
  | (Base & { type: "popover"; children: UiNode[]; closeAction: string; top?: number; bottom?: number; left?: number; right?: number; /** Height as a fraction of the parent (0.1–1). */ heightFraction?: number; maxHeight?: number })
  | (Base & { type: "toggle"; label: string; checked: boolean; action: string; disabled?: boolean })
  | (Base & { type: "tree"; rows: TreeRow[]; selectAction: string; expandAction: string; /** Fired with the row key as the pointer enters a row, and without one when it leaves the list. */ hoverAction?: string; /** Fired with the row key on double click (after the first click's selectAction). */ activateAction?: string;
      /** Fixed row height (px); omit for content height. */ rowHeight?: number;
      /** Lazy paging (fixed `rowHeight` trees only): fired with {rows} when the last row scrolls into view,
       *  once per row count and first row. Omit it while loading or when nothing more exists. */ endReachedAction?: string;
      /** Hover fill color token (default "hover") and its opacity 0–1 (default 1). */ hoverBackground?: UiColor; hoverOpacity?: number; /** Indent per depth level (px). */ indent?: number; rowGap?: number; iconSize?: number; /** Non-square row icon box (px); overrides iconSize per axis. */ iconWidth?: number; iconHeight?: number; expandedIconSvg?: string; collapsedIconSvg?: string })
  /** Native diff view of a unified patch (e.g. `git diff` output) held in a document handle. */
  | (Base & { type: "diff"; document: Handle | null; /** Initially fold file patches; later user expansion is preserved. */ filesCollapsed?: boolean; /** Floating navigation between changed regions; labels supplied by the module. */ changeNavigation?: { previous: string; next: string }; mode?: "split" | "unified"; softWrap?: boolean; header?: boolean; placeholder?: string; emptyText?: string })
  | (Base & { type: "status"; text: string; level?: "info" | "warn" | "error" | "success" })
  | (Base & { type: "progress"; value?: number; indeterminate?: boolean; label?: string })
  /** Markdown from a document handle (scrolls) or inline `text`; `inline` renders without its own scroll area. */
  | (Base & { type: "markdown"; /** Presentation of fenced code blocks. */ codeBlockStyle?: UiStyle; document?: Handle; text?: string; inline?: boolean; lineHeight?: number; /** rem */ paragraphGap?: number; /** Non-web link clicks fire this action with the raw href as `value`; http(s)/mailto open natively. */ linkAction?: string })
  /** Native syntax-highlighted editor over a document handle (read-only unless `editable`).
   *  Edits stay native; after `changeDebounceMs` (default 400) of quiet, `changeAction` fires
   *  with value {document, text}. The module decides whether/how to persist the text. */
  | (Base & { type: "codeViewer"; document: Handle | null; placeholder?: string; editable?: boolean; changeAction?: string; changeDebounceMs?: number;
      /** Override the document grammar without replacing its editor/buffer. */ language?: string;
      /** Wrap long lines at the panel width (default true). */ softWrap?: boolean;
      /** Bars at the editor's left edge for zero-based lines `line..endLine` (exclusive; equal = a
       *  deletion point). Clicking one fires `lineMarkerAction` with {marker: value, y}. */
      lineMarkers?: { line: number; endLine?: number; color: UiColor; value?: Json }[]; lineMarkerAction?: string; lineMarkerWidth?: number;
      /** Dim text painted after the end of zero-based `line` (e.g. author and age of a declaration); it
       *  follows scrolling and soft wrap and takes no input. Code font at `lineAnnotationScale` (0.5–1.2,
       *  default 0.9) of its size, `color` or the muted color at `lineAnnotationOpacity` (default 0.65). */
      lineAnnotations?: { line: number; text: string; color?: UiColor }[]; lineAnnotationScale?: number; lineAnnotationOpacity?: number;
      /** Optional module-supplied lexical highlighter (for languages without a bundled grammar). */ syntaxRules?: SyntaxRule[];
      /** Code font; unset fields keep the theme's mono font. `weight` 100–900, `size` px, `lineHeight` × size. */
      font?: { family?: string; weight?: number; size?: number; lineHeight?: number };
      /** Tree-sitter highlights query replacing the bundled one for `language` (all views of that grammar). */
      highlightQuery?: string;
      /** Restyle tokens by text: `{baseCapture: {text: capture}}`, e.g. `{type: {Runnable: "type.interface"}}`. */
      nameCaptures?: Record<string, Record<string, string>>;
      /** Method on this UI module returning LSP LocationLink[]. Receives args + document/text/position. */ definitionMethod?: string; definitionArgs?: Json | object;
      /** Methods on the rendering module receiving document/text/UTF-16 position and definitionArgs. */
      hoverMethod?: string; completionMethod?: string; completionTriggers?: string[];
      /** Completion items render `label` (+ muted `labelDetails.detail`) and right-aligned `labelDetails.description`
       *  (else `detail`); `data.presentation: {icon?: {text, color?, background?}, bold?, mutedFrom?}` adds a kind
       *  badge, bolds the label and mutes it from the UTF-8 offset `mutedFrom` (e.g. parameters). */
      completionMenu?: { width?: number; minWidth?: number; maxHeight?: number };
      /** Parameter hints: called with document/text/position/context (LSP SignatureHelpContext) after a
       *  trigger (default "(" and ",") and on every edit while shown; return LSP SignatureHelp or null. */
      signatureMethod?: string; signatureTriggers?: string[];
      /** Called with {item} when an offered completion is accepted; a returned item's
       *  `additionalTextEdits` (e.g. imports) are applied without moving the caret. */
      completionResolveMethod?: string;
      /** LSP {uri, selection} fired only when a definition is activated. */ openLocationAction?: string;
      /** Open Find with a literal case-insensitive query and reveal its first match. A new key repeats it. */
      search?: { key: string; query: string };
      /** One-shot cursor movement; a new key repeats it. Positions use zero-based UTF-16. */ reveal?: { key: string; line: number; character: number };
      /** Items appended to the editor's native right-click menu (after Cut/Copy/Paste). Choosing one fires
       *  `action` with value {document, value, selection: {start, end}} (zero-based UTF-16; start == end at a
       *  caret). `requiresSelection` disables the item while nothing is selected. */
      contextMenu?: ({ text: string; action: string; value?: Json; disabled?: boolean; requiresSelection?: boolean } | { separator: true })[] })
  | (Base & { type: "terminal"; pty: Handle | null; placeholder?: string })
  /** Native picture file dialog; fires `action` with attachments (or {error}). */
  | (Base & { type: "imagePicker"; action: string; disabled?: boolean; text?: string; iconSvg?: string; iconSize?: number; dialogTitle?: string; maxFiles?: number; maxBytes?: number })
  | (Base & { type: "image"; image: ImageAttachment })
  /** Follow-to-bottom list with native scroll anchoring. `children` are ordinary nodes (one per
   *  item, keyed). Scrolling near the top fires `loadOlderAction` (when `hasOlder`); reaching the
   *  bottom fires `bottomAction`. A new `followKey` re-enters follow mode; `scrollKey` separates
   *  scroll state (e.g. per conversation). See sdk/chat-transcript.ts. */
  | (Base & { type: "transcript"; children: UiNode[]; scrollbarMode?: "always" | "hover" | "scrolling"; scrollKey?: string; followKey?: string; hasOlder?: boolean; loadingOlder?: boolean; loadOlderAction?: string; bottomAction?: string; preserveScrollOnChange?: boolean; scrollReset?: number })
  | (Base & { type: "approvalPanel" })
  | (Base & { type: "divider" })
  | (Base & { type: "spacer" })
  | (Base & { type: "modal"; title: string; children: UiNode[]; closeAction?: string; /** Card width (px). */ width?: number });

/** Ordered lexical rules; earliest match wins, then declaration order. Rust regex syntax. */
export interface SyntaxRule { pattern: string; capture: string }

export interface TreeRow { /** Optional plugin-supplied row tint; selection/hover take precedence. */ background?: UiColor; /** Native hover tooltip for the row. */ tooltip?: string; description?: string; /** Shows an animated activity indicator after the label. */ busy?: boolean; iconSvg?: string; iconColor?: UiColor; connector?: "branch" | "last"; key: string; label: string; depth: number; expandable: boolean; expanded: boolean; selected: boolean; /** Shown as-is after the label. */ badge?: string;
  /** Colored short texts before `badge` (e.g. "+12" success, "−3" danger). */ badges?: { text: string; color?: UiColor }[];
  /** Native right-click menu; items fire `action` with this row's key as rowKey and `value`. */
  contextMenu?: ({ text: string; action: string; value?: Json; disabled?: boolean } | { separator: true })[];
  detail?: string; weight?: "medium" | "semibold" | "bold"; /** Module-side classification (not rendered). */ icon?: string }
export interface ImageAttachment { name: string; mimeType: string; data: string }
export interface ChatMessage { images?: ImageAttachment[]; key: string; role: "user" | "assistant" | "thought" | "tool" | "system" | "error" | "plan"; text: string; title?: string; status?: string }

/** Published at <moduleId>.settings; only the owning module can write it. */
export type SettingField =
  | { key: string; label: string; description?: string; type: "action"; buttonLabel: string; disabled?: boolean }
  | { key: string; label: string; description?: string; type: "text"; value: string; placeholder?: string }
  | { key: string; label: string; description?: string; type: "toggle"; value: boolean }
  | { key: string; label: string; description?: string; type: "select"; value: string; options: { value: string; label: string }[] }
  | { key: string; label: string; description?: string; type: "order"; value: string; items: { id: string; label: string }[]; allowSpacers?: boolean };
export interface SettingsSection { key: string; title: string; group?: string; layout?: "table"; description?: string; fields: SettingField[] }
export interface SettingsExport { sections: SettingsSection[]; error: string | null; resetLabel?: string }
