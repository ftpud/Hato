import { modelChoices } from "./persistent-agents";
import type { WorkflowBlock } from "./workflows";
export interface ProviderChoices { models: { value: string; label: string }[]; reasoning: { value: string; label: string }[]; reasoningId?: string; reasoningReady?: boolean }
export function advertisedChoices(session: { configOptions?: any[]; models?: any }): ProviderChoices {
  const thought = session.configOptions?.find(o => o.category === "thought_level" && o.type !== "boolean");
  const flatten = (items: any[]): any[] => items.flatMap(o => Array.isArray(o.options) ? flatten(o.options) : [o]);
  return { models: modelChoices(session).map(m => ({ value: m.id, label: m.label })),
    reasoning: thought ? flatten(thought.options || []).filter(o => typeof o.value === "string").map(o => ({ value: o.value, label: o.name || o.value })) : [],
    reasoningId: thought?.id };
}
export function blockProfile(b: WorkflowBlock, catalog: any): string {
  return b.profileId || (b.provider ? catalog?.profiles?.find((p: any) => p.provider === b.provider)?.id : null)
    || catalog?.defaultProfileId || catalog?.profiles?.[0]?.id || "";
}
export const providerChoiceKey = (workspaceId: string, profileId: string, model = "") => JSON.stringify([workspaceId, profileId, model]);
