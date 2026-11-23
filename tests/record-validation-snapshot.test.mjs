import test from 'node:test';
import assert from 'node:assert/strict';
import { createRecordValidationSnapshot } from '../api/_lib/record-validation-snapshot.mjs';

function fixture({ concurrency = 8 } = {}) {
  let clock = 1800000000000, delayed = false, scheduled = false, waiting = [], active = 0, peak = 0;
  const records = new Map(Array.from({ length: 20 }, (_, index) => [`records/${index}.json`, { etag: `version-${index}`, value: { index } }]));
  const prefixes = ['binding/', 'reviews/', 'operator-claims/'];
  const pages = new Map(prefixes.map(prefix => [prefix, { blobs: prefix === 'reviews/' ? [{ pathname: 'reviews/original.json' }] : [], hasMore: false }]));
  const reads = [], lists = [];
  // One deterministic storage round trip consumes one second, regardless of
  // how many independent requests share that round trip. No wall-clock sleeps.
  const latency = async () => {
    if (!delayed) return;
    active++; peak = Math.max(peak, active);
    await new Promise(resolve => {
      waiting.push(resolve);
      if (!scheduled) { scheduled = true; setImmediate(() => {
        scheduled = false; clock += 1000; const done = waiting; waiting = []; done.forEach(finish => finish());
      }); }
    });
    active--;
  };
  const read = async path => { reads.push(path); await latency(); return structuredClone(records.get(path) ?? null); };
  const listBlobs = async args => { lists.push(structuredClone(args)); await latency(); return structuredClone(pages.get(args.prefix)); };
  const snapshot = createRecordValidationSnapshot({ read, listBlobs, now: () => clock, concurrency });
  const capture = async () => {
    for (const path of records.keys()) await snapshot.read(path);
    await snapshot.read('absent.json');
    for (const prefix of prefixes) await snapshot.listBlobs({ prefix, limit: 32 });
  };
  return { records, pages, snapshot, read, listBlobs, reads, lists, capture, now: () => clock,
    advance: ms => { clock += ms; }, delay: () => { delayed = true; }, peak: () => peak,
    deadline: ms => new Date(clock + ms).toISOString() };
}

test('bounded parallel rechecks retain every read and list while fitting the unextended short payment deadline', async () => {
  for (const concurrency of [1, 8]) {
    const f = fixture({ concurrency }); await f.capture();
    const expiresAt = f.deadline(5000), beforeReads = f.reads.length, beforeLists = f.lists.length;
    f.delay();
    if (concurrency === 1) await assert.rejects(f.snapshot.recheck({ expiresAt }), { code: 'VISUAL_REVIEW_AUTH_REQUIRED' });
    else {
      assert.equal(await f.snapshot.recheck({ expiresAt }), true);
      assert.equal(f.reads.length - beforeReads, 21); assert.equal(f.lists.length - beforeLists, 3);
      assert.equal(f.peak(), 8); assert.ok(f.now() < Date.parse(expiresAt));
    }
  }
});

test('etag, body, absence and every recorded prefix remain current requirements', async () => {
  for (const mutate of [
    f => { f.records.get('records/0.json').etag = 'rewritten'; },
    f => { f.records.get('records/1.json').value.index = 999; },
    f => { f.records.delete('records/2.json'); },
    f => { f.records.set('absent.json', { etag: 'new', value: { claim: true } }); },
    ...['binding/', 'reviews/', 'operator-claims/'].map(prefix => f => { f.pages.get(prefix).blobs.push({ pathname: `${prefix}new-claim.json` }); }),
    f => { f.pages.get('binding/').hasMore = true; f.pages.get('binding/').cursor = 'more'; },
  ]) {
    const f = fixture(); await f.capture(); mutate(f);
    await assert.rejects(f.snapshot.recheck({ expiresAt: f.deadline(15000) }), { code: 'VISUAL_REVIEW_AUTH_REQUIRED' });
  }
});

test('repeated initial reads are fresh and a contradictory observation permanently invalidates the snapshot', async () => {
  const f = fixture();
  await f.snapshot.read('records/0.json'); await f.snapshot.read('records/0.json');
  assert.deepEqual(f.reads, ['records/0.json', 'records/0.json']);
  f.records.get('records/0.json').etag = 'changed';
  await assert.rejects(f.snapshot.read('records/0.json'));
  f.records.get('records/0.json').etag = 'version-0';
  await assert.rejects(f.snapshot.recheck({ expiresAt: f.deadline(15000) }));
  const g = fixture(); await g.snapshot.read('absent.json');
  g.records.set('absent.json', { etag: 'new', value: {} });
  await assert.rejects(g.snapshot.read('absent.json'));
});

test('fingerprints are captured before callers can mutate returned objects', async () => {
  const f = fixture(), value = await f.snapshot.read('records/0.json');
  value.etag = 'caller-change'; value.value.index = 999;
  assert.equal(await f.snapshot.recheck({ expiresAt: f.deadline(15000) }), true);
});

test('expired or malformed proof deadlines and expiration during reads never authorize', async () => {
  for (const expiresAt of [undefined, 'not-a-date', '2000-01-01T00:00:00Z']) {
    const f = fixture(); await f.capture(); const calls = f.reads.length;
    await assert.rejects(f.snapshot.recheck({ expiresAt })); assert.equal(f.reads.length, calls);
  }
  const f = fixture(); await f.capture(); f.delay();
  await assert.rejects(f.snapshot.recheck({ expiresAt: f.deadline(2000) }));
});

test('every captured pagination request is repeated and changed or unavailable listings reject', async () => {
  const responses = new Map([
    [undefined, { blobs: [{ pathname: 'claims/a.json' }], hasMore: true, cursor: 'page-two' }],
    ['page-two', { blobs: [], hasMore: false }],
  ]), requests = [];
  const snapshot = createRecordValidationSnapshot({ read: async () => null, listBlobs: async args => {
    requests.push(args.cursor); return structuredClone(responses.get(args.cursor));
  } });
  await snapshot.read('missing.json');
  await snapshot.listBlobs({ prefix: 'claims/', limit: 32 });
  await snapshot.listBlobs({ prefix: 'claims/', limit: 31, cursor: 'page-two' });
  assert.equal(await snapshot.recheck({ expiresAt: new Date(Date.now() + 15000).toISOString() }), true);
  assert.deepEqual(requests, [undefined, 'page-two', undefined, 'page-two']);
  responses.delete('page-two');
  await assert.rejects(snapshot.recheck({ expiresAt: new Date(Date.now() + 15000).toISOString() }));
});

test('failed reads, unfinished capture and additions after sealing cannot become reusable cached authority', async () => {
  let finish;
  const snapshot = createRecordValidationSnapshot({ read: async () => new Promise(resolve => { finish = resolve; }),
    listBlobs: async () => ({ blobs: [], hasMore: false }) });
  const pending = snapshot.read('record.json');
  await assert.rejects(snapshot.recheck({ expiresAt: new Date(Date.now() + 15000).toISOString() }));
  finish(null); await assert.rejects(pending);
  const f = fixture(); await f.capture(); await f.snapshot.recheck({ expiresAt: f.deadline(15000) });
  await assert.rejects(f.snapshot.read('records/0.json'));
  const failed = createRecordValidationSnapshot({ read: async () => { throw Error('Storage unavailable'); },
    listBlobs: async () => ({ blobs: [], hasMore: false }) });
  await assert.rejects(failed.read('record.json'), { code: 'VISUAL_REVIEW_AUTH_REQUIRED' });
});
