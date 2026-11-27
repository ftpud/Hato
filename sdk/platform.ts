// Machine platform layer: OS, paths, well-known folders, host features, shell profiles and tool
// resolution. Modules branch on what this file reports (a profile, a feature, a separator), not on
// OS names, so another OS or shell is added here rather than in every module.
//
// Modules never start `sh`/`bash` for their own work: they spawn programs with argv and parse
// output in TypeScript. The exceptions live here: `userCommand` runs text the *user* wrote through
// the shell profile they picked, and `resolveWindowsExecutable` asks Windows PowerShell for PATH.
import type { ExecutionTarget, Handle, KnownDirs, ModuleContext } from "./types";

/** OS of a machine. `posix` is a Unix machine whose flavour is not known (e.g. an SSH host not yet probed). */
export type MachineOs = "windows" | "macos" | "linux" | "posix";

export const isPosix = (os: MachineOs) => os !== "windows";

/** `env.info().platform` (Rust's `std::env::consts::OS`) as a machine OS. */
export function osOf(platform: unknown): MachineOs {
  return platform === "windows" ? "windows" : platform === "macos" ? "macos" : platform === "linux" ? "linux" : "posix";
}

/** OS of the desktop/daemon running this module. */
export function hostOs(ctx: ModuleContext): MachineOs {
  return osOf(ctx.host?.env?.info?.().platform);
}

/** OS of a workspace's machine: the descriptor's `os` when known; else local follows the host and
 *  remote machines (SSH, WSL, Cloud) are POSIX. */
export function workspaceOs(ctx: ModuleContext, desc: { location: string; os?: MachineOs | null }): MachineOs {
  return desc.os || (desc.location === "local" ? hostOs(ctx) : "posix");
}

// ---------------------------------------------------------------------------------------------
// Declared platform support (plugin manifests `platforms`, agent providers `platforms`)

export type PlatformId = "windows" | "macos" | "linux";
export const PLATFORM_LABELS: Record<PlatformId, string> = { windows: "Windows", macos: "macOS", linux: "Linux" };
/** `untested` runs with a warning; `unsupported` does not run (the kernel refuses to start such a plugin
 *  on that OS). `requires` names tools needed on that OS (providers; see `REQUIRED_TOOLS`). */
export interface PlatformSupport { status: "supported" | "untested" | "unsupported"; requires?: { tool: string; env?: string }[]; note?: string }
export type PlatformSupportMap = Partial<Record<PlatformId, PlatformSupport>>;

/** A validated `platforms` map (unknown OSes, statuses and malformed entries are dropped). */
export function parsePlatforms(raw: unknown): PlatformSupportMap | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const out: PlatformSupportMap = {};
  for (const id of Object.keys(PLATFORM_LABELS) as PlatformId[]) {
    const e: any = (raw as any)[id];
    if (!e || !["supported", "untested", "unsupported"].includes(e.status)) continue;
    const requires = Array.isArray(e.requires) ? e.requires.filter((r: any) => typeof r?.tool === "string" && /^[a-z0-9][a-z0-9-]{0,39}$/.test(r.tool)
      && (r.env === undefined || /^[A-Z][A-Z0-9_]{0,63}$/.test(r.env))).map((r: any) => ({ tool: r.tool, ...(r.env ? { env: r.env } : {}) })) : [];
    out[id] = { status: e.status, ...(requires.length ? { requires } : {}), ...(typeof e.note === "string" ? { note: e.note.slice(0, 500) } : {}) };
  }
  return Object.keys(out).length ? out : undefined;
}

/** Declared support on a machine OS. Undeclared: Linux/macOS (and unidentified POSIX machines) are
 *  `supported`; Windows is `untested`. */
export function supportOn(platforms: PlatformSupportMap | undefined | null, os: MachineOs): PlatformSupport {
  const declared = os === "posix" ? undefined : platforms?.[os];
  return declared || { status: os === "windows" ? "untested" : "supported" };
}

/** Combined support of several parts (a package's modules): the most restrictive status, notes joined. */
export function combinePlatforms(maps: (PlatformSupportMap | undefined)[]): PlatformSupportMap | undefined {
  const rank = { supported: 0, untested: 1, unsupported: 2 } as const;
  const out: PlatformSupportMap = {};
  for (const id of Object.keys(PLATFORM_LABELS) as PlatformId[]) {
    const entries = maps.map(m => m?.[id]).filter((e): e is PlatformSupport => !!e);
    if (!entries.length) continue;
    const worst = entries.reduce((a, b) => rank[b.status] > rank[a.status] ? b : a);
    const notes = [...new Set(entries.filter(e => e.status === worst.status && e.note).map(e => e.note!))];
    out[id] = { status: worst.status, ...(notes.length ? { note: notes.join(" ") } : {}) };
  }
  return Object.keys(out).length ? out : undefined;
}

/** A plugin's declared support on a machine OS (manifest `platforms`, exposed in `PluginInfo.metadata`). */
export const pluginSupport = (plugin: { metadata?: Record<string, unknown> } | null | undefined, os: MachineOs) =>
  supportOn(parsePlatforms(plugin?.metadata?.platforms), os);

/** Whether the host offers a capability (`env.info().hostFeatures`); prefer this to OS checks. */
export function hostFeature(ctx: ModuleContext, feature: string): boolean {
  return !!ctx.host?.env?.info?.().hostFeatures?.includes(feature);
}

/** Separator between PATH entries on a machine. */
export const pathListSeparator = (os: MachineOs) => os === "windows" ? ";" : ":";

/** Python 3 interpreters to try, in order (Windows: `python`, the `py` launcher, then the Store alias). */
export function pythonCandidates(os: MachineOs): { executable: string; args: string[] }[] {
  return os === "windows"
    ? [{ executable: "python", args: [] }, { executable: "py", args: ["-3"] }, { executable: "python3", args: [] }]
    : [{ executable: "python3", args: [] }, { executable: "python", args: [] }];
}

/** `/x`, `C:/x`, `C:\x`, `//server/share` or `\\server\share`. */
export function isAbsolutePath(p: string): boolean {
  return p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p) || p.startsWith("\\\\");
}

/** Forward slashes, as the kernel's canonical Windows paths (`C:/x`) use. */
export const slashPath = (p: string) => p.replace(/\\/g, "/");

/** A path in the machine's native separators (backslashes on Windows). */
export const nativePath = (p: string, os: MachineOs) => os === "windows" ? p.replace(/\//g, "\\") : p;

export function baseName(p: string): string {
  const parts = slashPath(p).replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || p;
}

export function dirName(p: string): string {
  const s = slashPath(p).replace(/\/+$/, "");
  const i = s.lastIndexOf("/");
  return i <= 0 ? (i === 0 ? "/" : ".") : /^[A-Za-z]:$/.test(s.slice(0, i)) ? s.slice(0, i + 1) : s.slice(0, i);
}

/** Path equality on the machine: Windows paths compare case-insensitively and slash-agnostically. */
export function samePath(a: string, b: string, os: MachineOs): boolean {
  if (os !== "windows") return a === b;
  const n = (p: string) => slashPath(p).replace(/\/+$/, "").toLowerCase();
  return n(a) === n(b);
}

// ---------------------------------------------------------------------------------------------
// Well-known folders

/** Well-known folders of this host (`env.info().knownDirs`), with Windows defaults for older hosts. */
export function knownDirs(ctx: ModuleContext): KnownDirs {
  const info = ctx.host?.env?.info?.();
  const d: Partial<KnownDirs> = info?.knownDirs || {};
  const windows = osOf(info?.platform) === "windows";
  return {
    home: d.home ?? info?.home ?? null,
    system: d.system || (windows ? "C:\\Windows" : null),
    programs: d.programs || (windows ? "C:\\Program Files" : null),
    localData: d.localData || null,
    roamingData: d.roamingData || null,
  };
}

const systemRoot = (ctx: ModuleContext) => knownDirs(ctx).system || "C:\\Windows";
/** Absolute paths of Windows system tools, so a same-named program in a workspace is never picked up. */
export const windowsPowerShell = (ctx: ModuleContext) => `${systemRoot(ctx)}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
export const windowsCmd = (ctx: ModuleContext) => `${systemRoot(ctx)}\\System32\\cmd.exe`;
export const windowsWsl = (ctx: ModuleContext) => `${systemRoot(ctx)}\\System32\\wsl.exe`;

// ---------------------------------------------------------------------------------------------
// Shell profiles: one table entry per shell. Adding a shell means adding an entry here.

export type ShellKind = "auto" | "login" | "pwsh" | "powershell" | "cmd" | "git-bash" | "wsl";

export interface ShellChoice { kind: ShellKind; /** WSL distribution (kind "wsl"). */ distro?: string; /** Explicit program path. */ program?: string }

export interface CommandLaunch { executable: string; args: string[]; /** cmd.exe: args passed verbatim (kernel-validated). */ verbatimArgs?: boolean }

export interface ShellProfile {
  label: string;
  /** Machines the profile runs on. */
  os: (os: MachineOs) => boolean;
  /** Programs to try, most specific first (absolute paths or names on PATH). Empty: the machine's default shell. */
  programs(ctx: ModuleContext, choice: ShellChoice): string[];
  /** Arguments for an interactive terminal. */
  terminal(choice: ShellChoice): string[];
  /** Arguments that run user-authored command text non-interactively. */
  command(command: string, choice: ShellChoice): Omit<CommandLaunch, "executable">;
  /** Markdown fence languages this shell runs when typed into its terminal, and how they are typed. */
  code: { languages: string[]; type(language: string, code: string): string };
  /** Actionable advice for a failure seen in this shell's output. */
  hint?(output: string): string | null;
}

/** Sets UTF-8 console input/output for PowerShell (5.1 defaults to the OEM code page). */
export const PWSH_UTF8 = "[Console]::InputEncoding=[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false);$OutputEncoding=[Console]::OutputEncoding";

/** PowerShell wrapper: UTF-8, the command on its own lines, and the native exit code kept. */
export function pwshScript(command: string): string {
  return `${PWSH_UTF8}\n${command}\n$hatoOk=$?\nif (-not $hatoOk) { if ($LASTEXITCODE) { exit $LASTEXITCODE }; exit 1 }\nexit 0`;
}

/** Actionable text when PowerShell refused a script (`npm.ps1` under the default client policy). */
export function executionPolicyHint(output: string): string | null {
  if (!/running scripts is disabled on this system|about_Execution_Policies|cannot be loaded because running scripts/i.test(output)) return null;
  return "PowerShell's execution policy blocked a script (for example npm.ps1). Hato does not change this policy. "
    + "Run `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` in PowerShell, or choose Command Prompt as the shell.";
}

/** POSIX shell code typed into a terminal: a quoted heredoc, so the text reaches the shell unchanged. */
function posixHeredoc(language: string, code: string): string {
  const shell = language === "bash" || language === "zsh" ? language : "sh";
  let delimiter = "HATO_SCRIPT";
  while (code.split(/\r?\n/).includes(delimiter)) delimiter += "_";
  return `${shell} <<'${delimiter}'\n${code}${code.endsWith("\n") ? "" : "\n"}${delimiter}`;
}
const POSIX_CODE = { languages: ["sh", "shell", "bash", "zsh"], type: posixHeredoc };
const asTyped = (_language: string, code: string) => code.replace(/\r?\n$/, "");
const windowsOnly = (os: MachineOs) => os === "windows";

const powershellProfile = (label: string, programs: (ctx: ModuleContext) => string[]): ShellProfile => ({
  label, os: windowsOnly, programs: (ctx, c) => c.program ? [c.program] : programs(ctx),
  terminal: () => ["-NoLogo", "-NoExit", "-Command", PWSH_UTF8],
  command: command => ({ args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", pwshScript(command)] }),
  code: { languages: ["powershell", "pwsh", "ps1"], type: asTyped }, hint: executionPolicyHint,
});

export const SHELL_PROFILES: Record<Exclude<ShellKind, "auto">, ShellProfile> = {
  // The user's login shell (Linux, macOS, SSH/WSL/Cloud machines). The kernel/daemon picks the program.
  login: {
    label: "Login shell", os: isPosix, programs: (_ctx, c) => c.program ? [c.program] : [],
    terminal: () => ["-l"], command: command => ({ args: ["-lc", command] }), code: POSIX_CODE,
  },
  pwsh: powershellProfile("PowerShell 7 (pwsh)", ctx => [`${knownDirs(ctx).programs || "C:\\Program Files"}\\PowerShell\\7\\pwsh.exe`, "pwsh.exe"]),
  powershell: powershellProfile("Windows PowerShell 5.1", ctx => [windowsPowerShell(ctx)]),
  cmd: {
    label: "Command Prompt (cmd)", os: windowsOnly, programs: (ctx, c) => c.program ? [c.program] : [windowsCmd(ctx)],
    terminal: () => ["/K", "chcp 65001>nul"],
    // `/s /c "<command>"`: cmd strips exactly the outer quotes and runs the rest as typed.
    command: command => ({ args: ["/d", "/s", "/c", `"${command}"`], verbatimArgs: true }),
    code: { languages: ["cmd", "bat", "batch"], type: asTyped },
  },
  "git-bash": {
    label: "Git Bash", os: windowsOnly,
    programs: (ctx, c) => {
      if (c.program) return [c.program];
      const d = knownDirs(ctx);
      return [`${d.programs || "C:\\Program Files"}\\Git\\bin\\bash.exe`, ...(d.localData ? [`${d.localData}\\Programs\\Git\\bin\\bash.exe`] : [])];
    },
    terminal: () => ["--login", "-i"], command: command => ({ args: ["-lc", command] }), code: POSIX_CODE,
  },
  wsl: {
    label: "WSL", os: windowsOnly, programs: (ctx, c) => c.program ? [c.program] : [windowsWsl(ctx)],
    terminal: c => c.distro ? ["-d", c.distro] : [],
    command: (command, c) => ({ args: [...(c.distro ? ["-d", c.distro] : []), "--exec", "/bin/sh", "-lc", command] }),
    code: POSIX_CODE,
  },
};

/** The automatic order on a machine: PowerShell 7, Windows PowerShell 5.1, then cmd on Windows; the login shell elsewhere. */
export function autoShells(os: MachineOs): Exclude<ShellKind, "auto">[] {
  return os === "windows" ? ["pwsh", "powershell", "cmd"] : ["login"];
}

/** Shells that can be chosen on a machine. */
export function shellsFor(os: MachineOs): Exclude<ShellKind, "auto">[] {
  return (Object.keys(SHELL_PROFILES) as Exclude<ShellKind, "auto">[]).filter(k => SHELL_PROFILES[k].os(os));
}

/** A choice made concrete for a machine: `auto` and shells that do not run there become the first automatic shell. */
function concrete(os: MachineOs, choice: ShellChoice): ShellChoice & { kind: Exclude<ShellKind, "auto"> } {
  const kind = choice.kind !== "auto" && SHELL_PROFILES[choice.kind].os(os) ? choice.kind : autoShells(os)[0];
  return { ...choice, kind };
}

/** Programs to try for a shell kind, most specific first (the kernel takes the first that exists). */
export function shellPrograms(ctx: ModuleContext, choice: ShellChoice): string[] {
  return choice.kind === "auto" ? [] : SHELL_PROFILES[choice.kind].programs(ctx, choice);
}

/** Arguments for an interactive terminal of a shell kind. */
export function terminalArgs(choice: ShellChoice): string[] {
  return choice.kind === "auto" ? [] : SHELL_PROFILES[choice.kind].terminal(choice);
}

/**
 * Terminal candidates for the kernel (`pty.open` `shellCandidates`), in preference order: the choice,
 * then the machine's automatic order, so a missing shell still leaves a working terminal. Empty means
 * "the machine's default shell" (the login shell on Linux and macOS).
 */
export function terminalCandidates(ctx: ModuleContext, choice: ShellChoice, os: MachineOs = hostOs(ctx)): { program: string; args: string[] }[] {
  const kinds = [...new Set([...(choice.kind === "auto" ? [] : [concrete(os, choice).kind]), ...autoShells(os)])];
  const out: { program: string; args: string[] }[] = [];
  for (const kind of kinds) {
    const c = kind === choice.kind ? { ...choice, kind } : { kind };
    for (const program of SHELL_PROFILES[kind].programs(ctx, c)) out.push({ program, args: SHELL_PROFILES[kind].terminal(c) });
  }
  return out;
}

/** The default login shell program for a machine when none was resolved. */
const defaultLoginShell = (os: MachineOs) => os === "macos" ? "/bin/zsh" : "/bin/sh";

/**
 * A user-authored command (run configuration, workflow step) through the chosen shell profile.
 * PowerShell runs without the user's profile and non-interactively, so runs are reproducible and fail
 * instead of prompting; a failing native command's exit code is preserved.
 * `program` is the installed shell; without it, `auto` is the machine's first automatic shell whose
 * program is always present (Windows PowerShell 5.1, or the login shell). `userCommandLaunch`
 * resolves the full automatic order (pwsh 7 first).
 */
export function userCommand(ctx: ModuleContext, os: MachineOs, choice: ShellChoice, command: string, program?: string): CommandLaunch {
  const c = choice.kind === "auto" && os === "windows" ? { ...choice, kind: "powershell" as const } : concrete(os, choice);
  const profile = SHELL_PROFILES[c.kind];
  const executable = program || profile.programs(ctx, c)[0] || defaultLoginShell(os);
  return { executable, ...profile.command(command, c) };
}

/** Fence languages any shell can run (for showing a Run action on Markdown code blocks). */
export const RUNNABLE_CODE_LANGUAGES: string[] = [...new Set(Object.values(SHELL_PROFILES).flatMap(p => p.code.languages))];

/** Text that runs a code block in a terminal of shell `kind`, or an error naming what would work. */
export function shellCode(os: MachineOs, choice: ShellChoice, language: string, code: string): string {
  const c = concrete(os, choice);
  const profile = SHELL_PROFILES[c.kind];
  if (profile.code.languages.includes(language)) return profile.code.type(language, code);
  const able = shellsFor(os).filter(k => SHELL_PROFILES[k].code.languages.includes(language)).map(k => SHELL_PROFILES[k].label);
  throw new Error(able.length
    ? `This terminal's shell (${profile.label}) cannot run ${language} code. Choose ${able.join(" or ")} in Settings → Terminals.`
    : `${language || "This"} code cannot run on this machine.`);
}

/** Actionable advice for a failed command's output, from any shell profile that recognizes it. */
export function failureHint(output: string): string | null {
  for (const p of Object.values(SHELL_PROFILES)) { const h = p.hint?.(output); if (h) return h; }
  return null;
}

/** The first shell of the choice, then the automatic order, whose program exists. */
export async function pickShell(ctx: ModuleContext, grant: Handle, cwd: string, choice: ShellChoice, os: MachineOs = hostOs(ctx)): Promise<{ choice: ShellChoice; program: string }> {
  if (os !== "windows") { const c = concrete(os, choice); return { choice: c, program: SHELL_PROFILES[c.kind].programs(ctx, c)[0] || "" }; }
  const kinds = [...new Set([...(choice.kind === "auto" ? [] : [concrete(os, choice).kind]), ...autoShells(os)])];
  for (const kind of kinds) for (const program of SHELL_PROFILES[kind].programs(ctx, { ...choice, kind })) {
    if (await programExists(ctx, grant, cwd, program)) return { choice: { ...choice, kind }, program };
  }
  return { choice: { kind: "cmd" }, program: windowsCmd(ctx) };
}

/** Whether a program exists on the local Windows machine (absolute file, or a name on the registry PATH). */
export async function programExists(ctx: ModuleContext, grant: Handle, cwd: string, program: string): Promise<boolean> {
  if (!isAbsolutePath(program)) return !!(await resolveWindowsExecutable(ctx, grant, cwd, program).catch(() => null));
  return (await firstExistingFile(ctx, grant, cwd, [program])) === program;
}

/** The first of `paths` (absolute) that is a file on the local Windows machine, with one PowerShell start. */
export async function firstExistingFile(ctx: ModuleContext, grant: Handle, cwd: string, paths: string[]): Promise<string | null> {
  const list = paths.filter(p => isAbsolutePath(p) && !/[\r\n]/.test(p));
  if (!list.length) return null;
  const r = await ctx.host.process.run(grant, { target: { kind: "local" }, executable: windowsPowerShell(ctx),
    args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
      "$i=0;foreach($p in ($env:HATO_PROBE -split \"`n\")){ if (Test-Path -LiteralPath $p -PathType Leaf) { exit (10+$i) }; $i++ }; exit 1"],
    cwd, env: { HATO_PROBE: list.join("\n") } }, { timeoutMs: 15000 }).catch(() => null);
  const i = (r?.code ?? 1) - 10;
  return i >= 0 && i < list.length ? list[i] : null;
}

// ---------------------------------------------------------------------------------------------
// Windows executable resolution

export interface ResolvedExecutable {
  /** The file found on PATH (may be an npm `.cmd` shim). */
  path: string;
  /** PATH rebuilt from the registry (so tools installed after Hato started are found). */
  pathEnv: string;
  /** How to start it without `cmd.exe`: shims become `node.exe <entry.js>`. */
  launch: { executable: string; args: string[] };
}

const RESOLVE_MARK = "__HATO_RESOLVE__=";
const RESOLVE_SCRIPT = [
  "$ErrorActionPreference='SilentlyContinue'",
  "$m=[Environment]::GetEnvironmentVariable('Path','Machine');$u=[Environment]::GetEnvironmentVariable('Path','User')",
  "$p=((@($m,$u)|Where-Object {$_}) -join ';');$env:Path=$p",
  "$n=$env:HATO_RESOLVE;$c=$null",
  "if ([IO.Path]::IsPathRooted($n)) { if (Test-Path -LiteralPath $n -PathType Leaf) { $c=(Resolve-Path -LiteralPath $n).Path } }",
  "else { $c=(Get-Command -Name $n -CommandType Application | Select-Object -First 1).Source }",
  "$s=$null;$nx=$false;$node=$null",
  "if ($c -and $c -match '\\.(cmd|bat)$') { $s=[IO.File]::ReadAllText($c);$nx=Test-Path -LiteralPath (Join-Path (Split-Path -Parent $c) 'node.exe');$node=(Get-Command -Name node -CommandType Application | Select-Object -First 1).Source }",
  `[Console]::Out.Write("\`n${RESOLVE_MARK}"+(ConvertTo-Json -Compress @{path=$c;pathEnv=$p;shim=$s;nodeNext=$nx;node=$node}))`,
].join("\n");

/** Names that may be looked up: no wildcards or shell metacharacters reach PowerShell's Get-Command. */
const SAFE_NAME = /^[A-Za-z0-9_.@+\-\\/: ()]+$/;

/**
 * Find a program on the Windows workspace machine (the local host), with PATH read from the
 * registry. `.cmd`/`.bat` npm shims are resolved to `node.exe <script>` so no argument is ever
 * re-parsed by `cmd.exe`. Returns null when the program is not installed.
 */
export async function resolveWindowsExecutable(ctx: ModuleContext, grant: Handle, cwd: string, name: string): Promise<ResolvedExecutable | null> {
  if (!SAFE_NAME.test(name) || /[*?\[\]]/.test(name)) throw new Error(`Unsupported executable name: ${name}`);
  const r = await ctx.host.process.run(grant, { target: { kind: "local" } as ExecutionTarget, executable: windowsPowerShell(ctx),
    args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", RESOLVE_SCRIPT], cwd, env: { HATO_RESOLVE: name } },
    { timeoutMs: 30000, limitBytes: 1 << 20 });
  const line = r.stdout.split(/\r?\n/).filter(l => l.startsWith(RESOLVE_MARK)).pop();
  if (!line) throw new Error(`Could not query PATH with Windows PowerShell: ${(r.stderr || r.stdout).trim().slice(-400)}`);
  const found = JSON.parse(line.slice(RESOLVE_MARK.length));
  if (!found.path) return null;
  const path = String(found.path), pathEnv = String(found.pathEnv || "");
  if (!/\.(cmd|bat)$/i.test(path)) return { path, pathEnv, launch: { executable: path, args: [] } };
  // Node shims start node directly. Other batch files (mvn.cmd, gradlew.bat) are started by path:
  // the kernel's process spawn escapes batch-file arguments for cmd.exe and refuses unsafe ones.
  const shim = parseCmdShim(String(found.shim || ""), path, npmNodeExe(path, !!found.nodeNext, found.node || null));
  return { path, pathEnv, launch: shim || { executable: path, args: [] } };
}

const resolvedCache = new Map<string, { at: number; value: Promise<ResolvedExecutable | null> }>();

/**
 * An argv launch made startable on a native Windows machine: bare names are looked up on the
 * registry PATH (cached for a minute), `./tool` names a file in `cwd` (with `.cmd`/`.bat`/`.exe`
 * tried when given without extension), node shims become `node.exe script`, and PATH is set so the
 * program's own children are found. Other platforms get the launch unchanged.
 */
export async function windowsLaunch<T extends { executable: string; args: string[]; cwd: string; env?: Record<string, string> }>(
  ctx: ModuleContext, grant: Handle, launch: T, candidates: string[] = []): Promise<T> {
  const exe = launch.executable;
  let name = exe;
  if (/^\.{1,2}[\\/]/.test(exe)) {
    const base = `${slashPath(launch.cwd).replace(/\/+$/, "")}/${slashPath(exe).replace(/^\.\//, "")}`;
    const variants = /\.[A-Za-z0-9]+$/.test(exe) ? [base] : [...candidates.map(e => base + e), `${base}.cmd`, `${base}.bat`, `${base}.exe`];
    const hit = await firstExistingFile(ctx, grant, launch.cwd, variants);
    if (!hit) throw new Error(`${exe} was not found in ${launch.cwd}`);
    name = hit;
  }
  const key = `${launch.cwd}\u0000${name}`;
  let hit = resolvedCache.get(key);
  if (!hit || Date.now() - hit.at > 60000) {
    hit = { at: Date.now(), value: resolveWindowsExecutable(ctx, grant, launch.cwd, name) };
    resolvedCache.set(key, hit);
    hit.value.catch(() => resolvedCache.delete(key));
  }
  const found = await hit.value;
  if (!found) throw new Error(`${exe} was not found on PATH. Install it, or set an absolute path.`);
  return { ...launch, executable: found.launch.executable, args: [...found.launch.args, ...launch.args],
    env: { ...(found.pathEnv ? { PATH: found.pathEnv } : {}), ...(launch.env || {}) } };
}

function npmNodeExe(shimPath: string, nodeNext: boolean, node: string | null): string | null {
  return nodeNext ? `${dirName(shimPath).replace(/\//g, "\\")}\\node.exe` : node;
}

/**
 * The node entry an npm `.cmd` shim (cmd-shim, or npm's own `npm.cmd`) runs.
 * `node` is the node.exe to use; null leaves the shim unresolvable.
 */
export function parseCmdShim(text: string, shimPath: string, node: string | null): { executable: string; args: string[] } | null {
  if (!node) return null;
  const dir = slashPath(shimPath).replace(/\/[^/]*$/, "");
  const win = (p: string) => p.replace(/\//g, "\\");
  // npm.cmd / npx.cmd: SET "NPM_CLI_JS=%~dp0\node_modules\npm\bin\npm-cli.js"
  const key = /npx\.cmd$/i.test(shimPath) ? "NPX_CLI_JS" : "NPM_CLI_JS";
  const npm = new RegExp(`SET\\s+"${key}=%~dp0\\\\?([^"]+\\.c?js)"`, "i").exec(text);
  if (npm) return { executable: node, args: [win(normalize(`${dir}/${slashPath(npm[1])}`))] };
  // cmd-shim: IF EXIST "%dp0%\node.exe" ... "%_prog%"  "%dp0%\node_modules\pkg\bin\cli.js" %*
  if (!/node\.exe"/i.test(text)) return null;
  const matches = [...text.matchAll(/"%(?:dp0%|~dp0)\\?([^"%]+)"\s+%\*/gi)];
  const m = matches[matches.length - 1];
  if (!m || /node\.exe$/i.test(m[1])) return null;
  return { executable: node, args: [win(normalize(`${dir}/${slashPath(m[1])}`))] };
}

function normalize(p: string): string {
  const prefix = p.startsWith("//") ? "//" : p.startsWith("/") ? "/" : "";
  const out: string[] = [];
  for (const part of p.slice(prefix.length).split("/")) {
    if (part === "..") { if (out.length > 1) out.pop(); }
    else if (part !== "." && part !== "") out.push(part);
  }
  return prefix + out.join("/");
}


/**
 * An argv launch made startable on the workspace machine. On Windows names are resolved on the
 * registry PATH and npm shims start node directly (see `windowsLaunch`); elsewhere the launch is
 * returned unchanged (the kernel or login shell resolves it).
 */
export async function prepareLaunch<T extends { executable: string; args: string[]; cwd: string; env?: Record<string, string> }>(
  ctx: ModuleContext, grant: Handle, os: MachineOs, launch: T): Promise<T> {
  return os === "windows" ? windowsLaunch(ctx, grant, launch) : launch;
}

// ---------------------------------------------------------------------------------------------
// The user's shell choice (scoped setting `shell.profile`: workspace → machine → user)

export const SHELL_SETTING = "shell.profile";

/** Stored as `auto`, a shell kind (`pwsh`, `cmd`, `login`, …) or `wsl:<distro>`. */
export function parseShellChoice(value: unknown): ShellChoice {
  const v = typeof value === "string" ? value : "";
  if (v.startsWith("wsl:")) return { kind: "wsl", distro: v.slice(4) || undefined };
  return v === "auto" || Object.prototype.hasOwnProperty.call(SHELL_PROFILES, v) ? { kind: v as ShellKind } : { kind: "auto" };
}

export const shellChoiceValue = (c: ShellChoice) => c.kind === "wsl" && c.distro ? `wsl:${c.distro}` : c.kind;

type WorkspaceRef = { id: string; machineId: string; location: string; os?: MachineOs | null };

/** The shell profile for a workspace. Machines with a single shell skip the lookup. `null` means
 *  "this machine" (a local process outside any workspace): the user-level choice. */
export async function shellChoiceFor(ctx: ModuleContext, ws: WorkspaceRef | null): Promise<ShellChoice> {
  const os = ws ? workspaceOs(ctx, ws) : hostOs(ctx);
  if (shellsFor(os).length <= 1) return { kind: autoShells(os)[0] };
  const scopes = ws ? [`workspace:${ws.id}`, `machine:${ws.machineId}`, "user"] : ["user"];
  const saved = await ctx.modules.call("persistence", "scoped.resolve", { key: SHELL_SETTING, scopes }).catch(() => null);
  return parseShellChoice((saved as any)?.value);
}

/** Resolved shell per machine and choice; refreshed after a minute so a newly installed shell is picked up. */
const picked = new Map<string, { at: number; value: Promise<{ choice: ShellChoice; program: string }> }>();

/**
 * Launch for a user-authored command on the machine of `grant`: the user's shell choice, resolved to
 * an installed program (cached per choice), then `userCommand`. `ws` is the workspace (null: this
 * machine). Remote POSIX workspaces get `/bin/sh -lc` (the kernel's login-shell setup applies).
 */
export async function userCommandLaunch(ctx: ModuleContext, grant: Handle, cwd: string, ws: WorkspaceRef | null, command: string): Promise<CommandLaunch> {
  const os = ws ? workspaceOs(ctx, ws) : hostOs(ctx);
  const choice = await shellChoiceFor(ctx, ws);
  if (ws && ws.location !== "local") return userCommand(ctx, os, choice, command, "/bin/sh");
  const key = `${os}\u0000${shellChoiceValue(choice)}`;
  let hit = picked.get(key);
  if (!hit || Date.now() - hit.at > 60000) {
    const entry = { at: Date.now(), value: pickShell(ctx, grant, cwd, choice, os) };
    picked.set(key, entry);
    entry.value.catch(() => { if (picked.get(key) === entry) picked.delete(key); });
    hit = entry;
  }
  const found = await hit.value;
  return userCommand(ctx, os, found.choice, command, found.program || undefined);
}

/** Select options for the shell setting on a machine (`auto` first, WSL per distribution). */
export function shellOptions(os: MachineOs, distros: string[] = []): { value: string; label: string }[] {
  const auto = autoShells(os).map(k => SHELL_PROFILES[k].label.replace(/ \(.*\)$/, ""));
  return [
    { value: "auto", label: `Automatic (${auto.slice(0, 2).join(", else ")})` },
    ...shellsFor(os).flatMap(k => k !== "wsl" ? [{ value: k, label: SHELL_PROFILES[k].label }]
      : distros.length ? distros.map(d => ({ value: `wsl:${d}`, label: `WSL · ${d}` })) : [{ value: "wsl", label: "WSL (default distribution)" }]),
  ];
}
