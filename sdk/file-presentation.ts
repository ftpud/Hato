// Shared, declarative file presentation. Views consume this contract without language branches.
import type { ModuleContext, PluginInfo, UiColor } from "./types";

export interface FilePresentation {
  iconSvg?: string;
  iconColor?: UiColor;
  background?: UiColor;
  /** Classification text for labels/tooltips (e.g. "Java interface"). */
  description?: string;
}
export interface FilePresentationRule extends FilePresentation {
  id: string;
  /** Higher priorities override lower priorities. Default 0; explicit user rules typically use 100. */
  priority?: number;
  /** Regex against the workspace-relative path, using forward slashes. */
  pathPattern: string;
  kind?: "file" | "dir";
  /** Optional regex against source with comments/strings masked. $FILE_STEM is escaped before substitution. */
  contentPattern?: string;
}
export interface FilePresentationContribution { rules: FilePresentationRule[] }
export interface FilePresentationEntry { path: string; kind: "file" | "dir" }
export interface CompiledFileRule { rule: FilePresentationRule; path: RegExp }
const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Only enabled, active plugins contribute. Optional module state replaces its manifest defaults. */
export function filePresentationRules(plugins: PluginInfo[], state?: (key: string) => unknown): CompiledFileRule[] {
  const rules: CompiledFileRule[] = [];
  for (const plugin of [...plugins].sort((a, b) => a.id.localeCompare(b.id))) {
    if (!plugin.enabled || !plugin.active) continue;
    const contribution = (state?.(`${plugin.id}.filePresentation`) ?? plugin.contributes?.filePresentation) as FilePresentationContribution | undefined;
    if (!Array.isArray(contribution?.rules)) continue;
    for (const rule of contribution.rules) {
      if (!rule || typeof rule.id !== "string" || typeof rule.pathPattern !== "string") continue;
      try {
        if (rule.contentPattern) new RegExp(rule.contentPattern.replace(/\$FILE_STEM/g, "File"), "m");
        rules.push({ rule, path: new RegExp(rule.pathPattern) });
      } catch { /* One malformed plugin rule cannot break file browsing. */ }
    }
  }
  return rules.sort((a, b) => (Number.isFinite(a.rule.priority) ? a.rule.priority! : 0) - (Number.isFinite(b.rule.priority) ? b.rule.priority! : 0));
}

/** Mask C-style comments and quoted literals; retain line breaks and declarations. */
export function presentationSource(text: string): string {
  return text.replace(/\/\*[\s\S]*?(?:\*\/|$)|\/\/[^\r\n]*|"""[\s\S]*?(?:"""|$)|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g,
    part => part.replace(/[^\r\n]/g, " "));
}
export function matchingFileRules(rules: CompiledFileRule[], entry: FilePresentationEntry): CompiledFileRule[] {
  return rules.filter(({ rule, path }) => (!rule.kind || rule.kind === entry.kind) && path.test(entry.path));
}
/** Matching rules compose in declaration order. Later rules override only supplied fields. */
export function presentFile(rules: CompiledFileRule[], entry: FilePresentationEntry, text?: string): FilePresentation {
  const result: FilePresentation = {};
  const stem = entry.path.split("/").pop()!.replace(/\.[^.]+$/, "");
  let source: string | undefined;
  for (const { rule } of matchingFileRules(rules, entry)) {
    if (rule.contentPattern) {
      if (text === undefined) continue;
      source ??= presentationSource(text);
      if (!new RegExp(rule.contentPattern.replace(/\$FILE_STEM/g, escapeRegex(stem)), "m").test(source)) continue;
    }
    for (const key of ["iconSvg", "iconColor", "background", "description"] as const)
      if (typeof rule[key] === "string") result[key] = rule[key];
  }
  return result;
}

/** Nonblocking, bounded batch adapter shared by explorer rows and viewer tabs. */
export class FilePresentationClient {
  private cache = new Map<string, FilePresentation>();
  private queued = new Map<string, FilePresentationEntry>();
  private workspace: string | null = null;
  private revision = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private busy = false;
  private stopped = false;
  private stops: (() => void)[];
  constructor(private ctx: ModuleContext) {
    this.stops = [ctx.state.watch("files.presentationRuleCount", () => this.clear()), ctx.events.on("files.presentationChanged", () => this.clear()),
      ctx.events.on("files.changed", (event: any) => { if (event.workspaceId === this.workspace) this.clear(); })];
  }
  get(workspaceId: string, path: string, kind: "file" | "dir" = "file"): FilePresentation {
    if (this.ctx.state.get("files.presentationRuleCount") === 0) return {};
    if (this.workspace !== workspaceId) { this.clear(); this.workspace = workspaceId; }
    const key = `${kind}:${path}`;
    const cached = this.cache.get(key);
    if (cached) return cached;
    this.queued.set(key, { path, kind });
    if (!this.timer && !this.busy && !this.stopped) this.timer = setTimeout(() => { this.timer = undefined; void this.flush(); }, 30);
    return {};
  }
  clear() { this.revision++; this.cache.clear(); this.queued.clear(); this.ctx.ui.invalidate(); }
  dispose() { this.stopped = true; this.revision++; if (this.timer) clearTimeout(this.timer); for (const stop of this.stops) if (typeof stop === "function") stop(); }
  private async flush() {
    if (this.stopped || this.busy || !this.workspace) return;
    this.busy = true;
    const revision = this.revision, workspaceId = this.workspace;
    const batch = [...this.queued.entries()].slice(0, 64);
    for (const [key] of batch) { this.queued.delete(key); this.cache.set(key, {}); }
    try {
      const result = await this.ctx.modules.call("files", "presentations", { workspaceId, entries: batch.map(([, entry]) => entry) }, { timeoutMs: 45000 });
      if (revision === this.revision && !this.stopped) for (const [key, entry] of batch) this.cache.set(key, result?.[entry.path] || {});
    } catch { /* Ordinary file icons remain usable if a provider/read fails. */ }
    finally {
      this.busy = false;
      if (revision === this.revision && !this.stopped) this.ctx.ui.invalidate();
      if (this.queued.size && !this.stopped) this.timer = setTimeout(() => { this.timer = undefined; void this.flush(); }, 30);
    }
  }
}
