// Hato kernel prelude: evaluated in every module generation's private QuickJS runtime before the
// module artifact. It implements the ModuleContext SDK on top of four native functions:
//   __host_sync(op, argsJson) -> resultJson          (cheap, non-blocking kernel ops)
//   __host_async(op, argsJson, callId)               (result arrives later via __hato_dispatch)
//   __host_reply(reqId, ok, json)                    (answer a kernel invocation)
//   __host_timer(id, ms) / __host_timer_clear(id)    (worker-local timers)
// No Node APIs exist here. Everything privileged goes through the kernel's capability broker.
(function () {
  "use strict";
  const G = globalThis;
  const hostSync = G.__host_sync;
  const hostAsync = G.__host_async;
  const hostReply = G.__host_reply;
  const hostTimer = G.__host_timer;
  const hostTimerClear = G.__host_timer_clear;
  const META = JSON.parse(G.__hato_meta);
  delete G.__host_sync; delete G.__host_async; delete G.__host_reply;
  delete G.__host_timer; delete G.__host_timer_clear; delete G.__hato_meta;

  function makeError(e) {
    const err = new Error((e && e.message) || "host error");
    err.code = (e && e.code) || "EIO";
    return err;
  }
  function sync(op, args) {
    const r = JSON.parse(hostSync(op, JSON.stringify(args === undefined ? null : args)));
    if (r.ok) return r.value;
    throw makeError(r.error);
  }
  let nextCall = 1;
  const pendingCalls = new Map();
  function call(op, args) {
    return new Promise((resolve, reject) => {
      const id = nextCall++;
      pendingCalls.set(id, { resolve, reject });
      hostAsync(op, JSON.stringify(args === undefined ? null : args), id);
    });
  }

  // ---- console -------------------------------------------------------------------------------
  function fmt(args) {
    return args.map((a) => {
      if (typeof a === "string") return a;
      if (a instanceof Error) return (a.stack ? a.message + "\n" + a.stack : a.message);
      try { return JSON.stringify(a); } catch (_) { return String(a); }
    }).join(" ");
  }
  const log = (level) => (...a) => { try { sync("log", { level, msg: fmt(a) }); } catch (_) {} };
  G.console = { log: log("info"), info: log("info"), warn: log("warn"), error: log("error"), debug: log("debug") };

  // ---- timers --------------------------------------------------------------------------------
  let nextTimer = 1;
  const timers = new Map();
  G.setTimeout = function (fn, ms, ...args) {
    const id = nextTimer++;
    timers.set(id, { fn, args, interval: null });
    hostTimer(id, Math.max(0, Number(ms) || 0));
    return id;
  };
  G.setInterval = function (fn, ms, ...args) {
    const id = nextTimer++;
    const period = Math.max(1, Number(ms) || 0);
    timers.set(id, { fn, args, interval: period });
    hostTimer(id, period);
    return id;
  };
  G.clearTimeout = G.clearInterval = function (id) {
    if (timers.delete(id)) hostTimerClear(id);
  };
  G.queueMicrotask = (fn) => { Promise.resolve().then(fn); };

  // ---- text codecs (UTF-8 only) --------------------------------------------------------------
  class TextEncoder {
    get encoding() { return "utf-8"; }
    encode(str) {
      const s = String(str); const out = [];
      for (let i = 0; i < s.length; i++) {
        let c = s.charCodeAt(i);
        if (c >= 0xd800 && c < 0xdc00 && i + 1 < s.length) {
          const d = s.charCodeAt(i + 1);
          if (d >= 0xdc00 && d < 0xe000) { c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00); i++; }
        }
        if (c < 0x80) out.push(c);
        else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
        else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
        else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      }
      return new Uint8Array(out);
    }
  }
  class TextDecoder {
    get encoding() { return "utf-8"; }
    decode(bytes) {
      if (!bytes) return "";
      const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
      let s = "";
      for (let i = 0; i < b.length;) {
        const c = b[i++];
        let cp;
        if (c < 0x80) cp = c;
        else if (c < 0xe0) cp = ((c & 31) << 6) | (b[i++] & 63);
        else if (c < 0xf0) cp = ((c & 15) << 12) | ((b[i++] & 63) << 6) | (b[i++] & 63);
        else cp = ((c & 7) << 18) | ((b[i++] & 63) << 12) | ((b[i++] & 63) << 6) | (b[i++] & 63);
        s += String.fromCodePoint(cp);
      }
      return s;
    }
  }
  G.TextEncoder = TextEncoder;
  G.TextDecoder = TextDecoder;
  G.crypto = { randomUUID: () => sync("random.uuid"), randomHex: (n) => sync("random.hex", { bytes: n || 16 }) };

  // ---- streams -------------------------------------------------------------------------------
  let nextSub = 1;
  const streamSubs = new Map(); // subId -> { onData, onEnd }
  function listen(handle, opts, onData, onEnd) {
    const subId = META.moduleId + ":" + META.generation + ":" + (nextSub++);
    streamSubs.set(subId, { onData, onEnd });
    const o = opts || {};
    return call("streams.subscribe", { handle, subId, channel: o.channel || "stdout", encoding: o.encoding || "utf8", highWaterMark: o.highWaterMark || 1048576 })
      .then(() => ({ subId, close: () => { streamSubs.delete(subId); return call("streams.unsubscribe", { subId }); } }))
      .catch((e) => { streamSubs.delete(subId); throw e; });
  }
  function subscribeIter(handle, opts) {
    const queue = []; let waiting = null; let ended = false; let subP = null; let failure = null;
    subP = listen(handle, opts, (chunk) => {
      if (waiting) { const w = waiting; waiting = null; w.resolve({ value: chunk, done: false }); }
      else queue.push(chunk);
    }, (err) => {
      ended = true; failure = err || null;
      if (waiting) { const w = waiting; waiting = null; failure ? w.reject(failure) : w.resolve({ value: undefined, done: true }); }
    }).catch((e) => { ended = true; failure = e; if (waiting) { const w = waiting; waiting = null; w.reject(e); } });
    return {
      [Symbol.asyncIterator]() { return this; },
      next() {
        if (queue.length) return Promise.resolve({ value: queue.shift(), done: false });
        if (ended) return failure ? Promise.reject(failure) : Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve, reject) => { waiting = { resolve, reject }; });
      },
      async return() { ended = true; const s = await subP; if (s) await s.close(); return { value: undefined, done: true }; },
    };
  }

  // ---- event bus / observable state ----------------------------------------------------------
  const topicListeners = new Map(); // topic -> Set(fn)
  const stateWatchers = new Map(); // key -> Set(fn)
  const ownTopicSubs = new Set();

  // ---- the ModuleContext ---------------------------------------------------------------------
  const ctx = {
    moduleId: META.moduleId,
    generation: META.generation,
    version: META.version,
    host: {
      abiVersion: 1,
      env: { info: () => sync("env.info") },
      capabilities: {
        request: (req) => call("capabilities.request", req),
        release: (grant) => call("capabilities.release", { grant }),
      },
      fs: {
        stat: (grant, path) => call("fs.stat", { grant, path }),
        watch: (grant, path, opts) => call("fs.watch", { grant, path, ...opts }),
        list: (grant, path) => call("fs.list", { grant, path }),
        realpath: (grant, path) => call("fs.realpath", { grant, path }),
        read: (grant, path, limitBytes) => call("fs.read", { grant, path, limitBytes }),
        writeAtomic: (grant, path, text, opts) => call("fs.writeAtomic", { grant, path, text, reason: opts && opts.reason, mode: opts && opts.mode }),
        mkdir: (grant, path) => call("fs.mkdir", { grant, path }),
      },
      process: {
        spawn: (grant, request) => call("process.spawn", { grant, request }),
        run: (grant, request, opts) => call("process.run", Object.assign({ grant, request }, opts || {})),
        write: (handle, text) => call("process.write", { handle, text }),
        closeStdin: (handle) => call("process.closeStdin", { handle }),
        terminate: (handle, signal) => call("process.terminate", { handle, signal }),
        wait: (handle) => call("process.wait", { handle }),
        info: (handle) => call("process.info", { handle }),
      },
      pty: {
        open: (grant, req) => call("pty.open", { grant, request: req }),
        write: (pty, text) => call("pty.write", { handle: pty, text }),
        resize: (pty, columns, rows) => call("pty.resize", { handle: pty, columns, rows }),
        close: (pty) => call("pty.close", { handle: pty }),
        read: (pty, opts) => call("pty.read", { handle: pty, ...(opts || {}) }),
        info: (pty) => call("pty.info", { handle: pty }),
      },
      ssh: {
        connect: (profile) => call("ssh.connect", { profile }),
        status: (connection) => call("ssh.status", { connection }),
        disconnect: (connection) => call("ssh.disconnect", { connection }),
        forwardLoopback: (connection, request) => call("ssh.forwardLoopback", Object.assign({ connection }, request)),
        cancelForward: (handle) => call("ssh.cancelForward", { handle }),
      },
      net: {
        listenLoopback: (opts) => call("net.listen", { port: (opts && opts.port) || 0 }),
        fetch: (request) => call("net.fetch", request),
        write: (handle, text) => call("net.write", { handle, text }),
        close: (handle) => call("net.close", { handle }),
      },
      db: {
        openNamespace: (namespace) => call("db.open", { namespace }),
        query: (db, sql, params) => call("db.query", { db, sql, params: params || [] }),
        exec: (db, sql, params) => call("db.exec", { db, sql, params: params || [] }),
        transaction: (db, statements) => call("db.transaction", { db, statements }),
      },
      streams: {
        listen,
        subscribe: subscribeIter,
        unsubscribe: (subId) => { streamSubs.delete(subId); return call("streams.unsubscribe", { subId }); },
      },
      resources: {
        retainForWorkspace: (handle, stableKey) => call("resources.retain", { handle, stableKey }),
        lookup: (stableKey) => call("resources.lookup", { stableKey }),
        info: (handle) => call("resources.info", { handle }),
        release: (handle) => call("resources.release", { handle }),
      },
      modules: {
        list: () => call("modules.list", {}),
        describe: (id) => call("modules.describe", { id }),
        logs: (id, limit) => call("modules.logs", { id, limit }),
        stageArtifact: (id, code, opts) => call("modules.stage", Object.assign({ id, code }, opts || {})),
        activate: (id, stageId, opts) => call("modules.activate", Object.assign({ id, stageId }, opts || {})),
        rollback: (id, opts) => call("modules.rollback", Object.assign({ id }, opts || {})),
        discard: (stageId) => call("modules.discard", { stageId }),
        sourceInfo: () => call("modules.sourceInfo", {}),
      },
      daemon: {
        ensure: (target) => call("daemon.ensure", { target: target || { kind: "local" } }),
        status: (target) => call("daemon.status", { target: target || { kind: "local" } }),
        request: (target, op, args) => call("daemon.request", { target: target || { kind: "local" }, op, args: args || {} }),
      },
      plugins: {
        list: () => call("plugins.list", {}),
        providers: (contract) => call("plugins.providers", { contract }),
        dependents: (id) => call("plugins.dependents", { id }),
        enable: (id) => call("plugins.enable", { id }),
        disable: (id, opts) => call("plugins.disable", Object.assign({ id }, opts || {})),
        setRoot: (id) => call("plugins.setRoot", { id: id || null }),
        install: (path) => call("plugins.install", { path }),
        uninstall: (id) => call("plugins.uninstall", { id }),
        rescan: () => call("plugins.rescan", {}),
      },
      approvals: {
        request: (req) => call("approvals.request", req),
      },
      ui: {
        invalidate: (moduleId) => sync("ui.invalidate", { moduleId }),
        documentOpen: (workspaceKey, text, language, opts) => call("ui.documentOpen", Object.assign({ workspaceKey, text, language }, opts || {})),
        pickFolder: () => call("ui.pickFolder", {}),
        openUrl: (url) => call("ui.openUrl", { url }),
        toast: (level, text) => sync("ui.toast", { level, text }),
      },
    },
    modules: {
      call: (id, method, args, opts) => call("modules.call", { target: id, method, args: args === undefined ? null : args, timeoutMs: (opts && opts.timeoutMs) || 30000 }),
    },
    events: {
      emit: (topic, payload) => sync("events.emit", { topic, payload: payload === undefined ? null : payload }),
      on(topic, listener) {
        let set = topicListeners.get(topic);
        if (!set) { set = new Set(); topicListeners.set(topic, set); }
        set.add(listener);
        if (!ownTopicSubs.has(topic)) { ownTopicSubs.add(topic); sync("events.subscribe", { topic }); }
        return () => {
          set.delete(listener);
          if (set.size === 0) { topicListeners.delete(topic); ownTopicSubs.delete(topic); try { sync("events.unsubscribe", { topic }); } catch (_) {} }
        };
      },
    },
    state: {
      get: (key) => { const v = sync("state.get", { key }); return v === null ? undefined : v; },
      set: (key, value) => sync("state.set", { key, value: value === undefined ? null : value }),
      watch(key, listener) {
        let set = stateWatchers.get(key);
        if (!set) { set = new Set(); stateWatchers.set(key, set); sync("state.watch", { key }); }
        set.add(listener);
        return () => { set.delete(listener); };
      },
    },
    ui: { invalidate: () => sync("ui.invalidate", {}) },
    log: G.console,
  };
  Object.freeze(ctx.host);

  // Headless integration-test driver only (the kernel rejects test.* ops from any other module).
  if (META.moduleId === "__driver") G.__testOp = (op, args) => call(op, args);

  let mod = null;
  G.__hato_setModule = function (m) {
    if (!m || typeof m !== "object") throw new Error("module artifact must default-export an AppModule object");
    if (m.moduleApiVersion !== 1) throw new Error("module must declare moduleApiVersion: 1");
    if (m.id !== META.moduleId) throw new Error("module id mismatch: artifact exports '" + m.id + "' but is installed as '" + META.moduleId + "'");
    mod = m;
    return JSON.stringify({
      methods: Object.keys(m.methods || {}),
      render: typeof m.render === "function",
      onEvent: typeof m.onEvent === "function",
      snapshot: typeof m.snapshot === "function",
      canSwap: typeof m.canSwap === "function",
    });
  };

  function errJson(e) {
    return JSON.stringify({ message: (e && e.message) || String(e), code: (e && e.code) || "EMODULE", stack: (e && e.stack) || "" });
  }
  function ok(req, v) { hostReply(req, true, JSON.stringify(v === undefined ? null : v)); }
  function fail(req, e) { hostReply(req, false, errJson(e)); }

  async function invoke(msg) {
    const req = msg.req;
    try {
      switch (msg.kind) {
        case "activate": ok(req, mod.activate ? await mod.activate(ctx, msg.prev === null ? undefined : msg.prev) : null); break;
        case "deactivate":
          try { if (mod.deactivate) await mod.deactivate(ctx); } finally {
            for (const id of timers.keys()) hostTimerClear(id);
            timers.clear(); topicListeners.clear(); stateWatchers.clear(); streamSubs.clear();
          }
          ok(req, null); break;
        case "snapshot": ok(req, mod.snapshot ? await mod.snapshot(ctx) : null); break;
        case "canSwap": ok(req, mod.canSwap ? await mod.canSwap(ctx) : { ok: true }); break;
        case "render": {
          if (!mod.render) throw new Error("module has no render()");
          ok(req, await mod.render(ctx));
          break;
        }
        case "event": {
          if (!mod.onEvent) throw new Error("module has no onEvent()");
          ok(req, await mod.onEvent(ctx, msg.event));
          break;
        }
        case "call": {
          const fn = mod.methods && Object.prototype.hasOwnProperty.call(mod.methods, msg.method) ? mod.methods[msg.method] : null;
          if (typeof fn !== "function") { const e = new Error("module '" + META.moduleId + "' has no method '" + msg.method + "'"); e.code = "ENOMETHOD"; throw e; }
          ok(req, await fn(ctx, msg.args === null ? undefined : msg.args, { caller: msg.caller }));
          break;
        }
        default: throw new Error("unknown invocation kind " + msg.kind);
      }
    } catch (e) {
      fail(req, e);
    }
  }

  G.__hato_dispatch = function (json) {
    const msg = JSON.parse(json);
    switch (msg.t) {
      case "invoke": invoke(msg); break;
      case "op": {
        const p = pendingCalls.get(msg.id);
        if (p) { pendingCalls.delete(msg.id); msg.ok ? p.resolve(msg.value) : p.reject(makeError(msg.error)); }
        break;
      }
      case "event": {
        const set = topicListeners.get(msg.topic);
        if (set) for (const fn of Array.from(set)) { try { const r = fn(msg.payload); if (r && r.catch) r.catch((e) => G.console.error("event listener failed", msg.topic, e)); } catch (e) { G.console.error("event listener failed", msg.topic, e); } }
        break;
      }
      case "state": {
        const set = stateWatchers.get(msg.key);
        if (set) for (const fn of Array.from(set)) { try { fn(msg.value); } catch (e) { G.console.error("state watcher failed", e); } }
        break;
      }
      case "timer": {
        const t = timers.get(msg.id);
        if (!t) break;
        if (t.interval === null) timers.delete(msg.id); else hostTimer(msg.id, t.interval);
        try { const r = t.fn(...t.args); if (r && r.catch) r.catch((e) => G.console.error("timer callback failed", e)); } catch (e) { G.console.error("timer callback failed", e); }
        break;
      }
    }
  };

  G.__hato_stream = function (subId, data, eof, nbytes, error) {
    const s = streamSubs.get(subId);
    if (!s) return;
    try {
      if (data !== null && data !== undefined && s.onData) {
        const r = s.onData(data);
        if (r && r.catch) r.catch((e) => G.console.error("stream listener failed", e));
      }
    } catch (e) { G.console.error("stream listener failed", e); }
    if (nbytes > 0) { try { sync("streams.ack", { subId, bytes: nbytes }); } catch (_) {} }
    if (eof) {
      streamSubs.delete(subId);
      try { if (s.onEnd) s.onEnd(error ? makeError({ message: error, code: "ESTREAM" }) : null); } catch (e) { G.console.error("stream end listener failed", e); }
    }
  };
})();
