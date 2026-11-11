---
name: hato-editor
description: Native code editor, diff, markdown and syntax theming seams in Hato (gpui-component 0.8.1). Use when changing highlighting, color schemes, soft wrap, gutter, completion/hover/definition, or other editor behavior, before deciding whether a change needs Rust.
---

# Hato editor and syntax seams

Read [AGENTS.md](../../../AGENTS.md) first; this is a short map of facts that are slow to rediscover.

## Who owns what

- `Hato-plugins/modules/ui/viewer` renders the editor tabs: `codeViewer` (source), `diff`
  (Git diff tabs, `softWrap`), `markdown` (preview). Save policy, settings and LSP forwarding live here.
- `Hato-plugins/modules/services/language-*` contribute languages (`contributes.languages` in the
  manifest: `grammar`, optional `syntaxRules`, `server`). `language-service` is the LSP client;
  `sdk/languages.ts` / `sdk/lsp.ts` are shared helpers.
- `kernel/src/ui/mod.rs` renders the nodes (search `"codeViewer" =>`, `"diff" =>`, `"markdown" =>`).
  `kernel/src/ui/editor.rs` holds the generic module→editor bridges: definition/hover/completion
  providers that call back into the rendering module, UTF-16⇄editor column conversion, and the
  module-supplied regex `LexicalHighlighter`.
- `kernel/src/ui/theme.rs` applies the root `theme` node (palette, typography, terminal, chrome)
  emitted by `workspace-layout`; `sdk/color-scheme.ts` is the default palette.

## gpui-component facts (0.8.1, source in `~/.cargo/registry/src/*/gpui-component-0.8.1` and `gpui-base-0.8.1`)

- Token colors come from `cx.theme().highlight_theme` (`HighlightTheme`, Zed theme JSON format,
  serde-deserializable: `style.syntax.<capture>` = `{color, font_style, font_weight}`, plus
  `editor.*` colors). The `Editor` element re-projects it into the editor style on every render,
  so replacing `theme.highlight_theme` restyles editors, diffs and markdown code blocks.
  Theme styles carry **no background color**; token backgrounds need a custom
  `InputHighlighter` whose `styles()` returns `HighlightStyle { background_color, .. }`.
- Highlighters are installed per `EditorState` via `set_highlighter_factory`; the default
  incremental tree-sitter adapter (`input_highlighter_factory`) is `pub(crate)` and cannot be
  wrapped. `SyntaxHighlighter::update(edit, text, timeout)` is public but returns early when the
  text is unchanged, so a deferred full reparse needs a fresh `SyntaxHighlighter`.
- Bundled grammars include Java/TS/Rust/etc. (feature `tree-sitter-languages`); capture names
  are the Zed ones (`keyword`, `type`, `string`, `function`, `property`, `attribute`, ...).
- `EditorState::set_soft_wrap` / `set_line_number` exist; `Diff::soft_wrap` exists.
- LSP seams on `state.lsp_mut()`: completion, hover, definition, code actions, document colors,
  semantic tokens. There is **no signature-help provider**, and completion
  `additional_text_edits` are **not applied** (auto-import needs host work). The completion menu
  is rendered in `gpui-component/src/input/popovers/completion_menu.rs` (label + detail only);
  restyling it means patching the crate (see `[patch.crates-io]` + `vendor/` in `Cargo.toml`).

## Hato seams built on top (use these before adding Rust)

- Syntax schemes: root `theme` node `syntax: {light, dark}` (`sdk/syntax-schemes.ts`; bundled
  Default/Weird, user JSON in `<sharedDir>/syntax-schemes` read via `settings.syntaxSchemeFiles`).
  Colors/fonts go into the highlight theme; token backgrounds/underlines use the overlay in
  `editor.rs`, which swaps in an incremental `GrammarHighlighter` only while a scheme needs it.
- `codeViewer` extras: `softWrap`, `lineMarkers` + `lineMarkerAction` (Git change bars in viewer),
  `signatureMethod` (parameter-hint popup, drawn by `Shell::signature_popup`), and
  `completionResolveMethod` (auto-import: an accepted, unambiguous completion is resolved and its
  `additionalTextEdits` applied by `editor::apply_text_edits`).
- Completion presentation (IDEA-style label/detail) is shaped in `viewer` (`shapeCompletions`).
- Language servers are opt-in per workspace (`language-service` project config, default off);
  the bottom-bar `lng-srv` menu lives in `language-status`/`language-tools`.

## Practical rules

- Prefer passing data on the node (`codeViewer` fields in `sdk/types.ts`) over new Rust branches;
  keep language names and color choices in modules.
- Positions crossing the module boundary are zero-based UTF-16 (LSP); convert with the helpers
  in `editor.rs`.
- Editor state is cached per document handle in `Shell.editors` (LRU at 48); per-handle side
  tables (`editor_syntax`, `editor_reveal`, ...) must be evicted together.
- Native changes need `cargo check` and an app rebuild/restart; module changes hot-reload.
