import type { ModuleContext } from "./types";

/** Resolve daemon-local tools without sending interactive shell startup output to ACP stdio. */
export async function agentExecutable(ctx: ModuleContext, grant: string, root: string, executable: string) {
  for (const mode of ["-lc", "-ic"]) {
    // The user's shell initializes version managers, then a POSIX child performs the probe.
    // The executable stays in argv, including paths with spaces or shell metacharacters.
    const probe = `exec /bin/sh -c 'p=$(command -v -- "$1") || exit; printf "\\n__HATO_EXEC__=%s\\n__HATO_PATH__=%s\\n" "$p" "$PATH"' hato-agent-detect `;
    const quote = (s: string) => "'" + s.replace(/'/g, "'\\''") + "'";
    const result = await ctx.host.process.run(grant, {
      target: { kind: "local" }, executable: "/bin/sh",
      args: ["-c", 'exec "${SHELL:-/bin/sh}" "$1" "$2"', "hato-agent-shell", mode, probe + quote(executable)],
      cwd: root,
    }, { timeoutMs: 20000 });
    const path = /^__HATO_EXEC__=(.+)$/m.exec(result.stdout)?.[1];
    const pathEnv = /^__HATO_PATH__=(.+)$/m.exec(result.stdout)?.[1];
    if (result.code === 0 && path && pathEnv) return { path, pathEnv };
  }
  throw new Error(`ACP adapter '${executable}' was not found in the daemon user's login or interactive shell PATH. Install it for that user on this machine or configure an absolute executable path.`);
}
