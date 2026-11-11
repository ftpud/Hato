# Git panels and presentation defaults

Application behavior lives in the independent `Hato-plugins` checkout. Native changes add
floating diff navigation, disabled choices, and narrow first-party call bounds for the new panels.

## Build and run

From the Hato repository:

```sh
npm run modules:build
npm run dev
```

`npm run dev` recompiles the native app and launches with `--dev-watch`, using the editable
plugin checkout instead of older installed marketplace overrides. Preserve the normal data
directory to retain workspaces, sessions and layout. Do not launch a second app against the same
live data directory. The existing app needs to exit before the rebuilt app is started.

Versioned plugin artifacts are included in `Hato-plugins/packages/foundation/0.1.12` and
`Hato-plugins/packages/git/0.1.7`. Ordinary packaged launches
that use installed marketplace overrides need the corresponding plugin update as well as the
native update; a native rebuild alone does not replace installed plugin source overrides.

## Controls

- **Git changes**: select files, write a message, commit, commit and push, fetch, pull, or push.
  Commits include complete working copies of the selected files. Other staged files stay staged
  and are excluded. Pull uses fast-forward only.
- **Changesets**: select files and create a named tab, or use “Move selected to…”. Each file
  belongs to one tab. Changed files appear in a left-aligned directory tree with folder checkboxes; single-child directory chains compact into rows such as `folder1/folder2`. Removing a tab returns its files to Changes. Commit drafts and assignments
  persist per workspace and survive module reloads; these tabs do not create Git branches.
- **Stashes**: save all working changes including untracked files, apply while keeping the
  stash, or explicitly confirm deletion. Git conflicts appear as errors and remain available
  for resolution. Stashes belong to the repository and are shared by its worktrees.
- **Task Git Changes**: compares the task’s current working tree with its fixed creation commit,
  including subsequent committed edits and current untracked files. An intact creation reflog
  can recover an older task’s baseline. Otherwise supply the full starting commit ID once.
- **Git history**: browse local/remote branches and tags, follow merge connections, load older
  commits, filter loaded commits, and review a selected commit’s complete patch. File previews
  start collapsed. The toolbar switches between side-by-side and unified diffs; Settings → Git
  history persists the layout, line wrapping and initial file-collapse preferences.
- **New task**: search and select a local or remote branch, generate a task branch, or explicitly
  choose to create a typed branch name. Branches already used by a workspace are disabled.
- **Compare views**: floating previous/next buttons navigate changed regions in unified and
  side-by-side diffs, including latest changes, task comparisons and history.

The default layout matches the latest captured setup for all 13 panels: Projects and AI on the
left, Latest changes in the middle, Files above Git, and MCP in the right column. Git and Task
Git Changes share a space; Git History shares the terminal space. Hidden and collapsed states,
proportions, toolbar placement and sidebar order follow the same snapshot. Panel placement and
shared spaces remain configurable in Layout.

## Defaults and verification

Presentation defaults were captured from the live setup: light Classic appearance, 14px
JetBrains Mono, Weird syntax colors, sidebar placement, panel proportions, viewer preferences
and table styling. Existing saved preferences take precedence. Reset appearance and layout uses
the captured defaults. Credentials, providers, sessions, workspace selections, plugin receipts
and MCP configuration are excluded.

Verification includes both repository TypeScript suites, disposable Git repository tests, and
Rust checks with and without default features. Native screenshots could not be captured because
macOS Screen Recording permission was unavailable; appearance and native click behavior still
need visual review after rebuilding.

## Language workspace cache and module builds

In `lng-srv`, each language now has its own **Project settings…** action below its enablement
button. This opens the selected language even when it is disabled for that workspace.

Language services retain three recent server processes by default. Switching back reuses the
existing JDTLS process, open-document state and index. Settings → Languages → Language server
cache controls the number of warm servers. The least recently used process receives LSP
`shutdown` and `exit` before termination; its existing per-workspace data directory remains on
disk. Explicit **Rebuild server index** still starts a new index generation. Module replacement
and application shutdown close processes, so a restart can still perform incremental imports.

The Modules window resolves installed module IDs to their editable checkout using the existing
modules-scoped source API. It does not invent `/src/index.ts` when an installed module has no
source directory. Bundle-only plugins without checkout sources are labelled accordingly and
updated through Settings → Plugins. Actual compiler errors remain available in a collapsed
details control, and the wider window wraps rows instead of clipping build controls.
