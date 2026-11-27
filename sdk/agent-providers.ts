import type { McpLaunchOptions } from "./provider-mcp";
import type { ModuleContext, PluginInfo } from './types';
import { SHELL_PROFILES, type MachineOs } from './platform';
export interface AgentProvider {
  id: string; name: string; module: string;
  profile: { id: string; name: string; executable: string; args: string[] };
  adapter: { pkg: string; bin: string };
  mcpLaunch?: McpLaunchOptions;
  usageCommand?: string;
  auth?: { key: string; field: string; label: string; description: string; default: boolean; envRemove: string[] };
  /** Support per workspace OS, from the provider's smoke tests (see `platformSupportOf` for defaults). */
  platforms?: Partial<Record<PlatformId, PlatformSupport>>;
}
export type PlatformId = "windows" | "macos" | "linux";
export const PLATFORM_LABELS: Record<PlatformId, string> = { windows: "Windows", macos: "macOS", linux: "Linux" };
/** `untested` runs with a warning; `unsupported` disables the agent and shows `note`. `requires` names tools
 *  the agent itself needs on that OS (see `REQUIRED_TOOLS`), with the environment variable that tells the
 *  agent where the tool is. */
export interface PlatformSupport { status: "supported" | "untested" | "unsupported"; requires?: { tool: string; env?: string }[]; note?: string }

/** Tools a provider may require, and where to look for them on the workspace machine (first found wins). */
export const REQUIRED_TOOLS: Record<string, { label: string; programs(ctx: ModuleContext): string[]; install: string }> = {
  "git-bash": { label: "Git for Windows (Git Bash)", programs: ctx => SHELL_PROFILES["git-bash"].programs(ctx, { kind: "git-bash" }), install: "https://git-scm.com/download/win" },
};

function platformSupport(raw: any): PlatformSupport | undefined {
  if (!raw || !["supported", "untested", "unsupported"].includes(raw.status)) return undefined;
  const requires = Array.isArray(raw.requires) ? raw.requires.filter((r: any) => typeof r?.tool === "string" && /^[a-z0-9][a-z0-9-]{0,39}$/.test(r.tool)
    && (r.env === undefined || /^[A-Z][A-Z0-9_]{0,63}$/.test(r.env))).map((r: any) => ({ tool: r.tool, ...(r.env ? { env: r.env } : {}) })) : undefined;
  return { status: raw.status, ...(requires?.length ? { requires } : {}), ...(typeof raw.note === "string" ? { note: raw.note.slice(0, 500) } : {}) };
}
function platformSupports(raw: any): AgentProvider["platforms"] | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const out: AgentProvider["platforms"] = {};
  for (const id of Object.keys(PLATFORM_LABELS) as PlatformId[]) { const s = platformSupport(raw[id]); if (s) out[id] = s; }
  return Object.keys(out).length ? out : undefined;
}
/** Declared support on a workspace OS. Undeclared: Linux/macOS (long supported) are `supported`,
 *  Windows and unidentified machines are `untested`. */
export function platformSupportOf(p: Pick<AgentProvider, "platforms"> | undefined, os: MachineOs): PlatformSupport {
  const declared = os === "posix" ? undefined : p?.platforms?.[os];
  return declared || { status: os === "macos" || os === "linux" || os === "posix" ? "supported" : "untested" };
}
/** Provider definitions belong to enabled plugin contributions, including saved profile ownership. */
export function agentProviders(plugins: PluginInfo[], enabledOnly = true): AgentProvider[] {
  const out: AgentProvider[] = [], seen = new Set<string>(), profiles = new Set<string>();
  for (const plugin of plugins) {
    if (enabledOnly && !plugin.enabled) continue;
    const definitions = plugin.contributes?.agentProviders;
    if (!Array.isArray(definitions)) continue;
    for (const raw of definitions) {
      if (!raw || typeof raw.id !== 'string' || seen.has(raw.id) || typeof raw.name !== 'string'
        || typeof raw.profile?.id !== 'string' || profiles.has(raw.profile.id) || typeof raw.profile?.name !== 'string' || typeof raw.profile?.executable !== 'string'
        || !Array.isArray(raw.profile.args) || !raw.profile.args.every((v: unknown) => typeof v === 'string')
        || typeof raw.adapter?.pkg !== 'string' || !/^(@[a-z0-9._-]+\/)?[a-z0-9._-]+$/.test(raw.adapter.pkg)
        || typeof raw.adapter?.bin !== 'string') continue;
      if (raw.auth && (typeof raw.auth.key !== 'string' || typeof raw.auth.field !== 'string' || typeof raw.auth.label !== 'string'
        || typeof raw.auth.default !== 'boolean' || !Array.isArray(raw.auth.envRemove) || !raw.auth.envRemove.every((key: unknown) => typeof key === 'string'))) continue;
      profiles.add(raw.profile.id); seen.add(raw.id); out.push({ ...raw, platforms: platformSupports(raw.platforms), module: plugin.id });
    }
  }
  return out;
}
export async function providerProfiles(ctx: ModuleContext) {
  const { plugins } = await ctx.host.plugins.list();
  const available = agentProviders(plugins);
  const saved: any[] = await ctx.modules.call('persistence', 'acpProfiles.list');
  // Custom profiles remain supported; named provider profiles require their provider plugin.
  const rows = saved.filter(p => !p.provider || p.provider === 'custom' || available.some(d => d.id === p.provider));
  for (const definition of available) {
    if (!rows.some(p => p.id === definition.profile.id)) rows.push({ ...definition.profile,
      provider: definition.id, machineId: '*', enabled: true, envRefs: {} });
  }
  return rows.map(p => {
    const definition = available.find(d => d.id === p.provider);
    return { ...p, providerModule: definition?.module, mcpLaunch: definition?.mcpLaunch, authOption: definition?.auth,
      platforms: definition?.platforms };
  });
}
