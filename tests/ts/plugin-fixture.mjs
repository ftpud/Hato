// Test fixture: a `plugins.list` result built from the real built-in manifests, so layout and
// sidebar tests exercise the same contributions the kernel forwards at runtime.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export function builtinPlugins(overrides = {}) {
  const out = [];
  for (const kind of ["services", "ui"]) {
    for (const id of fs.readdirSync(path.join(root, "Hato-plugins", "modules", kind)).sort()) {
      const file = path.join(root, "Hato-plugins", "modules", kind, id, "manifest.json");
      if (!fs.existsSync(file)) continue;
      const m = JSON.parse(fs.readFileSync(file, "utf8"));
      out.push({
        id: m.id, name: m.name || m.id, kind: m.kind, description: m.description || "", source: "builtin", enabled: true,
        active: `${m.id}@0001`, provides: m.provides || [], requires: m.requires || [], dependencies: m.dependencies || [],
        runsOn: m.runsOn || (m.kind === "ui" ? "ui" : "either"), capabilities: m.capabilities || [], calls: m.calls || [],
        pendingApprovals: [], contributes: m.contributes ?? null, lastError: null, dir: null, ...(overrides[m.id] || {}),
      });
    }
  }
  return out;
}

export const pluginsHost = (list = builtinPlugins()) => ({ list: async () => ({ plugins: list, root: "workspace-layout", rootOverride: null }) });

const built = await esbuild.build({ entryPoints: [path.join(root, "sdk/plugins.ts")], bundle: true, format: "esm", platform: "neutral", write: false });
export const P = await import("data:text/javascript;base64," + Buffer.from(built.outputFiles[0].text).toString("base64"));

/** Panel defs in the layout model's shape, from the built-in contributions. */
export function builtinPanelDefs(list = builtinPlugins()) {
  const c = P.collectContributions(list);
  return Object.fromEntries(Object.values(c.panels).map((p) => [p.id, { slot: p.module, title: p.title, defaultHidden: p.defaultHidden, dockBelow: p.dockBelow, dock: p.dock, pinned: p.pinned }]));
}
