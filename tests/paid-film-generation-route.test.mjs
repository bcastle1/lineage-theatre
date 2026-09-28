import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createStudioHandler } from "../api/studio.mjs";
import { createFilmGenerationHandler } from "../api/film-generation.mjs";
import { OWNER_EMAIL } from "../api/_lib/access.mjs";
import { PaidFilmGenerationError } from "../api/_lib/paid-film-generation.mjs";

const OWNER = { email: OWNER_EMAIL, role: "owner", status: "active" };
const CUSTOMER = { email: "customer@example.invalid", role: "customer", status: "active",
  approvedAt: "2026-09-01T00:00:00Z", approvedBy: OWNER_EMAIL };
const PREPARED = "00000000-0000-4000-8000-000000000001";
const ORDER = "a".repeat(64);
const SECRET = "synthetic-generation-cron-secret-0001";
const START = { action: "requestFilmGeneration", preparedId: PREPARED, orderId: ORDER, consent: true };
const CHECK = { action: "checkFilmGeneration", preparedId: PREPARED };
const REPLACE = { ...START, action: "replaceFilmGeneration", expectedChangeId: PREPARED, acknowledgePossibleDuplicate: true };
const ATTEMPT = { id: PREPARED, orderId: ORDER, filmId: "saved-film", manifestHash: "b".repeat(64),
  status: "processing", submittedAt: "2026-09-27T12:00:00Z", elapsedSeconds: 10, estimateAvailable: false };

function harness({ user = OWNER, limit = true, available = true, service = {} } = {}) {
  const calls = [], limits = [];
  const generation = { availableFor: () => available,
    start: async (...args) => { calls.push(["start", ...args]); return ATTEMPT; },
    replace: async (...args) => { calls.push(["replace", ...args]); return ATTEMPT; },
    status: async (...args) => { calls.push(["status", ...args]); return ATTEMPT; },
    check: async (...args) => { calls.push(["check", ...args]); return ATTEMPT; }, ...service };
  const handler = createStudioHandler({ getSession: async () => user ? { user } : null,
    limitAction: async (...args) => { limits.push(args); return limit; },
    connections: async () => ({ story: true, magiclight: false, billing: true, quality: { verified: false } }),
    readPricingSettings: async () => ({}), hostedCheckout: { configuration: async () => ({ available: true }) },
    paidFilmGeneration: generation,
  });
  return { calls, limits, run: async ({ method = "GET", query = `action=generationAttempt&id=${PREPARED}`, body, origin = "https://lineagetheater.com" } = {}) => {
    let status, output;
    await handler({ method, url: `/api/studio?${query}`, headers: { host: "lineagetheater.com", origin }, ...(body ? { body } : {}) },
      { set statusCode(value) { status = value; }, setHeader() {}, end(value) { output = JSON.parse(value); } });
    return { status, body: output };
  } };
}
const post = body => ({ method: "POST", body });

test("generation attempt routes require a completed owner session before accessing the service", async () => {
  for (const user of [null, { ...OWNER, mustChangePassword: true }, CUSTOMER,
    { ...CUSTOMER, role: "admin" }, { ...OWNER, status: "suspended" }, { ...CUSTOMER, role: "owner" }]) {
    const h = harness({ user });
    for (const request of [{}, post(START), post(CHECK), post(REPLACE)]) {
      const result = await h.run(request);
      assert.equal(result.status, !user || user.mustChangePassword ? 401 : 403);
    }
    assert.deepEqual(h.calls, []);
    assert.deepEqual(h.limits, []);
  }
});

test("generation start and provider checks require same-origin POST with exact saved references", async () => {
  const h = harness();
  for (const body of [START, CHECK, REPLACE]) {
    for (const origin of [undefined, "https://other.example.invalid", "null"]) {
      const request = { ...post(body), origin };
      // Undefined uses the harness default; an absent-origin request is represented
      // by null so the origin helper still sees the missing/invalid value.
      if (origin === undefined) request.origin = null;
      assert.equal((await h.run(request)).status, 403);
    }
    for (const preparedId of [undefined, "../other-film", "a".repeat(200), PREPARED.toUpperCase().replace("0001", "ABCD"), 7])
      assert.equal((await h.run(post({ ...body, preparedId }))).status, 400);
    for (const extra of [{ provider: "other" }, { charged: true }, { generationAttempt: true }, { apiKey: "synthetic" }])
      assert.equal((await h.run(post({ ...body, ...extra }))).status, 400);
  }
  for (const consent of [undefined, false, "true", 1])
    assert.equal((await h.run(post({ ...START, consent }))).status, 400);
  for (const orderId of [undefined, "other-order", "A".repeat(64), "a".repeat(65), 1])
    assert.equal((await h.run(post({ ...START, orderId }))).status, 400);
  assert.equal((await h.run(post({ ...CHECK, orderId: ORDER }))).status, 400);
  assert.equal((await h.run({ query: "action=requestFilmGeneration" })).status, 400);
  assert.equal((await h.run({ query: "action=checkFilmGeneration" })).status, 400);
  assert.equal((await h.run({ method: "PUT", body: START })).status, 405);
  assert.deepEqual(h.calls, []);
  assert.deepEqual(h.limits, []);
});

test("replacement requires explicit duplicate-risk acknowledgment and exact prior revision", async () => {
  const h = harness();
  for (const change of [{ expectedChangeId: undefined }, { expectedChangeId: "stale" },
    { acknowledgePossibleDuplicate: undefined }, { acknowledgePossibleDuplicate: false }, { consent: false }])
    assert.equal((await h.run(post({ ...REPLACE, ...change }))).status, 400);
  assert.deepEqual(h.calls, []);
  assert.deepEqual(await h.run(post(REPLACE)), { status: 202, body: ATTEMPT });
  assert.deepEqual(h.calls, [["replace", OWNER, { preparedId: PREPARED, orderId: ORDER, consent: true,
    expectedChangeId: PREPARED, acknowledgePossibleDuplicate: true }]]);
  assert.equal((await harness({ limit: false }).run(post(REPLACE))).status, 429);
  const failed = harness({ service: { replace: async () => { throw Error("private-key private-response"); } } });
  const result = await failed.run(post(REPLACE)); assert.equal(result.status, 503);
  assert.doesNotMatch(JSON.stringify(result), /private-key|private-response/);
});

test("saved attempt reads accept one exact plan reference and no provider or account selectors", async () => {
  const h = harness();
  for (const query of ["action=generationAttempt", "action=generationAttempt&id=../other",
    `action=generationAttempt&id=${PREPARED}&id=${PREPARED}`,
    `action=generationAttempt&action=generationAttempt&id=${PREPARED}`,
    `action=generationAttempt&id=${PREPARED}&email=other@example.invalid`,
    `action=generationAttempt&id=${PREPARED}&provider=other`])
    assert.equal((await h.run({ query })).status, 400);
  assert.deepEqual(h.calls, []);
  assert.deepEqual(h.limits, []);
});

test("valid attempt actions dispatch only the saved references under separate bounded rate limits", async () => {
  const h = harness();
  assert.deepEqual(await h.run(), { status: 200, body: ATTEMPT });
  assert.deepEqual(await h.run(post(START)), { status: 202, body: ATTEMPT });
  assert.deepEqual(await h.run(post(CHECK)), { status: 200, body: ATTEMPT });
  assert.deepEqual(h.calls, [["status", OWNER, { preparedId: PREPARED }],
    ["start", OWNER, { preparedId: PREPARED, orderId: ORDER, consent: true }],
    ["check", OWNER, { preparedId: PREPARED }]]);
  assert.deepEqual(h.limits, [[`film-generation-status:${OWNER_EMAIL}`, 240, 3600_000],
    [`film-generation-start:${OWNER_EMAIL}`, 6, 3600_000], [`film-generation-check:${OWNER_EMAIL}`, 60, 3600_000]]);
  const limited = harness({ limit: false });
  for (const request of [{}, post(START), post(CHECK)]) assert.equal((await limited.run(request)).status, 429);
  assert.deepEqual(limited.calls, []);
  assert.deepEqual(await harness({ service: { status: async () => null } }).run(), { status: 200, body: null });
});

test("only the configured owner sees the attempt capability; production readiness remains false", async () => {
  for (const [user, available, expected] of [[OWNER, true, true], [OWNER, false, undefined],
    [CUSTOMER, true, undefined], [{ ...CUSTOMER, role: "admin" }, true, undefined]]) {
    const h = harness({ user, available });
    const result = await h.run({ query: "action=capabilities" });
    assert.equal(result.status, 200);
    assert.equal(result.body.generationAttempt, expected);
    assert.equal(result.body.production, false);
    assert.equal(result.body.quality.verified, false);
    assert.deepEqual(h.calls, []);
  }
});

test("unexpected generation errors do not expose credentials or private provider responses", async () => {
  const fail = async () => { throw Error("private-provider-key synthetic-output-url"); };
  const h = harness({ service: { start: fail, status: fail, check: fail } });
  for (const request of [{}, post(START), post(CHECK)]) {
    const result = await h.run(request);
    assert.equal(result.status, 503);
    assert.doesNotMatch(JSON.stringify(result), /private-provider-key|synthetic-output-url/);
  }
  const conflict = new PaidFilmGenerationError("GENERATION_PAYMENT_REQUIRED", 409, "Confirm the payment for this exact saved film before requesting generation.");
  const result = await harness({ service: { start: async () => { throw conflict; } } }).run(post(START));
  assert.deepEqual(result, { status: 409, body: { code: conflict.code, message: conflict.message } });
});

async function cron(handler, { method = "GET", authorization = `Bearer ${SECRET}` } = {}) {
  let status, body;
  const headers = {};
  await handler({ method, url: "/api/film-generation", headers: { authorization } },
    { set statusCode(value) { status = value; }, setHeader(name, value) { headers[name] = value; }, end(value) { body = JSON.parse(value); } });
  return { status, body, headers };
}

test("scheduled generation checks require GET and an exact configured cron credential", async () => {
  let calls = 0;
  const handler = createFilmGenerationHandler({ env: { CRON_SECRET: SECRET }, service: { run: async () => { calls++; return { examined: 1 }; } } });
  for (const authorization of [null, "", SECRET, "Bearer incorrect", `bearer ${SECRET}`, `Bearer ${SECRET} `, [SECRET]])
    assert.equal((await cron(handler, { authorization })).status, 401);
  for (const method of ["POST", "PUT", "HEAD", "DELETE"]) {
    const result = await cron(handler, { method });
    assert.equal(result.status, 405);
    assert.equal(result.headers.Allow, "GET");
  }
  assert.equal(calls, 0);
  assert.deepEqual((await cron(handler)).body, { examined: 1 });
  assert.equal(calls, 1);
  for (const secret of [undefined, "", "short", " ".repeat(40), "a".repeat(513)]) {
    const disabled = createFilmGenerationHandler({ env: { CRON_SECRET: secret }, service: { run: async () => { calls++; } } });
    assert.equal((await cron(disabled)).status, 503);
  }
  assert.equal(calls, 1);
  const failed = createFilmGenerationHandler({ env: { CRON_SECRET: SECRET }, service: { run: async () => { throw Error(`private-provider-data ${SECRET}`); } } });
  const result = await cron(failed);
  assert.equal(result.status, 503);
  assert.doesNotMatch(JSON.stringify(result), /private-provider-data|synthetic-generation-cron/);
});

test("deployment schedules bounded saved generation checks every five minutes", async () => {
  const config = JSON.parse(await readFile(new URL("../vercel.json", import.meta.url), "utf8"));
  assert.equal(config.functions["api/film-generation.mjs"].maxDuration, 180);
  assert.deepEqual(config.crons.filter(value => value.path === "/api/film-generation"),
    [{ path: "/api/film-generation", schedule: "*/5 * * * *" }]);
});
