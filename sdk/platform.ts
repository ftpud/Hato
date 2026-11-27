// Workspace-machine platform helpers: OS, paths, shell profiles and Windows tool resolution.
//
// Modules never start `sh`/`bash` for their own work: they spawn programs with argv and parse
// output in TypeScript. The exceptions live here: `userCommand` runs text the *user* wrote through
// the shell profile they picked, and `resolveWindowsExecutable` asks Windows PowerShell for PATH.
import type { ExecutionTarget, Handle, ModuleContext } from "./types";

export type MachineOs = "windows" | "posix";

/** OS of the desktop/daemon running this module. */
export function hostOs(ctx: ModuleContext): MachineOs {
  return ctx.host?.env?.info?.().platform === "windows" ? "windows" : "posix";
}

/** OS of a workspace's machine: SSH, WSL and Cloud machines are POSIX; local follows the host. */
export function workspaceOs(ctx: ModuleContext, desc: { location: string }): MachineOs {
  return desc.location === "local" ? hostOs(ctx) : "posix";
}

/** `/x`, `C:/x`, `C:\x`, `//server/share` or `\\server\share`. */
export function isAbsolutePath(p: string): boolean {
  return p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p) || p.startsWith("\\\\");
}

/** Forward slashes, as the kernel's canonical Windows paths (`C:/x`) use. */
export const slashPath = (p: string) => p.replace(/\\/g, "/");

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
// Windows locations

export interface WindowsDirs { systemRoot: string; programFiles: string; localAppData: string | null; appData: string | null }

/** Well-known Windows folders reported by the host (defaults for older hosts). */
export function windowsDirs(ctx: ModuleContext): WindowsDirs {
  const w: Partial<WindowsDirs> = ctx.host?.env?.info?.().windows || {};
  return {
    systemRoot: w.systemRoot || "C:\\Windows",
    programFiles: w.programFiles || "C:\\Program Files",
    localAppData: w.localAppData || null,
    appData: w.appData || null,
  };
}

/** Absolute paths of system tools, so a same-named program in a workspace is never picked up. */
export const windowsPowerShell = (ctx: ModuleContext) => `${windowsDirs(ctx).systemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
export const windowsCmd = (ctx: ModuleContext) => `${windowsDirs(ctx).systemRoot}\\System32\\cmd.exe`;
export const windowsWsl = (ctx: ModuleContext) => `${windowsDirs(ctx).systemRoot}\\System32\\wsl.exe`;

// ---------------------------------------------------------------------------------------------
// Shell profiles

export type ShellKind = "auto" | "pwsh" | "powershell" | "cmd" | "git-bash" | "wsl" | "login";

export interface ShellChoice { kind: ShellKind; /** WSL distribution (kind "wsl"). */ distro?: string; /** Explicit program path. */ program?: string }

/** Automatic Windows order: PowerShell 7, then Windows PowerShell 5.1, then cmd. */
export const WINDOWS_SHELL_ORDER: ShellKind[] = ["pwsh", "powershell", "cmd"];

export const SHELL_LABELS: Record<ShellKind, string> = {
  auto: "Automatic", pwsh: "PowerShell 7 (pwsh)", powershell: "Windows PowerShell 5.1", cmd: "Command Prompt (cmd)",
  "git-bash": "Git Bash", wsl: "WSL", login: "Login shell",
};

/** Sets UTF-8 console input/output for PowerShell (5.1 defaults to the OEM code page). */
export const PWSH_UTF8 = "[Console]::InputEncoding=[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false);$OutputEncoding=[Console]::OutputEncoding";

/** Programs to try for a shell kind, most specific first (the kernel takes the first that exists). */
export function shellPrograms(ctx: ModuleContext, choice: ShellChoice): string[] {
  if (choice.program) return [choice.program];
  const d = windowsDirs(ctx);
  switch (choice.kind) {
    case "pwsh": return [`${d.programFiles}\\PowerShell\\7\\pwsh.exe`, "pwsh.exe"];
    case "powershell": return [windowsPowerShell(ctx)];
    case "cmd": return [windowsCmd(ctx)];
    case "git-bash": return [`${d.programFiles}\\Git\\bin\\bash.exe`, ...(d.localAppData ? [`${d.localAppData}\\Programs\\Git\\bin\\bash.exe`] : [])];
    case "wsl": return [windowsWsl(ctx)];
    default: return [];
  }
}

/** Arguments for an interactive terminal: logo off, the user's profile loaded, UTF-8 output. */
export function terminalArgs(choice: ShellChoice): string[] {
  switch (choice.kind) {
    case "pwsh": case "powershell": return ["-NoLogo", "-NoExit", "-Command", PWSH_UTF8];
    case "cmd": return ["/K", "chcp 65001>nul"];
    case "git-bash": return ["--login", "-i"];
    case "wsl": return choice.distro ? ["-d", choice.distro] : [];
    default: return [];
  }
}

/** Terminal candidates for the kernel (`pty.open` `shellCandidates`), in preference order. */
export function terminalCandidates(ctx: ModuleContext, choice: ShellChoice): { program: string; args: string[] }[] {
  const kinds = choice.kind === "auto" || choice.kind === "login" ? WINDOWS_SHELL_ORDER : [choice.kind];
  const out: { program: string; args: string[] }[] = [];
  for (const kind of kinds) {
    const c = { ...choice, kind };
    for (const program of shellPrograms(ctx, c)) out.push({ program, args: terminalArgs(c) });
  }
  // A chosen shell that is not installed still leaves the user a working terminal.
  if (choice.kind !== "auto") for (const kind of WINDOWS_SHELL_ORDER) if (kind !== choice.kind)
    for (const program of shellPrograms(ctx, { kind })) out.push({ program, args: terminalArgs({ kind }) });
  return out;
}

export interface CommandLaunch { executable: string; args: string[]; /** cmd.exe: args passed verbatim (kernel-validated). */ verbatimArgs?: boolean }

/**
 * A user-authored command (run configuration, workflow step) through the chosen shell profile.
 * PowerShell runs without the user's profile and non-interactively, so runs are reproducible and fail
 * instead of prompting; a failing native command's exit code is preserved.
 * `program` is the installed shell; without it, `auto` means Windows PowerShell 5.1 (present on every
 * supported Windows). Use `userCommandLaunch` to get the automatic order (pwsh 7 first).
 */
export function userCommand(ctx: ModuleContext, os: MachineOs, choice: ShellChoice, command: string, program?: string): CommandLaunch {
  if (os !== "windows" || choice.kind === "login") {
    const shell = program || choice.program || (ctx.host?.env?.info?.().platform === "macos" ? "/bin/zsh" : "/bin/sh");
    return { executable: shell, args: ["-lc", command] };
  }
  const kind = choice.kind === "auto" ? "powershell" : choice.kind;
  const exe = program || shellPrograms(ctx, { ...choice, kind })[0];
  switch (kind) {
    case "pwsh": case "powershell":
      return { executable: exe, args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", pwshScript(command)] };
    case "cmd":
      // `/s /c "<command>"`: cmd strips exactly the outer quotes and runs the rest as typed.
      return { executable: exe, args: ["/d", "/s", "/c", `"${command}"`], verbatimArgs: true };
    case "git-bash": return { executable: exe, args: ["-lc", command] };
    case "wsl": return { executable: exe, args: [...(choice.distro ? ["-d", choice.distro] : []), "--exec", "/bin/sh", "-lc", command] };
    default: return { executable: exe, args: ["-Command", pwshScript(command)] };
  }
}

/** PowerShell wrapper: UTF-8, the command on its own lines, and the native exit code kept. */
export function pwshScript(command: string): string {
  return `${PWSH_UTF8}\n${command}\n$hatoOk=$?\nif (-not $hatoOk) { if ($LASTEXITCODE) { exit $LASTEXITCODE }; exit 1 }\nexit 0`;
}

/** The first shell kind of the automatic order whose program exists. */
export async function pickShell(ctx: ModuleContext, grant: Handle, cwd: string, choice: ShellChoice): Promise<{ choice: ShellChoice; program: string }> {
  if (hostOs(ctx) !== "windows" || choice.kind === "login") return { choice: { kind: "login" }, program: choice.program || "" };
  const kinds = choice.kind === "auto" ? WINDOWS_SHELL_ORDER : [choice.kind, ...WINDOWS_SHELL_ORDER];
  for (const kind of kinds) for (const program of shellPrograms(ctx, { ...choice, kind })) {
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

/** Actionable text when PowerShell refused a script (`npm.ps1` under the default client policy). */
export function executionPolicyHint(output: string): string | null {
  if (!/running scripts is disabled on this system|about_Execution_Policies|cannot be loaded because running scripts/i.test(output)) return null;
  return "PowerShell's execution policy blocked a script (for example npm.ps1). Hato does not change this policy. "
    + "Run `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` in PowerShell, or choose Command Prompt as the shell.";
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

// ---------------------------------------------------------------------------------------------
// The user's shell choice (scoped setting `shell.profile`: workspace → machine → user)

export const SHELL_SETTING = "shell.profile";

/** Stored as `auto`, `pwsh`, `powershell`, `cmd`, `git-bash`, `login` or `wsl:<distro>`. */
export function parseShellChoice(value: unknown): ShellChoice {
  const v = typeof value === "string" ? value : "";
  if (v.startsWith("wsl:")) return { kind: "wsl", distro: v.slice(4) || undefined };
  if (v === "wsl") return { kind: "wsl" };
  return (["auto", "pwsh", "powershell", "cmd", "git-bash", "login"] as const).includes(v as any) ? { kind: v as ShellKind } : { kind: "auto" };
}

export const shellChoiceValue = (c: ShellChoice) => c.kind === "wsl" && c.distro ? `wsl:${c.distro}` : c.kind;

/** The shell profile for a workspace (POSIX machines always use the login shell). `null` means
 *  "this machine" (a local process outside any workspace): the user-level choice on Windows. */
export async function shellChoiceFor(ctx: ModuleContext, ws: { id: string; machineId: string; location: string } | null): Promise<ShellChoice> {
  if (ws ? workspaceOs(ctx, ws) !== "windows" : hostOs(ctx) !== "windows") return { kind: "login" };
  const scopes = ws ? [`workspace:${ws.id}`, `machine:${ws.machineId}`, "user"] : ["user"];
  const saved = await ctx.modules.call("persistence", "scoped.resolve", { key: SHELL_SETTING, scopes }).catch(() => null);
  return parseShellChoice((saved as any)?.value);
}

/** Resolved shell per choice; refreshed after a minute so a newly installed pwsh is picked up. */
const picked = new Map<string, { at: number; value: Promise<{ choice: ShellChoice; program: string }> }>();

/**
 * Launch for a user-authored command on the machine of `grant` (local Windows or POSIX): the user's
 * shell choice, resolved to an installed program (cached per choice), then `userCommand`.
 * `ws` is the workspace (null: this machine). Remote POSIX workspaces get `<login shell> -lc`.
 */
export async function userCommandLaunch(ctx: ModuleContext, grant: Handle, cwd: string, ws: { id: string; machineId: string; location: string } | null, command: string): Promise<CommandLaunch> {
  const os = ws ? workspaceOs(ctx, ws) : hostOs(ctx);
  const choice = await shellChoiceFor(ctx, ws);
  if (os !== "windows") return userCommand(ctx, os, choice, command, ws && ws.location !== "local" ? "/bin/sh" : undefined);
  const key = shellChoiceValue(choice);
  let hit = picked.get(key);
  if (!hit || Date.now() - hit.at > 60000) {
    const entry = { at: Date.now(), value: pickShell(ctx, grant, cwd, choice) };
    picked.set(key, entry);
    entry.value.catch(() => { if (picked.get(key) === entry) picked.delete(key); });
    hit = entry;
  }
  const found = await hit.value;
  return userCommand(ctx, os, found.choice, command, found.program);
}

/** Select options for the shell setting (Windows). */
export function shellOptions(distros: string[] = []): { value: string; label: string }[] {
  return [
    { value: "auto", label: "Automatic (PowerShell 7, else Windows PowerShell)" },
    ...(["pwsh", "powershell", "cmd", "git-bash"] as ShellKind[]).map(k => ({ value: k, label: SHELL_LABELS[k] })),
    ...(distros.length ? distros.map(d => ({ value: `wsl:${d}`, label: `WSL · ${d}` })) : [{ value: "wsl", label: "WSL (default distribution)" }]),
  ];
}
