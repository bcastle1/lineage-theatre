import test from "node:test";
import assert from "node:assert/strict";
import { createPaidFilmGenerationService, paidFilmGenerationPath } from "../api/_lib/paid-film-generation.mjs";
import { buildFilmManifest, fictionalOperatorProject } from "../api/_lib/film-production.mjs";
import { digest, userPath } from "../api/_lib/auth.mjs";
import { OWNER_EMAIL } from "../api/_lib/access.mjs";

const OWNER = { email: OWNER_EMAIL, role: "owner", status: "active" };
const ID = "00000000-0000-4000-8000-000000000009";
const ORDER = "a".repeat(64), KEY = "private-api-key-for-tests", TASK = "2032443088023777281";
const OUTPUT = "https://videocos.magiclight.ai/private-output.mp4?signature=private-signature";
const NOW = Date.parse("2026-09-28T01:00:00Z");
const clone = value => structuredClone(value);
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

test("unconfirmed requests expose only fixed owner diagnostics and never automatically resubmit", async () => {
  for (const error of [Object.assign(new Error("private response"), { code: "MAGICLIGHT_PROVIDER_REJECTED", providerCode: 40001, httpStatus: 200 }), Object.assign(new Error("private response"), { code: "untrusted secret", providerCode: "secret", httpStatus: 999 })]) {
    const h = fixture({ submit: () => { throw error; } });
    const value = await h.start();
    assert.equal(value.status, "uncertain"); assert.deepEqual(value.diagnostic, h.stored().diagnostic);
    assert.equal(h.stored().diagnostic.code, error.code === "MAGICLIGHT_PROVIDER_REJECTED" ? error.code : "GENERATION_RESULT_UNCONFIRMED");
    assert.doesNotMatch(JSON.stringify(h.stored()), /private response|untrusted secret/);
    await h.start(); assert.equal(h.submissions.length, 1);
  }
});

function fixture(options = {}) {
  let revision = 0, at = NOW;
  const { manifest, manifestHash } = buildFilmManifest(fictionalOperatorProject());
  const job = { id: ID, ownerHash: digest(OWNER.email), filmId: manifest.filmId, manifestHash, manifest,
    mode: "customer", status: "prepared", shots: manifest.shots.map(shot => ({ id: shot.id, status: "prepared" })) };
  const order = { id: ORDER, customerEmail: OWNER.email, preparedId: ID, manifestHash, filmId: job.filmId,
    status: "captured", capturedAt: new Date(NOW - 1000).toISOString(), checkoutMethod: "quickbooks-hosted-invoice",
    confirmationSource: "quickbooks-accounting", merchantBinding: { environment: "production" }, currency: "USD", amountCents: 519, refundedCents: 0 };
  const publicOrder = { id: ORDER, preparedId: ID, filmId: job.filmId, status: "captured", sandbox: false,
    requiresReview: false, refundedCents: 0, checkoutMethod: order.checkoutMethod, confirmationSource: order.confirmationSource,
    currency: "USD", amountCents: 519, receiptAvailable: true };
  const records = new Map([[userPath(OWNER.email), { value: clone(OWNER), etag: "owner1" }],
    [`payments/orders/${ORDER}.json`, { value: clone(order), etag: "order1" }]]);
  const path = paidFilmGenerationPath(OWNER.email, ID), submissions = [], checks = [], paymentChecks = [], configurations = [];
  const env = { MAGICLIGHT_API_KEY: KEY };
  const read = async key => { await options.beforeRead?.(key); return records.has(key) ? clone(records.get(key)) : null; };
  const write = async (key, value, etag) => {
    await options.beforeWrite?.(key, value);
    const old = records.get(key);
    if (old ? old.etag !== etag : Boolean(etag)) throw new Error("precondition failed");
    records.set(key, { value: clone(value), etag: `revision-${++revision}` });
    await options.afterWrite?.(key, value);
  };
  const deps = { read, write, env, now: () => at,
    getPrepared: async input => { assert.equal(input.email, OWNER.email); assert.equal(input.id, ID); return clone(job); },
    checkPayment: async (actor, input) => { paymentChecks.push(clone(input)); return options.payment ? options.payment(actor, input) : clone(publicOrder); },
    listBlobs: async input => { assert.equal(input.limit, 5); return { blobs: [...records.keys()].filter(key => key.startsWith(input.prefix)).map(pathname => ({ pathname })), hasMore: false }; },
    clientFactory: config => { configurations.push(config); return {
      submitTask: async input => { submissions.push(clone(input)); return options.submit ? options.submit(input) : { providerCode: 10000, taskId: TASK }; },
      checkTask: async input => { checks.push(clone(input)); return options.check ? options.check(input) : { providerCode: 10000, taskStatus: 2, taskId: TASK, videoUrl: OUTPUT }; },
    }; }, ...options.overrides };
  const service = createPaidFilmGenerationService(deps);
  return { service, records, job, order, publicOrder, env, path, submissions, checks, configurations, paymentChecks,
    peer: () => createPaidFilmGenerationService(deps), advance: ms => { at += ms; },
    start: () => service.start(OWNER, { preparedId: ID, orderId: ORDER, consent: true }),
    status: () => service.status(OWNER, { preparedId: ID }), check: () => service.check(OWNER, { preparedId: ID }),
    stored: () => clone(records.get(path)?.value),
    revoke: () => records.set(userPath(OWNER.email), { value: { ...OWNER, status: "suspended" }, etag: "revoked" }) };
}

test("single paid immutable screenplay request preserves content and exposes no private provider information", async () => {
  const h = fixture(); assert.equal(await h.status(), null); assert.equal(h.service.availableFor(OWNER), true);
  const result = await h.start();
  assert.equal(result.id, ID); assert.equal(result.preparedId, ID); assert.equal(result.status, "processing");
  assert.equal(result.manifestHash, h.job.manifestHash); assert.equal(result.orderId, ORDER); assert.equal(result.estimateAvailable, false);
  assert.equal(result.elapsedSeconds, 0); assert.equal(h.submissions.length, 1); assert.deepEqual(Object.keys(h.submissions[0]), ["text"]);
  const submitted = JSON.parse(h.submissions[0].text.split("\n\n")[1]);
  assert.deepEqual(submitted.screenplay, h.job.manifest.screenplay);
  assert.equal(submitted.requestedDurationSeconds, h.job.manifest.targetDurationSeconds);
  assert.equal(submitted.era, h.job.manifest.era); assert.equal(submitted.style, h.job.manifest.style);
  assert.equal(submitted.sources, undefined); assert.equal(h.stored().taskId, TASK); assert.equal(h.stored().submissionCount, 1);
  assert.equal(h.configurations[0].environment, "production"); assert.equal(h.configurations[0].enableSubmission, true);
  assert.equal(h.configurations[0].requestTimeoutMs, 90_000);
  assert.deepEqual(h.paymentChecks, [{ orderId: ORDER }]);
  h.advance(120_000); const checked = await h.check(); assert.equal(checked.status, "verifying"); assert.equal(checked.elapsedSeconds, 120);
  assert.equal(h.stored().outputUrl, OUTPUT); assert.deepEqual(h.checks, [{ taskId: TASK }]);
  for (const value of [result, checked, await h.status()]) {
    assert.equal(value.mediaReady, undefined); assert.equal(value.finished, undefined); assert.equal(value.productionReady, undefined);
    assert.doesNotMatch(JSON.stringify(value), /private-api-key|2032443088023777281|private-signature|private-output|ownerEmail|outputUrl/);
  }
  await h.check(); await h.start(); assert.equal(h.submissions.length, 1); assert.equal(h.checks.length, 1);
});

test("owner, account approval and exact request shape are required before provider operations", async () => {
  for (const actor of [null, { ...OWNER, role: "admin" }, { ...OWNER, role: "customer" }, { ...OWNER, mustChangePassword: true }, { ...OWNER, status: "suspended" }]) {
    const h = fixture(); assert.equal(h.service.availableFor(actor), false);
    await assert.rejects(h.service.start(actor, { preparedId: ID, orderId: ORDER, consent: true }), e => e.code === "GENERATION_OWNER_REQUIRED");
    assert.equal(h.submissions.length, 0);
  }
  for (const input of [{ preparedId: ID, orderId: ORDER }, { preparedId: ID, orderId: ORDER, consent: false },
    { preparedId: ID, orderId: ORDER, consent: true, text: "replacement" }, { preparedId: "../other", orderId: ORDER, consent: true }]) {
    const h = fixture(); await assert.rejects(h.service.start(OWNER, input), e => e.code === "GENERATION_INVALID_REQUEST"); assert.equal(h.submissions.length, 0);
  }
  const h = fixture(); h.revoke(); await assert.rejects(h.start(), e => e.code === "GENERATION_OWNER_REQUIRED"); assert.equal(h.paymentChecks.length, 0);
});

test("unpaid, mismatched, reviewed, sandbox and refunded payments cannot submit", async () => {
  for (const change of [{ status: "awaiting-payment" }, { requiresReview: true }, { sandbox: true }, { amountCents: 330 },
    { refundedCents: 1 }, { id: "b".repeat(64) }, { preparedId: "00000000-0000-4000-8000-000000000008" }, { filmId: ID }, { receiptAvailable: false }]) {
    const h = fixture(); Object.assign(h.publicOrder, change); await assert.rejects(h.start(), e => e.code === "GENERATION_PAYMENT_REQUIRED");
    assert.equal(h.submissions.length, 0); assert.equal(h.stored(), undefined);
  }
  for (const change of [{ customerEmail: "other@example.invalid" }, { manifestHash: "b".repeat(64) }, { status: "uncertain" },
    { amountCents: 330 }, { refundedCents: 1 }, { refundOperation: {} }, { checkOperation: {} }, { merchantBinding: { environment: "sandbox" } }]) {
    const h = fixture(); Object.assign(h.records.get(`payments/orders/${ORDER}.json`).value, change);
    await assert.rejects(h.start(), e => e.code === "GENERATION_PAYMENT_REQUIRED"); assert.equal(h.submissions.length, 0);
  }
});

test("tampered or changed saved plan cannot cross the paid film boundary", async () => {
  for (const change of [{ ownerHash: "b".repeat(64) }, { filmId: ID }, { manifestHash: "b".repeat(64) }, { mode: "operator-test" }, { status: "processing" }]) {
    const h = fixture(); Object.assign(h.job, change); await assert.rejects(h.start(), e => e.code === "GENERATION_CHANGED"); assert.equal(h.submissions.length, 0);
  }
  const h = fixture(); await h.start(); h.job.manifest.title = "different film";
  await assert.rejects(h.status(), e => e.code === "GENERATION_CHANGED"); await assert.rejects(h.check(), e => e.code === "GENERATION_CHANGED");
  assert.equal(h.checks.length, 0);
});

test("concurrent callers share one permanent claim and accepted task", async () => {
  const entered = deferred(), release = deferred();
  const h = fixture({ submit: async () => { entered.resolve(); await release.promise; return { providerCode: 10000, taskId: TASK }; } });
  const first = h.start(); await entered.promise;
  const second = await h.peer().start(OWNER, { preparedId: ID, orderId: ORDER, consent: true }); assert.equal(second.status, "submitting");
  assert.equal(second.recovery, undefined);
  release.resolve(); await first;
  await Promise.all([h.start(), h.peer().start(OWNER, { preparedId: ID, orderId: ORDER, consent: true })]);
  assert.equal(h.submissions.length, 1); assert.equal(h.stored().taskId, TASK);
  h.env.MAGICLIGHT_API_KEY = "rotated-key"; await h.start(); assert.equal(h.submissions.length, 1);
  await assert.rejects(h.check(), e => e.code === "GENERATION_CHANGED"); assert.equal(h.checks.length, 0);
});

test("ambiguous or invalid POST outcome never permits automatic or manual resubmission", async () => {
  for (const outcome of [new Error(KEY), { providerCode: 10001 }, { providerCode: 10000, taskId: KEY }, { providerCode: 10000, taskId: 2032443088023777281 }]) {
    const h = fixture({ submit: async () => { if (outcome instanceof Error) throw outcome; return outcome; } });
    const result = await h.start(); assert.equal(result.status, "uncertain"); assert.equal(h.stored().taskId, undefined);
    await h.start(); await h.check(); await h.service.run(); assert.equal(h.submissions.length, 1); assert.equal(h.checks.length, 0);
    assert.doesNotMatch(JSON.stringify(result), /private-api-key/);
  }
});

test("lost claim and accepted-task write responses are recovered without a second POST", async () => {
  let loses = 2;
  const h = fixture({ afterWrite: async (path) => { if (path.includes("generation-attempts/") && loses-- > 0) throw new Error("lost response"); } });
  assert.equal((await h.start()).status, "processing"); assert.equal(h.submissions.length, 1); assert.equal(h.stored().taskId, TASK);
  let failures = 2;
  const retry = fixture({ beforeWrite: async (path, value) => { if (path.includes("generation-attempts/") && value.taskId && failures-- > 0) throw new Error("temporary storage failure"); } });
  assert.equal((await retry.start()).status, "processing"); assert.equal(retry.submissions.length, 1); assert.equal(retry.stored().taskId, TASK);
});

test("permanent task persistence failure leaves a non-retryable saved submission claim", async () => {
  const h = fixture({ beforeWrite: async (path, value) => { if (path.includes("generation-attempts/") && value.taskId) throw new Error("storage down"); } });
  await assert.rejects(h.start(), e => e.code === "GENERATION_STORAGE_UNAVAILABLE"); assert.equal(h.stored().status, "submitting");
  await h.start(); await h.check(); assert.equal(h.submissions.length, 1); assert.equal(h.checks.length, 0);
});

test("owner revocation during acceptance preserves recovery identity but denies disclosure", async () => {
  let h; h = fixture({ submit: async () => { h.revoke(); return { providerCode: 10000, taskId: TASK }; } });
  await assert.rejects(h.start(), e => e.code === "GENERATION_OWNER_REQUIRED"); assert.equal(h.stored().taskId, TASK);
  await assert.rejects(h.status(), e => e.code === "GENERATION_OWNER_REQUIRED"); await h.service.run(); assert.equal(h.checks.length, 0);
});

test("unsafe completion URLs and task identity mismatches cannot become verified delivery", async () => {
  const urls = ["http://videocos.magiclight.ai/a.mp4", "https://127.0.0.1/a.mp4", "https://2130706433/a.mp4", "https://[::1]/a.mp4", "https://localhost/a.mp4",
    "https://metadata.internal/a.mp4", "https://user:pass@videocos.magiclight.ai/a.mp4", "https://videocos.magiclight.ai:443/a.mp4", "https://videocos.magiclight.ai/a.mp4#x",
    `https://videocos.magiclight.ai/${KEY}.mp4`, "https://videocos.magiclight.ai\\@other.com/a.mp4"];
  for (const videoUrl of urls) {
    const h = fixture({ check: async () => ({ providerCode: 10000, taskStatus: 2, taskId: TASK, videoUrl }) });
    await h.start(); assert.equal((await h.check()).status, "uncertain"); assert.equal(h.stored().outputUrl, undefined);
  }
  const h = fixture({ check: async () => ({ providerCode: 10000, taskStatus: 2, taskId: "different", videoUrl: OUTPUT }) });
  await h.start(); assert.equal((await h.check()).status, "uncertain"); assert.equal(h.stored().outputUrl, undefined);
});

test("provider failure is terminal; nonterminal status polls use only the stored exact task", async () => {
  let response = { providerCode: 10000, taskStatus: 1 };
  const h = fixture({ check: async () => response }); await h.start(); assert.equal((await h.check()).status, "processing");
  response = { providerCode: 10000, taskStatus: 999 }; assert.equal((await h.check()).status, "uncertain");
  response = { providerCode: 10000, taskStatus: 3 }; assert.equal((await h.check()).status, "failed");
  await h.check(); await h.service.run(); assert.equal(h.checks.length, 3); assert.equal(h.submissions.length, 1);
});

test("a stale poll cannot replace a newer completion", async () => {
  const entered = deferred(), release = deferred(); let calls = 0;
  const h = fixture({ check: async () => { if (++calls === 1) { entered.resolve(); await release.promise; return { providerCode: 10000, taskStatus: 1 }; }
    return { providerCode: 10000, taskStatus: 2, taskId: TASK, videoUrl: OUTPUT }; } });
  await h.start(); const first = h.check(); await entered.promise;
  assert.equal((await h.peer().check(OWNER, { preparedId: ID })).status, "verifying"); release.resolve();
  await assert.rejects(first, e => e.code === "GENERATION_CHANGED"); assert.equal(h.stored().status, "verifying");
});

test("scheduled worker checks only saved tasks, rate limits repeated polling and advances a bounded cursor", async () => {
  const h = fixture({ check: async () => ({ providerCode: 10000, taskStatus: 1 }) });
  assert.deepEqual(await h.service.run(), { checked: 0, skipped: 0, attention: 0 }); assert.equal(h.submissions.length, 0);
  await h.start(); assert.deepEqual(await h.service.run(), { checked: 1, skipped: 0, attention: 0 });
  assert.deepEqual(await h.service.run(), { checked: 0, skipped: 1, attention: 0 }); h.advance(60_000);
  assert.deepEqual(await h.service.run(), { checked: 1, skipped: 0, attention: 0 }); assert.equal(h.submissions.length, 1);
  let page = 0; const inputs = [];
  const paged = fixture({ overrides: { listBlobs: async input => { inputs.push(input); return page++ ? { blobs: [], hasMore: false } : { blobs: [], hasMore: true, cursor: "next-page" }; } } });
  await paged.service.run(); await paged.service.run(); assert.equal(inputs[0].cursor, undefined); assert.equal(inputs[1].cursor, "next-page");
  assert.equal(paged.submissions.length, 0);
});

test("an oversized screenplay is never truncated or submitted", async () => {
  const h = fixture(); h.job.manifest.screenplay.scenes[0].narration = "x".repeat(100_001); h.job.manifestHash = digest(JSON.stringify(h.job.manifest));
  await assert.rejects(h.start(), e => e.code === "GENERATION_SCRIPT_TOO_LARGE"); assert.equal(h.submissions.length, 0); assert.equal(h.paymentChecks.length, 0);
});

function replaceInput(h, extras = {}) {
  return { preparedId: ID, orderId: ORDER, consent: true, expectedChangeId: h.stored().changeId,
    acknowledgePossibleDuplicate: true, ...extras };
}
test("one explicit ambiguous replacement preserves the original record, paid identity and screenplay", async () => {
  let calls = 0;
  const h = fixture({ submit: () => { if (++calls === 1) throw new Error("lost response"); return { providerCode: 10000, taskId: TASK }; } });
  await h.start(); const original = h.stored();
  assert.deepEqual((await h.status()).recovery, { kind: "provider-review-required", canRetry: false });
  await assert.rejects(h.service.replace(OWNER, replaceInput(h)), e => e.code === "GENERATION_CHANGED");
  h.advance(300_000);
  assert.deepEqual((await h.status()).recovery, { kind: "replacement-available", canRetry: true, expectedChangeId: original.changeId });
  const paidBefore = clone(h.records.get(`payments/orders/${ORDER}.json`));
  const jobBefore = clone(h.job);
  const result = await h.service.replace(OWNER, replaceInput(h));
  assert.equal(result.status, "processing"); assert.equal(result.orderId, ORDER); assert.equal(result.preparedId, ID);
  assert.equal(h.submissions.length, 2); assert.deepEqual(h.submissions[0], h.submissions[1]);
  const current = h.stored(); assert.equal(current.replacementCount, 1); assert.equal(current.priorAttemptHash, digest(JSON.stringify(original)));
  assert.deepEqual(h.records.get(current.priorAttemptPath).value, original);
  assert.deepEqual(h.records.get(`payments/orders/${ORDER}.json`), paidBefore); assert.deepEqual(h.job, jobBefore);
  assert.equal(current.diagnostic, undefined); assert.equal(result.recovery, undefined);
  assert.doesNotMatch(JSON.stringify(result), /priorAttemptPath|priorAttemptHash|private-api-key|ownerEmail|lost response/);
});
test("ambiguous replacement requires fresh identity and duplicate-risk consent; only one is permitted", async () => {
  const h = fixture({ submit: () => { throw new Error("unknown"); } }); await h.start(); h.advance(300_000);
  for (const extras of [{ acknowledgePossibleDuplicate: false }, { acknowledgePossibleDuplicate: undefined },
    { consent: false }, { expectedChangeId: "bad" }, { providerTaskId: TASK }]) {
    await assert.rejects(h.service.replace(OWNER, replaceInput(h, extras)), e => e.code === "GENERATION_INVALID_REQUEST");
  }
  await assert.rejects(h.service.replace(OWNER, replaceInput(h, { expectedChangeId: ID })), e => e.code === "GENERATION_CHANGED");
  assert.equal(h.submissions.length, 1);
  const current = await h.service.replace(OWNER, replaceInput(h)); assert.equal(current.status, "uncertain");
  h.advance(300_000); assert.equal((await h.status()).recovery.canRetry, false);
  await assert.rejects(h.service.replace(OWNER, replaceInput(h)), e => e.code === "GENERATION_CHANGED");
  await h.start(); await h.check(); await h.service.run(); assert.equal(h.submissions.length, 2);
});
test("concurrent replacement confirmations dispatch at most one new request", async () => {
  const entered = deferred(), release = deferred(); let calls = 0;
  const h = fixture({ submit: async () => { if (++calls === 1) throw new Error("unknown"); entered.resolve(); await release.promise; return { providerCode: 10000, taskId: TASK }; } });
  await h.start(); h.advance(300_000); const input = replaceInput(h);
  const first = h.service.replace(OWNER, input); await entered.promise;
  await assert.rejects(h.peer().replace(OWNER, input), e => e.code === "GENERATION_CHANGED");
  release.resolve(); await first; assert.equal(h.submissions.length, 2);
});
test("two replacements racing at the claim write share only one provider dispatch", async () => {
  const barrier = deferred(); let waiting = 0, submits = 0;
  const h = fixture({ submit: () => { if (++submits === 1) throw new Error("unknown"); return { providerCode: 10000, taskId: TASK }; },
    beforeWrite: async (path, value) => { if (path.includes("generation-attempts/") && value.replacementCount === 1 && value.status === "submitting") {
      if (++waiting === 2) barrier.resolve(); await barrier.promise;
    } } });
  await h.start(); h.advance(300_000); const input = replaceInput(h);
  const results = await Promise.allSettled([h.service.replace(OWNER, input), h.peer().replace(OWNER, input)]);
  assert.equal(results.filter(value => value.status === "fulfilled").length, 2);
  assert.equal(h.submissions.length, 2); assert.equal(h.stored().taskId, TASK); assert.equal(h.stored().replacementCount, 1);
});
test("replacement checks current owner, unchanged film and confirmed payment before dispatch", async () => {
  for (const mutate of [h => h.revoke(), h => { h.publicOrder.status = "awaiting-payment"; },
    h => { h.records.get(`payments/orders/${ORDER}.json`).value.refundedCents = 1; }, h => { h.job.manifest.title = "changed"; }]) {
    const h = fixture({ submit: () => { throw new Error("unknown"); } }); await h.start(); h.advance(300_000); const input = replaceInput(h);
    mutate(h); await assert.rejects(h.service.replace(OWNER, input)); assert.equal(h.submissions.length, 1);
  }
});
test("a known accepted task cannot be replaced and failed history storage prevents a replacement POST", async () => {
  const accepted = fixture(); await accepted.start(); accepted.advance(300_000);
  await assert.rejects(accepted.service.replace(OWNER, replaceInput(accepted)), e => e.code === "GENERATION_CHANGED");
  const h = fixture({ submit: () => { throw new Error("unknown"); }, beforeWrite: key => { if (key.includes("generation-attempt-history/")) throw new Error("storage down"); } });
  await h.start(); h.advance(300_000); const original = h.stored();
  await assert.rejects(h.service.replace(OWNER, replaceInput(h)), e => e.code === "GENERATION_STORAGE_UNAVAILABLE");
  assert.deepEqual(h.stored(), original); assert.equal(h.submissions.length, 1);
});
test("client preflight failure leaves no permanent generation claim", async () => {
  const h = fixture({ overrides: { clientFactory: () => { throw new Error("client unavailable"); } } });
  await assert.rejects(h.start()); assert.equal(h.stored(), undefined); assert.equal(h.submissions.length, 0);
});
test("stale no-ID claims show unresolved status and explicit recovery instead of endless submission", async () => {
  const h = fixture({ beforeWrite: (_path, value) => { if (value.taskId) throw new Error("storage failure"); } });
  await assert.rejects(h.start()); h.advance(300_000);
  const value = await h.status(); assert.equal(value.status, "uncertain"); assert.equal(value.recovery.canRetry, true);
  assert.equal(h.stored().status, "submitting"); assert.equal(h.submissions.length, 1);
});

test("a successful provider status clears earlier failure diagnostics", async () => {
  for (const taskStatus of [0, 1, 2, 3]) {
    let fails = true;
    const h = fixture({ check: () => { if (fails) throw Object.assign(new Error("timeout"), { code: "MAGICLIGHT_TIMEOUT", stage: "transport" });
      return { providerCode: 10000, taskStatus, ...(taskStatus === 2 ? { videoUrl: OUTPUT } : {}) }; } });
    await h.start(); assert.equal((await h.check()).diagnostic.code, "MAGICLIGHT_TIMEOUT");
    fails = false; assert.equal((await h.check()).diagnostic, undefined); assert.equal(h.stored().diagnostic, undefined);
  }
});
