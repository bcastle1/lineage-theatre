// Retrieve original clips and publish an existing, verified repair preview for a paid film.
import { createHash } from 'node:crypto';
import { get, put } from '@vercel/blob';
import { mkdir, readFile, writeFile, lstat, realpath } from 'node:fs/promises';
import { dirname, join, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { digest, readRecord, writeRecord, userPath } from '../api/_lib/auth.mjs';
import { OWNER_EMAIL, isOwner, accessStatusForUser } from '../api/_lib/access.mjs';
import { productionJobPath } from '../api/_lib/film-production.mjs';
import { productionQueuePath } from '../api/_lib/production-queue.mjs';
import { requireFinishedFilmPayment } from '../api/_lib/production-media.mjs';
import { falProductionAdapter, FAL_LEGACY_RECIPE_VERSION as FAL_RECIPE_VERSION } from '../api/_lib/fal-production.mjs';
import { downloadProductionClip } from './production-worker.mjs';

const HASH = /^[a-f0-9]{64}$/;
const KIND = 'lineage-paid-soundtrack-repair-v1';
const MAX_AGE = 24 * 3600_000;
const hash = value => digest(JSON.stringify(value));
const fail = code => Object.assign(new Error('The exact paid-film soundtrack recovery could not be confirmed.'), { code });
const same = (a, b) => hash(a) === hash(b);
const expectedSourceName = (index, contentType) => `source-${String(index + 1).padStart(2, '0')}.${contentType === 'video/mp4' ? 'mp4' : 'webm'}`;
function assertIdentity(input) {
  if (!HASH.test(input?.orderId || '') || !HASH.test(input.manifestHash || '')) throw fail('REPAIR_IDENTITY_INVALID');
  productionJobPath(OWNER_EMAIL, input.preparedId);
}

async function context(identity, { read = readRecord, now = Date.now } = {}) {
  assertIdentity(identity);
  const owner = await read(userPath(OWNER_EMAIL));
  if (!owner?.etag || !isOwner(owner.value) || owner.value.mustChangePassword) throw fail('REPAIR_OWNER_REQUIRED');
  const order = await read(`payments/orders/${identity.orderId}.json`), value = order?.value;
  if (!order?.etag || value?.id !== identity.orderId || value.preparedId !== identity.preparedId
    || value.manifestHash !== identity.manifestHash || value.customerEmail !== OWNER_EMAIL
    || value.productionConsent !== true || value.sandbox === true
    || value.checkoutMethod !== 'quickbooks-hosted-invoice') throw fail('REPAIR_ORDER_CHANGED');
  const email = value.customerEmail, account = await read(userPath(email));
  if (!account?.etag || account.value.email !== email || account.value.mustChangePassword
    || accessStatusForUser(account.value) !== 'approved') throw fail('REPAIR_ACCOUNT_REQUIRED');
  const jobPath = productionJobPath(email, identity.preparedId), job = await read(jobPath);
  const saved = job?.value;
  if (!job?.etag || saved?.id !== identity.preparedId || saved.ownerHash !== digest(email)
    || saved.status !== 'awaiting-assembly' || saved.mode !== 'customer' || saved.manifestHash !== identity.manifestHash
    || hash(saved.manifest) !== identity.manifestHash
    || saved.filmId !== value.filmId || saved.manifest.filmId !== value.filmId || saved.media
    || saved.provider?.id !== 'fal' || saved.provider.model !== 'wan' || saved.provider.recipe !== FAL_RECIPE_VERSION
    || !Number.isSafeInteger(saved.revision) || saved.lease?.expiresAt > now()
    || !Array.isArray(saved.shots) || saved.shots.length < 1 || saved.shots.length > 6 || saved.manifest.shots?.length !== saved.shots.length
    || saved.shots.some((shot, index) => shot.status !== 'completed' || shot.id !== saved.manifest.shots[index].id || !shot.output))
    throw fail('REPAIR_JOB_CHANGED');
  await requireFinishedFilmPayment({ job: saved, email, actor: account.value, read, now });
  const queuePath = productionQueuePath(email, identity.preparedId), queue = await read(queuePath);
  if (!queue?.etag || queue.value.version !== 1 || queue.value.email !== email || queue.value.id !== identity.preparedId
    || queue.value.orderId !== identity.orderId || queue.value.manifestHash !== identity.manifestHash
    || queue.value.state !== 'attention') throw fail('REPAIR_QUEUE_CHANGED');
  return { email, owner, account, order, job, queue, jobPath, queuePath };
}
function revisions(value) {
  return { owner: value.owner.etag, account: value.account.etag, order: value.order.etag, job: value.job.etag,
    orderHash: hash(value.order.value), jobHash: hash(value.job.value) };
}
function assertSnapshot(snapshot, current, now) {
  if (snapshot?.kind !== KIND || snapshot.version !== 1 || snapshot.owner !== OWNER_EMAIL || snapshot.email !== current.email
    || !Number.isFinite(Date.parse(snapshot.createdAt)) || Date.parse(snapshot.createdAt) > now
    || now - Date.parse(snapshot.createdAt) > MAX_AGE || !same(snapshot.revisions, revisions(current))
    || !same(snapshot.originalJob, current.job.value) || !Array.isArray(snapshot.sources) || snapshot.sources.length !== current.job.value.shots.length)
    throw fail('REPAIR_SNAPSHOT_CHANGED');
}
async function localFile(path, root) {
  const stat = await lstat(path), actual = await realpath(path), inside = relative(await realpath(root), actual);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 16 || stat.size > 250 * 1024 * 1024
    || isAbsolute(inside) || inside === '..' || inside.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`))
    throw fail('REPAIR_LOCAL_MEDIA_INVALID');
  const bytes = await readFile(actual);
  if (bytes.length !== stat.size) throw fail('REPAIR_LOCAL_MEDIA_CHANGED');
  return { path: actual, sizeBytes: bytes.length, sha256: digest(bytes) };
}
async function readJsonSnapshot(path, sha256) {
  if (!HASH.test(sha256 || '')) throw fail('REPAIR_SNAPSHOT_HASH_REQUIRED');
  const fullPath = resolve(path), info = await lstat(fullPath);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 4 * 1024 * 1024) throw fail('REPAIR_SNAPSHOT_INVALID');
  const bytes = await readFile(fullPath);
  if (digest(bytes) !== sha256) throw fail('REPAIR_SNAPSHOT_CHANGED');
  return JSON.parse(bytes.toString('utf8'));
}
async function validateLocalSources(snapshot, root) {
  for (const [index, shot] of snapshot.originalJob.shots.entries()) {
    const source = snapshot.sources[index];
    if (source.shotId !== shot.id || source.filename !== expectedSourceName(index, shot.output.contentType)
      || source.outputHash !== hash(shot.output) || !HASH.test(source.sha256 || '')) throw fail('REPAIR_SOURCE_CHANGED');
    const actual = await localFile(join(root, source.filename), root);
    if (actual.sha256 !== source.sha256 || actual.sizeBytes !== source.sizeBytes) throw fail('REPAIR_SOURCE_CHANGED');
  }
}

// Preparation is read-only against storage and the video provider. Its local
// snapshot and unchanged source clips remain available if recovery fails.
export async function preparePaidFilmSoundtrackRepair({ orderId, preparedId, manifestHash, outputDir }, dependencies = {}) {
  const read = dependencies.read || readRecord, now = dependencies.now || Date.now;
  const identity = { orderId, preparedId, manifestHash }, current = await context(identity, { read, now });
  if (current.queue.value.lease?.expiresAt > now()) throw fail('REPAIR_ALREADY_LEASED');
  const root = resolve(outputDir);
  await mkdir(dirname(root), { recursive: true });
  await mkdir(root, { mode: 0o700 });
  const sources = [];
  for (const [index, shot] of current.job.value.shots.entries()) {
    const bytes = await downloadProductionClip(shot.output, falProductionAdapter.outputHosts, dependencies);
    const filename = expectedSourceName(index, shot.output.contentType);
    await writeFile(join(root, filename), bytes, { flag: 'wx', mode: 0o600 });
    sources.push({ shotId: shot.id, filename, sizeBytes: bytes.length, sha256: digest(bytes), outputHash: hash(shot.output) });
  }
  const fresh = await context(identity, { read, now });
  if (!same(revisions(current), revisions(fresh)) || fresh.queue.etag !== current.queue.etag) throw fail('REPAIR_CHANGED_DURING_SNAPSHOT');
  const snapshot = { kind: KIND, version: 1, ...identity, owner: OWNER_EMAIL, email: current.email,
    createdAt: new Date(now()).toISOString(), revisions: revisions(current), queueEtag: current.queue.etag,
    originalJob: current.job.value, originalQueue: current.queue.value, sources,
    scope: 'Replace soundtrack only; preserve every paid video source and exact saved narration/dialogue; no provider spending.' };
  const bytes = Buffer.from(JSON.stringify(snapshot, null, 2));
  const snapshotPath = join(root, 'snapshot.json');
  await writeFile(snapshotPath, bytes, { flag: 'wx', mode: 0o600 });
  return { state: 'prepared', snapshotPath, snapshotSha256: digest(bytes), sourceCount: sources.length };
}

export async function publishPaidFilmSoundtrackPreview({ snapshotPath, snapshotSha256, buildPath, buildSha256 }, dependencies = {}) {
  const read = dependencies.read || readRecord, write = dependencies.write || writeRecord, now = dependencies.now || Date.now;
  const putBlob = dependencies.putBlob || put, getBlob = dependencies.getBlob || get;
  const snapshot = await readJsonSnapshot(snapshotPath, snapshotSha256), current = await context(snapshot, { read, now });
  assertSnapshot(snapshot, current, now());
  if (current.queue.etag !== snapshot.queueEtag || current.queue.value.lease?.expiresAt > now()) throw fail('REPAIR_QUEUE_CHANGED');
  await validateLocalSources(snapshot, dirname(resolve(snapshotPath)));
  const build = await readJsonSnapshot(buildPath, buildSha256), buildRoot = dirname(resolve(buildPath));
  if (build.kind !== KIND || build.version !== 1 || build.state !== 'preview-ready' || build.snapshotSha256 !== snapshotSha256
    || build.orderId !== snapshot.orderId || build.preparedId !== snapshot.preparedId || build.manifestHash !== snapshot.manifestHash
    || !same(build.sources, snapshot.sources) || build.speechReview?.passed !== true || !HASH.test(build.preview?.sha256 || '')
    || build.preview.manifestHash !== snapshot.manifestHash || build.preview.contentType !== 'video/mp4'
    || build.preview.technicalSample !== false || build.preview.playable !== true || build.preview.hasAudio !== true
    || !Number.isFinite(build.preview.durationSeconds)
    || Math.abs(build.preview.durationSeconds - current.job.value.manifest.targetDurationSeconds) > 1
    || !Array.isArray(build.selectedAudio) || build.selectedAudio.length !== snapshot.sources.length) throw fail('REPAIR_PREVIEW_UNCONFIRMED');
  for (const [index, selected] of build.selectedAudio.entries()) {
    if (selected.shotId !== snapshot.sources[index].shotId || typeof selected.filename !== 'string') throw fail('REPAIR_AUDIO_INVALID');
    const audio = await localFile(resolve(buildRoot, selected.filename), buildRoot);
    if (audio.sha256 !== selected.sha256 || audio.sizeBytes !== selected.sizeBytes) throw fail('REPAIR_AUDIO_CHANGED');
  }
  const preview = await localFile(join(buildRoot, 'preview.mp4'), buildRoot);
  if (preview.sha256 !== build.preview.sha256 || preview.sizeBytes !== build.preview.sizeBytes) throw fail('REPAIR_PREVIEW_CHANGED');
  const ownerHash = digest(current.email), prefix = `production/repair-previews/${ownerHash}/${snapshot.preparedId}/`;
  const pathname = `${prefix}${preview.sha256}.mp4`, metadataPath = `${prefix}current.json`;
  const before = await read(metadataPath);
  const local = await readFile(preview.path);
  if (digest(local) !== preview.sha256) throw fail('REPAIR_PREVIEW_CHANGED');
  try { await putBlob(pathname, local, { access: 'private', addRandomSuffix: false, allowOverwrite: false,
    contentType: 'video/mp4', cacheControlMaxAge: 60 }); } catch { /* Only exact private readback confirms an immutable upload. */ }
  const stored = await getBlob(pathname, { access: 'private', useCache: false });
  if (!stored?.stream || stored.blob?.pathname !== pathname || stored.blob.size !== preview.sizeBytes || stored.blob.contentType !== 'video/mp4') {
    await stored?.stream?.cancel().catch(() => {}); throw fail('REPAIR_PREVIEW_UPLOAD_UNCONFIRMED');
  }
  const reader = stored.stream.getReader(), checksum = createHash('sha256'); let length = 0;
  try {
    for (;;) {
      const chunk = await reader.read(); if (chunk.done) break;
      length += chunk.value.length;
      if (length > preview.sizeBytes) throw fail('REPAIR_PREVIEW_UPLOAD_UNCONFIRMED');
      checksum.update(chunk.value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  if (length !== preview.sizeBytes || checksum.digest('hex') !== preview.sha256) throw fail('REPAIR_PREVIEW_UPLOAD_UNCONFIRMED');
  const fresh = await context(snapshot, { read, now }); assertSnapshot(snapshot, fresh, now());
  if (fresh.queue.etag !== snapshot.queueEtag) throw fail('REPAIR_QUEUE_CHANGED');
  const metadata = { kind: 'soundtrack-repair-preview-v1', version: 1, preview: true, ownerHash,
    preparedId: snapshot.preparedId, orderId: snapshot.orderId, filmId: fresh.job.value.filmId, manifestHash: snapshot.manifestHash,
    jobRevision: fresh.job.value.revision, jobHash: hash(fresh.job.value), jobEtag: fresh.job.etag, orderEtag: fresh.order.etag,
    snapshotSha256, buildSha256, sha256: preview.sha256, sizeBytes: preview.sizeBytes, contentType: 'video/mp4',
    durationSeconds: build.preview.durationSeconds, pathname, createdAt: new Date(now()).toISOString() };
  await write(metadataPath, metadata, before?.etag);
  if (!same((await read(metadataPath))?.value, metadata)) throw fail('REPAIR_PREVIEW_RECORD_UNCONFIRMED');
  return { state: 'preview-published', preparedId: snapshot.preparedId, sha256: preview.sha256,
    mediaUrl: `/api/studio?action=productionRepairPreview&id=${snapshot.preparedId}&artifact=${preview.sha256}`,
    completed: false, providerSubmissions: 0 };
}

async function main() {
  const [action, ...args] = process.argv.slice(2), parsed = {};
  if (['build', 'review-built', 'apply'].includes(action)) throw fail('REPAIR_SOUNDTRACK_MODEL_RETIRED');
  for (let index = 0; index < args.length; index += 2) {
    if (!args[index]?.startsWith('--') || !args[index + 1] || Object.hasOwn(parsed, args[index])) throw fail('REPAIR_ARGUMENTS_INVALID');
    parsed[args[index]] = args[index + 1];
  }
  let result;
  if (action === 'prepare' && Object.keys(parsed).length === 4 && ['--order-id', '--prepared-id', '--manifest-hash', '--output-dir'].every(key => parsed[key]))
    result = await preparePaidFilmSoundtrackRepair({ orderId: parsed['--order-id'], preparedId: parsed['--prepared-id'], manifestHash: parsed['--manifest-hash'], outputDir: parsed['--output-dir'] });
  else if (action === 'publish-preview' && Object.keys(parsed).length === 4 && ['--snapshot', '--snapshot-sha256', '--build', '--build-sha256'].every(key => parsed[key]))
    result = await publishPaidFilmSoundtrackPreview({ snapshotPath: parsed['--snapshot'], snapshotSha256: parsed['--snapshot-sha256'],
      buildPath: parsed['--build'], buildSha256: parsed['--build-sha256'] });
  else throw fail('REPAIR_ARGUMENTS_INVALID');
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => {
  const code = /^REPAIR_[A-Z_]+$/.test(error?.code || '') ? error.code : 'REPAIR_FAILED';
  process.stdout.write(`${JSON.stringify({ state: 'not-confirmed', code })}\n`);
  process.exitCode = 1;
});
