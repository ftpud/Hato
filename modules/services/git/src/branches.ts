import type { GitBranch } from "../../../../sdk/git-branches";
import type { RunResult } from "../../../../sdk/types";

type Run = (args: string[]) => Promise<RunResult>;
const message = (r: RunResult, action: string) => `${action}: ${(r.stderr || r.stdout).trim().slice(0, 1200) || `Git exited with ${r.code}`}`;
async function checked(run: Run, args: string[], action: string) {
  const result = await run(args);
  if (result.code !== 0) throw new Error(message(result, action));
  return result;
}

export async function listBranches(run: Run) {
  const repo = await run(["rev-parse", "--is-inside-work-tree"]);
  if (repo.code !== 0 || repo.stdout.trim() !== "true") return { repo: false, current: null, head: null, local: [], remote: [], remotes: [] };
  const current = await run(["symbolic-ref", "-q", "HEAD"]);
  const head = await run(["rev-parse", "--short", "--verify", "HEAD"]);
  const result = await checked(run, ["for-each-ref", "--sort=refname", "--format=%(refname)%00%(objectname:short)%00%(symref)%00%(upstream)%00%(worktreepath)%00", "refs/heads/", "refs/remotes/"], "List branches");
  if (result.truncated) throw new Error("Branch list is too large; Git output was truncated.");
  const currentRef = current.code === 0 ? current.stdout.trim() : null;
  const local: GitBranch[] = [], remote: GitBranch[] = [];
  const fields = result.stdout.split("\0");
  for (let i = 0; i + 4 < fields.length; i += 5) {
    const ref = fields[i].replace(/^\n/, "");
    if (fields[i + 2]) continue; // symbolic remote HEAD aliases are not checkout targets
    const isLocal = ref.startsWith("refs/heads/");
    if (!isLocal && !ref.startsWith("refs/remotes/")) continue;
    (isLocal ? local : remote).push({ ref, name: ref.slice(isLocal ? 11 : 13), commit: fields[i + 1] || null,
      current: ref === currentRef, upstream: fields[i + 3] || null, worktree: fields[i + 4] || null });
  }
  if (currentRef?.startsWith("refs/heads/") && !local.some(b => b.ref === currentRef)) {
    local.unshift({ ref: currentRef, name: currentRef.slice(11), commit: null, current: true, upstream: null, worktree: null, unborn: true });
  }
  const remotes = await checked(run, ["remote"], "List remotes");
  return { repo: true, current: currentRef?.slice(11) || null, head: head.code === 0 ? head.stdout.trim() : null, local, remote,
    remotes: remotes.stdout.trim().split("\n").filter(Boolean) };
}

async function validName(run: Run, value: unknown): Promise<string> {
  const name = typeof value === "string" ? value.trim() : "";
  if (!name || name.startsWith("-") || name.length > 1024) throw new Error("Enter a valid branch name.");
  const result = await run(["check-ref-format", "--branch", name]);
  // Reject Git's checkout-history expansion (@{-1}) as a name, too.
  if (result.code !== 0 || result.stdout.trim() !== name) throw new Error("Invalid branch name. Use a name such as feature/welcome.");
  return name;
}

function findRef(catalog: Awaited<ReturnType<typeof listBranches>>, ref: unknown) {
  if (!catalog.repo) throw new Error("This workspace is not a Git worktree.");
  const branch = [...catalog.local, ...catalog.remote].find(b => b.ref === ref);
  if (!branch) throw new Error("Branch is no longer available. Refresh the branch list.");
  return branch;
}

export async function checkoutBranch(run: Run, ref: unknown) {
  const catalog = await listBranches(run);
  const branch = findRef(catalog, ref);
  if (branch.current) return;
  if (branch.ref.startsWith("refs/heads/")) {
    await validName(run, branch.name);
    await checked(run, ["switch", "--no-guess", "--", branch.name], "Checkout branch");
  } else {
    const remote = [...catalog.remotes].sort((a, b) => b.length - a.length).find(r => branch.name.startsWith(r + "/"));
    if (!remote) throw new Error("This remote no longer exists. Refresh the branch list.");
    const name = await validName(run, branch.name.slice(remote.length + 1));
    const local = catalog.local.find(b => b.name === name);
    if (local && local.upstream !== branch.ref) throw new Error(`Local branch “${name}” already exists with a different upstream. Use “Create branch from here” to choose another name.`);
    await checked(run, local ? ["switch", "--no-guess", "--", name] : ["switch", "--create", name, "--track", "--", branch.ref], "Checkout remote branch");
  }
}

export async function createBranch(run: Run, nameValue: unknown, from: unknown) {
  const name = await validName(run, nameValue);
  const catalog = await listBranches(run);
  if (!catalog.repo) throw new Error("This workspace is not a Git worktree.");
  if (catalog.local.some(b => b.name === name)) throw new Error(`Branch “${name}” already exists.`);
  const source = from ? findRef(catalog, from) : null;
  const args = ["switch", "--create", name];
  if (source && !source.unborn) {
    if (source.ref.startsWith("refs/remotes/")) args.push("--track");
    args.push("--", source.ref);
  }
  await checked(run, args, "Create and checkout branch");
}
