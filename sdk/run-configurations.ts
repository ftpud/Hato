/** Shared contracts for run configuration providers, the editor, and the future runner. */
export interface RunConfigType {
  id: string;
  label: string;
  targetLabel: string;
  runtimeLabel: string;
  runtimeHint: string;
  profileHint: string;
}
export interface BeforeLaunch { kind?: "build" | "npm" | "configuration" | "command"; executable: string; args: string[]; cwd: string }
export interface RunConfigDraft {
  name: string;
  type: string;
  target: string;
  args: string[];
  runtimeArgs: string[];
  cwd: string;
  env: Record<string, string>;
  envFiles: string[];
  profiles: string[];
  beforeLaunch: BeforeLaunch[];
  runtime: string;
  shared?: boolean;
}
export interface RunConfig extends RunConfigDraft { id: string; revision: number }
export interface RunCandidate {
  name: string;
  type: string;
  target: string;
  cwd: string;
  file: string;
  line: number;
}
export interface RunSource { path: string; text: string }
export interface RunDiscovery { sources: RunSource[]; paths: string[] }
export interface EnvironmentRow { name: string; source: string; value: string }
export interface EnvironmentPreview { rows: EnvironmentRow[]; missing: string[] }
export const runDirname = (path: string) => path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : ".";
