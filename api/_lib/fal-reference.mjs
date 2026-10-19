import sharp from 'sharp';
import { falMediaUrl } from './fal-client.mjs';

const cache = new Map();
// Wan accepts data URIs. Normalize only newly submitted Wan references, keeping
// the full image and its dimensions while staying below its 20 MB file limit.
export async function falReferenceData(value, { fetchImpl = fetch } = {}) {
  const url = falMediaUrl(value);
  if (cache.has(url)) return cache.get(url);
  const response = await fetchImpl(url, { redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(60_000) });
  if (!response.ok || !/^image\/(png|jpeg|webp)$/.test(response.headers.get('content-type')?.split(';')[0] || '')
    || !response.body) { await response.body?.cancel(); throw new Error('The character reference could not be verified.'); }
  const reader = response.body.getReader(), chunks = []; let length = 0;
  try {
    for (;;) {
      const { done, value: chunk } = await reader.read(); if (done) break;
      length += chunk.byteLength;
      if (length > 50_000_000) throw new Error('The character reference exceeds the input limit.');
      chunks.push(chunk);
    }
  } finally { await reader.cancel().catch(() => {}); }
  const bytes = await sharp(Buffer.concat(chunks), { limitInputPixels: 40_000_000 }).rotate()
    .flatten({ background: '#ffffff' }).jpeg({ quality: 95, chromaSubsampling: '4:4:4' }).toBuffer();
  if (bytes.length < 100 || bytes.length > 15_000_000) throw new Error('The character reference could not be normalized.');
  const data = `data:image/jpeg;base64,${bytes.toString('base64')}`;
  if (cache.size >= 16) cache.delete(cache.keys().next().value);
  cache.set(url, data);
  return data;
}
