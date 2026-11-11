# Hato development instructions

## Prefer configurable, hot-swappable modules

Hato's application behavior should live in TypeScript modules as much as possible. Keep the Rust core small and focused on reusable native primitives. Prefer changes that can be configured and hot reloaded without rebuilding or restarting the app.

- Put application logic, workflows, defaults, and policy in `modules/services/` or `modules/ui/`.
- Let UI modules define panel composition, layout, navigation, actions, labels, icons, ordering, spacing, and presentation choices. Pass these as data to the native renderer instead of hardcoding them in Rust.
- Expose useful user preferences through module settings or Layout, and persist them through the persistence service. Avoid making users edit source code for ordinary preferences.
- Use `sdk/` for shared types and helpers. Shared helpers are bundled into their consumers; rebuild and reload each affected module when changing them.
- Keep domain concepts such as projects, tasks, conversations, providers, and protocol workflows outside the Rust core.

## When native work is necessary

Rust owns native rendering and controls, operating-system adapters, resource handles, module runtimes, capability enforcement, and trusted approval UI.

Before adding Rust code, check whether existing module APIs and native primitives can handle the change. If a primitive is missing, add the smallest reusable host or UI capability, define its contract in `sdk/types.ts`, and keep feature-specific decisions in TypeScript. For example, Rust may render an SVG supplied by a module; the module chooses the drawing, size, order, and action.

When touching application logic or presentation currently hardcoded in Rust, move it into modules when practical and within the task's scope. Avoid adding more application-specific branches to the core. Do not move capability enforcement, ownership checks, scope validation, or trusted approval decisions into modules.

## Build, reload, and verify

- For module changes, run the relevant TypeScript checks and build the affected modules. Prefer hot activation through Hato's existing module tools when available and authorized.
- Preserve workspace state and kernel-owned resources across module reloads.
- Run appropriate Rust checks when native code changes.
- A module build alone does not activate changes in a running app. Report whether changes were built, staged, activated, or require a restart.
- Do not require a Rust rebuild or app restart for changes that existing module contracts can already express. When native changes are unavoidable, explain why a rebuild or restart is needed.

## Plugin architecture reference

For plugin builds, activation, lifecycle, permissions and service/UI wiring, consult
[the Hato plugin skill](.agents/skills/hato-plugins/SKILL.md). Its reference tree links to the
relevant subsystem guides; load only the branches needed for the task.

Module sources live in the nested `Hato-plugins/` repository (its own Git history and
`AGENTS.md`); `sdk/` and `kernel/` belong to this repository. Keep commits separate.

For the source editor, diff/markdown views, syntax highlighting and color schemes, and the
completion/hover/definition seams, see [the Hato editor skill](.agents/skills/hato-editor/SKILL.md).
