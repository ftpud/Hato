import type { PluginInfo, SyntaxRule } from "./types";

export type LanguageDependencySetup =
  | { kind: "jdtls"; version: string; url: string; sha256: string; javaMajor: number }
  | { kind: "npm"; packages: string[]; nodeMajor: number };
export interface LanguageServerSpec {
  id: string; executable: string; args: string[]; initializationOptions?: any;
  projectSettings?: { title: string; enabledLabel: string; initializationSettings?: boolean; fields: {
    key: string; label: string; setting: string; type: "paths" | "text" | "toggle"; description?: string; directory?: boolean;
  }[] };
  settings?: Record<string, any>; installHint: string; dependencySetup?: LanguageDependencySetup;
}
export interface LanguageDefinition {
  id: string; name: string; extensions?: string[]; filenames?: string[];
  grammar: string; syntaxRules?: SyntaxRule[]; server?: LanguageServerSpec;
  /** Highlights query for the bundled grammar; an array is joined with newlines. */
  highlightQuery?: string | string[];
  pluginId?: string;
}
/** Contributions are data: installing a language never grants it native code execution. */
export function languageDefinitions(plugins: PluginInfo[]): LanguageDefinition[] {
  const result: LanguageDefinition[] = [];
  for (const plugin of [...plugins].sort((a, b) => a.id.localeCompare(b.id))) {
    if (!plugin.enabled || !plugin.active) continue;
    const contributions = plugin.contributes?.languages;
    if (!Array.isArray(contributions)) continue;
    for (const lang of contributions) {
      if (!lang || typeof lang.id !== "string" || typeof lang.grammar !== "string" || typeof lang.name !== "string") continue;
      const extensions = Array.isArray(lang.extensions) ? lang.extensions.filter((v: any) => typeof v === "string" && v.length) : [];
      const filenames = Array.isArray(lang.filenames) ? lang.filenames.filter((v: any) => typeof v === "string" && v.length) : [];
      if (!extensions.length && !filenames.length) continue;
      const server = lang.server;
      const validServer = server && typeof server.id === "string" && typeof server.executable === "string"
        && Array.isArray(server.args) && server.args.every((v: any) => typeof v === "string") && typeof server.installHint === "string";
      result.push({ ...lang, extensions, filenames, server: validServer ? server : undefined, pluginId: plugin.id });
    }
  }
  return result;
}
export function languageForPath(languages: LanguageDefinition[], path: string): LanguageDefinition | null {
  const name = path.replace(/\\/g, "/").split("/").pop()!.toLowerCase();
  return languages.find(l => l.filenames?.some(n => n.toLowerCase() === name))
    || languages.find(l => l.extensions?.some(ext => name.endsWith("." + ext.toLowerCase()))) || null;
}
export function relativeFile(path: string): string {
  if (!path || /^[\\/]|^[a-z]:/i.test(path) || path.includes("\0")) throw new Error("Expected a workspace-relative file");
  const parts: string[] = [];
  for (const part of path.replace(/\\/g, "/").split("/")) {
    if (part === "..") { if (!parts.length) throw new Error("File escapes the workspace"); parts.pop(); }
    else if (part && part !== ".") parts.push(part);
  }
  if (!parts.length) throw new Error("Expected a file");
  return parts.join("/");
}
export function fileUri(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  if (!normalized.startsWith("/") && !/^[a-z]:\//i.test(normalized)) throw new Error("Expected an absolute path");
  const absolute = normalized.startsWith("/") ? normalized : "/" + normalized;
  return "file://" + absolute.split("/").map((s, i) => i === 1 && /^[a-z]:$/i.test(s) ? s : encodeURIComponent(s)).join("/");
}
export function documentUri(root: string, path: string): string {
  return fileUri(root.replace(/[\\/]+$/, "") + "/" + relativeFile(path));
}
/** Remote URIs refer to the remote filesystem; never open them as local paths. */
export function workspacePath(root: string, uri: string): string | null {
  const match = /^file:\/\/(?:localhost)?(\/[^?#]*)$/i.exec(uri);
  if (!match) return null;
  let path: string;
  try { path = decodeURIComponent(match[1]); } catch { return null; }
  const base = root.replace(/\\/g, "/").replace(/\/+$/, "");
  if (/^[a-z]:\//i.test(base) && /^\/[a-z]:\//i.test(path)) path = path.slice(1);
  if (!path.startsWith(base + "/")) return null;
  try { return relativeFile(path.slice(base.length + 1)); } catch { return null; }
}
export function definitionLinks(value: any): any[] {
  return (Array.isArray(value) ? value : value ? [value] : []).flatMap(item => {
    const targetUri = item?.targetUri ?? item?.uri;
    const targetRange = item?.targetRange ?? item?.range;
    const selection = item?.targetSelectionRange ?? targetRange;
    if (typeof targetUri !== "string" || !validRange(targetRange) || !validRange(selection)) return [];
    return [{ targetUri, targetRange, targetSelectionRange: selection,
      ...(validRange(item.originSelectionRange) ? { originSelectionRange: item.originSelectionRange } : {}) }];
  });
}
export function validPosition(p: any): boolean {
  return p && Number.isInteger(p.line) && p.line >= 0 && Number.isInteger(p.character) && p.character >= 0;
}
function validRange(r: any): boolean { return r && validPosition(r.start) && validPosition(r.end); }
