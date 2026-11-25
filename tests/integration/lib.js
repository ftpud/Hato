// Shared helpers for headless driver scripts (concatenated in front of each test by run-integration.sh).
const T = (op, args) => globalThis.__testOp(op, args || {});
const results = [];
function check(name, cond, info) { results.push({ name, ok: !!cond, info: info === undefined ? null : info }); if (!cond) console.error("FAIL", name, JSON.stringify(info)); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 10000, step = 100) { const t0 = Date.now(); let v; while (Date.now() - t0 < ms) { try { v = await fn(); if (v) return v; } catch (e) { v = null; } await sleep(step); } return v; }
function find(node, pred) { if (!node || typeof node !== "object") return null; if (pred(node)) return node; for (const c of node.children || []) { const r = find(c, pred); if (r) return r; } return null; }
function texts(node, out = []) { if (!node) return out; if (node.text) out.push(node.text); if (node.rows) for (const r of node.rows) out.push(r.label); for (const c of node.children || []) texts(c, out); return out; }
const ev = async (module, action, extra) => {
  const event = Object.assign({ action, key: action, inputs: {} }, extra || {});
  if(module === "ai" && !action.startsWith("origin:")) {
    const tree = await T("test.render", {module});
    const node = find(tree, n => Object.keys(n).some(k => (k === "action" || k.endsWith("Action")) && typeof n[k] === "string" && n[k].startsWith("origin:") && n[k].slice(n[k].indexOf(":", 7)+1) === action));
    const scoped = node && Object.values(node).find(v => typeof v === "string" && v.startsWith("origin:") && v.slice(v.indexOf(":", 7)+1) === action);
    if(scoped)event.action=scoped; else delete event.key; // Explicit programmatic actions need no native key.
  }
  return T("test.event", {module,event});
};
async function finish() { const ok = results.every((r) => r.ok); await T("test.done", { ok, report: { passed: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).map((r) => r), all: results.map((r) => (r.ok ? "PASS " : "FAIL ") + r.name) } }); }
