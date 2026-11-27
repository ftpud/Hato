import type { McpLaunchOptions } from "./provider-mcp";
import type { ModuleContext, PluginInfo } from './types';
export interface AgentProvider {
  id: string; name: string; module: string;
  profile: { id: string; name: string; executable: string; args: string[] };
  adapter: { pkg: string; bin: string };
  mcpLaunch?: McpLaunchOptions;
  usageCommand?: string;
  auth?: { key: string; field: string; label: string; description: string; default: boolean; envRemove: string[] };
  /** Support on native Windows workspaces, from the provider's Windows smoke test. Absent means untested. */
  platforms?: { windows?: WindowsSupport };
}
/** `untested` runs with a warning; `unsupported` disables the agent and shows `note`. `requires` names tools
 *  the agent itself needs (e.g. Git Bash), with the environment variable that tells the agent where it is. */
export interface WindowsSupport { status: "supported" | "untested" | "unsupported"; requires?: { tool: "git-bash"; env?: string }[]; note?: string }

function windowsSupport(raw: any): WindowsSupport | undefined {
  if (!raw || !["supported", "untested", "unsupported"].includes(raw.status)) return undefined;
  const requires = Array.isArray(raw.requires) ? raw.requires.filter((r: any) => r?.tool === "git-bash" && (r.env === undefined || /^[A-Z][A-Z0-9_]{0,63}$/.test(r.env))) : undefined;
  return { status: raw.status, ...(requires?.length ? { requires } : {}), ...(typeof raw.note === "string" ? { note: raw.note.slice(0, 500) } : {}) };
}
/** Windows support for a provider (untested when the manifest says nothing). */
export const windowsSupportOf = (p: Pick<AgentProvider, "platforms"> | undefined): WindowsSupport => p?.platforms?.windows || { status: "untested" };
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
      const windows = windowsSupport(raw.platforms?.windows);
      profiles.add(raw.profile.id); seen.add(raw.id); out.push({ ...raw, platforms: windows ? { windows } : undefined, module: plugin.id });
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
      windows: definition ? windowsSupportOf(definition) : undefined };
  });
}
