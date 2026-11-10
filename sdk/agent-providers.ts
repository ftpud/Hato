import type { ModuleContext, PluginInfo } from './types';
export interface AgentProvider {
  id: string; name: string; module: string;
  profile: { id: string; name: string; executable: string; args: string[] };
  adapter: { pkg: string; bin: string };
  usageCommand?: string;
  auth?: { key: string; field: string; label: string; description: string; default: boolean; envRemove: string[] };
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
      profiles.add(raw.profile.id); seen.add(raw.id); out.push({ ...raw, module: plugin.id });
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
    return { ...p, providerModule: definition?.module, authOption: definition?.auth };
  });
}
