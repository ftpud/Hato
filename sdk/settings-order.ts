export const SPACER_PREFIX = '@spacer:';
export function parseOrder(value: unknown, allowed: string[], allowSpacers = false): string[] {
  if (typeof value !== 'string') throw new Error('Invalid item order');
  const items: unknown = JSON.parse(value);
  if (!Array.isArray(items) || items.length > allowed.length + 24) throw new Error('Invalid item order');
  const seen = new Set<string>(); let gaps = 0;
  for (const item of items) {
    if (typeof item !== 'string' || seen.has(item)) throw new Error('Duplicate or invalid item');
    seen.add(item);
    if (!allowed.includes(item) && !(allowSpacers && item.startsWith(SPACER_PREFIX) && /^@spacer:[a-zA-Z0-9_-]{1,80}$/.test(item) && ++gaps <= 24)) throw new Error('Unknown item');
  }
  if (!allowed.every(id => seen.has(id))) throw new Error('Order must retain all current items');
  return items;
}
