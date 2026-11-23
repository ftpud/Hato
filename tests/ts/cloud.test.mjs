import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
async function bundled(relative) {
  const { outputFiles } = await build({
    absWorkingDir: root, entryPoints: [relative], alias: { "@hato/sdk": root + "/sdk" },
    bundle: true, write: false, format: "esm", platform: "neutral",
  });
  return import("data:text/javascript;base64," + Buffer.from(outputFiles[0].text).toString("base64"));
}
const path = "Hato-plugins/modules/services/cloud/src/";
const protocol = await bundled(path + "protocol.ts");
const runtime = await bundled("sdk/runtime.ts");
const flush = () => new Promise(resolve => setImmediate(resolve));

test("Cloud server origins, return paths and HTTP errors are mapped safely", () => {
  assert.equal(protocol.serverOrigin(" HTTPS://Cloud-Dev.HatoPad.Dev:443/ "), "https://cloud-dev.hatopad.dev");
  assert.equal(protocol.serverOrigin("http://localhost:3000"), "http://127.0.0.1:3000");
  assert.equal(protocol.serverOrigin("http://[::1]:3000"), "http://[::1]:3000");
  for (const value of ["http://other.test", "https://user@localhost", "https://x.test/api", "https://x.test?", "https://x.test:99999"]) {
    assert.throws(() => protocol.serverOrigin(value));
  }
  assert.throws(() => protocol.webPath("//other.test"));
  assert.throws(() => protocol.webPath("/\\other.test"));
  assert.equal(protocol.webPath("/enrol?code=ABCD"), "/enrol?code=ABCD");
  assert.throws(() => protocol.jsonResponse({ status: 401, body: "" }), error => error.status === 401 && /expired/.test(error.message));
  assert.throws(() => protocol.jsonResponse({ status: 404, body: '{"error":{"code":"not_found","message":"Host missing"}}' }),
    error => error.code === "not_found" && error.message === "Host missing");
  assert.throws(() => protocol.jsonResponse({ status: 200, body: "<html>" }), /invalid response/);
});

test("Cloud workspace routing has no local or SSH fallback", async () => {
  const descriptor = { location: "cloud", cloudHostId: "host", machineId: "cloud:machine", rootAbsolutePath: "/srv/project" };
  const calls = [];
  const ctx = { modules: { async call(...args) { calls.push(args); throw new Error("Host offline"); } } };
  await assert.rejects(runtime.daemonTargetFor(ctx, descriptor), /Host offline/);
  assert.deepEqual(calls[0].slice(0, 3), ["cloud", "target", { hostId: "host", machineId: "cloud:machine" }]);
  await assert.rejects(runtime.targetFor(ctx, descriptor), /Host offline/);
  await assert.rejects(runtime.daemonTargetFor(ctx, { ...descriptor, cloudHostId: undefined }), /missing its host/);
  assert.deepEqual(await runtime.daemonTargetFor(ctx, { location: "local" }), { kind: "local" });
  assert.equal(calls.length, 2);
  const target = { kind: "cloud", connection: "scoped-handle" };
  assert.deepEqual(await runtime.targetFor({ modules: { call: async () => target } }, descriptor), target);
  const invalid = { modules: { call: async () => ({ kind: "local" }) } };
  await assert.rejects(runtime.daemonTargetFor(invalid, descriptor), /Invalid Cloud daemon route/);
});

test("Cloud sign-in handles invalid callbacks, cancellation and successful PKCE exchange", async () => {
  const { default: mod } = await bundled(path + "index.ts");
  const { methods } = mod;
  const listeners = new Map();
  const browser = [];
  const released = [];
  const exchanges = [];
  const events = [];
  const state = "t".repeat(64);
  const code = "f".repeat(43);
  const response = (body, status = 200) => ({ status, body: JSON.stringify(body) });
  const ctx = {
    modules: { call: async () => null },
    events: { emit: (...args) => events.push(args) },
    host: {
      env: { info: () => ({ platform: "macos" }) },
      ui: { openUrl: async url => { browser.push(url); } },
      net: {
        listenLoopback: async () => ({ handle: "listener", port: 1234 }),
        close: async handle => released.push(handle),
        write: async () => {},
      },
      streams: {
        listen: async (handle, _options, fn) => {
          listeners.set(handle, fn);
          return { close: async () => listeners.delete(handle) };
        },
      },
      resources: { release: async handle => released.push(handle) },
      cloud: {
        begin: async () => ({ state, verifier: "verifier", challenge: "challenge", publicKey: "key" }),
        exchange: async (server, body) => {
          exchanges.push({ server, body });
          return response({ user: { name: "Alice", email: "a@example.test" }, device: { name: "Mac", fingerprint: "abc" } });
        },
        request: async (_server, route) => {
          if (route === "/api/me") throw Object.assign(new Error("Signed out"), { code: "ECLOUD_AUTH" });
          return response(route.endsWith("hosts") ? { hosts: [] } : { projects: [] });
        },
        device: async () => null,
        events: async () => ({ handle: "events" }),
        clear: async () => {},
      },
    },
  };
  await mod.activate(ctx, null);
  try {
    await flush();
    methods.signIn(ctx);
    assert.equal(methods.status().signingIn, true);
    await flush();
    assert.match(browser[0], /auth\/desktop\?/);
    assert.match(browser[0], /code_challenge=challenge/);
    methods.cancelSignIn(ctx);
    await flush();
    assert.equal(methods.status().signingIn, false);
    assert.deepEqual(exchanges, []);
    assert(released.includes("listener"));

    methods.signIn(ctx);
    await flush();
    listeners.get("listener")('{"connection":"bad"}\n');
    await flush();
    listeners.get("bad")(`GET /callback?state=invalid&code=${code} HTTP/1.1\r\n\r\n`);
    await flush();
    assert.deepEqual(exchanges, []);
    listeners.get("listener")('{"connection":"good"}\n');
    await flush();
    listeners.get("good")(`GET /callback?state=${state}&code=${code} HTTP/1.1\r\n\r\n`);
    for (let i = 0; i < 20 && methods.status().signingIn; i++) await flush();
    assert.equal(methods.status().signedIn, true, JSON.stringify(methods.status()));
    assert.equal(methods.status().device.name, "Mac");
    assert.equal(methods.status().signingIn, false);
    assert.deepEqual(exchanges[0].body, { code, verifier: "verifier", redirect_uri: "http://127.0.0.1:1234/callback" });
    assert(events.every(([event]) => event === "cloud.changed"));
    await methods.signOut(ctx);
    assert.equal(methods.status().signedIn, false);
  } finally { await mod.deactivate(ctx); }
});
