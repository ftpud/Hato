// The Add project dialog: one window, a source on the left and its form on the right. Everything here
// is pure, so forms and validation can be tested without a host. Passwords never appear in this
// form: the kernel asks for them in its own prompt when connecting.
import type { UiNode } from "../../../../sdk/types";
import { uiIcons } from "../../../../sdk/ui-icons";

export type AddSource = "local" | "wsl" | "ssh";
export type SshAuth = "agent" | "key" | "password";
export type FieldErrors = Record<string, string>;
type Values = Record<string, string | undefined>;

export interface AddProjectView {
  windows: boolean;
  source: AddSource;
  sshAuth: SshAuth;
  values: Values;
  errors: FieldErrors;
  error: string | null;
  busy: string | null;
  distros: string[];
  distro: string;
}

/** On Windows, projects live in WSL or on a Linux host; there are no local Windows projects. */
export function sourcesFor(windows: boolean): { id: AddSource; title: string; description: string }[] {
  return [
    windows
      ? { id: "wsl", title: "WSL", description: "A Linux distribution on this PC" }
      : { id: "local", title: "Local folder", description: "A folder on this computer" },
    { id: "ssh", title: "SSH host", description: "A folder on another machine" },
  ];
}

const text = (values: Values, key: string) => String(values[key] ?? "").trim();
const optional = (values: Values, key: string) => text(values, key) || null;

/** `user@host:port` in the host field fills in what the other fields leave empty. */
export function parseSshTarget(target: string): { host: string; user?: string; port?: string } {
  const at = target.lastIndexOf("@");
  const user = at > 0 ? target.slice(0, at) : undefined;
  const rest = at >= 0 ? target.slice(at + 1) : target;
  const address = /^(\[[^\]]+\]|[^:\[\]]+):(\d+)$/.exec(rest);
  return address ? { host: address[1].replace(/^\[|\]$/g, ""), user, port: address[2] } : { host: rest.replace(/^\[|\]$/g, ""), user };
}

export function localRequest(values: Values) {
  const errors: FieldErrors = {};
  const path = text(values, "local-path");
  if (!path) errors["local-path"] = "Enter a folder, or choose one with Browse.";
  return { errors, request: path ? { path, name: optional(values, "local-name") } : null };
}

export function wslRequest(values: Values, distro: string) {
  const errors: FieldErrors = {};
  const remotePath = text(values, "wsl-path");
  if (!remotePath.startsWith("/")) errors["wsl-path"] = "Enter an absolute Linux path, like /home/you/project.";
  return { errors, request: remotePath.startsWith("/") ? { distro, remotePath, name: optional(values, "wsl-name") } : null };
}

export function sshRequest(values: Values, auth: SshAuth) {
  const errors: FieldErrors = {};
  const target = parseSshTarget(text(values, "ssh-host"));
  const user = text(values, "ssh-user") || target.user || "";
  const portText = text(values, "ssh-port") || target.port || "22";
  const port = Number(portText);
  const remotePath = text(values, "ssh-path");
  const identityFile = auth === "key" ? text(values, "ssh-key") : "";
  if (!target.host || /\s/.test(target.host)) errors["ssh-host"] = "Enter a host name or IP address.";
  if (!user) errors["ssh-user"] = "Enter the user to log in as.";
  if (!/^\d+$/.test(portText) || port < 1 || port > 65535) errors["ssh-port"] = "1–65535";
  if (!remotePath.startsWith("/")) errors["ssh-path"] = "Enter an absolute path on that machine, like /home/you/project.";
  if (auth === "key" && !identityFile) errors["ssh-key"] = "Enter the path of your private key file.";
  if (Object.keys(errors).length) return { errors, request: null };
  return { errors, request: {
    host: target.host, user, port, remotePath, identityFile: identityFile || null,
    ...(auth === "password" ? { auth: "password" } : {}), name: optional(values, "ssh-name"),
  } };
}

function field(view: AddProjectView, key: string, label: string, options: { placeholder?: string; hint?: string; submit: string; width?: number; grow?: boolean; trailing?: UiNode }): UiNode {
  const input: UiNode = { type: "textInput", key, value: view.values[key] ?? "", placeholder: options.placeholder, changeAction: "addField", submitAction: options.submit, ...(options.trailing ? { grow: true } : {}) };
  const below = view.errors[key] ?? options.hint;
  return { type: "column", key: `${key}:field`, gap: 4, ...(options.width ? { width: options.width } : {}), ...(options.grow ? { grow: true } : {}), children: [
    { type: "label", key: "label", text: label, size: "xs", weight: "medium" },
    options.trailing ? { type: "row", key: "control", gap: 6, children: [input, options.trailing] } : input,
    ...(below ? [{ type: "label", key: "below", text: below, size: "xs", color: view.errors[key] ? "danger" : "muted", wrap: true } as UiNode] : []),
  ] };
}

const browse = (view: AddProjectView): UiNode => ({ type: "button", key: "browse", text: "Browse…", iconSvg: uiIcons.folder, action: "browse", disabled: !!view.busy });
const nameField = (view: AddProjectView, key: string, submit: string, placeholder: string) =>
  field(view, key, "Display name (optional)", { placeholder, submit });

function localForm(view: AddProjectView): UiNode[] {
  return [
    field(view, "local-path", "Folder", { placeholder: "/path/to/project", submit: "addLocalPath", trailing: browse(view) }),
    nameField(view, "local-name", "addLocalPath", "The folder's name"),
  ];
}

function wslForm(view: AddProjectView): UiNode[] {
  if (!view.distros.length) return [{ type: "status", key: "no-distro", text: "No WSL distribution found. Install one with `wsl --install`, then reopen this window.", level: "warn" }];
  return [
    { type: "column", key: "distro-field", gap: 4, children: [
      { type: "label", key: "label", text: "Distribution", size: "xs", weight: "medium" },
      { type: "select", key: "wsl-distro", value: view.distro, action: "wslDistro", options: view.distros.map((d) => ({ value: d, label: d })), buttonStyle: { height: 32, fullWidth: true } },
    ] },
    field(view, "wsl-path", "Linux folder", { placeholder: "/home/you/project", submit: "addWsl", trailing: browse(view) }),
    nameField(view, "wsl-name", "addWsl", "The folder's name"),
  ];
}

function sshAuthDetail(view: AddProjectView): UiNode {
  if (view.sshAuth === "key") return field(view, "ssh-key", "Private key file", {
    placeholder: "~/.ssh/id_ed25519", submit: "addSsh", hint: view.windows ? "A path inside your default WSL distribution." : "The path is saved; the key itself is not.",
  });
  return { type: "label", key: "auth-hint", size: "xs", color: "muted", wrap: true, text: view.sshAuth === "password"
    ? "Hato asks for the password in a secure prompt when it connects. It isn't saved, so Hato asks again after a restart or a lost connection."
    : view.windows ? "Uses the SSH agent and ~/.ssh keys of your default WSL distribution." : "Uses your SSH agent and the keys in ~/.ssh." };
}

const SSH_AUTH: [SshAuth, string][] = [["agent", "SSH agent"], ["key", "Key file"], ["password", "Password"]];

function sshForm(view: AddProjectView): UiNode[] {
  return [
    { type: "row", key: "endpoint", gap: 8, align: "start", children: [
      field(view, "ssh-host", "Host", { placeholder: "server.example.com", submit: "addSsh", grow: true }),
      field(view, "ssh-port", "Port", { placeholder: "22", submit: "addSsh", width: 80 }),
    ] },
    field(view, "ssh-user", "User", { placeholder: "you", submit: "addSsh" }),
    { type: "column", key: "auth-field", gap: 6, children: [
      { type: "label", key: "label", text: "Sign in with", size: "xs", weight: "medium" },
      { type: "row", key: "ssh-auth", gap: 4, children: SSH_AUTH.map(([id, title]): UiNode => ({
        type: "button", key: `auth:${id}`, text: title, action: "sshAuth", value: id, small: true, variant: view.sshAuth === id ? "primary" : "ghost",
      })) },
      sshAuthDetail(view),
    ] },
    field(view, "ssh-path", "Remote folder", { placeholder: "/home/you/project", submit: "addSsh" }),
    nameField(view, "ssh-name", "addSsh", "The folder's name and host"),
  ];
}

const FORMS: Record<AddSource, { form: (view: AddProjectView) => UiNode[]; submit: string; label: string; intro: (windows: boolean) => string }> = {
  local: { form: localForm, submit: "addLocalPath", label: "Add project", intro: () => "Files, Git, terminals and agents run on this computer." },
  wsl: { form: wslForm, submit: "addWsl", label: "Add project", intro: () => "Files, Git, terminals and agents run inside the distribution." },
  ssh: { form: sshForm, submit: "addSsh", label: "Connect & add", intro: (windows) => `Files, Git, terminals and agents run on that machine. Its host key is checked against known_hosts${windows ? " in your default WSL distribution" : ""}.` },
};

export function addProjectModal(view: AddProjectView): UiNode {
  const { form, submit, label, intro } = FORMS[view.source];
  const unavailable = view.source === "wsl" && !view.distros.length;
  return { type: "modal", key: "add-modal", title: "Add project", width: 720, closeAction: "hideAdd", children: [
    { type: "row", key: "add-content", height: 430, gap: 14, align: "stretch", children: [
      { type: "column", key: "sources", width: 190, gap: 4, borderSide: "right", children: sourcesFor(view.windows).map((source): UiNode => ({
        type: "choice", key: `source:${source.id}`, text: source.title, description: source.description, selected: view.source === source.id, action: "addSource", value: source.id, mark: "",
      })) },
      { type: "column", key: `form:${view.source}`, gap: 10, grow: true, scroll: true, children: [
        { type: "label", key: "intro", text: intro(view.windows), size: "sm", color: "muted", wrap: true },
        ...(view.error ? [{ type: "status", key: "add-error", text: view.error, level: "error" } as UiNode] : []),
        ...form(view),
      ] },
    ] },
    ...(view.busy ? [{ type: "progress", key: "add-busy", indeterminate: true, label: view.busy } as UiNode] : []),
    { type: "row", key: "add-actions", gap: 6, children: [
      { type: "spacer", key: "gap" },
      { type: "button", key: "add-cancel", text: "Cancel", action: "hideAdd", disabled: !!view.busy },
      { type: "button", key: "add-submit", text: view.busy ? "Working…" : label, action: submit, variant: "primary", disabled: !!view.busy || unavailable },
    ] },
  ] };
}
