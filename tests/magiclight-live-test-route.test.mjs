import test from "node:test";
import assert from "node:assert/strict";
import { createAdminHandler } from "../api/admin.mjs";
import { OWNER_EMAIL } from "../api/_lib/access.mjs";

const owner = { email: OWNER_EMAIL, role: "owner", status: "active" };
function fixture(actor = owner, limit = true) {
  const calls = [], events = [];
  const result = { productionReady: false, customerFulfillment: false, test: { status: "submitted", submissionCount: 1 } };
  const handler = createAdminHandler({ getSession: async () => actor ? { user: actor } : null,
    limitAction: async () => limit, audit: async (...event) => events.push(event),
    magiclightLiveTest: Object.fromEntries(["status", "submit", "check"].map(method => [method, async (...args) => { calls.push({ method, args }); return result; }])) });
  return { calls, events, async run({ action = "submitMagicLightLiveTest", method = "POST", fields = { consent: true }, origin = "https://lineagetheater.com" } = {}) {
    let status, body; const headers = {};
    await handler({ method, url: `/api/admin?action=${action}`, headers: { host: "lineagetheater.com", origin },
      ...(method === "POST" ? { body: { action, ...fields } } : {}) }, {
      set statusCode(value) { status = value; }, setHeader(name, value) { headers[name] = value; }, end(value) { body = JSON.parse(value); },
    });
    return { status, body, headers };
  } };
}

test("retired MagicLight submission never dispatches a paid request",async()=>{
 for(const actor of [null,owner,{email:"customer@example.invalid",role:"customer"}]){
  const h=fixture(actor);assert.equal((await h.run()).status,410);assert.equal(h.calls.length,0);
 }
 assert.equal((await fixture().run({origin:"https://elsewhere.invalid"})).status,403);
});

test("saved live-test reads and checks cannot submit another task", async () => {
  const h = fixture();
  assert.equal((await h.run({ method: "GET", action: "magicLightLiveTest" })).status, 200);
  assert.equal((await h.run({ action: "checkMagicLightLiveTest", fields: {} })).status, 200);
  assert.deepEqual(h.calls.map(call => call.method), ["status", "check"]);
  assert.equal((await h.run({ method: "GET", action: "submitMagicLightLiveTest" })).status, 410);
  assert.equal((await h.run({ action: "checkMagicLightLiveTest", fields: { taskId: "another" } })).status, 400);
  assert.equal(h.calls.length, 2);
  const limited = fixture(owner, false);
  assert.equal((await limited.run()).status, 410);
  assert.equal(limited.calls.length, 0);
});

test("test media routes are owner-only, accept no caller media input and retain write guards", async () => {
  const calls = [];
  async function request({ actor = owner, method = "POST", action = "importMagicLightLiveTestMedia", fields = {}, query = "", origin = "https://lineagetheater.com", limit = true } = {}) {
    const handler = createAdminHandler({ getSession: async () => actor ? { user: actor } : null,
      limitAction: async () => limit, audit: async () => {}, magiclightTestMedia: {
        state: async actor => { calls.push(["state", actor.email]); return { media: { ready: false } }; },
        importClip: async actor => { calls.push(["import", actor.email]); return { media: { ready: true } }; },
        stream: async ({ actor, req, res, download }) => { calls.push(["stream", actor.email, req.method, download]); res.statusCode = 200; res.end(); },
      } });
    const res = { statusCode: 0, setHeader() {}, end() {} };
    await handler({ method, url: `/api/admin?action=${action}${query}`, headers: { host: "lineagetheater.com", origin },
      ...(method === "POST" ? { body: { action, ...fields } } : {}) }, res);
    return res.statusCode;
  }
  for (const actor of [null, { ...owner, role: "admin" }, { ...owner, role: "customer" }, { ...owner, status: "suspended" }, { ...owner, mustChangePassword: true }]) {
    assert.ok([401, 403].includes(await request({ actor })));
    assert.ok([401, 403].includes(await request({ actor, method: "GET", action: "magicLightLiveTestMedia" })));
  }
  assert.equal(await request({ origin: "https://elsewhere.invalid" }), 403);
  assert.equal(await request({ limit: false }), 429);
  for (const key of ["url", "taskId", "pathname", "testId", "apiKey"]) {
    assert.equal(await request({ fields: { [key]: "untrusted" } }), 400);
    assert.equal(await request({ method: "GET", action: "magicLightLiveTestMedia", query: `&${key}=untrusted` }), 400);
  }
  assert.equal(calls.length, 0);
  assert.equal(await request(), 200);
  assert.equal(await request({ method: "GET", action: "magicLightLiveTestMedia" }), 200);
  assert.equal(await request({ method: "HEAD", action: "magicLightLiveTestMedia", query: "&download=1" }), 200);
  assert.equal(await request({ method: "GET", action: "magicLightLiveTest" }), 200);
  assert.deepEqual(calls.map(call => call[0]), ["import", "stream", "stream", "state"]);
  assert.deepEqual(calls[2], ["stream", owner.email, "HEAD", true]);
});
