import { createHash } from 'node:crypto';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const failure = () => Object.assign(Error('The production authorization evidence changed.'), { code: 'VISUAL_REVIEW_AUTH_REQUIRED' });

// Initial callers still run every domain validator and every storage read.
// This captures only fingerprints, never a resolved-record cache. A later
// bounded parallel pass proves that the validated evidence is unchanged while
// the original payment deadline still holds.
export function createRecordValidationSnapshot({ read, listBlobs, now = Date.now, concurrency = 8 } = {}) {
  const records = new Map(), listings = new Map();
  let invalid = false, sealed = false, pending = 0;
  const need = value => { if (!value || invalid) { invalid = true; throw failure(); } };
  need(typeof read === 'function' && typeof listBlobs === 'function' && typeof now === 'function'
    && Number.isSafeInteger(concurrency) && concurrency >= 1 && concurrency <= 16);
  function recordFingerprint(value) {
    if (value === null || value === undefined) return 'absent';
    need(typeof value === 'object' && typeof value.etag === 'string' && value.etag.length > 0
      && value.etag.length <= 256 && value.value !== undefined);
    return hash({ etag: value.etag, valueHash: hash(value.value) });
  }
  function listRequest(args) {
    need(args && typeof args === 'object' && !Array.isArray(args)
      && ['limit,prefix', 'cursor,limit,prefix'].includes(Object.keys(args).sort().join(','))
      && typeof args.prefix === 'string' && args.prefix.length > 0 && args.prefix.length <= 512
      && Number.isSafeInteger(args.limit) && args.limit >= 1 && args.limit <= 32
      && (args.cursor === undefined || typeof args.cursor === 'string' && args.cursor.length > 0 && args.cursor.length <= 4096));
    return { prefix: args.prefix, limit: args.limit, ...(args.cursor === undefined ? {} : { cursor: args.cursor }) };
  }
  function listFingerprint(value, args) {
    need(value && Array.isArray(value.blobs) && value.blobs.length <= args.limit && typeof value.hasMore === 'boolean');
    const paths = value.blobs.map(blob => blob?.pathname);
    need(paths.every(path => typeof path === 'string' && path.startsWith(args.prefix) && path.length <= 1024)
      && new Set(paths).size === paths.length
      && (!value.hasMore || typeof value.cursor === 'string' && value.cursor.length > 0 && value.cursor.length <= 4096));
    return hash({ paths: paths.sort(), hasMore: value.hasMore, cursor: value.hasMore ? value.cursor : null });
  }
  async function trackedRead(path) {
    need(!sealed && typeof path === 'string' && path.length > 0 && path.length <= 1024);
    pending++;
    try {
      const value = await read(path), fingerprint = recordFingerprint(value), previous = records.get(path);
      need(previous === undefined || previous === fingerprint);
      records.set(path, fingerprint); need(records.size <= 256);
      return value;
    } catch { invalid = true; throw failure(); }
    finally { pending--; }
  }
  async function trackedList(args) {
    need(!sealed); const request = listRequest(args), key = JSON.stringify(request); pending++;
    try {
      const value = await listBlobs(request), fingerprint = listFingerprint(value, request), previous = listings.get(key);
      need(!previous || previous.fingerprint === fingerprint);
      listings.set(key, { request, fingerprint }); need(listings.size <= 32);
      return value;
    } catch { invalid = true; throw failure(); }
    finally { pending--; }
  }
  async function recheck({ expiresAt } = {}) {
    const until = typeof expiresAt === 'string' ? Date.parse(expiresAt) : NaN;
    const fresh = () => need(Number.isFinite(until) && Number.isFinite(now()) && now() < until);
    need(!pending && records.size > 0); sealed = true; fresh();
    const tasks = [
      ...[...records].map(([path, fingerprint]) => async () => need(recordFingerprint(await read(path)) === fingerprint)),
      ...[...listings.values()].map(({ request, fingerprint }) => async () => need(listFingerprint(await listBlobs(request), request) === fingerprint)),
    ];
    let next = 0;
    const worker = async () => {
      for (;;) {
        const index = next++; if (index >= tasks.length) return;
        fresh(); await tasks[index](); fresh();
      }
    };
    const outcomes = await Promise.allSettled(Array.from({ length: Math.min(concurrency, tasks.length) }, worker));
    need(outcomes.every(value => value.status === 'fulfilled')); fresh();
    return true;
  }
  return { read: trackedRead, listBlobs: trackedList, recheck };
}
