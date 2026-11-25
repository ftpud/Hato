#!/usr/bin/env node
// Deterministic UiNode fixtures; all rendering goes through Hato's production renderer.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
function option(name, fallback) {
  const i = args.indexOf(name);
  if (i < 0) return fallback;
  if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`Missing ${name} value`);
  return args[i + 1];
}
const out = resolve(option('--out', '/tmp/hato-render-bench'));
const binary = resolve(option('--binary', join(repo, 'target/debug/hato')));
const frames = Number(option('--frames', '80'));
const rounds = Number(option('--rounds', '2'));
const size = option('--size', '1280x832');
if (![frames, rounds].every(n => Number.isSafeInteger(n) && n > 0)) throw new Error('frames/rounds must be positive integers');
const filter = new RegExp(option('--case', '.'));
const metal = args.includes('--metal');
const icon = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16"><path d="M2 3h5l2 2h5v8H2z" fill="none" stroke="currentColor"/></svg>';
const seq = (n, fn) => Array.from({ length: n }, (_, i) => fn(i));
const label = (key, text) => ({ type: 'label', key, text, size: 'sm' });
const column = (key, children, extra = {}) => ({ type: 'column', key, children, ...extra });
const row = (key, children, extra = {}) => ({ type: 'row', key, align: 'stretch', children, ...extra });
const scroll = (children, lazy = false) => ({ type: 'scroll', key: 'scroll', grow: true, ...(lazy ? { itemHeight: 24 } : {}), children });
const labels = n => seq(n, i => ({ ...label(`l${i}`, `Item ${String(i).padStart(5, '0')} — deterministic render workload`), height: 24 }));
const buttons = n => row('buttons', seq(n, i => ({ type: 'button', key: `b${i}`, text: `Action ${i}`, action: 'noop', small: true, iconSvg: icon })), { wrap: true, gap: 4 });
const tree = (n, fixed = true) => ({ type: 'tree', key: 'tree', grow: true, ...(fixed ? { rowHeight: 24 } : {}), selectAction: 'noop', expandAction: 'noop',
  rows: seq(n, i => ({ key: `r${i}`, label: `src/component-${String(i).padStart(5, '0')}.ts`, depth: i % 4, expandable: i % 7 === 0, expanded: true, selected: i === 3, iconSvg: icon, children: [] })) });
const spinner = i => ({ type: 'spinner', key: `spin${i}`, size: 16, thickness: 2, color: '#e06040', fps: 30 });
const ring = i => ({ type: 'ring', key: `ring${i}`, size: 24, thickness: 3, value: (i % 9 + 1) / 10, max: 1, color: '#e06040', trackColor: '#303038' });
const markdown = i => ({ type: 'markdown', key: `m${i}`, inline: true, text: `### Message ${i}\n\nA **repeatable** message with a [link](https://example.com), inline \`code\`, and ordinary prose.\n\n- One item\n- Another item\n\n\`\`\`ts\nconst total = items.reduce((sum, item) => sum + item.value, 0);\nconsole.log(total);\n\`\`\`` });
const transcript = n => ({ type: 'transcript', key: 'transcript', grow: true, scrollKey: 'fixed', followKey: 'fixed', children: seq(n, markdown) });
const glow = (radius, n = 1) => ({ glow: seq(n, i => ({ x: 0.2 + i * 0.3, y: 0.25, radius, color: ['#e06040', '#4169b0', '#a35389'][i % 3] })) });
const layers = (n, kind, blur = 32) => seq(n, i => column(`layer${i}`, [], { style: {
  position: 'absolute', left: 80 + i * 9, top: 70 + i * 7, width: 760, height: 520, radius: 16,
  background: kind === 'translucent' ? '#30304020' : '#23232b',
  ...(kind === 'gradient' ? { gradient: { angle: 135, from: '#e0604060', to: '#4169b010' } } : {}),
  ...(kind === 'shadow' ? { shadows: [{ x: 0, y: 8, blur, spread: 0, color: '#00000080' }] } : {}),
} }));
const cases = [];
function add(name, children = [], props = {}, modules) {
  // Ambient is intentionally suppressed by reduced motion, so enable it only for those cases.
  // No particles are supplied: glow tests remain static even with full motion enabled.
  const tree = column('root', [{ type: 'theme', key: 'theme', mode: 'dark', motion: { mode: props.ambient ? 'on' : 'off' } }, ...children], {
    grow: true, style: { background: '#141418', position: 'relative', clip: true }, ...props,
  });
  cases.push({ name, tree: modules ? { tree, modules } : tree });
}
add('flat');
for (const n of [100, 500, 1500]) {
  add(`labels-eager-${n}`, [scroll(labels(n))]);
  add(`labels-lazy-${n}`, [scroll(labels(n), true)]);
}
for (const n of [32, 128, 512]) add(`buttons-${n}`, [buttons(n)]);
for (const n of [100, 1000, 5000]) {
  add(`tree-fixed-${n}`, [tree(n)]);
  add(`tree-intrinsic-${n}`, [tree(n, false)]);
}
for (const n of [1, 16, 128]) {
  add(`spinners-${n}`, [row('sprites', seq(n, spinner), { wrap: true, gap: 4 })]);
  add(`rings-${n}`, [row('sprites', seq(n, ring), { wrap: true, gap: 4 })]);
}
for (const radius of [96, 320, 640]) add(`glow-1-radius-${radius}`, [], { ambient: glow(radius) });
add('glow-3-radius-640', [], { ambient: glow(640, 3) });
const emberGlow = { glow: [{ x: 0.07, y: 0, radius: 170, color: '#ffffff14' }, { x: 0.55, y: 0, radius: 120, color: '#ffffff14' }] };
add('glow-ember', [], { ambient: emberGlow });
for (const n of [1, 8, 32]) {
  add(`opaque-layers-${n}`, layers(n, 'opaque'));
  add(`translucent-layers-${n}`, layers(n, 'translucent'));
  add(`gradient-layers-${n}`, layers(n, 'gradient'));
  for (const blur of [32, 128]) add(`shadow-${n}-blur-${blur}`, layers(n, 'shadow', blur));
}
for (const n of [1, 10, 50]) add(`markdown-${n}`, [scroll(seq(n, markdown))]);
for (const n of [25, 100]) add(`transcript-${n}`, [transcript(n)]);
// Cumulative realistic composition, then change exactly one effect.
const rail = column('rail', [tree(1000)], { width: 280 });
const toolbar = row('toolbar', [buttons(8), spinner(0)], { height: 40, padding: 4 });
const content = column('content', [toolbar, transcript(25)], { grow: true });
add('workspace-1-rail', [row('workspace', [rail, column('content', [], { grow: true })], { grow: true })]);
add('workspace-2-toolbar', [row('workspace', [rail, column('content', [toolbar], { grow: true })], { grow: true })]);
add('workspace-3-transcript', [row('workspace', [rail, content], { grow: true })]);
add('workspace-4-glow', [row('workspace', [rail, content], { grow: true })], { ambient: glow(640, 3) });
add('workspace-5-shadows', [row('workspace', [rail, { ...content, style: { shadows: [{ x: 0, y: 0, blur: 128, color: '#00000080' }] } }], { grow: true })], { ambient: glow(640, 3) });
const slot = (module, extra = {}) => ({ type: 'slot', key: module, module: `__${module}`, grow: true, ...extra });
for (const n of [25, 100]) add(`workspace-cached-${n}`, [row('workspace', [slot('rail', { width: 280 }), slot('body')], { grow: true })], {}, {
  __rail: column('rail', [tree(1000)], { grow: true }),
  __body: column('body', [toolbar, transcript(n)], { grow: true }),
});
add('workspace-cached-ember', [row('workspace', [slot('rail', { width: 280 }), slot('body')], { grow: true })], { ambient: emberGlow }, {
  __rail: column('rail', [tree(1000)], { grow: true }), __body: column('body', [toolbar, transcript(25)], { grow: true }),
});
for (const n of [8, 32]) {
  add(`inputs-${n}`, [scroll(seq(n, i => ({ type: 'textInput', key: `input${i}`, value: `Value ${i}`, changeAction: 'noop' })))]);
  add(`switches-${n}`, [scroll(seq(n, i => ({ type: 'switch', key: `switch${i}`, label: `Setting ${i}`, checked: i % 2 === 0, action: 'noop' })))]);
}
// Even one native path can switch GPUI to a full-window MSAA intermediate.
const items = seq(16, i => ({ key: `item${i}`, x: 40 + i % 4 * 270, y: 40 + Math.floor(i / 4) * 170, width: 180, height: 80,
  style: { background: '#23232b', radius: 8 }, children: [label(`text${i}`, `Node ${i}`)] }));
for (const n of [0, 1, 16, 64]) add(`canvas-edges-${n}`, [{ type: 'canvas', key: 'canvas', grow: true, margin: 0, items,
  edges: seq(n, i => ({ key: `edge${i}`, from: `item${i % 15}`, to: `item${i % 15 + 1}`, color: '#e06040', width: 2 })) }]);
add('canvas-grid', [{ type: 'canvas', key: 'canvas', grow: true, margin: 0, items, grid: 24 }]);
// Actual Ember panel styling from sdk/halo-glass.ts + workspace-layout's dark palette.
const panelStyle = { radius: 14, borderWidth: 1, borderColor: '#ffffff10', background: '#0e0e0f', padding: 4 };
const panelGradient = { gradient: { angle: 180, from: '#181819', to: '#0a0a0b', toAt: 0.34 } };
const panelShadows = { shadows: [{ y: 1, color: '#ffffff09', inset: true }, { y: 18, blur: 40, color: '#00000099' }] };
for (const [name, effect] of [['flat', {}], ['gradient', panelGradient], ['glass', { ...panelGradient, ...panelShadows }]]) {
  add(`ember-panels-${name}`, [row('workspace', [
    column('rail-panel', [slot('rail')], { width: 280, style: { ...panelStyle, ...effect } }),
    column('body-panel', [slot('body')], { grow: true, style: { ...panelStyle, ...effect } }),
  ], { grow: true, gap: 6, padding: 6 })], { ambient: emberGlow }, {
    __rail: column('rail', [tree(1000)], { grow: true }), __body: column('body', [toolbar, transcript(25)], { grow: true }),
  });
}

const selected = cases.filter(c => filter.test(c.name));
if (!selected.length) throw new Error('No cases matched');
if (args.includes('--list')) { console.log(selected.map(c => c.name).join('\n')); process.exit(0); }
mkdirSync(out, { recursive: true });
for (const c of selected) writeFileSync(join(out, `${c.name}.tree.json`), JSON.stringify(c.tree, null, 2));
const binaryStat = statSync(binary);
writeFileSync(join(out, 'manifest.json'), JSON.stringify({ size, frames, rounds, metal, cases: selected.map(c => c.name), binary,
  binary_size: binaryStat.size, binary_mtime: binaryStat.mtime.toISOString(), fixture_source: fileURLToPath(import.meta.url) }, null, 2));
if (args.includes('--generate-only')) { console.log(out); process.exit(0); }
const results = [];
// Fixed pseudo-random ordering distributes thermal/order effects across repeated runs.
let seed = 173;
const random = () => { seed = Math.imul(seed, 1664525) + 1013904223 | 0; return (seed >>> 0) / 2 ** 32; };
for (let round = 1; round <= rounds; round++) {
  const order = selected.map(c => ({ c, order: random() })).sort((a, b) => a.order - b.order).map(x => x.c);
  for (const c of order) {
    const stem = join(out, `${c.name}.r${round}`);
    const cli = ['--repo-root', repo, '--root', repo, '--data-dir', mkdtempSync(join(out, 'data-')),
      '--snapshot', `${stem}.png`, '--snapshot-tree', join(out, `${c.name}.tree.json`), '--snapshot-size', size,
      '--snapshot-delay', '250', '--snapshot-bench', `${stem}.json`, '--snapshot-frames', String(frames)];
    const command = metal ? 'xcrun' : binary;
    const commandArgs = metal ? ['xctrace', 'record', '--template', 'Metal System Trace', '--output', `${stem}.trace`,
      '--no-prompt', '--time-limit', '60s', '--target-stdout', `${stem}.target.log`, '--launch', '--', binary, ...cli] : cli;
    const run = spawnSync(command, commandArgs, { cwd: repo, encoding: 'utf8', timeout: 180000, maxBuffer: 8 * 1024 * 1024 });
    writeFileSync(`${stem}.log`, `${run.stdout ?? ''}\n${run.stderr ?? ''}`);
    if (run.error || run.status !== 0) throw new Error(`${c.name}: ${run.error ?? `exit ${run.status}`} (see ${stem}.log)`);
    const measurement = JSON.parse(readFileSync(`${stem}.json`, 'utf8'));
    measurement.fixture_sha256 = createHash('sha256').update(readFileSync(join(out, `${c.name}.tree.json`))).digest('hex');
    if (metal) {
      const exported = spawnSync('xcrun', ['xctrace', 'export', '--input', `${stem}.trace`, '--xpath',
        '/trace-toc/run[@number="1"]/data/table[@schema="metal-gpu-intervals"]', '--output', `${stem}.gpu.xml`], { encoding: 'utf8', timeout: 120000 });
      if (exported.error || exported.status !== 0) throw new Error(`Metal export failed: ${exported.error ?? exported.stderr}`);
      const summary = spawnSync('python3', [join(repo, 'tools/render-bench/metal-summary.py'), `${stem}.gpu.xml`, String(measurement.pid)], { encoding: 'utf8', timeout: 30000 });
      if (summary.error || summary.status !== 0) throw new Error(`Metal summary failed: ${summary.error ?? summary.stderr}`);
      measurement.gpu = JSON.parse(summary.stdout);
      writeFileSync(`${stem}.gpu.json`, summary.stdout);
    }
    results.push({ case: c.name, round, ...measurement });
    writeFileSync(join(out, 'results.json'), JSON.stringify(results, null, 2));
    const { retained, invalidated } = measurement.modes;
    console.log(`${round}/${rounds} ${c.name.padEnd(29)} draw ${retained.draw_ms.p50.toFixed(3)} / ${invalidated.draw_ms.p50.toFixed(3)} ms; raster+readback ${invalidated.raster_readback_ms.p50.toFixed(3)} ms${measurement.gpu ? `; GPU fragment ${measurement.gpu.fragment_ms_per_buffer.p50.toFixed(3)} ms` : ''}`);
  }
}
const rows = ['case,round,width_px,height_px,retained_draw_p50_ms,invalidated_draw_p50_ms,invalidated_draw_p95_ms,raster_readback_p50_ms,total_p50_ms'];
for (const r of results) rows.push([r.case, r.round, r.width_px, r.height_px, r.modes.retained.draw_ms.p50, r.modes.invalidated.draw_ms.p50, r.modes.invalidated.draw_ms.p95, r.modes.invalidated.raster_readback_ms.p50, r.modes.invalidated.total_ms.p50].join(','));
writeFileSync(join(out, 'results.csv'), rows.join('\n') + '\n');
console.log(`Saved ${results.length} measurements to ${out}`);
