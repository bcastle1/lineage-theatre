import test from "node:test";
import assert from "node:assert/strict";
import { createMagicLightLiveTestService, MAGICLIGHT_LIVE_TEST_PATH as PATH, MAGICLIGHT_LIVE_TEST_FIXTURE as FIXTURE } from "../api/_lib/magiclight-live-test.mjs";
import { createMagicLightClient } from "../api/_lib/magiclight-client.mjs";
import { userPath, digest } from "../api/_lib/auth.mjs";
import { OWNER_EMAIL } from "../api/_lib/access.mjs";

const OWNER = { email: OWNER_EMAIL, role: "owner", status: "active" };
const KEY = "fictional-key-never-public-123";
const TASK = "private-provider-task-123";
const VIDEO = "https://cdn.example.com/secret-output.mp4?signature=private-output-signature";
const NOW = Date.parse("2026-09-24T12:00:00Z");
const clone = value => structuredClone(value);
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function fixture(options = {}) {
  let version = 0;
  const records = new Map([[userPath(OWNER.email), { value: clone(OWNER), etag: "owner-1" }]]);
  const env = { MAGICLIGHT_API_KEY: KEY }, submissions = [], checks = [], configurations = [];
  const read = async path => { await options.beforeRead?.(path); return records.has(path) ? clone(records.get(path)) : null; };
  const write = async (path, value, etag) => {
    await options.beforeWrite?.(path, value);
    const old = records.get(path);
    if (old ? old.etag !== etag : Boolean(etag)) throw new Error("precondition failed");
    const next = { value: clone(value), etag: `record-${++version}` }; records.set(path, next);
    await options.afterWrite?.(path, value);
    return clone(next);
  };
  const deps = { read, write, env, now: () => NOW,
    clientFactory: config => {
      configurations.push(config);
      return { submitTask: async input => { submissions.push(clone(input)); return options.submit ? options.submit(input) : { providerCode: 10000, taskId: TASK }; },
        checkTask: async input => { checks.push(clone(input)); return options.check ? options.check(input) : { providerCode: 10000, taskStatus: 2, taskId: TASK, videoUrl: VIDEO }; } };
    }, ...options.overrides };
  const service = createMagicLightLiveTestService(deps);
  return { service, env, records, submissions, checks, configurations, deps,
    peer: () => createMagicLightLiveTestService(deps),
    submit: () => service.submit(OWNER, { consent: true }), check: () => service.check(OWNER), status: () => service.status(OWNER),
    stored: () => clone(records.get(PATH)?.value), revoke: () => records.set(userPath(OWNER.email), { value: { ...OWNER, status: "suspended" }, etag: "revoked" }) };
}

test("one fixed live fixture persists a task then polls it without touching customer records or exposing provider secrets", async () => {
  const h = fixture();
  const initial = await h.status(); assert.equal(initial.test, null); assert.equal(initial.configured, true);
  const submitted = await h.submit(); assert.equal(submitted.test.status, "submitted"); assert.equal(submitted.test.submissionCount, 1);
  assert.deepEqual(h.submissions, [{ text: FIXTURE.prompt, imageUrl: FIXTURE.imageUrl }]);
  assert.equal(h.stored().taskId, TASK); assert.equal(h.stored().keyFingerprint, digest(KEY));
  const complete = await h.check(); assert.equal(complete.test.status, "completed"); assert.equal(complete.test.outputOrigin, "https://cdn.example.com");
  assert.deepEqual(h.checks, [{ taskId: TASK }]); assert.equal(h.stored().videoUrl, VIDEO);
  for (const result of [initial, submitted, complete]) {
    assert.equal(result.productionReady, false); assert.equal(result.customerFulfillment, false);
    assert.equal(result.fixture.costVerified, false); assert.equal(result.fixture.durationVerified, false);
    assert.doesNotMatch(JSON.stringify(result), /fictional-key|private-provider-task|private-output-signature|secret-output/);
  }
  assert.deepEqual([...h.records.keys()].sort(), [PATH, userPath(OWNER.email)].sort());
  assert.equal(h.configurations[0].enableSubmission, true); assert.equal(h.configurations[1].enableSubmission, false);
  assert.equal(h.configurations.every(c => c.environment === "production" && c.requestTimeoutMs === 15_000), true);
});

test("concurrent processes, repeated clicks, reloads and key rotation never submit a second task", async () => {
  const h = fixture();
  await Promise.allSettled([h.submit(), h.peer().submit(OWNER, { consent: true }), h.peer().submit(OWNER, { consent: true })]);
  await h.peer().submit(OWNER, { consent: true }); await h.submit();
  assert.equal(h.submissions.length, 1);
  h.env.MAGICLIGHT_API_KEY = "changed-key";
  assert.equal((await h.peer().submit(OWNER, { consent: true })).test.id, h.stored().id);
  await assert.rejects(h.check(), e => e.code === "MAGICLIGHT_TEST_BINDING_CHANGED");
  assert.equal(h.checks.length, 0); assert.equal(h.submissions.length, 1);
});

test("explicit consent and fixed input reject browser credentials, prompt, task ID, URLs or new identity", async () => {
  for (const body of [undefined, null, [], {}, { consent: false }, ...["prompt", "imageUrl", "apiKey", "taskId", "idempotencyKey", "environment"].map(key => ({ consent: true, [key]: "untrusted" }))]) {
    const h = fixture(); await assert.rejects(h.service.submit(OWNER, body), e => e.status === 400);
    assert.equal(h.records.has(PATH), false); assert.equal(h.submissions.length, 0);
  }
});

test("only the persisted active owner can submit, inspect or poll; legacy owners remain valid", async () => {
  const actors = [null, { email: OWNER_EMAIL }, { ...OWNER, role: "admin" }, { ...OWNER, status: "suspended" }, { ...OWNER, mustChangePassword: true }, { ...OWNER, email: "someone@example.com" }];
  for (const actor of actors) {
    const h = fixture();
    for (const operation of [() => h.service.status(actor), () => h.service.submit(actor, { consent: true }), () => h.service.check(actor)]) await assert.rejects(operation, e => e.status === 403);
    assert.equal(h.configurations.length, 0);
  }
  for (const current of [null, { ...OWNER, role: "admin" }, { ...OWNER, status: "suspended" }, { ...OWNER, mustChangePassword: true }]) {
    const h = fixture(); h.records.set(userPath(OWNER.email), { value: current, etag: "changed" });
    await assert.rejects(h.submit(), e => e.status === 403); assert.equal(h.submissions.length, 0);
  }
  const legacy = fixture(); legacy.records.set(userPath(OWNER.email), { value: { email: OWNER_EMAIL, role: "owner" }, etag: "legacy" });
  assert.equal((await legacy.service.submit({ email: OWNER_EMAIL, role: "owner" }, { consent: true })).test.status, "submitted");
});

test("missing or malformed protected keys make no claim and no provider call", async () => {
  for (const key of [undefined, "", "contains whitespace", "a".repeat(4097)]) {
    const h = fixture(); h.env.MAGICLIGHT_API_KEY = key;
    assert.equal((await h.status()).configured, false);
    await assert.rejects(h.submit(), e => e.code === "MAGICLIGHT_TEST_KEY_REQUIRED");
    assert.equal(h.records.has(PATH), false); assert.equal(h.submissions.length, 0);
  }
});

test("durable claim precedes provider dispatch and a lost committed write response is recovered", async () => {
  let h; h = fixture({ afterWrite: async () => { throw new Error("private write reply lost"); }, submit: async () => {
    assert.equal(h.stored().status, "submitting"); assert.equal(h.stored().submissionCount, 1);
    return { providerCode: 10000, taskId: TASK };
  } });
  assert.equal((await h.submit()).test.status, "submitted"); await h.peer().submit(OWNER, { consent: true });
  assert.equal(h.submissions.length, 1);
  const denied = fixture({ beforeWrite: async () => { throw new Error("private store down"); } });
  await assert.rejects(denied.submit(), e => e.code === "MAGICLIGHT_TEST_CONFLICT" && !e.message.includes("private"));
  assert.equal(denied.submissions.length, 0);
});

test("unconfirmed readback or a modified claim prevents dispatch", async () => {
  let h; h = fixture({ afterWrite: async (path, value) => {
    if (value.status === "submitting") h.records.get(path).value.submissionCount = 2;
  } });
  await assert.rejects(h.submit(), e => e.code === "MAGICLIGHT_TEST_CONFLICT"); assert.equal(h.submissions.length, 0);
});

test("an accepted task is not resubmitted if final persistence fails", async () => {
  const h = fixture({ beforeWrite: async (path, value) => { if (value.status === "submitted") throw new Error("save failed after acceptance"); } });
  await assert.rejects(h.submit()); assert.equal(h.stored().status, "submitting");
  const recovered = await h.peer().submit(OWNER, { consent: true }); assert.equal(recovered.test.status, "submitting");
  await h.peer().check(OWNER); assert.equal(h.checks.length, 0); assert.equal(h.submissions.length, 1);
});

test("transient accepted-task persistence retries only storage with identical CAS identity", async () => {
  const writes = [];
  const h = fixture({ beforeWrite: async (path, value) => {
    if (value.status === "submitted") { writes.push(clone(value)); if (writes.length === 1) throw new Error("temporary uncommitted write"); }
  } });
  const result = await h.submit(); assert.equal(result.test.status, "submitted");
  assert.equal(h.submissions.length, 1); assert.equal(writes.length, 2); assert.deepEqual(writes[0], writes[1]);
  assert.equal(h.stored().taskId, TASK);
  await h.peer().check(OWNER); assert.deepEqual(h.checks, [{ taskId: TASK }]);
});

test("accepted-task storage retries cannot overwrite a concurrent changed claim", async () => {
  let h, writes = 0;
  h = fixture({ beforeWrite: async (path, value) => {
    if (value.status === "submitted") {
      writes++;
      h.records.set(PATH, { value: { ...h.stored(), status: "uncertain", changeId: "00000000-0000-4000-8000-000000000099" }, etag: "concurrent" });
      throw new Error("lost race");
    }
  } });
  await assert.rejects(h.submit(), e => e.code === "MAGICLIGHT_TEST_CONFLICT");
  assert.equal(writes, 1); assert.equal(h.stored().status, "uncertain");
  await h.submit(); assert.equal(h.submissions.length, 1);
});

test("uncertain, rejected and malformed submission replies consume the one attempt and redact errors", async () => {
  for (const submit of [async () => { throw Object.assign(new Error(`${KEY} raw provider body`), { code: "MAGICLIGHT_HTTP_REJECTED", httpStatus: 500 }); },
    async () => ({ providerCode: 90000 }), async () => ({ providerCode: 10000, taskId: "bad/path" }),
    async () => ({ providerCode: 10000, taskId: KEY }), async () => { throw Object.assign(new Error(KEY), { code: KEY }); }]) {
    const h = fixture({ submit }); const result = await h.submit(); assert.equal(result.test.status, "uncertain");
    await h.peer().submit(OWNER, { consent: true }); await h.peer().check(OWNER);
    assert.equal(h.submissions.length, 1); assert.equal(h.checks.length, 0);
    assert.doesNotMatch(JSON.stringify([result, h.stored()]), /fictional-key|raw provider body/);
  }
});

test("owner revocation and key changes during claim confirmation stop generation", async () => {
  for (const change of [h => h.revoke(), h => { h.env.MAGICLIGHT_API_KEY = "replacement-key"; }]) {
    let h; h = fixture({ afterWrite: async (path, value) => { if (value.status === "submitting") change(h); } });
    await assert.rejects(h.submit()); assert.equal(h.submissions.length, 0); assert.equal(h.stored().status, "submitting");
  }
});

test("revocation during provider submission retains the accepted task privately but prevents disclosure", async () => {
  let h; h = fixture({ submit: async () => { h.revoke(); return { providerCode: 10000, taskId: TASK }; } });
  await assert.rejects(h.submit(), e => e.status === 403);
  assert.equal(h.stored().taskId, TASK); assert.equal(h.stored().status, "submitted");
  await assert.rejects(h.status(), e => e.status === 403); assert.equal(h.submissions.length, 1);
});

test("polling restart uses the exact saved task and keeps unknown business/status evidence unconfirmed", async () => {
  let response = { providerCode: 81234 };
  const h = fixture({ check: async () => response }); await h.submit();
  const unknownCode = await h.peer().check(OWNER); assert.equal(unknownCode.test.status, "submitted"); assert.equal(unknownCode.test.providerCode, 81234);
  response = { providerCode: 10000, taskStatus: 77 };
  const unknownStatus = await h.check(); assert.equal(unknownStatus.test.status, "submitted"); assert.equal(unknownStatus.test.taskStatus, 77);
  response = { providerCode: 10000, taskStatus: 3 };
  assert.equal((await h.check()).test.status, "failed");
  await h.check(); await h.submit(); assert.equal(h.checks.length, 3); assert.equal(h.submissions.length, 1);
  assert.equal(h.checks.every(x => x.taskId === TASK), true);
});

test("stale in-flight polls cannot overwrite a completed response", async () => {
  const firstStarted = deferred(), release = deferred(); let calls = 0;
  const h = fixture({ check: async () => { if (++calls === 1) { firstStarted.resolve(); await release.promise; return { providerCode: 10000, taskStatus: 1 }; }
    return { providerCode: 10000, taskStatus: 2, videoUrl: VIDEO }; } });
  await h.submit(); const stale = h.check(); await firstStarted.promise;
  assert.equal((await h.peer().check(OWNER)).test.status, "completed"); release.resolve();
  await assert.rejects(stale, e => e.code === "MAGICLIGHT_TEST_CONFLICT"); assert.equal((await h.status()).test.status, "completed");
});

test("revocation or key rotation while polling prevents saving its response", async () => {
  for (const change of [h => h.revoke(), h => { h.env.MAGICLIGHT_API_KEY = "changed-key"; }]) {
    let h; h = fixture({ check: async () => { change(h); return { providerCode: 10000, taskStatus: 2, videoUrl: VIDEO }; } });
    await h.submit(); await assert.rejects(h.check()); assert.equal(h.stored().status, "submitted");
  }
});

test("malformed statuses and unsafe output URLs never become completed or escape through diagnostics", async () => {
  const values = ["http://cdn.example.com/a.mp4", "https://user:pass@cdn.example.com/a.mp4", "https://127.0.0.1/a.mp4", "https://localhost/a.mp4",
    "https://cdn.example.com:8443/a.mp4", "https://cdn.example.com/a.mp4#fragment", `https://cdn.example.com/${KEY}`, `https://${KEY}.example.com/a.mp4`];
  for (const response of [...values.map(videoUrl => ({ providerCode: 10000, taskStatus: 2, videoUrl })),
    { providerCode: 10000, taskStatus: 2 }, { providerCode: 10000, taskStatus: "2" }, { providerCode: 10000, taskStatus: 2, taskId: "another-task", videoUrl: VIDEO }]) {
    const h = fixture({ check: async () => response }); await h.submit();
    const result = await h.check(); assert.equal(result.test.status, "submitted"); assert.equal(result.test.code, "MAGICLIGHT_INVALID_RESPONSE");
    assert.equal(result.test.outputOrigin, undefined); assert.equal(h.stored().videoUrl, undefined);
    assert.doesNotMatch(JSON.stringify(result), /fictional-key|user:pass|another-task/);
  }
});

test("altered persisted fixture, owner, origin and submission count cannot authorize polling or another POST", async () => {
  for (const patch of [{ fixtureHash: "f".repeat(64) }, { ownerEmail: "another@example.com" }, { origin: "https://other.example.com" }, { submissionCount: 2 }]) {
    const h = fixture(); await h.submit(); Object.assign(h.records.get(PATH).value, patch);
    await assert.rejects(h.check(), e => e.code === "MAGICLIGHT_TEST_BINDING_CHANGED");
    await assert.rejects(h.submit(), e => e.code === "MAGICLIGHT_TEST_BINDING_CHANGED");
    assert.equal(h.checks.length, 0); assert.equal(h.submissions.length, 1);
  }
});

test("malformed saved records are never treated as permission to create a replacement", async () => {
  for (const value of [null, {}, "corrupt"]) {
    const h = fixture(); h.records.set(PATH, { value, etag: "existing" });
    await assert.rejects(h.submit(), e => e.code === "MAGICLIGHT_TEST_BINDING_CHANGED");
    await assert.rejects(h.check(), e => e.code === "MAGICLIGHT_TEST_BINDING_CHANGED");
    assert.equal(h.submissions.length, 0); assert.equal(h.checks.length, 0);
  }
});

test("HTTP diagnostics retain only valid numeric statuses and clear stale failure evidence after recovery", async () => {
  for (const status of [401, 500, 501, 99, 600, "500", KEY]) {
    const h = fixture({ submit: async () => { throw Object.assign(new Error(KEY), { code: "MAGICLIGHT_HTTP_REJECTED", httpStatus: status }); } });
    const result = await h.submit();
    assert.equal(result.test.httpStatus, typeof status === "number" && status >= 100 && status <= 599 ? status : undefined);
    assert.doesNotMatch(JSON.stringify(result), /fictional-key/);
  }
  let error = true;
  const h = fixture({ check: async () => { if (error) throw Object.assign(new Error(KEY), { code: "MAGICLIGHT_HTTP_REJECTED", httpStatus: 500 });
    return { providerCode: 10000, taskStatus: 2, videoUrl: VIDEO }; } });
  await h.submit(); assert.equal((await h.check()).test.httpStatus, 500);
  error = false;
  const recovered = await h.check(); assert.equal(recovered.test.status, "completed");
  assert.equal(recovered.test.httpStatus, undefined); assert.equal(recovered.test.code, undefined);
});

test("real protocol client composition sends one authenticated POST and GET, never downloads the returned media", async () => {
  const calls = [];
  const h = fixture({ overrides: { clientFactory: config => createMagicLightClient({ ...config, fetchImpl: async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify({ biz_code: 10000, data: options.method === "POST" ? { task_id: TASK } : { task_id: TASK, task_status: 2, video_url: VIDEO } }), { headers: { "content-type": "application/json" } });
  } }) } });
  await h.submit(); await h.check(); await h.peer().submit(OWNER, { consent: true });
  assert.deepEqual(calls.map(x => x.options.method), ["POST", "GET"]);
  assert.equal(calls.every(x => x.url.startsWith("https://open.magiclight.ai/api/misc/") && x.options.headers.Authorization === `Bearer ${KEY}` && x.options.redirect === "error"), true);
  assert.equal(calls.some(x => x.url.includes("cdn.example.com")), false);
});
