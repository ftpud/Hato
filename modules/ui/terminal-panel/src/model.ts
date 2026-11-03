export interface Block { kind: "block"; id: string; keys: string[]; active: string }
export interface Split { kind: "split"; id: string; direction: "horizontal" | "vertical"; sizes: number[]; children: [Node, Node] }
export type Node = Block | Split;
export const firstBlock = (): Block => ({ kind: "block", id: "block-main", keys: ["main"], active: "main" });
export function blocks(node: Node): Block[] { return node.kind === "block" ? [node] : node.children.flatMap(blocks); }
export function replace(node: Node, id: string, next: Node): Node {
  if (node.id === id) return next;
  return node.kind === "block" ? node : { ...node, children: node.children.map(child => replace(child, id, next)) as [Node, Node] };
}
export function remove(node: Node, id: string): Node | null {
  if (node.id === id) return null;
  if (node.kind === "block") return node;
  const a = remove(node.children[0], id), b = remove(node.children[1], id);
  return !a ? b : !b ? a : { ...node, children: [a, b] };
}
export function resize(node: Node, id: string, sizes: number[]): Node {
  if (node.kind === "block") return node;
  if (node.id === id) return sizes.length === 2 && sizes.every(n => Number.isFinite(n) && n > 0) ? { ...node, sizes } : node;
  return { ...node, children: node.children.map(child => resize(child, id, sizes)) as [Node, Node] };
}
export function restore(saved: any, legacy?: any): Node {
  const ids = new Set<string>(), keys = new Set<string>();
  function read(value: any, depth = 0): Node | null {
    if (!value || depth > 32 || typeof value.id !== "string" || ids.has(value.id)) return null;
    ids.add(value.id);
    if (value.kind === "block" && Array.isArray(value.keys)) {
      const tabs = value.keys.filter((key: unknown): key is string => typeof key === "string" && !!key && !keys.has(key) && !!keys.add(key));
      return tabs.length ? { kind: "block", id: value.id, keys: tabs, active: tabs.includes(value.active) ? value.active : tabs[0] } : null;
    }
    if (value.kind !== "split" || !Array.isArray(value.children)) return null;
    const a = read(value.children[0], depth + 1), b = read(value.children[1], depth + 1);
    if (!a || !b) return a || b;
    return { kind: "split", id: value.id, direction: value.direction === "vertical" ? "vertical" : "horizontal",
      sizes: Array.isArray(value.sizes) && value.sizes.length === 2 && value.sizes.every((n: unknown) => typeof n === "number" && Number.isFinite(n) && n > 0) ? value.sizes : [0.5, 0.5], children: [a, b] };
  }
  return read(saved) || read({ ...firstBlock(), keys: legacy?.keys || ["main"], active: legacy?.active || "main" }) || firstBlock();
}
