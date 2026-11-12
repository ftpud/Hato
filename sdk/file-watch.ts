import type { ModuleContext, StreamSubscription } from "./types";
import { errMsg, workspaceGrant, type WorkspaceDescriptor } from "./runtime";

export interface FileWatchOptions {
  /** Called with the watcher's `warning` lines (e.g. the OS watch limit was reached). */
  warning?: (workspaceId: string, text: string) => void;
}
export interface WatchSelection {
  /** Directories to skip: names at any depth (`node_modules`) or root-relative paths (`dist/`). */
  exclude?: string[];
}

/** Own one notification stream; handles workspace switches, late starts and reconnects.
 * Retries only failed streams, never polls directory contents. */
export function fileWatch(ctx: ModuleContext, changed: (workspaceId: string) => void, options: FileWatchOptions = {}) {
  let generation = 0, stopped = false;
  let close: (() => Promise<void>) | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let delay = 1000;
  async function select(ws: WorkspaceDescriptor | null, root?: string, selection: WatchSelection = {}) {
    const mine = ++generation;
    if (retry) clearTimeout(retry);
    retry = null;
    const previous = close; close = null;
    await previous?.();
    if (!ws || stopped || mine !== generation) return;
    let handle: string | null = null, subscription: StreamSubscription | null = null;
    const dispose = async () => {
      await subscription?.close().catch(() => {});
      if (handle) await ctx.host.resources.release(handle).catch(() => {});
    };
    const failed = (error: unknown) => {
      if (mine !== generation || stopped) return;
      ctx.log.warn(`File watcher: ${errMsg(error)}`);
      retry = setTimeout(() => { void select(ws, root, selection); }, delay);
      delay = Math.min(delay * 2, 30000);
    };
    try {
      const grant = await workspaceGrant(ctx, ws, "fs", root);
      if (mine !== generation || stopped) return;
      ({ handle } = await ctx.host.fs.watch(grant.grant, ".", selection.exclude?.length ? { exclude: selection.exclude } : undefined));
      if (mine !== generation || stopped) { await dispose(); return; }
      close = dispose;
      subscription = await ctx.host.streams.listen(handle, { channel: "stdout" }, chunk => {
        if (mine !== generation || stopped) return;
        delay = 1000;
        // Chunks can coalesce lines. `ready` also invalidates, covering edits made during
        // watch installation; a chunk of only warnings does not.
        const lines = String(chunk ?? "").split("\n").map(l => l.trim()).filter(Boolean);
        for (const l of lines) if (l.startsWith("warning ")) options.warning?.(ws.id, l.slice(8));
        if (!lines.length || lines.some(l => !l.startsWith("warning "))) changed(ws.id);
      }, error => failed(error || new Error("notification stream closed")));
      if (mine !== generation || stopped) await dispose();
    } catch (error) { await dispose(); failed(error); }
  }
  return {
    select,
    async stop() {
      stopped = true; generation++;
      if (retry) clearTimeout(retry);
      retry = null;
      const previous = close; close = null;
      await previous?.();
    },
  };
}
