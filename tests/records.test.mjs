import test from "node:test";
import assert from "node:assert/strict";
import { BlobPreconditionFailedError } from "@vercel/blob";
import { readRecord, writeRecord } from "../api/_lib/auth.mjs";

function blobHarness() {
  let value = { revision: 1, padding: "Synthetic private JSON record. ".repeat(160) };
  let etag = '"stored-revision-1"';
  const reads = [], writes = [];
  return {
    reads,
    writes,
    getImpl: async (path, options) => {
      reads.push({ path, options });
      // Reproduce Blob delivery: compressed JSON has a weak response validator.
      const responseETag = options.headers?.["accept-encoding"] === "identity" ? etag : `W/${etag}`;
      return { stream: new Response(JSON.stringify(value)).body, blob: { etag: responseETag } };
    },
    putImpl: async (path, body, options) => {
      writes.push({ path, options });
      if (options.ifMatch !== etag) throw new BlobPreconditionFailedError();
      value = JSON.parse(body);
      etag = `"stored-revision-${value.revision}"`;
      return { etag };
    },
  };
}

test("private JSON reads retain the original strong ETag for a conditional update", async () => {
  const blob = blobHarness();
  const path = "qa/synthetic-record.json";
  const compressed = await blob.getImpl(path, { access: "private", useCache: false });
  assert.match(compressed.blob.etag, /^W\//);
  await new Response(compressed.stream).arrayBuffer();
  await assert.rejects(
    writeRecord(path, { revision: 2 }, compressed.blob.etag, blob),
    BlobPreconditionFailedError,
  );

  const record = await readRecord(path, blob);
  assert.equal(record.value.revision, 1);
  assert.equal(record.etag, '"stored-revision-1"');
  assert.deepEqual(blob.reads.at(-1), {
    path,
    options: { access: "private", useCache: false, headers: { "accept-encoding": "identity" } },
  });
  const saved = await writeRecord(path, { ...record.value, revision: 2 }, record.etag, blob);
  assert.equal(saved.etag, '"stored-revision-2"');
  assert.equal(blob.writes.at(-1).options.ifMatch, record.etag);
  assert.equal(blob.writes.at(-1).options.allowOverwrite, true);
});

test("strong ETags still reject a stale writer without overwriting the newer record", async () => {
  const blob = blobHarness();
  const path = "qa/synthetic-record.json";
  const first = await readRecord(path, blob);
  const competing = await readRecord(path, blob);
  await writeRecord(path, { revision: 2 }, first.etag, blob);
  await assert.rejects(
    writeRecord(path, { revision: 3 }, competing.etag, blob),
    BlobPreconditionFailedError,
  );
  assert.deepEqual((await readRecord(path, blob)).value, { revision: 2 });
});

test("reads never manufacture a strong ETag if a provider returns a weak validator", async () => {
  const etag = 'W/"unexpected-weak-validator"';
  const record = await readRecord("qa/synthetic-record.json", {
    getImpl: async () => ({ stream: new Response("{}").body, blob: { etag } }),
  });
  assert.equal(record.etag, etag);
});

test("absent private JSON records still return null", async () => {
  assert.equal(await readRecord("qa/missing.json", { getImpl: async () => null }), null);
  assert.equal(await readRecord("qa/missing.json", { getImpl: async () => ({ stream: null }) }), null);
});
