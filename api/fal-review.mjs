import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { get } from '@vercel/blob';
import { getSession, readRecord, userPath, digest, json } from './_lib/auth.mjs';
import { isOwner } from './_lib/access.mjs';
import { parseRange } from './_lib/archive.mjs';
import { comparisonPath } from './_lib/fal-comparison.mjs';

// Owner-only acceptance playback, separate from customer completion. This can
// review an immutable private candidate before qualifying a provider release.
export function createFalReviewHandler({ sessionFor = getSession, read = readRecord, getBlob = get } = {}) {
  return async (req, res) => {
    res.setHeader('Cache-Control', 'private, no-store'); res.setHeader('Vary', 'Cookie');
    let upstream;
    try {
      if (!['GET','HEAD'].includes(req.method)) return json(res,405,{code:'METHOD_NOT_ALLOWED'});
      const session = await sessionFor(req), actor = session?.user;
      if (!actor || actor.mustChangePassword) return json(res,401,{code:'SIGN_IN_REQUIRED'});
      const current = (await read(userPath(actor.email)))?.value;
      if (!isOwner(actor) || !isOwner(current) || current.mustChangePassword) return json(res,403,{code:'OWNER_REQUIRED'});
      const url = new URL(req.url, 'https://lineagetheater.com'), orderId = url.searchParams.get('order'), model = url.searchParams.get('model');
      if (url.searchParams.size !== 2 || url.searchParams.getAll('order').length !== 1 || url.searchParams.getAll('model').length !== 1
        || !/^[a-f0-9]{64}$/.test(orderId || '') || !['seedance','wan'].includes(model)) return json(res,400,{code:'REVIEW_INVALID'});
      const comparison = (await read(comparisonPath(orderId)))?.value;
      const candidate = (await read(`production/fal/candidates/${orderId}/${model}.json`))?.value;
      const media = candidate?.artifact;
      if (!comparison || comparison.approvedBy !== actor.email || candidate?.model !== model || candidate.orderId !== orderId
        || candidate.manifestHash !== comparison.manifestHash || media?.manifestHash !== comparison.manifestHash
        || !/^[a-f0-9]{64}$/.test(media?.sha256 || '') || media.pathname !== `production/media/${digest(comparison.customerEmail)}/${comparison.preparedId}/${media.sha256}.mp4`
        || media.contentType !== 'video/mp4' || !Number.isSafeInteger(media.sizeBytes) || media.sizeBytes < 16 || media.sizeBytes > 250*1024*1024
        || media.playable !== true || media.technicalSample !== false || media.hasAudio !== true) return json(res,404,{code:'CANDIDATE_NOT_FOUND'});
      const etag = `"sha256-${media.sha256}"`;
      let range;
      try { range = parseRange(req.headers?.['if-range'] && req.headers['if-range'] !== etag ? null : req.headers?.range, media.sizeBytes); }
      catch { res.statusCode=416; res.setHeader('Content-Range',`bytes */${media.sizeBytes}`); return res.end(); }
      const length = range?.length ?? media.sizeBytes;
      upstream = await getBlob(media.pathname,{access:'private',useCache:false,headers:{'accept-encoding':'identity',...(range?{Range:range.header}:{})}});
      if (!upstream?.stream || upstream.blob?.pathname !== media.pathname || upstream.blob.contentType !== 'video/mp4'
        || upstream.blob.size !== length || upstream.headers?.get('content-length') !== String(length)
        || upstream.headers?.get('content-range') !== (range?.contentRange ?? null)
        || ![null,'identity'].includes(upstream.headers?.get('content-encoding'))) throw new Error('Private candidate readback failed.');
      res.statusCode=range?206:200; res.setHeader('Content-Type','video/mp4'); res.setHeader('Content-Length',String(length));
      res.setHeader('Accept-Ranges','bytes'); res.setHeader('ETag',etag); res.setHeader('X-Content-Type-Options','nosniff');
      if(range)res.setHeader('Content-Range',range.contentRange);
      if(req.method==='HEAD'){await upstream.stream.cancel();upstream=undefined;return res.end();}
      const source=Readable.fromWeb(upstream.stream);upstream=undefined;let received=0;
      await pipeline(source,new Transform({transform(chunk,encoding,done){received+=chunk.length;done(received>length?new Error('Invalid length'):null,chunk);},
        flush(done){done(received===length?null:new Error('Incomplete candidate'));}}),res);
    } catch {
      await upstream?.stream?.cancel().catch(()=>{});
      if(res.headersSent){res.destroy();return;}
      for(const key of ['Content-Length','Content-Range','ETag','Accept-Ranges'])res.removeHeader?.(key);
      return json(res,503,{code:'REVIEW_UNAVAILABLE'});
    }
  };
}
export default createFalReviewHandler();
