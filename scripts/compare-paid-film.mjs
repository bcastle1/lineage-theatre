import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { parseEnv } from 'node:util';
import { createFalComparison } from '../api/_lib/fal-comparison.mjs';
import { OWNER_EMAIL } from '../api/_lib/access.mjs';
import { downloadProductionClip } from './production-worker.mjs';
import { FAL_MEDIA_HOSTS } from '../api/_lib/fal-client.mjs';
import { assembleFilm } from './assemble-film.mjs';

async function main() {
  const [action, orderId, outputDirectory] = process.argv.slice(2);
  if (!['--begin', '--step', '--assemble'].includes(action) || !/^[a-f0-9]{64}$/.test(orderId || '')
    || (action === '--assemble' && !outputDirectory)) throw new Error('Invalid comparison command.');
  if (process.env.LINEAGE_BLOB_ENV_FILE) {
    const env = parseEnv(await readFile(process.env.LINEAGE_BLOB_ENV_FILE, 'utf8'));
    process.env.BLOB_READ_WRITE_TOKEN = env.BLOB_READ_WRITE_TOKEN;
  }
  if (!process.env.BLOB_READ_WRITE_TOKEN || !process.env.FAL_KEY) throw new Error('Comparison runtime is not configured.');
  const comparison = createFalComparison();
  if (action === '--begin') {
    // Current 1080p/4K rates verified against the exact endpoint pages and
    // authenticated pricing API before this explicit merchant-funded run.
    const rates = JSON.parse(process.env.LINEAGE_COMPARISON_RATES || 'null');
    const saved = await comparison.begin({ orderId, actorEmail: OWNER_EMAIL, maximumCostCents: 10000, rates });
    console.log(JSON.stringify({ preparedId: saved.preparedId, estimatedCostCents: saved.estimatedCostCents,
      customerAmountCents: saved.customerAmountCents, funding: saved.funding }));
    return;
  }
  const state = await comparison.pass({ orderId, actorEmail: OWNER_EMAIL });
  console.log(JSON.stringify(state.results.map(({ model, shotId, status }) => ({ model, shotId, status }))));
  if (action !== '--assemble') return;
  const root = resolve(outputDirectory); await mkdir(root, { recursive: true });
  await writeFile(join(root, 'manifest.json'), JSON.stringify({ manifest: state.manifest, manifestHash: state.manifestHash }, null, 2));
  for (const model of ['seedance', 'wan']) {
    if (state.results.filter(r => r.model === model).some(r => r.status !== 'completed')) continue;
    const modelDirectory = join(root, model); await mkdir(modelDirectory, { recursive: true });
    const old = await readFile(join(root, `${model}-report.json`), 'utf8').then(JSON.parse).catch(() => null);
    if (old) {
      const bytes = await readFile(join(modelDirectory, 'film.mp4'));
      if (old.manifestHash !== state.manifestHash || old.sha256 !== createHash('sha256').update(bytes).digest('hex'))
        throw new Error('A saved comparison film has changed.');
      console.log(JSON.stringify({ model, report: old })); continue;
    }
    const clips = [];
    for (const result of state.results.filter(r => r.model === model)) {
      const path = join(root, `${model}-${result.shotId}.mp4`);
      const existing = await stat(path).catch(() => null);
      if (!existing) await writeFile(path, await downloadProductionClip(result.output, FAL_MEDIA_HOSTS), { flag: 'wx' });
      else if (existing.size !== result.output.sizeBytes) throw new Error('A saved comparison clip has changed.');
      clips.push({ shotId: result.shotId, path });
    }
    const report = await assembleFilm({ manifest: state.manifest, manifestHash: state.manifestHash, clips,
      outputPath: join(modelDirectory, 'film.mp4'), ffmpeg: process.env.FFMPEG_PATH || 'ffmpeg', technicalSample: false });
    await writeFile(join(root, `${model}-report.json`), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ model, report }));
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => {
  console.error(JSON.stringify({ error: error.code || error.message })); process.exitCode = 1;
});
