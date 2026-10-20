import { digest, readRecord, writeRecord } from './auth.mjs';

export const FAL_MODELS = Object.freeze({
  kling: 'fal-ai/kling-video/o3/pro/reference-to-video',
  // Historical endpoint identifiers remain readable for reconciliation only.
  seedance: 'bytedance/seedance-2.5/us/reference-to-video',
  wan: 'alibaba/wan-3.0/reference-to-video',
  reference: 'fal-ai/nano-banana-pro',
});
export const FAL_MEDIA_HOSTS = Object.freeze(['v3.fal.media', 'v3b.fal.media', 'v3c.fal.media', 'fal.media']);
const ID = /^[a-zA-Z0-9_-]{8,100}$/;
const HASH = /^[a-f0-9]{64}$/;
const failure = code => Object.assign(new Error('The video provider request needs attention.'), { code });

export function falMediaUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw failure('FAL_MEDIA_INVALID'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash
    || !FAL_MEDIA_HOSTS.includes(url.hostname) || value.length > 8192) throw failure('FAL_MEDIA_INVALID');
  return url.href;
}

// Convenience URLs are supplied by fal, but are still untrusted input. Never
// forward a credential to a different origin, endpoint namespace, or request.
export function falRequestUrl(value, endpoint, requestId, kind) {
  let url;
  try { url = new URL(value); } catch { throw failure('FAL_RECEIPT_INVALID'); }
  const root = endpoint.split('/').slice(0, 2).join('/');
  const endings = kind === 'status' ? [`/requests/${requestId}/status`] : [`/requests/${requestId}`, `/requests/${requestId}/response`];
  if (!ID.test(requestId) || url.origin !== 'https://queue.fal.run' || url.username || url.password || url.search || url.hash
    || ![root, endpoint].some(prefix => endings.some(end => url.pathname === `/${prefix}${end}`))) throw failure('FAL_RECEIPT_INVALID');
  return url.href;
}

async function boundedJson(response) {
  if (!response.body) throw failure('FAL_RESPONSE_INVALID');
  const reader = response.body.getReader(); let size = 0; const chunks = [];
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > 2_000_000) throw failure('FAL_RESPONSE_INVALID');
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch { throw failure('FAL_RESPONSE_INVALID'); }
  finally { await reader.cancel().catch(() => {}); }
}

export const falRequestPath = identity => {
  if (!HASH.test(identity || '')) throw failure('FAL_IDENTITY_INVALID');
  return `production/fal/requests/${identity}.json`;
};

// At most one POST for a durable operation identity, including across workers.
// A timeout or lost receipt never authorizes another submission. An unresolved
// claim is retained for provider reconciliation; polling cannot create work.
export function createFalClient({ key = () => process.env.FAL_KEY, read = readRecord, write = writeRecord,
  fetchImpl = fetch, now = Date.now } = {}) {
  async function request(url, method, body, terminal = false) {
    const secret = typeof key === 'function' ? key() : key;
    if (!secret || typeof secret !== 'string') throw failure('FAL_KEY_REQUIRED');
    const response = await fetchImpl(url, { method, redirect: 'error', credentials: 'omit', cache: 'no-store',
      headers: { Authorization: `Key ${secret}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30_000) });
    if (!response.ok) {
      if (terminal && response.status === 422) {
        const body = await boundedJson(response);
        const errors = Array.isArray(body.detail) ? body.detail : [];
        throw failure(errors.length && errors.every(error => error.type === 'file_too_large')
          ? 'FAL_REFERENCE_TOO_LARGE' : 'FAL_RENDER_FAILED');
      }
      await response.body?.cancel(); throw failure(`FAL_HTTP_${response.status}`);
    }
    return boundedJson(response);
  }
  async function submit({ identity, endpoint, input }) {
    if (!Object.values(FAL_MODELS).includes(endpoint)) throw failure('FAL_MODEL_INVALID');
    const path = falRequestPath(identity), inputHash = digest(JSON.stringify(input));
    const existing = await read(path);
    if (existing) {
      if (existing.value.endpoint !== endpoint || existing.value.inputHash !== inputHash) throw failure('FAL_IDEMPOTENCY_CONFLICT');
      return existing.value;
    }
    if (![FAL_MODELS.kling, FAL_MODELS.reference].includes(endpoint)) throw failure('FAL_LEGACY_SUBMISSION_DISABLED');
    if (!(typeof key === 'function' ? key() : key)) throw failure('FAL_KEY_REQUIRED');
    const claim = { version: 1, identity, endpoint, inputHash, state: 'submitting', createdAt: new Date(now()).toISOString() };
    try { await write(path, claim); }
    catch {
      const saved = await read(path);
      if (saved?.value.endpoint === endpoint && saved.value.inputHash === inputHash) return saved.value;
      throw failure('FAL_CLAIM_UNCONFIRMED');
    }
    const stored = await read(path);
    if (!stored || stored.value.inputHash !== inputHash || stored.value.state !== 'submitting') throw failure('FAL_CLAIM_UNCONFIRMED');
    let receipt;
    try {
      const result = await request(`https://queue.fal.run/${endpoint}`, 'POST', input);
      receipt = { ...claim, state: 'queued', requestId: result.request_id,
        statusUrl: falRequestUrl(result.status_url, endpoint, result.request_id, 'status'),
        responseUrl: falRequestUrl(result.response_url, endpoint, result.request_id, 'result') };
    } catch (error) {
      const uncertain = { ...claim, state: 'uncertain', failureCode: /^FAL_[A-Z0-9_]+$/.test(error?.code || '') ? error.code : 'FAL_TRANSPORT_UNCONFIRMED' };
      try { await write(path, uncertain, stored.etag); } catch { /* Keep the claim; never resubmit. */ }
      return uncertain;
    }
    // Retrying a receipt write is safe. Retrying the generation POST is not.
    for (let attempt = 0; attempt < 3; attempt++) {
      const current = await read(path);
      if (current?.value.requestId === receipt.requestId) return current.value;
      if (!current || current.value.requestId || current.value.inputHash !== inputHash) throw failure('FAL_RECEIPT_CONFLICT');
      try { await write(path, receipt, current.etag); return receipt; } catch { /* Re-read before another conditional save. */ }
    }
    throw failure('FAL_RECEIPT_UNCONFIRMED');
  }
  async function poll(identity) {
    const path = falRequestPath(identity), record = await read(path), job = record?.value;
    if (!job) throw failure('FAL_REQUEST_MISSING');
    if (!Object.values(FAL_MODELS).includes(job.endpoint)) throw failure('FAL_MODEL_INVALID');
    if (['completed', 'failed'].includes(job.state)) return job;
    if (!job.requestId) return { ...job, state: 'uncertain' };
    const status = await request(falRequestUrl(job.statusUrl, job.endpoint, job.requestId, 'status'), 'GET');
    if (status.request_id && status.request_id !== job.requestId) throw failure('FAL_RECEIPT_CONFLICT');
    let next = { ...job, checkedAt: new Date(now()).toISOString() };
    if (status.status === 'COMPLETED') {
      if (status.error || status.error_type) next.state = 'failed';
      else {
        try {
          const result = await request(falRequestUrl(job.responseUrl, job.endpoint, job.requestId, 'result'), 'GET', undefined, true);
          next = { ...next, state: 'completed', result };
        } catch (error) {
          if (!['FAL_REFERENCE_TOO_LARGE', 'FAL_RENDER_FAILED'].includes(error.code)) throw error;
          next = { ...next, state: 'failed', failureCode: error.code };
        }
      }
    } else if (status.status === 'IN_QUEUE') next.state = 'queued';
    else if (status.status === 'IN_PROGRESS') next.state = 'processing';
    else next.state = 'uncertain';
    try { await write(path, next, record.etag); }
    catch { return (await read(path))?.value || next; }
    return next;
  }
  return { submit, poll, get: async identity => (await read(falRequestPath(identity)))?.value || null };
}
