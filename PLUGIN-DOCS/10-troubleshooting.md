# 10. Troubleshooting

[← Publish](09-publish.md) · [Index](README.md)

Start with the **Modules** panel (rail footer menu → Modules) to see the module's active build
and logs. Over MCP, use `modules_describe` and `modules_logs`.

| Symptom | Likely cause | Fix |
|---|---|---|
| Rail button doesn't appear | plugin disabled; no `activity` block; bad id or side; position saved as `hidden` | enable it; add `activity.side`; check `workspace-layout.sidebarButtons` |
| Button has the fallback icon | unknown `activity.icon` name, or invalid SVG | use a name from `sdk/sidebar-icons.ts` or a valid inline SVG |
| My edits don't show up | only **built**, not activated; or the app runs from a different runtime folder | stage + activate ([ch. 5](05-update-reload.md)); check paths with `modules_describe` |
| Installed plugin still runs the old code | editing source doesn't touch the installed copy | bump the version, export, Update or reinstall |
| `module 'x' is not allowed to call 'y'` | `y` missing from `calls`, or not approved | add it to `calls`, update or reinstall, approve `call:y` |
| Native op denied | capability not declared or approved, or path outside the granted scope | declare the capability; use a scoped grant for the workspace |
| Swap returns `EDEFERRED` | your `canSwap()` vetoed it | wait until idle, or activate with force if it's safe |
| Swap failed, old version still running | new generation threw in `activate`, or failed render/health | check logs; the old generation is kept on purpose |
| State lost on reload | no `snapshot()`, or `activate` ignores `previousState` | implement both; persist durable data |
| Agent provider not listed | invalid `agentProviders` entry (silently skipped); duplicate `id` or `profile.id`; plugin disabled | check every required field type ([ch. 8](08-acp-providers.md)) |
| "ACP adapter '…' was not found on …" | adapter not on that machine's login-shell PATH | Manage agents → Install, or use an absolute path in the profile |
| Agent says authentication required | adapter not logged in on that machine | authenticate the adapter there, then reconnect |
| `require`, `fs` or `window` undefined | modules run in an embedded runtime, not Node or a browser | use `ctx.host` and SDK helpers |
| SDK change has no effect | consumers bundle the SDK | rebuild and activate every consumer |

## Don'ts

- Don't edit `approved-grants.json`, installed manifests, or cached artifacts by hand.
- Don't rewrite published package versions.
- Don't add Rust to work around something a module contract can express.
- Don't release kernel resources in `deactivate` that the next generation will reuse.

## Deeper references

- `.agents/skills/hato-plugins/references/` covers architecture, build-and-reload,
  lifecycle-and-permissions, ui-composition, service-flows, marketplace, native-and-remote
  and visual-review
- `docs/PLUGINS.md`, `docs/PLUGIN_RUNTIME.md`, `docs/PLUGIN-MARKETPLACE.md`, `docs/TESTING.md`
