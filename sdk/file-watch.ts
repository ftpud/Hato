import type { ModuleContext, StreamSubscription } from "./types";
import { errMsg, workspaceGrant, type WorkspaceDescriptor } from "./runtime";

/** Own one notification stream; handles workspace switches, late starts and reconnects.
 * Retries only failed streams, never polls directory contents. */
export function fileWatch(ctx: ModuleContext, changed: (workspaceId: string) => void) {
  let generation = 0, stopped = false;
  let close: (() => Promise<void>) | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let delay = 1000;
  async function select(ws: WorkspaceDescriptor | null, root?: string) {
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
      retry = setTimeout(() => { void select(ws, root); }, delay);
      delay = Math.min(delay * 2, 30000);
    };
    try {
      const grant = await workspaceGrant(ctx, ws, "fs", root);
      if (mine !== generation || stopped) return;
      ({ handle } = await ctx.host.fs.watch(grant.grant, "."));
      if (mine !== generation || stopped) { await dispose(); return; }
      close = dispose;
      subscription = await ctx.host.streams.listen(handle, { channel: "stdout" }, () => {
        if (mine !== generation || stopped) return;
        delay = 1000;
        // `ready` also invalidates, covering edits made during watch installation.
        changed(ws.id);
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
