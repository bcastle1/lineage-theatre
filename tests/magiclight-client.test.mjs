import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { gzipSync, brotliCompressSync } from "node:zlib";
import { createMagicLightClient, MagicLightClientError, MAGICLIGHT_ORIGINS } from "../api/_lib/magiclight-client.mjs";
import { createFilmProductionService } from "../api/_lib/film-production.mjs";

const apiKey = "synthetic-only-key-123456789";
const taskId = "2032443088023777280";
const json = value => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
const success = data => json({ biz_code: 10000, msg: apiKey, data, trace_id: apiKey });
function fixture(options = {}) {
  const calls = [];
  const client = createMagicLightClient({ apiKey, fetchImpl: async (...args) => {
    calls.push(args); return success({ task_id: taskId, task_status: 0 });
  }, ...options });
  return { client, calls };
}
const code = expected => error => error instanceof MagicLightClientError && error.code === expected;

test("default client checks the fixed production origin and exposes only bounded task evidence", async () => {
  const { client, calls } = fixture();
  assert.deepEqual(await client.checkTask({ taskId }), { providerCode: 10000, taskStatus: 0, taskId });
  assert.equal(calls[0][0], `${MAGICLIGHT_ORIGINS.production}/api/misc/openclaw_check_task?task_id=${taskId}`);
  assert.equal(calls[0][1].headers.Authorization, `Bearer ${apiKey}`);
  assert.equal(calls[0][1].method, "GET");
  assert.equal(calls[0][1].redirect, "error");
  assert.equal(calls[0][1].cache, "no-store");
  assert.equal(calls[0][1].body, undefined);
  assert.equal(client.available, false);
  assert.equal(JSON.stringify(client).includes(apiKey), false);
  assert.equal(createFilmProductionService().readiness().available, false);
});

test("only the two published origins are selectable, with no URL override", async () => {
  const { client, calls } = fixture({ environment: "test", baseUrl: "https://untrusted.invalid" });
  await client.checkTask({ taskId });
  assert.ok(calls[0][0].startsWith("https://open-test.magiclight.ai/"));
  for (const environment of ["https://other.invalid", "__proto__", "staging", "production/../test"]) {
    assert.throws(() => fixture({ environment }), code("MAGICLIGHT_INVALID_CONFIGURATION"));
  }
});

test("task identifiers and missing credentials fail before any network call", async () => {
  const { client, calls } = fixture();
  for (const id of ["", "../secret", "a?task_id=other", "a#b", "a/b", "a\\b", "a\nb", "a%2Fb", "a".repeat(129), 123]) {
    await assert.rejects(client.checkTask({ taskId: id }), code("MAGICLIGHT_INVALID_TASK"));
  }
  assert.equal(calls.length, 0);
  for (const invalidKey of [undefined, "", "key\nsecret", "a".repeat(4097)]) {
    const bad = fixture({ apiKey: invalidKey });
    await assert.rejects(bad.client.checkTask({ taskId }), code("MAGICLIGHT_KEY_REQUIRED"));
    assert.equal(bad.calls.length, 0);
  }
});

test("unknown provider business codes remain exact evidence without guessed authentication", async () => {
  for (const providerCode of [10002, 401, 0, -1]) {
    const { client } = fixture({ fetchImpl: async () => json({ biz_code: providerCode, msg: apiKey, data: { apiKey } }) });
    assert.deepEqual(await client.checkTask({ taskId }), { providerCode });
  }
});

test("submission is separately disabled by default and never turns on film readiness", async () => {
  const { client, calls } = fixture();
  await assert.rejects(client.submitTask({ text: "Synthetic fictional garden." }), code("MAGICLIGHT_SUBMISSION_DISABLED"));
  assert.equal(calls.length, 0);
  assert.equal(client.available, false);
  assert.equal(createFilmProductionService({ adapter: client }).readiness().available, false);
});

test("explicit submission sends the documented body exactly once, without fetching the image", async () => {
  const { client, calls } = fixture({ enableSubmission: true });
  assert.deepEqual(await client.submitTask({ text: "Synthetic fictional garden.", imageUrl: "https://images.example.invalid/fictional.png" }), { providerCode: 10000, taskId });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], `${MAGICLIGHT_ORIGINS.production}/api/misc/openclaw_add_task`);
  assert.equal(calls[0][1].method, "POST");
  assert.equal(calls[0][1].headers["X-DashScope-Async"], "enable");
  assert.deepEqual(JSON.parse(calls[0][1].body), { text: "Synthetic fictional garden.", image_url: "https://images.example.invalid/fictional.png" });
});

test("numeric provider task IDs retain their exact digits through submission and polling", async () => {
  const exactId = "2032443088023777281", calls = [];
  const { client } = fixture({ enableSubmission: true, fetchImpl: async (url, options) => {
    calls.push({ url, method: options.method });
    return new Response(`{"biz_code":10000,"data":{"task_id":${exactId},"task_status":1}}`, {
      headers: { "content-type": "application/json" },
    });
  } });
  const submitted = await client.submitTask({ text: "Fictional test", imageUrl: "https://images.example.invalid/test.png" });
  assert.equal(submitted.taskId, exactId);
  assert.equal((await client.checkTask({ taskId: submitted.taskId })).taskId, exactId);
  assert.equal(calls.length, 2);
  assert.ok(calls[1].url.endsWith(`task_id=${exactId}`));
  for (const invalidToken of ["1.5", "-1", "2e18"]) {
    const bad = fixture({ enableSubmission: true, fetchImpl: async () => new Response(`{"biz_code":10000,"data":{"task_id":${invalidToken}}}`, {
      headers: { "content-type": "application/json" },
    }) });
    await assert.rejects(bad.client.submitTask({ text: "Fictional test" }), error => error.code === "MAGICLIGHT_INVALID_RESPONSE" && error.submissionUncertain);
  }
});

test("invalid submission inputs never dispatch", async () => {
  const { client, calls } = fixture({ enableSubmission: true });
  for (const text of [undefined, "", " ", "a".repeat(100001), "é".repeat(50001)]) {
    await assert.rejects(client.submitTask({ text }), code("MAGICLIGHT_INVALID_TEXT"));
  }
  for (const imageUrl of ["http://example.invalid/x", "file:///secret", "https://user:secret@example.invalid/x", "https://example.invalid:444/x", "https://example.invalid/x#fragment"]) {
    await assert.rejects(client.submitTask({ text: "Fictional scene", imageUrl }), code("MAGICLIGHT_INVALID_URL"));
  }
  assert.equal(calls.length, 0);
});

test("submission transport failure never retries and marks the result uncertain without leaking secrets", async () => {
  let calls = 0;
  const { client } = fixture({ enableSubmission: true, fetchImpl: async () => { calls++; throw new Error(`transport leaked ${apiKey}`); } });
  await assert.rejects(client.submitTask({ text: "Fictional scene" }), error => {
    assert.equal(error.code, "MAGICLIGHT_TRANSPORT_FAILED");
    assert.equal(error.submissionUncertain, true);
    assert.equal(`${error.stack}${JSON.stringify(error)}`.includes(apiKey), false);
    return true;
  });
  assert.equal(calls, 1);
});

test("uncertain malformed/rejected submissions never retry", async () => {
  for (const data of [{ biz_code: 10001, msg: apiKey }, { biz_code: 10000, data: {} }, { biz_code: 10000, data: { task_id: apiKey } }]) {
    let calls = 0;
    const { client } = fixture({ enableSubmission: true, fetchImpl: async () => { calls++; return json(data); } });
    await assert.rejects(client.submitTask({ text: "Fictional scene" }), error => {
      assert.equal(error.submissionUncertain, true);
      assert.equal(`${error.stack}${JSON.stringify(error)}`.includes(apiKey), false);
      return true;
    });
    assert.equal(calls, 1);
  }
});

test("HTTP rejection records only the HTTP status and cancels its untrusted body", async () => {
  for (const status of [301, 401, 403, 429, 500]) {
    let cancelled = false;
    const body = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(apiKey)); }, cancel() { cancelled = true; } });
    const { client } = fixture({ fetchImpl: async () => new Response(body, { status }) });
    await assert.rejects(client.checkTask({ taskId }), error => {
      assert.equal(error.code, "MAGICLIGHT_HTTP_REJECTED");
      assert.equal(error.httpStatus, status);
      assert.equal(`${error.stack}${JSON.stringify(error)}`.includes(apiKey), false);
      return true;
    });
    assert.equal(cancelled, true);
  }
});

test("streaming byte caps cancel oversized bodies even without Content-Length", async () => {
  let cancelled = false, reads = 0;
  const body = new ReadableStream({ pull(controller) { reads++; controller.enqueue(new Uint8Array(65536)); }, cancel() { cancelled = true; } });
  const { client } = fixture({ fetchImpl: async () => new Response(body, { headers: { "content-type": "application/json" } }) });
  await assert.rejects(client.checkTask({ taskId }), code("MAGICLIGHT_RESPONSE_TOO_LARGE"));
  assert.equal(cancelled, true);
  assert.ok(reads <= 4);
});

test("truncated, non-JSON, malformed and schema-mismatched responses fail closed", async () => {
  const responses = [
    () => new Response('{"biz_code":10000,', { headers: { "content-type": "application/json" } }),
    () => new Response("{}", { headers: { "content-type": "text/html" } }),
    () => new Response("{}", { headers: { "content-type": "application/json", "content-length": "99999999" } }),
    () => new Response('{"biz_code":10001}', { headers: { "content-type": "application/json", "content-length": "100" } }),
    () => json({ biz_code: "10000", data: {} }),
    () => success({ task_id: "different", task_status: 0 }),
    () => success({ task_status: "2" }),
    () => success({ task_status: 2 }),
    () => success({ task_status: 2, video_url: `https://media.example.invalid/${apiKey}.mp4` }),
    () => success({ task_status: 2, video_url: "file:///secret" }),
  ];
  for (const response of responses) {
    const { client } = fixture({ fetchImpl: async () => response() });
    await assert.rejects(client.checkTask({ taskId }), error => error instanceof MagicLightClientError && !JSON.stringify(error).includes(apiKey));
  }
});

test("known complete output is returned as an unfetched URL; failed/unknown statuses are not renamed", async () => {
  let calls = 0;
  const { client } = fixture({ fetchImpl: async () => { calls++; return success({ task_status: 2, task_id: taskId, video_url: "https://media.example.invalid/fictional.mp4" }); } });
  assert.deepEqual(await client.checkTask({ taskId }), { providerCode: 10000, taskStatus: 2, taskId, videoUrl: "https://media.example.invalid/fictional.mp4" });
  assert.equal(calls, 1);
  for (const taskStatus of [0, 1, 3, 999]) {
    const fix = fixture({ fetchImpl: async () => success({ task_status: taskStatus }) });
    assert.deepEqual(await fix.client.checkTask({ taskId }), { providerCode: 10000, taskStatus });
  }
});

test("deadline covers a hung fetch and aborts without POST retry", async () => {
  let calls = 0, signal;
  const { client } = fixture({ enableSubmission: true, requestTimeoutMs: 10, fetchImpl: async (_url, options) => {
    calls++; signal = options.signal; return new Promise(() => {});
  } });
  await assert.rejects(client.submitTask({ text: "Fictional scene" }), error => error.code === "MAGICLIGHT_TIMEOUT" && error.submissionUncertain);
  assert.equal(calls, 1);
  assert.equal(signal.aborted, true);
});

test("deadline also covers a stalled response body and cancels the reader", async () => {
  let cancelled = false;
  const body = new ReadableStream({ pull() { return new Promise(() => {}); }, cancel() { cancelled = true; } });
  const { client } = fixture({ requestTimeoutMs: 10, fetchImpl: async () => new Response(body, { headers: { "content-type": "application/json" } }) });
  await assert.rejects(client.checkTask({ taskId }), code("MAGICLIGHT_TIMEOUT"));
  assert.equal(cancelled, true);
});

test("a transport resolving after the deadline still has its response cancelled", async () => {
  let complete, cancelled = false;
  const { client } = fixture({ requestTimeoutMs: 10, fetchImpl: () => new Promise(resolve => { complete = resolve; }) });
  await assert.rejects(client.checkTask({ taskId }), code("MAGICLIGHT_TIMEOUT"));
  complete(new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { "content-type": "application/json" } }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(cancelled, true);
});

test("native fetch accepts gzip/Brotli JSON with compressed Content-Length and still bounds decoded bytes", async t => {
  let encoding = "gzip", payload = { biz_code: 10000, data: { task_status: 0 } };
  const server = createServer((_request, response) => {
    const raw = Buffer.from(JSON.stringify(payload));
    const compressed = encoding === "gzip" ? gzipSync(raw) : brotliCompressSync(raw);
    assert.notEqual(compressed.length, raw.length);
    response.writeHead(200, { "content-type": "application/json", "content-encoding": encoding, "content-length": compressed.length });
    response.end(compressed);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => { const closed = new Promise(resolve => server.close(resolve)); server.closeAllConnections(); await closed; });
  const localOrigin = `http://127.0.0.1:${server.address().port}`;
  const { client } = fixture({ fetchImpl: (url, options) => {
    assert.equal(new URL(url).origin, MAGICLIGHT_ORIGINS.production);
    return fetch(`${localOrigin}${new URL(url).pathname}`, options);
  } });
  for (encoding of ["gzip", "br"]) {
    assert.deepEqual(await client.checkTask({ taskId }), { providerCode: 10000, taskStatus: 0 });
    payload = { biz_code: 10000, data: { task_status: 0 }, padding: "x".repeat(128 * 1024) };
    await assert.rejects(client.checkTask({ taskId }), code("MAGICLIGHT_RESPONSE_TOO_LARGE"));
    payload = { biz_code: 10000, data: { task_status: 0 } };
  }
});
