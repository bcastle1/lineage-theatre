import sharp from 'sharp';
import { falMediaUrl } from './fal-client.mjs';
import { validatedPhotoDataUrl } from './production-photo-reference.mjs';

const cache = new Map();
// The historical JPEG normalization is also the bounded download stage for
// new Kling references. It preserves the full image and removes EXIF rotation.
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

// Kling requires both sides >=300px and aspect 0.4–2.5. Preserve every pixel
// of the supplied portrait: rotate/scale and pad only, never crop or invent it.
export async function klingReferenceData(value, { fetchImpl = fetch } = {}) {
  const data = typeof value === 'string' && value.startsWith('data:')
    ? validatedPhotoDataUrl(value) : await falReferenceData(value, { fetchImpl });
  const bytes = Buffer.from(data.slice(data.indexOf(',') + 1), 'base64');
  const image = sharp(bytes, { limitInputPixels: 40_000_000, failOn: 'warning' }).rotate();
  const info = await image.metadata();
  if (!info.width || !info.height || (info.pages || 1) !== 1) throw new Error('The character reference is invalid.');
  // Prior normalization has removed EXIF rotation. fit:contain retains the
  // complete source while a bounded neutral border satisfies extreme ratios.
  const scale = Math.min(Math.max(1, 300 / Math.min(info.width, info.height)), 1600 / Math.max(info.width, info.height));
  const scaledWidth = Math.round(info.width * scale), scaledHeight = Math.round(info.height * scale);
  const width = Math.max(300, scaledWidth, Math.ceil(scaledHeight * .4));
  const height = Math.max(300, scaledHeight, Math.ceil(scaledWidth / 2.5));
  const normalized = await image.resize({ width, height, fit: 'contain', background: '#ffffff' })
    .flatten({ background: '#ffffff' }).jpeg({ quality: 90, chromaSubsampling: '4:4:4' }).toBuffer();
  if (normalized.length < 100 || normalized.length > 2 * 1024 * 1024) throw new Error('The character reference exceeds the input limit.');
  return validatedPhotoDataUrl(`data:image/jpeg;base64,${normalized.toString('base64')}`);
}
