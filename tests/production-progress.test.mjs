import test from 'node:test';
import assert from 'node:assert/strict';
import { createProductionProgress, productionProgressSnapshot, productionTimingProfile } from '../api/_lib/production-progress.mjs';
import { digest } from '../api/_lib/auth.mjs';
const NOW = Date.parse('2026-10-08T12:00:00Z'), at = seconds => new Date(NOW + seconds * 1000).toISOString();
const email = 'sample@example.invalid';
const history = Array.from({ length: 5 }, (_, i) => ({ id: digest(String(i)), completedAt: at(-100), totalSeconds: 1000 + i * 20, renderSeconds: 800 + i * 20 }));
function job() { return { id: 'saved-film', ownerHash: digest(email), manifestHash: 'a'.repeat(64), filmId: 'film', mode: 'customer',
  status: 'processing', productionStartedAt: at(-200), lastCheckedAt: at(0), updatedAt: at(0),
  manifest: { targetDurationSeconds: 60, style: 'Cinematic', qualityPreference: 'highest', sound: { musicRequested: true }, shots: [{ id: 'one', targetDurationMs: 30000 }, { id: 'two', targetDurationMs: 30000 }] },
  shots: [{ id: 'one', status: 'processing', submittedAt: at(-200) }, { id: 'two', status: 'prepared' }] }; }
test('uncalibrated generation cannot invent an ETA or time-driven progress', () => {
  const film = job(); const first = productionProgressSnapshot({ job: film, now: NOW });
  assert.equal(first.estimate, null); assert.equal(first.percent, 10); assert.equal(first.timing, 'learning');
  assert.equal(productionProgressSnapshot({ job: { ...film, lastCheckedAt: at(800) }, now: NOW + 800000 }).percent, 10);
  assert.equal(productionProgressSnapshot({ job: film, history: history.slice(0, 4), now: NOW }).estimate, null);
});
test('measured progress advances within the unfinished scene and yields a delivery window', () => {
  const film = job(), early = productionProgressSnapshot({ job: film, history, now: NOW });
  const later = productionProgressSnapshot({ job: { ...film, lastCheckedAt: at(100) }, history, now: NOW + 100000 });
  assert.ok(later.percent > early.percent); assert.ok(later.percent < 48);
  assert.equal(later.timing, 'available'); assert.equal(later.estimate.sampleCount, 5);
  assert.equal(early.estimate.latestAt, later.estimate.latestAt, 'polling cannot move the promised window into the future');
  assert.doesNotMatch(JSON.stringify(later), /magiclight|provider|taskId|sample@example|url/i);
});
test('stale observations freeze the last estimate and suppress the countdown', () => {
  const film = job(), fresh = productionProgressSnapshot({ job: film, history, now: NOW });
  const stale = productionProgressSnapshot({ job: film, history, now: NOW + 601000 });
  assert.equal(stale.percent, fresh.percent); assert.equal(stale.timing, 'stale'); assert.equal(stale.estimate, null);
});
test('overdue jobs cannot crawl into finishing or report zero time remaining', () => {
  const film = { ...job(), lastCheckedAt: at(2000) };
  const result = productionProgressSnapshot({ job: film, history, now: NOW + 2000000 });
  assert.equal(result.timing, 'delayed'); assert.equal(result.estimate, null); assert.ok(result.percent < 48);
  assert.equal(result.stage, 'creating');
});
test('weighted completed work and delivery verification control later stages', () => {
  const film = job(); film.shots[0].status = 'completed';
  assert.equal(productionProgressSnapshot({ job: film, now: NOW }).percent, 47);
  film.status = 'awaiting-assembly'; assert.equal(productionProgressSnapshot({ job: film, now: NOW }).percent, 90);
  film.status = 'completed'; assert.equal(productionProgressSnapshot({ job: film, now: NOW }).percent, 90);
  assert.equal(productionProgressSnapshot({ job: film, mediaReady: true, now: NOW }).percent, 100);
  assert.equal(productionProgressSnapshot({ job: film, needsAttention: true, now: NOW }).percent, null);
});
test('legacy pilot timing never borrows full-film estimates', () => {
  const film = { ...job(), status: 'prepared' };
  const result = productionProgressSnapshot({ job: film, history, attempt: { status: 'processing', submittedAt: at(-200), updatedAt: at(0) }, now: NOW });
  assert.equal(result.stage, 'creating'); assert.equal(result.estimate, null);
});
test('timing profiles separate model versions, runtimes, quality and sound', () => {
  const film = job(), adapter = { id: 'magiclight', environment: 'production', timingVersion: 1 }, original = productionTimingProfile(film, adapter);
  for (const change of [{ timingVersion: 2 }, { environment: 'sandbox' }, { id: 'other' }]) assert.notEqual(productionTimingProfile(film, { ...adapter, ...change }), original);
  for (const change of [{ targetDurationSeconds: 120 }, { style: 'Documentary' }, { qualityPreference: 'draft' }, { sound: { musicRequested: false } }])
    assert.notEqual(productionTimingProfile({ ...film, manifest: { ...film.manifest, ...change } }, adapter), original);
});
test('recording samples is idempotent, private and excludes test/uncertain runs', async () => {
  const records = new Map(); let serial = 0;
  const read = async path => structuredClone(records.get(path) || null);
  const write = async (path, value, etag) => { if (records.get(path)?.etag !== etag) throw Error('conflict'); records.set(path, { value, etag: String(++serial) }); };
  const service = createProductionProgress({ read, write, now: () => NOW });
  const film = { ...job(), status: 'completed', media: { pathname: 'PRIVATE' }, authorization: { environment: 'production' }, timingProfile: 'a'.repeat(64), finishingStartedAt: at(-20), completedAt: at(0) };
  await Promise.all([service.record(film), service.record(film)]);
  assert.equal([...records.values()][0].value.samples.length, 1);
  for (const patch of [{ mode: 'operator-test' }, { timingDisrupted: true }, { authorization: { environment: 'sandbox' } }, { completedAt: at(1) }, { media: undefined }])
    await service.record({ ...film, id: 'new-film', ...patch });
  assert.equal([...records.values()][0].value.samples.length, 1);
  assert.doesNotMatch(JSON.stringify([...records.values()]), /PRIVATE|sample@example|magiclight|ownerHash/);
  const baseline = await service.calibrate(film); assert.equal(baseline.samples.length, 1);
});
test('private generation request maps to customer attention without leaking diagnostics', async () => {
  const film = { ...job(), status: 'prepared' }, value = { version: 1, id: film.id, ownerEmail: email, filmId: film.filmId, manifestHash: film.manifestHash,
    status: 'uncertain', submittedAt: at(-400), updatedAt: at(0), diagnostic: { code: 'MAGICLIGHT_TIMEOUT' }, keyFingerprint: 'PRIVATE' };
  const service = createProductionProgress({ now: () => NOW, read: async () => ({ value }) });
  const result = await service.snapshot({ job: film, email }); assert.equal(result.stage, 'attention'); assert.equal(result.percent, null);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|MAGICLIGHT|diagnostic|sample@example/);
  value.ownerEmail = 'other@example.invalid'; assert.equal((await service.snapshot({ job: film, email })).stage, 'waiting');
});
