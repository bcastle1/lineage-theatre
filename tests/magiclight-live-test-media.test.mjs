import test from "node:test";
import assert from "node:assert/strict";
import { Writable } from "node:stream";
import { digest, userPath } from "../api/_lib/auth.mjs";
import { OWNER_EMAIL } from "../api/_lib/access.mjs";
import { parseRange } from "../api/_lib/archive.mjs";
import { createMagicLightLiveTestService, MAGICLIGHT_LIVE_TEST_PATH, MAGICLIGHT_LIVE_TEST_FIXTURE } from "../api/_lib/magiclight-live-test.mjs";
import { createMagicLightTestMediaService, MAGICLIGHT_TEST_MEDIA_PATH, MAGICLIGHT_TEST_OUTPUT_HOSTS,
  MAX_TEST_MEDIA_BYTES, testMediaSource } from "../api/_lib/magiclight-live-test-media.mjs";

const OWNER = { email: OWNER_EMAIL, role: "owner", status: "active" };
const ID = "11111111-1111-4111-8111-111111111111";
const KEY = "fictional-provider-key-do-not-expose";
const TASK = "900719925474099312345";
const HOST = "media.example.invalid";
const VIDEO = `https://${HOST}/private-output.mp4?signature=private-signed-value`;
const NOW = Date.parse("2026-09-24T12:00:00Z"), TIME = new Date(NOW).toISOString();
const clone = value => structuredClone(value);
const bytes = Buffer.alloc(128, 3);
bytes.writeUInt32BE(24, 0); bytes.write("ftyp", 4, "ascii"); bytes.write("isom", 8, "ascii");
const sha = digest(bytes);
const pathname = `integrations/magiclight/media/${digest(OWNER_EMAIL)}/${ID}/${sha}.mp4`;
function completed() {
  return { version: 1, id: ID, changeId: "22222222-2222-4222-8222-222222222222", ownerEmail: OWNER_EMAIL,
    fixtureHash: MAGICLIGHT_LIVE_TEST_FIXTURE.hash, origin: "https://open.magiclight.ai", keyFingerprint: digest(KEY),
    submissionCount: 1, status: "completed", createdAt: TIME, updatedAt: TIME, checkedAt: TIME,
    providerCode: 10000, taskStatus: 2, taskId: TASK, videoUrl: VIDEO };
}
function metadata(saved = completed(), body = bytes) {
  const hash = digest(body);
  return { version: 1, testId: saved.id, ownerHash: digest(saved.ownerEmail), fixtureHash: saved.fixtureHash,
    taskHash: digest(saved.taskId), sourceHash: digest(saved.videoUrl), downloadSourceHash: digest(saved.videoUrl), sha256: hash,
    pathname: `integrations/magiclight/media/${digest(saved.ownerEmail)}/${saved.id}/${hash}.mp4`,
    sizeBytes: body.length, contentType: "video/mp4", importedAt: TIME };
}
class ResponseCapture extends Writable {
  constructor() { super(); this.headers = {}; this.chunks = []; this.statusCode = 200; this.headersSent = false; }
  setHeader(name, value) { this.headers[name.toLowerCase()] = value; }
  removeHeader(name) { delete this.headers[name.toLowerCase()]; }
  _write(chunk, encoding, done) { this.headersSent = true; this.chunks.push(Buffer.from(chunk)); done(); }
  get body() { return Buffer.concat(this.chunks); }
  get data() { return JSON.parse(this.body.toString()); }
}
function fixture(options = {}) {
  const records = new Map([[userPath(OWNER_EMAIL), { value: clone(OWNER), etag: "owner-1" }],
    [MAGICLIGHT_LIVE_TEST_PATH, { value: completed(), etag: "test-1" }]]);
  const blobs = new Map(), reads = [], writes = [], fetches = [], puts = [], gets = [], cancelled = [], checks = [];
  let h, serial = 0;
  const read = async path => { reads.push(path); await options.beforeRead?.(path, h); return clone(records.get(path) || null); };
  const write = async (path, value, etag) => {
    writes.push({ path, value: clone(value), etag });
    await options.beforeWrite?.(path, value, h);
    const previous = records.get(path);
    if (previous ? previous.etag !== etag : Boolean(etag)) throw new Error("precondition failed");
    records.set(path, { value: clone(value), etag: `saved-${++serial}` });
    await options.afterWrite?.(path, value, h);
  };
  const liveTest = createMagicLightLiveTestService({ read, write, now: () => NOW, env: { MAGICLIGHT_API_KEY: KEY },
    clientFactory: config => {
      assert.equal(config.enableSubmission, false);
      return { submitTask: () => assert.fail("Media delivery must never create a provider task."),
        checkTask: async input => { checks.push(input); if (!options.check) assert.fail("Unexpected provider status call"); return options.check(input, h); } };
    } });
  const fetchImpl = async (url, init) => {
    fetches.push({ url, init });
    if (options.fetch) return options.fetch(url, init, h);
    return new Response(bytes, { headers: { "content-type": "video/mp4", "content-length": String(bytes.length) } });
  };
  const putBlob = async (path, body, init) => {
    puts.push({ path, body: Buffer.from(body), init });
    await options.beforePut?.(path, body, h);
    if (blobs.has(path)) throw new Error("already exists");
    blobs.set(path, Buffer.from(body));
    await options.afterPut?.(path, body, h);
  };
  const getBlob = async (path, init) => {
    gets.push({ path, init });
    await options.beforeGet?.(path, init, h);
    const body = blobs.get(path);
    if (!body) return null;
    const range = parseRange(init.headers?.Range, body.length);
    const sliced = range ? body.subarray(range.start, range.end + 1) : body;
    const stream = new ReadableStream({ start(controller) {
      for (const chunk of options.streamChunks || [sliced]) controller.enqueue(chunk);
      controller.close();
    }, cancel() { cancelled.push(path); } });
    const result = { statusCode: 200, stream, blob: { pathname: path, contentType: "video/mp4", size: sliced.length },
      headers: new Headers({ "content-type": "video/mp4", "content-length": String(sliced.length),
        ...(range ? { "content-range": range.contentRange } : {}) }) };
    return options.changeBlob ? options.changeBlob(result, h) : result;
  };
  const service = createMagicLightTestMediaService({ liveTest, read, write, fetchImpl, getBlob, putBlob, now: () => NOW,
    approvedHosts: options.approvedHosts ?? [HOST], ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}) });
  h = { service, records, blobs, reads, writes, fetches, puts, gets, cancelled, checks, liveTest,
    saved: () => records.get(MAGICLIGHT_LIVE_TEST_PATH).value,
    revoke: () => { records.get(userPath(OWNER_EMAIL)).value.status = "suspended"; },
    imported: (value = metadata()) => { records.set(MAGICLIGHT_TEST_MEDIA_PATH, { value, etag: "media-1" }); blobs.set(value.pathname, bytes); },
    import: (actor = OWNER) => service.importClip(actor), state: (actor = OWNER) => service.state(actor),
    async stream({ actor = OWNER, method = "GET", headers = {}, download = false } = {}) {
      const res = new ResponseCapture();
      await service.stream({ actor, req: { method, headers }, res, download }); return res;
    } };
  return h;
}
const safe = value => assert.doesNotMatch(JSON.stringify(value), /fictional-provider-key|private-signed-value|private-output\.mp4|900719925474099312345/);

test("output import defaults closed and allows only an exact reviewed HTTPS source", async () => {
  assert.equal(Object.isFrozen(MAGICLIGHT_TEST_OUTPUT_HOSTS), true);
  assert.equal(MAGICLIGHT_TEST_OUTPUT_HOSTS.includes(HOST), false);
  assert.equal(testMediaSource(VIDEO, [HOST]), VIDEO);
  for (const source of [VIDEO, `http://${HOST}/a.mp4`, `https://child.${HOST}/a.mp4`, `https://${HOST}.attacker.invalid/a.mp4`,
    `https://user:pass@${HOST}/a.mp4`, `https://${HOST}:8443/a.mp4`, `https://${HOST}/a.mp4#fragment`, "https://127.0.0.1/a.mp4"]) {
    if (source === VIDEO) assert.throws(() => testMediaSource(source));
    else assert.throws(() => testMediaSource(source, [HOST]));
  }
  const h = fixture({ approvedHosts: [] });
  await assert.rejects(h.import(), e => e.code === "MAGICLIGHT_TEST_MEDIA_HOST_UNAPPROVED");
  assert.equal(h.fetches.length, 0); assert.equal(h.writes.length, 0);
});

test("import copies the fixed completed clip privately and verifies bytes before publishing ready", async () => {
  const h = fixture(), original = clone(h.saved());
  assert.equal((await h.state()).media.ready, false);
  const result = await h.import();
  assert.equal(result.media.ready, true); assert.equal(result.media.sha256, sha); assert.equal(result.media.sizeBytes, bytes.length);
  assert.equal(result.productionReady, false); assert.equal(result.customerFulfillment, false); safe(result);
  assert.equal(h.fetches.length, 1); assert.equal(h.fetches[0].url, VIDEO);
  const init = h.fetches[0].init;
  assert.equal(init.method, "GET"); assert.equal(init.redirect, "error"); assert.equal(init.credentials, "omit");
  assert.deepEqual(Object.keys(init.headers).sort(), ["Accept", "Accept-Encoding"]);
  assert.equal(init.headers["Accept-Encoding"], "identity");
  const { abortSignal, ...putOptions } = h.puts[0].init;
  assert.ok(abortSignal instanceof AbortSignal);
  assert.deepEqual({ ...h.puts[0], init: putOptions }, { path: pathname, body: bytes, init: { access: "private", contentType: "video/mp4", addRandomSuffix: false, allowOverwrite: false, cacheControlMaxAge: 60 } });
  assert.equal(h.gets[0].init.access, "private"); assert.equal(h.gets[0].init.useCache, false);
  assert.deepEqual(h.records.get(MAGICLIGHT_TEST_MEDIA_PATH).value, metadata());
  assert.deepEqual(h.saved(), original); assert.deepEqual(h.writes.map(x => x.path), [MAGICLIGHT_TEST_MEDIA_PATH]);
  await h.import(); assert.equal(h.fetches.length, 1); assert.equal(h.puts.length, 1); assert.equal(h.writes.length, 1);
});

test("an expired signed source recovers once from the same completed job without changing its permanent binding", async () => {
  const renewed = `https://${HOST}/renewed-output.mp4?signature=renewed-private-value`;
  for (const status of [401, 403, 404, 410]) {
    const h = fixture({ check: async () => ({ providerCode: 10000, taskStatus: 2, taskId: TASK, videoUrl: renewed }),
      fetch: async (_url, _init, fix) => fix.fetches.length === 1 ? new Response("expired", { status })
        : new Response(bytes, { headers: { "content-type": "video/mp4" } }) });
    const original = clone(h.saved());
    const result = await h.import();
    assert.equal(result.media.ready, true); safe(result); assert.doesNotMatch(JSON.stringify(result), /renewed-private/);
    assert.deepEqual(h.checks, [{ taskId: TASK }]);
    assert.deepEqual(h.fetches.map(call => call.url), [VIDEO, renewed]);
    assert.equal(h.fetches.every(call => call.init.credentials === "omit" && call.init.redirect === "error" && !call.init.headers.Authorization), true);
    assert.deepEqual(h.saved(), original);
    assert.deepEqual(h.records.get(MAGICLIGHT_TEST_MEDIA_PATH).value, { ...metadata(), downloadSourceHash: digest(renewed) });
    await h.import(); const stream = await h.stream(); assert.deepEqual(stream.body, bytes);
    assert.equal(h.fetches.length, 2); assert.equal(h.checks.length, 1);
  }
});

test("source recovery rejects unapproved hosts, changed owner, nonterminal status and repeated denial", async () => {
  const result = { providerCode: 10000, taskStatus: 2, taskId: TASK, videoUrl: VIDEO };
  for (const check of [async () => ({ ...result, videoUrl: "https://unapproved.example.invalid/a.mp4" }),
    async () => ({ ...result, taskStatus: 1 }), async () => ({ ...result, taskStatus: 3 }),
    async () => ({ ...result, taskId: "different-job" }), async () => { throw new Error(`${KEY} ${VIDEO}`); },
    async (_input, h) => { h.revoke(); return result; }]) {
    const h = fixture({ check, fetch: async () => new Response("denied", { status: 403 }) }), original = clone(h.saved());
    await assert.rejects(h.import(), error => { safe({ code: error.code, message: error.message }); return true; });
    assert.equal(h.fetches.length, 1); assert.equal(h.checks.length, 1); assert.deepEqual(h.saved(), original);
    assert.equal(h.puts.length + h.writes.length, 0);
  }
  const denied = fixture({ check: async () => result, fetch: async () => new Response("denied", { status: 403 }) });
  await assert.rejects(denied.import()); assert.equal(denied.fetches.length, 2); assert.equal(denied.checks.length, 1);
  assert.equal(denied.puts.length + denied.writes.length, 0);
});

test("link recovery does not run for transient download errors or after the download deadline", async () => {
  for (const status of [400, 429, 500, 503]) {
    const h = fixture({ fetch: async () => new Response("unavailable", { status }) });
    await assert.rejects(h.import()); assert.equal(h.checks.length, 0); assert.equal(h.fetches.length, 1);
  }
  const expired = fixture({ timeoutMs: 5, fetch: async () => new Response("expired", { status: 403 }),
    check: async () => { await new Promise(resolve => setTimeout(resolve, 20)); return { providerCode: 10000, taskStatus: 2, taskId: TASK, videoUrl: VIDEO }; } });
  await assert.rejects(expired.import(), error => error.code === "MAGICLIGHT_TEST_MEDIA_TIMEOUT");
  assert.equal(expired.fetches.length, 1); assert.equal(expired.puts.length + expired.writes.length, 0);
});

test("owner and saved completion are required before importing or reading media", async () => {
  for (const actor of [null, { ...OWNER, role: "admin" }, { ...OWNER, email: "another@example.invalid" }, { ...OWNER, status: "suspended" }, { ...OWNER, mustChangePassword: true }]) {
    const h = fixture(); h.imported();
    await assert.rejects(h.import(actor), e => e.status === 403);
    assert.equal((await h.stream({ actor })).statusCode, 403); assert.equal(h.fetches.length + h.gets.length, 0);
  }
  for (const patch of [{ status: "suspended" }, { role: "admin" }, { mustChangePassword: true }]) {
    const h = fixture(); Object.assign(h.records.get(userPath(OWNER_EMAIL)).value, patch);
    await assert.rejects(h.import(), e => e.status === 403); assert.equal(h.fetches.length, 0);
  }
  for (const status of ["submitted", "failed", "uncertain"]) {
    const h = fixture(); Object.assign(h.saved(), { status }); delete h.saved().videoUrl;
    if (status === "failed") h.saved().taskStatus = 3;
    if (status === "uncertain") delete h.saved().taskId;
    await assert.rejects(h.import(), e => e.code === "MAGICLIGHT_TEST_NOT_COMPLETE");
    assert.equal((await h.state()).media.ready, false); assert.equal(h.fetches.length, 0);
  }
});

test("non-video, redirect, encoded, ranged and malformed provider responses are cancelled without publication", async () => {
  const changes = [result => ({ ...result, status: 302 }), result => ({ ...result, redirected: true }),
    result => ({ ...result, url: "https://unapproved.invalid/a.mp4" }),
    result => { result.headers.set("content-type", "text/html"); return result; },
    result => { result.headers.set("content-encoding", "gzip"); return result; },
    result => { result.headers.set("content-range", "bytes 0-127/128"); return result; },
    result => { result.headers.set("content-length", "not-a-length"); return result; }];
  for (const change of changes) {
    let cancelled = false;
    const h = fixture({ fetch: async () => change({ status: 200, redirected: false, url: VIDEO,
      headers: new Headers({ "content-type": "video/mp4", "content-length": "128" }),
      body: new ReadableStream({ start(controller) { controller.enqueue(bytes); }, cancel() { cancelled = true; } }) }) });
    await assert.rejects(h.import(), e => e.code === "MAGICLIGHT_TEST_MEDIA_INVALID");
    assert.equal(cancelled, true); assert.equal(h.puts.length + h.writes.length, 0);
  }
});

test("untrusted declared sizes are rejected and their unread provider body is cancelled", async () => {
  for (const length of [0, 15, MAX_TEST_MEDIA_BYTES + 1, Number.MAX_SAFE_INTEGER + 1]) {
    let cancelled = false;
    const h = fixture({ fetch: async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(bytes); }, cancel() { cancelled = true; },
    }), { headers: { "content-type": "video/mp4", "content-length": String(length) } }) });
    await assert.rejects(h.import());
    assert.equal(cancelled, true, `Body must be cancelled for declared length ${length}`);
    assert.equal(h.puts.length + h.writes.length, 0);
  }
});

test("short, oversized, malformed and missing-length bodies are checked from actual bytes", async () => {
  const malformed = Buffer.from(bytes); malformed.write("html", 4, "ascii");
  for (const body of [Buffer.alloc(15), malformed, bytes.subarray(0, 127), Buffer.concat([bytes, Buffer.from([1])])]) {
    const h = fixture({ fetch: async () => new Response(body, { headers: { "content-type": "video/mp4", "content-length": "128" } }) });
    await assert.rejects(h.import()); assert.equal(h.puts.length + h.writes.length, 0);
  }
  const h = fixture({ fetch: async () => new Response(bytes, { headers: { "content-type": "application/octet-stream" } }) });
  assert.equal((await h.import()).media.ready, true);
});

test("a body without Content-Length is still bounded and cancelled at the byte cap", async () => {
  let cancelled = false;
  const h = fixture({ fetch: async () => new Response(new ReadableStream({ start(controller) {
    controller.enqueue(new Uint8Array(MAX_TEST_MEDIA_BYTES + 1));
  }, cancel() { cancelled = true; } }), { headers: { "content-type": "video/mp4" } }) });
  await assert.rejects(h.import(), e => e.code === "MAGICLIGHT_TEST_MEDIA_TOO_LARGE");
  assert.equal(cancelled, true); assert.equal(h.puts.length, 0);
});

test("the import deadline cancels a stalled provider body and cannot publish readiness", async () => {
  let cancelled = false;
  const h = fixture({ timeoutMs: 10, fetch: async () => new Response(new ReadableStream({
    pull() { return new Promise(() => {}); }, cancel() { cancelled = true; },
  }), { headers: { "content-type": "video/mp4" } }) });
  await assert.rejects(h.import(), e => e.code === "MAGICLIGHT_TEST_MEDIA_TIMEOUT");
  assert.equal(cancelled, true); assert.equal(h.puts.length + h.writes.length, 0);
});

test("lost upload and metadata replies recover only through exact immutable readback", async () => {
  const h = fixture({ afterPut: async () => { throw new Error("lost upload reply"); }, afterWrite: async () => { throw new Error("lost record reply"); } });
  assert.equal((await h.import()).media.ready, true); assert.equal(h.fetches.length, 1);
  for (const option of [
    { beforePut: async () => { throw new Error("private Blob credential failure"); } },
    { afterPut: async (path, body, fix) => { const wrong = Buffer.from(body); wrong[50] ^= 1; fix.blobs.set(path, wrong); } },
    { changeBlob: result => ({ ...result, blob: { ...result.blob, pathname: "private/other-owner.mp4" } }) },
    { beforeWrite: async () => { throw new Error("private metadata write failed"); } },
  ]) {
    const f = fixture(option);
    await assert.rejects(f.import(), e => { safe(e); return e.code === "MAGICLIGHT_TEST_MEDIA_UNAVAILABLE"; });
    assert.equal(f.records.has(MAGICLIGHT_TEST_MEDIA_PATH), false);
  }
});

test("the storage deadline cancels a stalled private readback before publishing media metadata", async () => {
  let cancelled = false;
  const h = fixture({ timeoutMs: 10, changeBlob: result => {
    void result.stream.cancel();
    return { ...result, stream: new ReadableStream({
      pull() { return new Promise(() => {}); }, cancel() { cancelled = true; },
    }) };
  } });
  await assert.rejects(h.import(), e => e.code === "MAGICLIGHT_TEST_MEDIA_UNAVAILABLE");
  assert.equal(cancelled, true);
  assert.ok(h.gets[0].init.abortSignal instanceof AbortSignal);
  assert.equal(h.gets[0].init.abortSignal.aborted, true);
  assert.equal(h.records.has(MAGICLIGHT_TEST_MEDIA_PATH), false);
  assert.equal(h.saved().submissionCount, 1);
});

test("concurrent identical imports converge on one create-only media record", async () => {
  const h = fixture();
  const results = await Promise.all([h.import(), h.import()]);
  assert.equal(results.every(result => result.media.ready && result.media.sha256 === sha), true);
  assert.equal(h.blobs.size, 1); assert.equal(h.records.get(MAGICLIGHT_TEST_MEDIA_PATH).value.sha256, sha);
  assert.equal(h.puts.every(call => call.init.allowOverwrite === false), true);
  assert.equal(h.writes.every(call => call.etag === undefined), true);
  assert.equal(h.saved().submissionCount, 1);
});

test("owner revocation or changed task binding during import prevents a ready sidecar", async () => {
  for (const change of [h => h.revoke(), h => { h.saved().taskId = "different-task"; }, h => { h.saved().videoUrl = `https://${HOST}/changed.mp4`; }]) {
    const h = fixture({ fetch: async (_url, _init, fix) => { change(fix); return new Response(bytes, { headers: { "content-type": "video/mp4" } }); } });
    await assert.rejects(h.import()); assert.equal(h.puts.length + h.writes.length, 0);
    const late = fixture({ afterPut: async (_path, _body, fix) => change(fix) });
    await assert.rejects(late.import()); assert.equal(late.records.has(MAGICLIGHT_TEST_MEDIA_PATH), false);
  }
});

test("mismatched private media identity and paths never cause a Blob read", async () => {
  for (const patch of [{ ownerHash: "a".repeat(64) }, { testId: "22222222-2222-4222-8222-222222222222" },
    { fixtureHash: "b".repeat(64) }, { taskHash: "c".repeat(64) }, { sourceHash: "d".repeat(64) },
    { pathname: "https://media.example.invalid/other.mp4" }, { pathname: `${pathname}/../../auth.json` },
    { contentType: "text/html" }, { sizeBytes: 15 }, { sizeBytes: MAX_TEST_MEDIA_BYTES + 1 }, { sha256: "wrong" }]) {
    const h = fixture(); h.imported({ ...metadata(), ...patch });
    await assert.rejects(h.state(), e => e.code === "MAGICLIGHT_TEST_MEDIA_INVALID");
    const res = await h.stream(); assert.equal(res.statusCode, 409); safe(res.data); assert.equal(h.gets.length, 0);
  }
});

test("private GET and downloads use fixed filenames, exact bytes and no secret output URLs", async () => {
  const h = fixture(); h.imported();
  for (const download of [false, true]) {
    const res = await h.stream({ download }); assert.equal(res.statusCode, 200); assert.deepEqual(res.body, bytes);
    assert.equal(res.headers["content-disposition"], `${download ? "attachment" : "inline"}; filename="lineage-fictional-test.mp4"`);
    assert.equal(res.headers["cache-control"], "private, no-store"); assert.equal(res.headers.vary, "Cookie");
    assert.equal(res.headers["x-content-type-options"], "nosniff"); assert.equal(res.headers.etag, `"sha256-${sha}"`); safe(res.headers);
  }
  assert.equal(h.fetches.length, 0); assert.equal(h.gets.every(call => call.path === pathname && call.init.access === "private" && call.init.useCache === false), true);
});

test("ranges and If-Range bind to the exact strong media hash", async () => {
  for (const [header, expected] of [["bytes=0-3", bytes.subarray(0, 4)], ["bytes=-4", bytes.subarray(124)], ["bytes=124-", bytes.subarray(124)]]) {
    const h = fixture(); h.imported(); const res = await h.stream({ headers: { range: header } });
    assert.equal(res.statusCode, 206); assert.deepEqual(res.body, expected); assert.equal(res.headers["content-length"], "4");
  }
  for (const [validator, status] of [[`"sha256-${sha}"`, 206], [`W/"sha256-${sha}"`, 200], ['"another-film"', 200]]) {
    const h = fixture(); h.imported(); const res = await h.stream({ headers: { range: "bytes=0-3", "if-range": validator } });
    assert.equal(res.statusCode, status); assert.deepEqual(res.body, status === 206 ? bytes.subarray(0, 4) : bytes);
  }
  for (const range of ["bytes=0-3,5-7", "bytes=128-", "bytes=-0", "bytes=4-2", "invalid"]) {
    const h = fixture(); h.imported(); const res = await h.stream({ headers: { range } });
    assert.equal(res.statusCode, 416); assert.equal(res.headers["content-range"], "bytes */128"); assert.equal(h.gets.length, 0);
  }
});

test("HEAD checks current ownership and storage then cancels its body", async () => {
  const h = fixture(); h.imported(); const res = await h.stream({ method: "HEAD", headers: { range: "bytes=4-7" } });
  assert.equal(res.statusCode, 206); assert.equal(res.body.length, 0); assert.deepEqual(h.cancelled, [pathname]);
  const revoked = fixture({ beforeGet: async (_path, _init, fix) => fix.revoke() }); revoked.imported();
  const denied = await revoked.stream(); assert.equal(denied.statusCode, 403); assert.deepEqual(revoked.cancelled, [pathname]); safe(denied.data);
});

test("incorrect Blob metadata or ignored ranges are cancelled with sanitized errors", async () => {
  for (const changeBlob of [result => ({ ...result, statusCode: 206 }), result => ({ ...result, blob: { ...result.blob, size: 999 } }),
    result => { result.headers.set("content-type", "text/html"); return result; },
    result => { result.headers.set("content-range", "bytes 1-4/128"); return result; },
    result => { result.headers.delete("content-length"); return result; },
    result => { result.headers.set("content-encoding", "gzip"); return result; }]) {
    const h = fixture({ changeBlob }); h.imported(); const res = await h.stream({ headers: { range: "bytes=0-3" } });
    assert.equal(res.statusCode, 503); assert.deepEqual(h.cancelled, [pathname]); safe(res.data);
    assert.equal(res.headers["content-disposition"], undefined); assert.equal(res.headers["content-length"], undefined);
  }
});

test("truncated and oversized private streams terminate rather than claim a completed download", async () => {
  for (const streamChunks of [[bytes.subarray(0, 127)], [bytes.subarray(0, 64), Buffer.alloc(65)]]) {
    const h = fixture({ streamChunks }); h.imported(); const res = await h.stream();
    assert.equal(res.destroyed, true); assert.ok(res.body.length < 128);
  }
});

test("unsupported methods, missing imports and private failures cannot expose media", async () => {
  const h = fixture();
  assert.equal((await h.stream({ method: "POST" })).statusCode, 405); assert.equal(h.reads.length, 0);
  const missing = await h.stream(); assert.equal(missing.statusCode, 404); assert.equal(h.gets.length, 0); safe(missing.data);
  const broken = fixture({ beforeGet: async () => { throw new Error(`${KEY} ${VIDEO} raw private transport`); } }); broken.imported();
  const failed = await broken.stream(); assert.equal(failed.statusCode, 503); safe(failed.data);
});
