// Library catalog contract shared by the library service (publisher) and its consumers (chat,
// agents, persistent agents). The library service publishes skills and agent instructions as
// state so consumers do not need a module-call grant to the optional Library plugin.

/** State key the library service publishes its catalog under. */
export const LIBRARY_STATE = "library.catalog";
/** Instruction/skill references to Library entries use this prefix instead of a workspace path. */
export const LIBRARY_PREFIX = "library:";

export interface LibraryMachine { id: string; label: string }
export interface LibraryItem {
  id: string; kind: "skill" | "agent"; name: string; description: string;
  /** null for global entries; otherwise the owning project. */
  projectId: string | null;
  /** Machines a global entry is offered on. Empty means every machine. */
  machines: string[];
  /** The entry's SKILL.md / AGENT.md text. */
  text: string;
  /** Other files of the entry (readable through the Library MCP tools). */
  paths: string[];
  revision: number;
}
export interface LibraryCatalog { items: LibraryItem[]; machines: LibraryMachine[] }

export const libraryRef = (id: string) => LIBRARY_PREFIX + id;
export const isLibraryRef = (path: unknown): path is string => typeof path === "string" && path.startsWith(LIBRARY_PREFIX);
export const libraryRefId = (path: string) => path.slice(LIBRARY_PREFIX.length);

export function libraryCatalog(value: unknown): LibraryCatalog {
  const v = value as any;
  return { items: Array.isArray(v?.items) ? v.items : [], machines: Array.isArray(v?.machines) ? v.machines : [] };
}

/** Is a Library entry offered in a workspace (its project, or global and allowed on its machine)? */
export function libraryOffered(item: LibraryItem, ws: { projectId?: string | null; machineId: string }): boolean {
  if (item.projectId) return item.projectId === ws.projectId;
  return !item.machines?.length || item.machines.includes(ws.machineId);
}

/** Library entries of one kind offered in a workspace, project entries first, then by name. */
export function libraryItemsFor(value: unknown, ws: { projectId?: string | null; machineId: string } | null | undefined, kind: LibraryItem["kind"]): LibraryItem[] {
  if (!ws) return [];
  return libraryCatalog(value).items.filter(i => i.kind === kind && libraryOffered(i, ws))
    .sort((a, b) => Number(!a.projectId) - Number(!b.projectId) || a.name.localeCompare(b.name));
}

/** Instruction text an agent receives for a Library entry. */
export function libraryInstructions(item: LibraryItem): string {
  const scope = item.projectId ? "project" : "global";
  const extra = item.paths.filter(p => p !== "SKILL.md" && p !== "AGENT.md");
  return item.text + (extra.length
    ? `\n\n(Library ${item.kind} "${item.name}" also has these files: ${extra.join(", ")}. Read them with the Library read tool, scope "${scope}", id "${item.id}", when needed.)`
    : "");
}

/** A short stable digest used to notice Library text changes without shipping the text around. */
export function textDigest(text: string): string {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36) + ":" + text.length.toString(36);
}
