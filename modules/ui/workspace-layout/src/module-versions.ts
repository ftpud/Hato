import type { ModuleStatus } from "../../../../sdk/types";

/** Only successfully activated artifacts are offered; staged builds are not recovery points. */
export function moduleVersions(m: ModuleStatus) {
  const healthy = m.versions.filter(v => v.status === "ok");
  // Older kernels omit seedVersion; their most recent imported seed is the fallback.
  const seed = m.seedVersion === undefined
    ? healthy.filter(v => v.origin === "seed" || v.origin === "plugin").sort((a, b) => b.version - a.version)[0]
    : healthy.find(v => v.version === m.seedVersion);
  const updated = healthy.filter(v => v.version !== seed?.version && (v.origin === "build" || v.origin === "dev-watch"))
    .sort((a, b) => b.version - a.version)[0];
  return { bundled: seed?.version, updated: updated?.version };
}
