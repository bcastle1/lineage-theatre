import { get } from '@vercel/blob';
import sharp from 'sharp';
import { digest, readRecord } from './auth.mjs';

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
const TYPES = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
const MAX_SOURCE_BYTES = 20 * 1024 * 1024, MAX_NORMALIZED_BYTES = 2 * 1024 * 1024;
const NORMALIZATION = 'jpeg-1600-q90-v1';
export class ProductionPhotoError extends Error {
  constructor(message = 'A selected character photo is unavailable or changed. Restore it in your media library and prepare the plan again.') {
    super(message); this.name = 'ProductionPhotoError'; this.code = 'PRODUCTION_PHOTO_UNAVAILABLE'; this.status = 409;
  }
}
const requireValue = condition => { if (!condition) throw new ProductionPhotoError(); };

export function validateProductionPhotoBinding(binding, sourceId) {
  requireValue(binding?.version === 1 && binding.sourceId === sourceId && UUID.test(sourceId || '')
    && HASH.test(binding.ownerHash || '') && HASH.test(binding.sha256 || '') && HASH.test(binding.normalizedSha256 || '')
    && Object.values(TYPES).includes(binding.contentType) && Number.isSafeInteger(binding.sizeBytes)
    && binding.sizeBytes > 0 && binding.sizeBytes <= MAX_SOURCE_BYTES
    && typeof binding.etag === 'string' && binding.etag.length > 0 && binding.etag.length <= 500
    && binding.normalization === NORMALIZATION);
  return binding;
}

// Reads only the source owner's exact private object. The original stays intact;
// normalization rotates and scales the entire image, never crops or generates it.
export async function readProductionPhoto({ ownerHash, sourceId, expected }, { read = readRecord, getBlob = get } = {}) {
  requireValue(HASH.test(ownerHash || '') && UUID.test(sourceId || ''));
  if (expected) { validateProductionPhotoBinding(expected, sourceId); requireValue(expected.ownerHash === ownerHash); }
  const metadataPath = `sources/metadata/${ownerHash}/${sourceId}.json`;
  const first = await read(metadataPath), record = first?.value;
  const pathname = `sources/files/${ownerHash}/${sourceId}.${record?.ext}`;
  requireValue(record?.id === sourceId && typeof record.ownerEmail === 'string' && digest(record.ownerEmail) === ownerHash
    && record.status === 'ready' && record.customerState !== 'trash' && record.pathname === pathname
    && Object.hasOwn(TYPES, record.ext) && record.contentType === TYPES[record.ext]
    && Number.isSafeInteger(record.size) && record.size > 0 && record.size <= MAX_SOURCE_BYTES
    && typeof record.etag === 'string' && record.etag.length > 0);
  const blob = await getBlob(pathname, { access: 'private', useCache: false, headers: { 'accept-encoding': 'identity' },
    abortSignal: AbortSignal.timeout(45_000) });
  let bytes;
  try {
    requireValue(blob?.stream && blob.blob.pathname === pathname && blob.blob.size === record.size
      && blob.blob.contentType === record.contentType && blob.blob.etag === record.etag);
    const chunks = []; let size = 0;
    for await (const chunk of blob.stream) {
      size += chunk.byteLength; requireValue(size <= record.size && size <= MAX_SOURCE_BYTES); chunks.push(chunk);
    }
    requireValue(size === record.size); bytes = Buffer.concat(chunks);
  } finally { if (!blob?.stream?.locked) await blob?.stream?.cancel().catch(() => {}); }
  let normalized;
  try {
    const image = sharp(bytes, { limitInputPixels: 40_000_000, failOn: 'warning' });
    const info = await image.metadata();
    requireValue(info.format === (record.ext === 'jpg' ? 'jpeg' : record.ext) && (info.pages || 1) === 1
      && info.width >= 64 && info.height >= 64);
    normalized = await image.rotate().resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
      .flatten({ background: '#ffffff' }).jpeg({ quality: 90, chromaSubsampling: '4:4:4' }).toBuffer();
    requireValue(normalized.length >= 100 && normalized.length <= MAX_NORMALIZED_BYTES);
  } catch { throw new ProductionPhotoError('A selected character photo could not be read. Use a clear JPEG, PNG or WebP up to 20 MB and prepare the plan again.'); }
  const binding = { version: 1, sourceId, ownerHash, sha256: digest(bytes), contentType: record.contentType,
    sizeBytes: bytes.length, etag: record.etag, normalization: NORMALIZATION, normalizedSha256: digest(normalized) };
  if (expected) for (const key of Object.keys(binding)) requireValue(binding[key] === expected[key]);
  const current = await read(metadataPath);
  requireValue(current?.value?.status === 'ready' && current.value.customerState !== 'trash'
    && current.value.pathname === pathname && current.value.etag === record.etag
    && current.value.ownerEmail === record.ownerEmail && current.value.size === record.size && current.value.contentType === record.contentType);
  return { binding, dataUrl: `data:image/jpeg;base64,${normalized.toString('base64')}` };
}

function selectedSource(manifest, character) {
  const sourceId = character.referencePhotoId;
  requireValue(UUID.test(sourceId || '') && character.sourceIds?.includes(sourceId)
    && manifest.sources?.some(source => source.id === sourceId && Object.values(TYPES).includes(source.type)));
  return sourceId;
}

export async function bindProductionPhotos(manifest, email, dependencies = {}) {
  const selected = manifest.screenplay.characters.filter(character => character.referencePhotoId !== undefined);
  if (!selected.length) return manifest;
  const bound = structuredClone(manifest), ownerHash = digest(email), photos = new Map();
  for (const character of bound.screenplay.characters) {
    if (character.referencePhotoId === undefined) continue;
    const sourceId = selectedSource(bound, character);
    if (!photos.has(sourceId)) photos.set(sourceId, await readProductionPhoto({ ownerHash, sourceId }, dependencies));
    character.referencePhoto = photos.get(sourceId).binding;
  }
  return bound;
}

export async function productionPhotoData(manifest, character, dependencies = {}) {
  const sourceId = selectedSource(manifest, character);
  validateProductionPhotoBinding(character.referencePhoto, sourceId);
  return (await readProductionPhoto({ ownerHash: character.referencePhoto.ownerHash, sourceId,
    expected: character.referencePhoto }, dependencies)).dataUrl;
}

export function validatedPhotoDataUrl(value) {
  requireValue(typeof value === 'string' && value.length <= Math.ceil(MAX_NORMALIZED_BYTES * 4 / 3) + 30
    && /^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(value));
  return value;
}
