import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHmac } from "node:crypto";
import { Writable } from "node:stream";
import {
  createMediaLibrary,
  sourceRecordPath,
  MAX_SOURCE_BYTES,
} from "../api/_lib/media-library.mjs";
import { createMediaHandler } from "../api/media.mjs";
import { userPath } from "../api/_lib/auth.mjs";
import { parseRange } from "../api/_lib/archive.mjs";

const customer = {
  email: "family@example.invalid",
  role: "customer",
  status: "active",
  approvedAt: "2026-09-01T00:00:00Z",
  approvedBy: "erik@brocotech.ai",
};
const other = { ...customer, email: "other@example.invalid" };
const admin = {
  email: "admin@example.invalid",
  role: "admin",
  status: "active",
};
const input = () => ({
  id: randomUUID(),
  name: "family-notes.txt",
  size: 25,
  retentionAccepted: true,
});
function fixture() {
  const records = new Map(),
    files = new Map(),
    audits = [];
  let revision = 0,
    clock = 1_800_000_000_000,
    failDelete = false;
  const read = async (path) => structuredClone(records.get(path) || null);
  const write = async (path, value, etag) => {
    if (records.get(path)?.etag !== etag)
      throw new Error("ETag precondition failed");
    records.set(path, {
      value: structuredClone(value),
      etag: String(++revision),
    });
  };
  records.set(userPath(customer.email), { value: customer, etag: "customer" });
  records.set(userPath(other.email), { value: other, etag: "other" });
  const list = async ({ prefix, cursor, limit }) => {
    const paths = [...records.keys()]
      .filter((path) => path.startsWith(prefix))
      .sort();
    const start = Number(cursor || 0),
      end = start + limit;
    return {
      blobs: paths.slice(start, end).map((pathname) => ({ pathname })),
      hasMore: paths.length > end,
      cursor: String(end),
    };
  };
  const head = async (pathname) => {
    const file = files.get(pathname);
    if (!file) throw new Error("BlobNotFoundError");
    return {
      pathname,
      contentType: file.type,
      size: file.bytes.length,
      etag: "source-etag",
    };
  };
  const getBlob = async (pathname, options) => {
    const file = files.get(pathname);
    if (!file) return null;
    const range = parseRange(options.headers?.Range, file.bytes.length);
    const bytes = range
      ? file.bytes.subarray(range.start, range.end + 1)
      : file.bytes;
    return {
      stream: new Response(bytes).body,
      blob: { pathname, contentType: file.type, size: bytes.length },
      headers: new Headers(
        range ? { "content-range": range.contentRange } : {},
      ),
    };
  };
  const service = createMediaLibrary({
    read,
    write,
    list,
    head,
    del: async (path) => {
      if (failDelete) throw new Error("storage unavailable");
      files.delete(path);
    },
    audit: async (...args) => audits.push(args),
    now: () => clock,
  });
  async function uploaded(actor = customer, data = input()) {
    const result = await service.reserve(actor, data);
    const options = await service.uploadOptions(
      actor,
      result.upload.pathname,
      result.upload.clientPayload,
    );
    files.set(result.upload.pathname, {
      bytes: Buffer.alloc(data.size, 65),
      type: result.upload.contentType,
    });
    const item = await service.finalize(actor.email, data.id);
    return {
      item,
      path: result.upload.pathname,
      ticket: JSON.parse(options.tokenPayload),
      data,
    };
  }
  return {
    records,
    files,
    audits,
    service,
    uploaded,
    getBlob,
    read,
    write,
    advance: (ms) => {
      clock += ms;
    },
    failDelete: (value) => {
      failDelete = value;
    },
  };
}
class Capture extends Writable {
  constructor() {
    super();
    this.headers = {};
    this.chunks = [];
    this.statusCode = 200;
  }
  setHeader(name, value) {
    this.headers[name.toLowerCase()] = value;
  }
  removeHeader(name) {
    delete this.headers[name.toLowerCase()];
  }
  _write(chunk, encoding, done) {
    this.chunks.push(Buffer.from(chunk));
    done();
  }
  get bytes() {
    return Buffer.concat(this.chunks);
  }
  get data() {
    return JSON.parse(this.bytes.toString());
  }
}
async function request(
  fix,
  {
    user = customer,
    method = "GET",
    url = "/api/media",
    body,
    headers = {},
    deps = {},
  } = {},
) {
  const res = new Capture();
  await createMediaHandler({
    service: fix.service,
    sessionFor: async () => (user ? { user } : null),
    limiter: async () => true,
    getBlob: fix.getBlob,
    ...deps,
  })(
    {
      method,
      url,
      body,
      headers: {
        host: "lineagetheater.com",
        origin: "https://lineagetheater.com",
        ...headers,
      },
    },
    res,
  );
  return res;
}
test("customer files are private; administrators see every owner's files and retained trash", async () => {
  const fix = fixture(),
    first = await fix.uploaded(),
    second = await fix.uploaded(other);
  assert.equal((await fix.service.listMedia(customer)).items.length, 1);
  assert.equal(
    (await fix.service.listMedia(admin, { admin: true, view: "all" })).items
      .length,
    2,
  );
  await assert.rejects(
    () => fix.service.listMedia(customer, { admin: true, view: "all" }),
    { status: 403 },
  );
  await assert.rejects(
    () => fix.service.file(customer, other.email, second.item.id),
    { status: 403 },
  );
  const trashed = await fix.service.organize(customer, {
    action: "trash",
    id: first.item.id,
    revision: first.item.revision,
  });
  assert.equal((await fix.service.listMedia(customer)).items.length, 0);
  assert.equal(
    (await fix.service.listMedia(customer, { view: "trash" })).items[0].id,
    first.item.id,
  );
  assert.equal(
    (
      await fix.service.listMedia(admin, { admin: true, view: "all" })
    ).items.find((item) => item.id === first.item.id).customerState,
    "trash",
  );
  assert.ok(fix.files.has(first.path));
  assert.equal(
    (await fix.service.file(admin, customer.email, first.item.id)).pathname,
    first.path,
  );
  await fix.service.organize(customer, {
    action: "restore",
    id: first.item.id,
    revision: trashed.item.revision,
  });
  assert.equal((await fix.service.listMedia(customer)).items.length, 1);
});
test("customer and administrator archive states are independent; rename preserves the original format", async () => {
  const fix = fixture(),
    { item } = await fix.uploaded();
  const archived = await fix.service.organize(customer, {
    action: "archive",
    id: item.id,
    revision: item.revision,
  });
  const adminArchive = await fix.service.organize(admin, {
    action: "admin-archive",
    owner: customer.email,
    id: item.id,
    revision: archived.item.revision,
  });
  const restored = await fix.service.organize(customer, {
    action: "restore",
    id: item.id,
    revision: adminArchive.item.revision,
  });
  assert.ok(restored.item.adminArchivedAt);
  assert.equal(
    (await fix.service.listMedia(admin, { admin: true, view: "archived" }))
      .items.length,
    1,
  );
  await assert.rejects(
    () =>
      fix.service.organize(customer, {
        action: "rename",
        id: item.id,
        revision: restored.item.revision,
        name: "evil.html",
      }),
    /extension/,
  );
  const renamed = await fix.service.organize(customer, {
    action: "rename",
    id: item.id,
    revision: restored.item.revision,
    name: "new-name.txt",
  });
  assert.equal(renamed.item.originalName, "family-notes.txt");
  assert.equal(renamed.item.name, "new-name.txt");
  await assert.rejects(
    () =>
      fix.service.organize(customer, {
        action: "trash",
        id: item.id,
        revision: item.revision,
      }),
    { status: 409 },
  );
});
test("only an administrator can purge an archived file with explicit confirmation after upload tokens expire", async () => {
  const fix = fixture(),
    upload = await fix.uploaded();
  const { item } = upload;
  const command = {
    action: "purge",
    id: item.id,
    owner: customer.email,
    revision: item.revision,
    confirmation: "DELETE",
  };
  await assert.rejects(() => fix.service.organize(customer, command), {
    status: 403,
  });
  await assert.rejects(
    () => fix.service.organize(admin, command),
    /Archive the media/,
  );
  const archived = await fix.service.organize(admin, {
    ...command,
    action: "admin-archive",
  });
  command.revision = archived.item.revision;
  await assert.rejects(
    () => fix.service.organize(admin, { ...command, confirmation: "" }),
    /type DELETE/,
  );
  await assert.rejects(
    () => fix.service.organize(admin, command),
    /authorization is still active/,
  );
  fix.advance(11 * 60_000 + 1);
  await fix.service.organize(admin, command);
  assert.equal(fix.files.has(upload.path), false);
  assert.equal(
    (await fix.service.listMedia(admin, { admin: true, view: "all" })).items
      .length,
    0,
  );
  assert.equal(
    (await fix.read(sourceRecordPath(customer.email, item.id))).value.name,
    undefined,
  );
  await assert.rejects(
    () => fix.service.finalize(customer.email, item.id, upload.ticket),
    { status: 410 },
  );
  await assert.rejects(() => fix.service.reserve(customer, upload.data), {
    status: 409,
  });
  assert.equal(fix.audits[0][1], "media.purge");
});
test("a storage deletion failure leaves a blocked, retryable archive record", async () => {
  const fix = fixture(),
    upload = await fix.uploaded();
  const archived = await fix.service.organize(admin, {
    action: "admin-archive",
    owner: customer.email,
    id: upload.item.id,
    revision: upload.item.revision,
  });
  fix.advance(11 * 60_000 + 1);
  fix.failDelete(true);
  await assert.rejects(() =>
    fix.service.organize(admin, {
      action: "purge",
      owner: customer.email,
      id: upload.item.id,
      revision: archived.item.revision,
      confirmation: "DELETE",
    }),
  );
  await assert.rejects(
    () => fix.service.file(customer, customer.email, upload.item.id),
    { status: 404 },
  );
  const retry = (
    await fix.service.listMedia(admin, { admin: true, view: "archived" })
  ).items[0];
  assert.equal(retry.status, "deleting");
  fix.failDelete(false);
  await fix.service.organize(admin, {
    action: "purge",
    owner: customer.email,
    id: retry.id,
    revision: retry.revision,
    confirmation: "DELETE",
  });
  assert.equal(fix.files.size, 0);
});
test("upload reservations reject bad types, names, sizes, missing notice and path changes", async () => {
  const fix = fixture();
  for (const patch of [
    { name: "evil.html" },
    { name: "../photo.jpg" },
    { size: 0 },
    { size: MAX_SOURCE_BYTES + 1 },
    { retentionAccepted: false },
    { id: "../escape" },
  ]) {
    await assert.rejects(() =>
      fix.service.reserve(customer, { ...input(), ...patch }),
    );
  }
  const data = input(),
    saved = await fix.service.reserve(customer, data);
  await assert.rejects(
    () =>
      fix.service.uploadOptions(
        customer,
        saved.upload.pathname + "other",
        saved.upload.clientPayload,
      ),
    { status: 409 },
  );
  await assert.rejects(
    () => fix.service.reserve(customer, { ...data, size: 26 }),
    { status: 409 },
  );
  const options = await fix.service.uploadOptions(
    customer,
    saved.upload.pathname,
    saved.upload.clientPayload,
  );
  assert.equal(options.allowOverwrite, false);
  assert.equal(options.maximumSizeInBytes, data.size);
  assert.deepEqual(options.allowedContentTypes, ["text/plain"]);
  assert.equal((await fix.service.reserve(customer, data)).resumed, true);
});
test("upload finalization checks size, content type, current account approval, and signed ticket", async () => {
  const fix = fixture(),
    data = input(),
    saved = await fix.service.reserve(customer, data);
  await assert.rejects(() => fix.service.finalize(customer.email, data.id), {
    status: 409,
  });
  fix.files.set(saved.upload.pathname, {
    bytes: Buffer.alloc(25),
    type: "text/html",
  });
  await assert.rejects(
    () => fix.service.finalize(customer.email, data.id),
    /approved size and format/,
  );
  fix.files.set(saved.upload.pathname, {
    bytes: Buffer.alloc(25),
    type: "text/plain",
  });
  await assert.rejects(
    () =>
      fix.service.finalize(customer.email, data.id, {
        pathname: saved.upload.pathname,
        nonce: "bad",
      }),
    { status: 403 },
  );
  const old = await fix.read(userPath(customer.email));
  await fix.write(
    userPath(customer.email),
    { ...customer, status: "suspended" },
    old.etag,
  );
  await assert.rejects(() => fix.service.finalize(customer.email, data.id), {
    status: 403,
  });
});
test("list pagination preserves cursors even when the selected state has no matches on a page", async () => {
  const fix = fixture();
  for (let n = 0; n < 51; n++) await fix.service.reserve(customer, input());
  const first = await fix.service.listMedia(customer, { view: "trash" });
  assert.equal(first.items.length, 0);
  assert.ok(first.cursor);
  const next = await fix.service.listMedia(customer, { cursor: first.cursor });
  assert.equal(next.items.length, 1);
});
test("route enforces sessions, same-origin writes, limits, and private byte/range delivery", async () => {
  const fix = fixture(),
    upload = await fix.uploaded();
  assert.equal((await request(fix, { user: null })).statusCode, 401);
  assert.equal(
    (await request(fix, { user: { ...customer, mustChangePassword: true } }))
      .statusCode,
    401,
  );
  assert.equal(
    (
      await request(fix, {
        method: "POST",
        headers: { origin: "https://attacker.invalid" },
        body: { action: "reserve", ...input() },
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await request(fix, {
        method: "POST",
        body: { action: "reserve", ...input() },
        deps: { limiter: async () => false },
      })
    ).statusCode,
    429,
  );
  assert.equal(
    (await request(fix, { url: "/api/media?scope=admin&view=all" })).statusCode,
    403,
  );
  const url = `/api/media?action=file&owner=${customer.email}&id=${upload.item.id}`;
  assert.equal((await request(fix, { user: other, url })).statusCode, 403);
  const full = await request(fix, { url });
  assert.equal(full.bytes.length, 25);
  assert.match(full.headers["content-disposition"], /^attachment/);
  assert.match(full.headers["cache-control"], /no-store/);
  assert.equal(full.headers["x-content-type-options"], "nosniff");
  const range = await request(fix, { url, headers: { range: "bytes=2-6" } });
  assert.equal(range.statusCode, 206);
  assert.equal(range.bytes.length, 5);
  assert.equal(range.headers["content-range"], "bytes 2-6/25");
  const invalidRange = await request(fix, {
    url,
    headers: { range: "bytes=99-100" },
  });
  assert.equal(invalidRange.statusCode, 416);
  const head = await request(fix, { url, method: "HEAD" });
  assert.equal(head.bytes.length, 0);
  assert.equal(head.headers["content-length"], "25");
});
test("unsigned upload callbacks cannot finalize a file; genuine SDK signatures can", async () => {
  const fix = fixture(),
    data = input(),
    saved = await fix.service.reserve(customer, data);
  const options = await fix.service.uploadOptions(
    customer,
    saved.upload.pathname,
    saved.upload.clientPayload,
  );
  fix.files.set(saved.upload.pathname, {
    bytes: Buffer.alloc(25),
    type: "text/plain",
  });
  const body = {
    type: "blob.upload-completed",
    payload: {
      blob: { pathname: saved.upload.pathname },
      tokenPayload: options.tokenPayload,
    },
  };
  const original = process.env.BLOB_READ_WRITE_TOKEN;
  process.env.BLOB_READ_WRITE_TOKEN =
    "vercel_blob_rw_synthetic_media_test_token";
  try {
    assert.notEqual(
      (await request(fix, { user: null, method: "POST", body })).statusCode,
      200,
    );
    const signature = createHmac("sha256", process.env.BLOB_READ_WRITE_TOKEN)
      .update(JSON.stringify(body))
      .digest("hex");
    assert.equal(
      (
        await request(fix, {
          user: null,
          method: "POST",
          body,
          headers: { "x-vercel-signature": signature },
        })
      ).statusCode,
      200,
    );
  } finally {
    if (original === undefined) delete process.env.BLOB_READ_WRITE_TOKEN;
    else process.env.BLOB_READ_WRITE_TOKEN = original;
  }
  assert.equal(
    (await fix.service.listMedia(customer)).items[0].status,
    "ready",
  );
});
