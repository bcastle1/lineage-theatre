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

test("retired generation creation rejects all customer and owner requests without dispatch",async()=>{
 for(const user of [OWNER,CUSTOMER,{...CUSTOMER,role:"admin"}]){
  const h=harness({user});
  for(const body of [START,REPLACE,{...START,consent:false},{...START,apiKey:"private"}]) assert.equal((await h.run(post(body))).status,410);
  assert.deepEqual(h.calls,[]);
 }
 const h=harness({user:null});assert.equal((await h.run(post(START))).status,401);
 assert.equal((await harness().run({...post(START),origin:"https://elsewhere.invalid"})).status,403);
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

test("saved legacy attempts remain readable without enabling creation",async()=>{
 const h=harness();assert.deepEqual(await h.run(),{status:200,body:ATTEMPT});
 assert.deepEqual(await h.run(post(CHECK)),{status:200,body:ATTEMPT});
 assert.deepEqual(h.calls.map(c=>c[0]),["status","check"]);
 assert.equal((await harness({user:CUSTOMER}).run()).status,403);
 assert.equal((await harness({limit:false}).run()).status,429);
 for(const user of [OWNER,CUSTOMER]) assert.equal((await harness({user}).run({query:"action=capabilities"})).body.generationAttempt,undefined);
 const fail=async()=>{throw Error("private-key synthetic-output-url")};
 const result=await harness({service:{status:fail}}).run();assert.equal(result.status,503);assert.doesNotMatch(JSON.stringify(result),/private-key|synthetic-output-url/);
});

async function cron(handler, { method = "GET", authorization = `Bearer ${SECRET}` } = {}) {
  let status, body;
  const headers = {};
  await handler({ method, url: "/api/film-generation", headers: { authorization } },
    { set statusCode(value) { status = value; }, setHeader(name, value) { headers[name] = value; }, end(value) { body = JSON.parse(value); } });
  return { status, body, headers };
}

test("scheduled generation checks require GET and an exact configured cron credential", async () => {
  let calls = 0, automaticCalls = 0;
  const handler = createFilmGenerationHandler({ env: { CRON_SECRET: SECRET }, service: { run: async () => { calls++; return { examined: 1 }; } },
    automation: { run: async () => { automaticCalls++; return { queued: 1, pending: 0, skipped: 0 }; } } });
  for (const authorization of [null, "", SECRET, "Bearer incorrect", `bearer ${SECRET}`, `Bearer ${SECRET} `, [SECRET]])
    assert.equal((await cron(handler, { authorization })).status, 401);
  for (const method of ["POST", "PUT", "HEAD", "DELETE"]) {
    const result = await cron(handler, { method });
    assert.equal(result.status, 405);
    assert.equal(result.headers.Allow, "GET");
  }
  assert.equal(calls, 0);
  assert.equal(automaticCalls, 0);
  assert.deepEqual((await cron(handler)).body, { examined: 1, automatic: { queued: 1, pending: 0, skipped: 0 } });
  assert.equal(calls, 1);
  assert.equal(automaticCalls, 1);
  for (const secret of [undefined, "", "short", " ".repeat(40), "a".repeat(513)]) {
    const disabled = createFilmGenerationHandler({ env: { CRON_SECRET: secret }, service: { run: async () => { calls++; } } });
    assert.equal((await cron(disabled)).status, 503);
  }
  assert.equal(calls, 1);
  const failed = createFilmGenerationHandler({ env: { CRON_SECRET: SECRET }, service: { run: async () => { throw Error(`private-provider-data ${SECRET}`); } },
    automation: { run: async () => { automaticCalls++; return { queued: 1 }; } } });
  const result = await cron(failed);
  assert.equal(result.status, 503);
  assert.equal(result.body.automatic.queued, 1);
  assert.equal(automaticCalls, 2);
  assert.doesNotMatch(JSON.stringify(result), /private-provider-data|synthetic-generation-cron/);
});

test("a scheduling outage preserves existing task polling and reports partial failure", async () => {
  let polled = false;
  const handler = createFilmGenerationHandler({ env: { CRON_SECRET: SECRET },
    service: { run: async () => { polled = true; return { checked: 2 }; } },
    automation: { run: async () => { throw Error("PRIVATE_STORAGE_FAILURE"); } } });
  const result = await cron(handler);
  assert.equal(polled, true); assert.equal(result.status, 503); assert.equal(result.body.checked, 2);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_STORAGE_FAILURE/);
});

test("deployment schedules bounded saved generation checks every minute", async () => {
  const config = JSON.parse(await readFile(new URL("../vercel.json", import.meta.url), "utf8"));
  assert.equal(config.functions["api/film-generation.mjs"].maxDuration, 180);
  assert.deepEqual(config.crons.filter(value => value.path === "/api/film-generation"),
    [{ path: "/api/film-generation", schedule: "* * * * *" }]);
});
