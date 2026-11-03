import type { Json, ModuleContext } from "./types";

export type SettingsScope = "user" | `machine:${string}` | `workspace:${string}`;
export interface ScopedValue { value: Json; rev: number; updatedAt?: string }
export interface ScopedEntry extends ScopedValue { key: string }
export function scopesFor(ws?: { id: string; machineId: string } | null): SettingsScope[] {
  return ws ? [`workspace:${ws.id}`, `machine:${ws.machineId}`, "user"] : ["user"];
}
export function get(ctx: ModuleContext, key: string, ws?: { id: string; machineId: string } | null): Promise<(ScopedValue & { scope: SettingsScope }) | null> {
  return ctx.modules.call("persistence", "scoped.resolve", { key, scopes: scopesFor(ws) });
}
export function set(ctx: ModuleContext, scope: SettingsScope, key: string, value: Json, expectedRev?: number): Promise<{ rev: number; applied: boolean }> {
  return ctx.modules.call("persistence", "scoped.set", { scope, key, value, ...(expectedRev === undefined ? {} : { expectedRev }) });
}

// Object property order is not a settings conflict.
function canonical(value: Json): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
  return JSON.stringify(value);
}
/** Reconcile one scope. Equal-revision conflicts retain the desktop value on both peers,
 * advancing its revision so subsequent syncs converge. CAS prevents overwriting new edits. */
export async function syncScope(scope: SettingsScope, local: (method: string, args: any) => Promise<any>, remote: (method: string, args: any) => Promise<any>) {
  const [left, right]: ScopedEntry[][] = await Promise.all([local("scoped.list", { scope }), remote("scoped.list", { scope })]);
  const l = new Map(left.map(e => [e.key, e])), r = new Map(right.map(e => [e.key, e]));
  const conflicts: string[] = [];
  for (const key of new Set([...l.keys(), ...r.keys()])) {
    const a = l.get(key), b = r.get(key);
    if (a && b && a.rev === b.rev) {
      if (canonical(a.value) === canonical(b.value)) continue;
      conflicts.push(key);
      const rev = a.rev + 1;
      await local("scoped.set", { scope, key, value: a.value, expectedRev: a.rev, rev });
      await remote("scoped.set", { scope, key, value: a.value, expectedRev: b.rev, rev });
    } else {
      const from = a && (!b || a.rev > b.rev) ? a : b!;
      const destination = from === a ? remote : local;
      await destination("scoped.set", { scope, key, value: from.value, rev: from.rev, expectedRev: (from === a ? b : a)?.rev ?? 0 });
    }
  }
  return { conflicts };
}
