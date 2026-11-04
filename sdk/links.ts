// Resolves a Markdown link href to a workspace-relative file path, or null when the link is
// not a local file inside the workspace root. Accepts relative paths (resolved against
// `baseDir`), absolute paths, `file://` URLs, and strips `#fragment`, `?query` and
// `:line[:col]` suffixes that agents commonly append.
export function resolveWorkspaceLink(href: string, rootAbsolutePath: string | null | undefined, baseDir = ""): string | null {
  let raw = String(href || "").trim().replace(/^<|>$/g, "");
  if (!raw || raw.startsWith("#")) return null;
  if (!rootAbsolutePath || !rootAbsolutePath.startsWith("/")) return null;
  let absolute = false;
  if (/^file:/i.test(raw)) {
    const authority = /^file:\/\/([^/]*)/i.exec(raw)?.[1];
    if (authority && authority.toLowerCase() !== "localhost") return null;
    raw = raw.replace(/^file:(\/\/[^/]*)?/i, "");
    absolute = true;
  } else if (/^[a-z][a-z0-9+.-]*:/i.test(raw.replace(/:\d+(?::\d+)?(?:[?#].*)?$/, ""))) return null; // other schemes are not files
  raw = raw.replace(/[?#].*$/, "");
  try { raw = decodeURIComponent(raw); } catch { /* keep undecoded */ }
  raw = raw.replace(/:\d+(?::\d+)?$/, "");
  if (!raw) return null;
  const root = normalize(rootAbsolutePath || "");
  let full: string;
  if (absolute || raw.startsWith("/")) full = normalize(raw);
  else if (raw.startsWith("~")) return null;
  else full = normalize(`${root}/${baseDir}/${raw}`);
  if (!root || full === root) return null;
  const prefix = root === "/" ? "/" : root + "/";
  if (!full.startsWith(prefix)) return null;
  return full.slice(prefix.length);
}

function normalize(path: string): string {
  const out: string[] = [];
  for (const part of path.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") out.pop(); else out.push(part);
  }
  return "/" + out.join("/");
}
