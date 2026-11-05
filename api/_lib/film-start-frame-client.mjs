const failure = code => Object.assign(new Error('The starting frame needs verification before video production.'), { code });

export function createRemoteStartFrameReview({ env = process.env, fetchImpl = fetch } = {}) {
  return async ({ email, preparedId, manifestHash, shotId, referenceIdentity }) => {
    if (!/^[a-f0-9]{64}$/.test(env.LINEAGE_WORKER_SECRET || '')) throw failure('CAST_START_FRAME_UNAVAILABLE');
    const response = await fetchImpl('https://lineagetheater.com/api/production-worker', {
      method: 'POST', redirect: 'error', credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(65_000),
      headers: { Authorization: `Bearer ${env.LINEAGE_WORKER_SECRET}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'review-start-frame', email, preparedId, manifestHash, shotId, referenceIdentity }),
    });
    if (!response.ok) { await response.body?.cancel(); throw failure('CAST_START_FRAME_UNAVAILABLE'); }
    if (!response.body) throw failure('CAST_START_FRAME_UNCERTAIN');
    const reader = response.body.getReader(), chunks = []; let size = 0;
    try {
      for (;;) { const { done, value } = await reader.read(); if (done) break;
        size += value.byteLength; if (size > 8192) throw failure('CAST_START_FRAME_UNCERTAIN'); chunks.push(value); }
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch { throw failure('CAST_START_FRAME_UNCERTAIN'); }
    finally { await reader.cancel().catch(() => {}); }
  };
}
