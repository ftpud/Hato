// Plan usage limits from ACP adapters, contributed bar items, and sidebar grouping by shared space.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as esbuild from "esbuild";
import { P, builtinPlugins } from "./plugin-fixture.mjs";

const load = async (entry) => import("data:text/javascript;base64," + Buffer.from((await esbuild.build({ entryPoints: [entry], bundle: true, format: "esm", platform: "neutral", write: false })).outputFiles[0].text).toString("base64") + "#" + Math.random());
const U = await load("sdk/usage-limits.ts");
const M = await load("Hato-plugins/modules/ui/workspace-layout/src/model.ts");

test("Claude /usage Markdown yields used percent per window", () => {
  const md = "## Usage\n\n> Claude max subscription usage\n\n### Limits\n\n**5-hour limit** — **42%** · Resets Nov 4, 3:00 PM\n\n`████░░`\n\n**Weekly · all models** — **7%**\n\n**Weekly · Opus** — **12.5%** · Resets Nov 9, 10:00 AM PST\n";
  const r = U.parseClaudeUsage(md);
  assert.equal(r.plan, "Claude max subscription");
  assert.deepEqual(r.windows.map(w => [w.id, w.label, w.usedPercent]), [["five_hour", "5h", 42], ["seven_day", "Wk", 7], ["weekly-opus", "Wk · Opus", 12.5]]);
  assert.ok(Number.isFinite(r.windows[0].resetsAt));
  assert.equal(r.windows[1].resetsAt, null);
});

test("Codex /status Markdown converts percent left to used and skips spend limits", () => {
  const md = "**Model:** gpt\n**Account:** ChatGPT pro (me@example.com)\n**codex 5h limit:** 73% left (resets 14:00)\n**codex Weekly limit:** 90% left (resets 09:00 on 9 Nov)\n**codex individual spend limit:** 50% left (1 of 2 credits used; resets Nov 9)\n";
  const r = U.parseCodexStatus(md);
  assert.equal(r.plan, "ChatGPT pro");
  assert.deepEqual(r.windows.map(w => [w.label, w.usedPercent, w.resetsText]), [["5h", 27, "14:00"], ["Wk", 10, "09:00 on 9 Nov"]]);
  assert.deepEqual(U.parseCodexStatus("**Limits:** data not available yet").windows, []);
});

test("Claude in-session rate limit events update only the reported window", () => {
  const a = U.applyClaudeRateLimit(null, { status: "allowed", rateLimitType: "seven_day", utilization: 0.31, resetsAt: 2000000000 }, 5);
  const b = U.applyClaudeRateLimit(a, { rateLimitType: "five_hour", utilization: 0.8 }, 6);
  assert.deepEqual(b.windows.map(w => [w.id, w.usedPercent]), [["five_hour", 80], ["seven_day", 31]]);
  assert.equal(b.windows[1].resetsAt, 2000000000000);
  assert.equal(U.applyClaudeRateLimit(b, { utilization: "x" }), b);
});

test("bar item contributions are validated and offered once on their default bar", () => {
  const c = P.collectContributions(builtinPlugins());
  assert.deepEqual(c.barItems.map(b => [b.id, b.module, b.bar]), [["claude-usage", "claude-usage", "bottom"], ["git-branch", "git-branch", "top"], ["codex-usage", "codex-usage", "bottom"]]);
  M.setContributedBarItems(Object.fromEntries(c.barItems.map(b => [b.id, { title: b.title, slot: b.module, width: b.width, defaultBar: b.bar }])));
  const fresh = M.defaultLayout();
  assert.deepEqual(fresh.bars.top.items, ["title", "workspace", "git-branch", "toolbarGap", "layoutMenu", "settings"]);
  assert.deepEqual(fresh.bars.bottom.items, ["machine", "toolbarSpace", "claude-usage", "codex-usage", "approvals", "modules"]);
  // A layout saved before the meters existed gets them once; a later removal sticks.
  const old = { ...fresh, bars: { top: fresh.bars.top, bottom: { visible: true, items: ["machine", "modules"] } } }; delete old.barItemsSeen;
  const upgraded = M.repair(old);
  assert.ok(upgraded.bars.bottom.items.includes("claude-usage"));
  const removed = M.repair({ ...upgraded, bars: { ...upgraded.bars, bottom: { visible: true, items: ["machine"] } } });
  assert.deepEqual(removed.bars.bottom.items, ["machine"]);
  assert.equal(M.repair({ ...fresh, showCollapsedTray: false }).showCollapsedTray, false);
  assert.equal(M.repair(old).showCollapsedTray, true);
});

test("sidebar draws a rule between adjacent buttons of different shared spaces, not over spacers", async () => {
  const { pluginsHost } = await import("./plugin-fixture.mjs");
  const left = (await load("Hato-plugins/modules/ui/left-sidebar/src/index.ts")).default;
  const values = new Map([["workspace-layout.panelSharing", { files: "space-2", git: "space-2", remote: "space-2", viewer: "space-1", "git-changes": "space-1", workflows: "space-1" }],
    ["workspace-layout.sidebarOrder", { "left-top": ["projects", "files", "git", "remote", "@spacer:x", "viewer", "git-changes", "workflows", "terminal"] }]]);
  const ctx = { host: { plugins: pluginsHost() }, state: { get: k => values.get(k), watch() {} }, events: { on() { return () => {}; } }, ui: { invalidate() {} }, log: { warn() {} } };
  await left.activate(ctx);
  assert.deepEqual(left.render().children.map(n => n.key), ["projects", "group-rule:files", "files", "git", "remote", "@spacer:x", "viewer", "git-changes", "workflows", "group-rule:terminal", "terminal"]);
  values.set("workspace-layout.sidebarGrouping", false);
  const off = (await load("Hato-plugins/modules/ui/left-sidebar/src/index.ts")).default; await off.activate(ctx);
  assert.ok(!off.render().children.some(n => n.key.startsWith("group-rule:")));
});
