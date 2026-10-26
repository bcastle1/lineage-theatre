import test from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import sharp from 'sharp';
import { digest, userPath } from '../api/_lib/auth.mjs';
import { OWNER_EMAIL } from '../api/_lib/access.mjs';
import { createFilmProductionService, fictionalOperatorProject, productionJobPath } from '../api/_lib/film-production.mjs';
import { createFilmPricingService } from '../api/_lib/film-pricing.mjs';
import { createHostedCheckoutService, HOSTED_CHECKOUT_SETTINGS_PATH } from '../api/_lib/hosted-checkout.mjs';
import { createPaymentsService } from '../api/_lib/payments.mjs';
import { createProductionQueue, productionQueuePath } from '../api/_lib/production-queue.mjs';
import { createAutomaticProduction, automaticProductionPath } from '../api/_lib/automatic-production.mjs';
import { createFalFunding } from '../api/_lib/fal-funding.mjs';
import { FAL_RECIPE_VERSION } from '../api/_lib/fal-production.mjs';
import { falRequestPath, FAL_MODELS } from '../api/_lib/fal-client.mjs';
import { createFilmVisualReviewService } from '../api/_lib/film-visual-review.mjs';
import { createFilmVisualReviewer } from '../scripts/review-film-visuals.mjs';
import { STORY_MODEL } from '../api/_lib/story.mjs';
import { verifyPublishedFilm } from '../scripts/production-worker.mjs';
import { streamProductionMedia } from '../api/_lib/production-media.mjs';
import { FILM_PERFORMANCE_RECIPE, KLING_VOICES, validateFilmPerformance, validatePerformanceOutput } from '../api/_lib/film-performance.mjs';
import { performanceReceiptPath, validatePerformanceReviewBinding, validatePerformanceReviewProof } from '../api/_lib/film-performance-review.mjs';

const NOW = Date.parse('2026-10-22T12:00:00Z');
const actor = { email: 'fictional-customer@example.invalid', role: 'customer', status: 'active',
  approvedAt: new Date(NOW - 86400_000).toISOString(), approvedBy: OWNER_EMAIL };
const binding = { environment: 'production', realmId: '1234', grantId: 'a'.repeat(64) };
const clone = value => structuredClone(value), json = value => new Response(JSON.stringify(value));

// Use the real pricing, hosted checkout, payment dispatcher, automatic outbox,
// queue, film service, private-byte verifier and download authorization. Only
// external Accounting/provider/storage transports and media construction are
// synthetic. This test performs no network requests, real charges or generation.
async function fixture({ eager = true, corruptStoredMedia = false, visualResult = 'passed', performance = false, performanceFailure } = {}) {
  let time = NOW, serial = 0, invoice, customer, order, hosted, automatic, payments;
  let cost = 1000, maximumCost = 1000, priceRevision = 0, credits = 100, quoteEffect;
  const records = new Map(), blobs = new Map(), operations = new Map();
  const calls = { accounting: [], quotes: [], submits: [], polls: [], assemblies: 0, privateReads: 0, receipts: 0, visualReviews: 0 };
  const now = () => time;
  const seed = (path, value) => records.set(path, { value: clone(value), etag: String(++serial) });
  const read = async path => clone(records.get(path) || null);
  const write = async (path, value, etag) => {
    assert.equal(records.get(path)?.etag, etag, 'conditional record write');
    seed(path, value); return read(path);
  };
  const listBlobs = async ({ prefix, cursor, limit = 100 }) => {
    const paths = [...records.keys()].filter(path => path.startsWith(prefix)), start = Number(cursor || 0);
    return { blobs: paths.slice(start, start + limit).map(pathname => ({ pathname })), hasMore: start + limit < paths.length, cursor: String(start + limit) };
  };
  seed(userPath(actor.email), actor);
  seed(HOSTED_CHECKOUT_SETTINGS_PATH, { revision: 1, enabled: true, serviceItemId: '2', serviceItemName: 'Film production', taxCode: 'NON',
    deliveryTerms: 'Your film will be delivered after production and verification.', refundTerms: 'Contact the administrator about refunds.',
    merchantConfirmed: true, pciAcknowledged: true, automaticInvoiceEmailDisabled: true, merchantBinding: binding });
  const adapter = { id: 'fal', model: 'kling', modelVersion: FAL_RECIPE_VERSION, environment: 'production', available: true,
    recipeForManifest: manifest => validateFilmPerformance(manifest) ? FILM_PERFORMANCE_RECIPE : FAL_RECIPE_VERSION,
    timingVersion: 'synthetic-kling-flow-v1', maxConcurrentShots: 4, outputHosts: ['media.example.invalid'],
    evidence: { apiVerified: true, qualityVerified: true, commercialTermsVerified: true, reconciliationVerified: true },
    validateManifest: async manifest => { if (performance) assert.equal(validateFilmPerformance(manifest), true);
      return { ready: true, maximumCostCents: maximumCost }; },
    quote: async request => {
      calls.quotes.push(clone(request));
      await quoteEffect?.();
      return { manifestHash: request.manifestHash, currency: 'USD', providerCostCents: cost,
        quoteReference: `synthetic-kling-rate-${++priceRevision}`, expiresAt: new Date(time + 300_000).toISOString() };
    },
    submitShot: async request => {
      assert.equal(await request.authorizeSpend(), true, 'each external generation needs fresh real payment-service authorization');
      assert.equal(operations.has(request.idempotencyKey), false, 'a paid shot must be submitted once');
      const result = { providerJobId: `synthetic-${request.shot.id}`, status: 'processing' };
      operations.set(request.idempotencyKey, result); calls.submits.push({ id: request.idempotencyKey, budget: request.budgetCents, quote: request.quoteReference });
      return result;
    },
    pollShot: async request => {
      assert.ok(operations.has(request.idempotencyKey)); calls.polls.push(request.idempotencyKey);
      const output = { url: `https://media.example.invalid/${request.shot.id}${performance ? '-final' : ''}.mp4`, contentType: 'video/mp4', sizeBytes: 128,
        durationSeconds: request.shot.targetDurationMs / 1000 };
      if (performance) {
        const p = request.shot.performance;
        if (p.mode === 'narration') output.audio = { url: `https://media.example.invalid/${request.shot.id}.mp3`,
          contentType: 'audio/mpeg', sizeBytes: 128, durationSeconds: request.shot.targetDurationMs / 1000 };
        output.performance = { version: 1, recipe: FILM_PERFORMANCE_RECIPE, mode: p.mode, speakerId: p.speakerId, voiceId: p.voiceId,
          textSha256: digest(p.text), videoOperationId: digest(`synthetic-video:${request.idempotencyKey}`),
          speechOperationId: p.mode === 'silent' ? null : digest(`synthetic-speech:${request.idempotencyKey}`),
          sourceVideoUrlSha256: digest(`https://media.example.invalid/${request.shot.id}-source.mp4`),
          outputVideoUrlSha256: digest(output.url), audioUrlSha256: output.audio ? digest(output.audio.url) : null };
        validatePerformanceOutput(request.manifest, request.shot, output);
        if (performanceFailure === 'tampered-voice' && p.mode === 'dialogue') output.performance.voiceId = KLING_VOICES.find(voice => voice.id !== p.voiceId).id;
      }
      return { ...operations.get(request.idempotencyKey), status: 'completed', output };
    },
    reconcileShot: async () => assert.fail('No uncertain response is present in this fixture'),
  };
  const getBlob = async pathname => {
    const original = blobs.get(pathname); assert.ok(original, 'only the stored private film can be read'); calls.privateReads++;
    const bytes = Buffer.from(original);
    if (corruptStoredMedia) bytes[0] ^= 255;
    return { statusCode: 200, blob: { pathname, size: bytes.length, contentType: 'video/mp4' },
      headers: new Headers({ 'content-length': String(bytes.length), 'content-type': 'video/mp4' }),
      stream: new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }) };
  };
  const film = createFilmProductionService({ readRecordImpl: read, writeRecordImpl: write, now, adapter,
    authorize: ({ email, id, manifestHash, authorizationReference }) => payments.authorizeProduction({ email, preparedId: id, manifestHash, orderId: authorizationReference }),
    verifyAssembledMedia: input => verifyPublishedFilm(input, { getBlob, read }) });
  const pricingSettings = async () => ({ revision: 1, markupBasisPoints: 5000 });
  const pricing = createFilmPricingService({ filmProduction: film, pricingSettings, now });
  const payment = () => ({ Id: '40', CustomerRef: { value: '20' }, CurrencyRef: { value: 'USD' }, TotalAmt: 15,
    SyncToken: '0', MetaData: { CreateTime: new Date(NOW).toISOString(), LastUpdatedTime: new Date(NOW).toISOString() },
    Line: [{ Amount: 15, LinkedTxn: [{ TxnId: '30', TxnType: 'Invoice' }] }] });
  const transport = { binding: async () => clone(binding), request: async (expected, operation) => {
    assert.deepEqual(expected, binding); calls.accounting.push(clone(operation));
    if (operation.path === '/query') {
      const entity = operation.query.entity;
      const values = entity === 'Customer' ? customer ? [customer] : [] : entity === 'Payment' ? [payment()] : [];
      const entries = values.slice((operation.query.startPosition || 1) - 1, (operation.query.startPosition || 1) - 1 + (operation.query.maxResults || 1000));
      return json({ QueryResponse: entries.length ? { [entity]: entries, startPosition: operation.query.startPosition || 1, maxResults: entries.length } : {} });
    }
    if (operation.path === '/item/2') return json({ Item: { Id: '2', Name: 'Film production', Type: 'Service', Active: true, Taxable: false } });
    if (operation.path === '/customer') { customer = { Id: '20', Active: true, ...operation.body }; return json({ Customer: customer }); }
    if (operation.path === '/customer/20') return json({ Customer: customer });
    if (operation.path === '/invoice') {
      assert.equal(invoice, undefined, 'only one customer invoice');
      invoice = { ...clone(operation.body), Id: '30', DocNumber: '1001', TotalAmt: 15, Balance: 15, LinkedTxn: [], InvoiceLink: 'https://connect.intuit.com/portal/app/fictional' };
      return json({ Invoice: invoice });
    }
    if (operation.path === '/invoice/30') return json({ Invoice: invoice });
    if (operation.path === '/payment/40') return json({ Payment: payment() });
    assert.fail(`Unexpected Accounting operation ${operation.path}`);
  } };
  const env = { QUICKBOOKS_ENVIRONMENT: 'production', LINEAGE_PAYMENT_ACCESS: 'approved',
    FAL_BILLING_KEY: 'synthetic-test-key', FAL_BILLING_ACCOUNT: 'synthetic-account' };
  const funding = createFalFunding({ read, write, now, env, listBlobs,
    fetchImpl: async () => json({ username: 'synthetic-account', credits: { currency: 'USD', current_balance: credits } }) });
  hosted = createHostedCheckoutService({ read, write, now, env, transport, pricingSettings, funding,
    quoteProvider: (...args) => pricing.quoteForPayment(...args), productionQuote: input => film.quoteForProductionBudget(input),
    productionAutomation: { schedule: input => automatic.schedule(input) }, receiptDelivery: { deliver: async () => { calls.receipts++; } } });
  payments = createPaymentsService({ read, write, now, hostedCheckout: hosted,
    provider: { binding: async () => assert.fail('Hosted payment cannot use direct-card processing') } });
  const queueDependencies = { read, write, listBlobs, now, film, paymentService: payments };
  const queue = createProductionQueue(queueDependencies);
  automatic = createAutomaticProduction({ read, write, listBlobs, now, queue, eager });
  const project = fictionalOperatorProject();
  if (performance) {
    project.performanceControlsVersion = 1; project.narratorVoiceId = KLING_VOICES[0].id;
    project.characters.forEach((character, index) => { character.voiceId = KLING_VOICES[index].id;
      character.wardrobe = index ? 'Blue apron over a cream shirt.' : 'Green apron over a cream shirt.'; });
    project.scenes[0].narration = 'Two fictional sisters tend a garden.';
    project.scenes[1].narration = ''; project.scenes[1].dialogue = 'Fictional Ada: Let us plant two rows.';
    project.scenes[2].narration = ''; project.scenes[2].dialogue = 'Fictional Alice: We will share the harvest.';
  }
  const plan = await film.prepare({ email: actor.email, project, preparationConsent: true, idempotencyKey: 'fictional-integrated-plan-001' });
  const quote = await hosted.quote(actor, { project, preparedId: plan.id, idempotencyKey: 'fictional-integrated-quote-001' });
  const path = productionQueuePath(actor.email, plan.id), jobPath = productionJobPath(actor.email, plan.id);
  const image = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#886644' } }).jpeg().toBuffer();
  const imageData = `data:image/jpeg;base64,${image.toString('base64')}`;
  const visualService = createFilmVisualReviewService({ read, write, now,
    key: () => visualResult === 'unavailable' ? null : 'synthetic-visual-model-key', generatedPhoto: async () => imageData,
    authorize: async ({ email, id, job }) => {
      const ticket = (await read(path))?.value, saved = (await read(jobPath))?.value;
      if (email !== actor.email || id !== plan.id || ticket?.state !== 'pending' || ticket.lease?.expiresAt <= time
        || saved?.manifestHash !== job.manifestHash || saved.status !== 'awaiting-assembly') return false;
      return (await payments.authorizeProduction({ email, preparedId: id, manifestHash: job.manifestHash, orderId: order.id })).allowed === true;
    },
    fetchImpl: async (url, options) => {
      assert.equal(url, 'https://api.openai.com/v1/responses'); assert.equal(JSON.parse(options.body).model, STORY_MODEL); calls.visualReviews++;
      if (visualResult === 'uncertain') throw new Error('synthetic lost model response');
      const decision = { appearance: visualResult === 'mismatch' ? 'mismatch' : 'consistent', wardrobe: 'consistent',
        sceneAction: 'consistent', imageIntegrity: 'consistent', ...(performance ? { textIntegrity: 'consistent', speakerStaging: 'consistent' } : {}),
        findings: visualResult === 'mismatch' ? ['appearance-drift'] : [] };
      return json({ status: 'completed', model: STORY_MODEL, output: [{ content: [{ type: 'output_text', text: JSON.stringify(decision) }] }] });
    } });
  const reviewVisuals = createFilmVisualReviewer({ extract: async () => imageData,
    review: async ({ email, preparedId, shotId, frames }) => visualService({ email, id: preparedId, shotId, frames,
      job: (await read(jobPath)).value }) });
  const assemble = async ({ id, job, stillOwned }) => {
    assert.equal(await stillOwned(), true); assert.ok(job.shots.every(shot => shot.status === 'completed')); calls.assemblies++;
    for (const character of job.manifest.screenplay.characters) {
      const referencePath = falRequestPath(digest(`${job.provider.recipe}:cast:${job.id}:${job.manifestHash}:${character.id}`));
      if (!records.has(referencePath)) seed(referencePath, { state: 'completed', endpoint: FAL_MODELS.reference,
        result: { images: [{ url: `https://media.example.invalid/reference-${character.id}.jpg` }] } });
    }
    const visualReview = await reviewVisuals({ email: actor.email, id, job, stillOwned,
      clips: job.shots.map(shot => ({ shotId: shot.id, path: `synthetic-${shot.id}.mp4` })) });
    const bytes = Buffer.from('Synthetic assembly boundary: full FFmpeg/media tests run separately. '.repeat(4));
    const sha256 = digest(bytes), pathname = `production/media/${digest(actor.email)}/${id}/${sha256}.mp4`;
    blobs.set(pathname, bytes);
    let speechReview, performanceReview;
    if (performance) {
      // Synthetic media-measurement and transcription results, validated by the
      // real shared proof contract and later re-read by verifyPublishedFilm.
      speechReview = { version: 1, method: 'local-speech-transcription', passed: true,
        shots: job.manifest.shots.map(shot => ({ shotId: shot.id, scriptMatched: true })) };
      const observations = job.manifest.shots.map((shot, index) => {
        const saved = job.shots[index], mode = shot.performance.mode, videoHash = digest(`synthetic-video-bytes:${shot.id}`);
        return { shotId: shot.id, outputHash: digest(JSON.stringify(saved.output)), provenance: validatePerformanceOutput(job.manifest, shot, saved.output),
          videoSha256: videoHash, videoBytes: saved.output.sizeBytes, videoDurationSeconds: shot.targetDurationMs / 1000, videoFrameRate: 24,
          selectedAudioContainerSha256: mode === 'dialogue' ? videoHash : digest(`synthetic-selected-audio:${shot.id}`),
          selectedAudioContainerBytes: 128, selectedAudioDurationSeconds: shot.targetDurationMs / 1000,
          providerAudioSha256: mode === 'narration' ? digest(`synthetic-provider-audio:${shot.id}`) : null,
          providerAudioBytes: mode === 'narration' ? saved.output.audio.sizeBytes : null,
          sourceAudioDurationSeconds: mode === 'silent' ? null : shot.targetDurationMs / 1000,
          audioSelection: mode === 'dialogue' ? 'embedded-synchronized' : mode === 'narration' ? 'stock-narration-silence-padded' : 'planned-silence' };
      });
      const ownerHash = digest(actor.email), binding = { version: 1, recipe: FILM_PERFORMANCE_RECIPE, ownerHash, id,
        manifestHash: job.manifestHash, artifactSha256: sha256, speechReviewSha256: digest(JSON.stringify(speechReview)),
        music: { requested: false }, shots: observations };
      validatePerformanceReviewBinding(binding, { job, ownerHash, id, artifactSha256: sha256, speechReview });
      const bindingHash = digest(JSON.stringify(binding)), receiptPath = performanceReceiptPath(ownerHash, id, bindingHash);
      seed(receiptPath, { version: 1, state: 'verified', bindingHash, binding });
      performanceReview = validatePerformanceReviewProof({ manifest: job.manifest, manifestHash: job.manifestHash, ownerHash, id, artifactSha256: sha256,
        review: { version: 1, recipe: FILM_PERFORMANCE_RECIPE, manifestHash: job.manifestHash, artifactSha256: sha256,
          passed: true, bindingHash, receiptPath, shotCount: observations.length } });
      if (performanceFailure === 'missing-proof') performanceReview = undefined;
    }
    return { pathname, sha256, sizeBytes: bytes.length, contentType: 'video/mp4', manifestHash: job.manifestHash,
      durationSeconds: job.manifest.targetDurationSeconds, width: 1920, height: 1080, frameRate: 24,
      playable: true, hasAudio: true, technicalSample: false, visualReview,
      ...(performance ? { speechReview, ...(performanceReview ? { performanceReview } : {}) } : {}) };
  };
  const checkout = async () => (order = await hosted.checkout(actor, { quoteId: quote.id, idempotencyKey: 'fictional-integrated-checkout-001', consent: true, productionConsent: true }));
  return { records, calls, read, write, seed, film, hosted, payments, queue, automatic, quote, plan, path, jobPath, assemble, getBlob, blobs, now,
    checkout, advance: ms => { time += ms; }, setPrice: (value, ceiling = value) => { cost = value; maximumCost = ceiling; }, setCredits: value => { credits = value; },
    setQuoteEffect: effect => { quoteEffect = effect; }, editInvoice: change => Object.assign(invoice, change),
    confirmPayment: async () => { invoice.Balance = 0; invoice.LinkedTxn = [{ TxnId: '40', TxnType: 'Payment' }]; return hosted.check(actor, { orderId: order.id }); },
    restartQueue: (overrides = {}) => createProductionQueue({ ...queueDependencies, ...overrides }), order: () => order,
    status: () => queue.status({ email: actor.email, id: plan.id }),
    step: async () => { time += 6000; return queue.runTicket(path, { assemble }); },
    finish: async () => { for (let i = 0; i < 20; i++) { time += 6000; const result = await queue.runTicket(path, { assemble }); if (result.state !== 'pending') return result; } assert.fail('bounded film should finish'); },
  };
}

test('hosted payment flows through restartable automatic production and verified private download exactly once', async () => {
  const f = await fixture({ eager: false }), order = await f.checkout();
  assert.equal(order.status, 'awaiting-payment'); assert.equal(f.calls.submits.length, 0);
  assert.equal((await f.status()).progress.stage, 'waiting');
  assert.equal((await f.hosted.check(actor, { orderId: order.id })).status, 'awaiting-payment');
  assert.equal(await f.read(automaticProductionPath(order.id)), null);
  assert.equal((await f.confirmPayment()).status, 'captured');
  assert.equal((await f.status()).progress.stage, 'waiting');
  assert.equal((await f.queue.status({ email: actor.email, id: f.plan.id, orderId: order.id })).progress.stage, 'queued');
  assert.equal((await f.automatic.run()).queued, 1);
  const restarted = f.restartQueue();
  assert.equal((await restarted.status({ email: actor.email, id: f.plan.id })).progress.percent, 5);
  assert.equal((await f.finish()).state, 'completed');
  const status = await f.status();
  assert.equal(status.status, 'completed'); assert.equal(status.mediaReady, true);
  assert.equal(status.progress.stage, 'ready'); assert.equal(status.progress.percent, 100); assert.equal(status.progress.timing, 'complete');
  assert.equal(f.calls.submits.length, f.plan.shotCount); assert.equal(f.calls.assemblies, 1); assert.equal(f.calls.privateReads, 1);
  assert.equal(f.calls.visualReviews, f.plan.shotCount);
  assert.equal(f.calls.accounting.filter(op => op.method === 'POST' && op.path === '/invoice').length, 1);
  await f.confirmPayment(); await f.automatic.run();
  assert.equal((await restarted.runTicket(f.path, { assemble: f.assemble })).state, 'skipped');
  assert.equal(f.calls.submits.length, f.plan.shotCount); assert.equal(f.calls.assemblies, 1);
  const res = new class extends Writable {
    headers = {}; chunks = []; statusCode = 200;
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; }
    removeHeader(name) { delete this.headers[name.toLowerCase()]; }
    _write(chunk, encoding, callback) { this.chunks.push(Buffer.from(chunk)); callback(); }
  }();
  await streamProductionMedia({ req: { method: 'GET', headers: {} }, res, email: actor.email, actor, id: f.plan.id,
    filmProduction: f.film, read: f.read, now: f.now, getBlob: f.getBlob, download: true });
  assert.equal(res.statusCode, 200); assert.match(res.headers['content-disposition'], /^attachment/);
  assert.deepEqual(Buffer.concat(res.chunks), [...f.blobs.values()][0]);
  // The first public read may have preceded the final assembly write. The
  // newer verified job read must make the public status agree with ready100.
  const crossed = f.restartQueue({ film: { ...f.film, status: async input => ({ ...await f.film.status(input), status: 'processing', mediaReady: false }) } });
  assert.equal((await crossed.status({ email: actor.email, id: f.plan.id })).status, 'completed');
});

test('selected voices flow from one hosted payment through automatic production, v2 checks, private proof and authenticated download', async () => {
  const f = await fixture({ performance: true, eager: false }), order = await f.checkout();
  assert.equal(order.status, 'awaiting-payment'); assert.equal(f.calls.submits.length, 0);
  await f.confirmPayment(); await f.confirmPayment();
  assert.equal((await f.automatic.run()).queued, 1);
  assert.equal((await f.finish()).state, 'completed');
  const job = (await f.read(f.jobPath)).value;
  assert.equal(job.provider.recipe, FILM_PERFORMANCE_RECIPE); assert.equal(validateFilmPerformance(job.manifest), true);
  assert.equal(job.visualReview.version, 2); assert.equal(job.performanceReview.passed, true);
  const receipt = (await f.read(job.performanceReview.receiptPath)).value;
  assert.equal(receipt.state, 'verified'); assert.equal(receipt.bindingHash, digest(JSON.stringify(receipt.binding)));
  assert.equal(receipt.binding.artifactSha256, job.media.sha256);
  for (const [index, shot] of job.manifest.shots.entries()) {
    const output = job.shots[index].output, p = shot.performance;
    validatePerformanceOutput(job.manifest, shot, output);
    assert.equal(output.performance.voiceId, p.voiceId); assert.equal(output.performance.textSha256, digest(p.text));
    assert.equal(output.performance.outputVideoUrlSha256, digest(output.url)); assert.match(output.url, /-final\.mp4$/);
    if (p.mode === 'dialogue') { assert.equal(output.audio, undefined); assert.equal(receipt.binding.shots[index].audioSelection, 'embedded-synchronized'); }
    if (p.mode === 'narration') assert.equal(output.audio.url, `https://media.example.invalid/${shot.id}.mp3`);
  }
  const visualReceipts = [...f.records.entries()].filter(([path]) => path.startsWith('production/visual-reviews/'));
  assert.equal(visualReceipts.length, f.plan.shotCount);
  for (const [, { value }] of visualReceipts) {
    assert.equal(value.binding.version, 2); assert.equal(value.binding.frameHashes.length, 5);
    assert.equal(value.decision.textIntegrity, 'consistent'); assert.equal(value.decision.speakerStaging, 'consistent');
  }
  assert.equal((await f.status()).mediaReady, true); assert.equal((await f.status()).progress.percent, 100);
  assert.equal(f.calls.privateReads, 1); assert.equal(f.calls.assemblies, 1); assert.equal(f.calls.submits.length, f.plan.shotCount);
  await f.confirmPayment(); await f.automatic.run(); await f.step();
  assert.equal(f.calls.accounting.filter(op => op.method === 'POST' && op.path === '/invoice').length, 1);
  assert.equal(f.calls.submits.length, f.plan.shotCount); assert.equal(f.calls.assemblies, 1);
  const response = () => new class extends Writable {
    headers = {}; chunks = []; statusCode = 200;
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; }
    removeHeader(name) { delete this.headers[name.toLowerCase()]; }
    _write(chunk, encoding, callback) { this.chunks.push(Buffer.from(chunk)); callback(); }
  }();
  const res = response();
  await streamProductionMedia({ req: { method: 'GET', headers: {} }, res, email: actor.email, actor, id: f.plan.id,
    filmProduction: f.film, read: f.read, now: f.now, getBlob: f.getBlob, download: true });
  assert.equal(res.statusCode, 200); assert.match(res.headers['content-disposition'], /^attachment/);
  assert.equal(digest(Buffer.concat(res.chunks)), job.media.sha256);
  const stranger = { ...actor, email: 'different-customer@example.invalid' };
  const denied = response(), reads = f.calls.privateReads;
  await streamProductionMedia({ req: { method: 'GET', headers: {} }, res: denied, email: stranger.email, actor: stranger,
    id: f.plan.id, filmProduction: f.film, read: f.read, now: f.now, getBlob: f.getBlob, download: true });
  assert.equal(denied.statusCode, 404); assert.equal(f.calls.privateReads, reads);
});

test('paid performance films hold delivery for missing private proof or tampered selected voice without charging or submitting again', async () => {
  for (const performanceFailure of ['missing-proof', 'tampered-voice']) {
    const f = await fixture({ performance: true, performanceFailure }); await f.checkout(); await f.confirmPayment();
    for (let i = 0; i < 14; i++) await f.step();
    const job = (await f.read(f.jobPath)).value, submitted = f.calls.submits.length;
    assert.notEqual(job.status, 'completed'); assert.equal(job.media, undefined);
    assert.equal((await f.status()).mediaReady, false); assert.notEqual((await f.status()).progress.percent, 100);
    if (performanceFailure === 'missing-proof') { assert.equal(job.status, 'awaiting-assembly'); assert.equal(f.calls.assemblies, 1); }
    else { assert.equal(job.status, 'uncertain'); assert.equal(f.calls.assemblies, 0); }
    await f.confirmPayment(); await f.automatic.run(); await f.step();
    assert.equal(f.calls.accounting.filter(op => op.method === 'POST' && op.path === '/invoice').length, 1);
    assert.equal(f.calls.submits.length, submitted);
  }
});

test('an ongoing Kling film renews expired pricing within its fixed execution ceiling without another invoice', async () => {
  const f = await fixture(); const order = await f.checkout(); await f.confirmPayment(); await f.step();
  const originalJob = (await f.read(f.jobPath)).value, originalOrder = (await f.read(`payments/orders/${order.id}.json`)).value;
  const initial = clone(originalJob.authorization), keys = originalJob.shots.map(shot => shot.requestKey);
  f.advance(301_000); f.setPrice(900);
  assert.equal((await f.finish()).state, 'completed');
  const result = (await f.read(f.jobPath)).value, savedOrder = (await f.read(`payments/orders/${order.id}.json`)).value;
  for (const field of ['manifestHash', 'environment', 'budgetCents', 'quoteReference']) assert.equal(result.authorization[field], initial[field]);
  assert.deepEqual(result.shots.map(shot => shot.requestKey), keys);
  assert.equal(savedOrder.fulfillmentQuote.maximumCostCents, initial.budgetCents);
  assert.equal(savedOrder.fulfillmentQuote.providerCostCents, 900);
  assert.equal(savedOrder.fulfillmentQuote.quoteReference, initial.quoteReference);
  assert.notEqual(savedOrder.fulfillmentQuote.providerQuoteReference, initial.quoteReference);
  for (const field of ['invoiceId', 'amountCents', 'providerCostCents', 'accountingPayments', 'capturedAt', 'quoteId']) assert.deepEqual(savedOrder[field], originalOrder[field]);
  assert.ok(f.calls.submits.every(call => call.budget === initial.budgetCents && call.quote === initial.quoteReference));
  assert.equal(f.calls.accounting.filter(op => op.method === 'POST' && op.path === '/invoice').length, 1);
  assert.equal((await f.status()).progress.percent, 100);
});

test('expired execution pricing cannot enlarge a budget or migrate the saved provider', async () => {
  for (const change of ['higher-price', 'higher-ceiling', 'different-provider', 'different-recipe', 'changed-script']) {
    const f = await fixture(); await f.checkout(); await f.confirmPayment(); await f.step();
    const before = (await f.read(f.jobPath)).value, submitCount = f.calls.submits.length;
    f.advance(301_000);
    if (change === 'higher-price') f.setPrice(1001);
    if (change === 'higher-ceiling') f.setPrice(900, 1001);
    if (change === 'different-provider') f.seed(f.jobPath, { ...before, provider: { ...before.provider, model: 'wan' } });
    if (change === 'different-recipe') f.seed(f.jobPath, { ...before, provider: { ...before.provider, recipe: 'changed' } });
    if (change === 'changed-script') f.seed(f.jobPath, { ...before, manifest: { ...before.manifest, title: 'changed after purchase' } });
    await assert.rejects(f.payments.authorizeProduction({ email: actor.email, orderId: f.order().id, preparedId: f.plan.id, manifestHash: f.plan.manifestHash }));
    assert.equal(f.calls.submits.length, submitCount);
    assert.deepEqual((await f.read(f.jobPath)).value.authorization, before.authorization);
    assert.equal(f.calls.accounting.filter(op => op.method === 'POST' && op.path === '/invoice').length, 1);
  }
});

test('private checksum failure never produces ready progress or completed delivery', async () => {
  const f = await fixture({ corruptStoredMedia: true }); await f.checkout(); await f.confirmPayment();
  for (let i = 0; i < 10 && !f.calls.assemblies; i++) await f.step();
  assert.equal(f.calls.assemblies, 1); assert.equal((await f.read(f.jobPath)).value.status, 'awaiting-assembly');
  const state = await f.status(); assert.equal(state.mediaReady, false); assert.notEqual(state.progress.percent, 100);
});

test('ongoing quote refresh rechecks payment and saved job after the external price response', async () => {
  for (const change of ['invoice', 'refund', 'plan', 'account']) {
    const f = await fixture(); await f.checkout(); await f.confirmPayment(); await f.step(); f.advance(301_000);
    const orderPath = `payments/orders/${f.order().id}.json`, before = (await f.read(orderPath)).value;
    const submits = f.calls.submits.length;
    f.setQuoteEffect(async () => {
      if (change === 'invoice') f.editInvoice({ Balance: 15, LinkedTxn: [] });
      if (change === 'refund') f.seed(orderPath, { ...(await f.read(orderPath)).value, refundedCents: 1 });
      if (change === 'plan') f.seed(f.jobPath, { ...(await f.read(f.jobPath)).value, revision: 999 });
      if (change === 'account') f.seed(userPath(actor.email), { ...actor, status: 'suspended' });
    });
    await assert.rejects(f.payments.authorizeProduction({ email: actor.email, orderId: f.order().id, preparedId: f.plan.id, manifestHash: f.plan.manifestHash }));
    assert.equal(f.calls.submits.length, submits);
    assert.deepEqual((await f.read(orderPath)).value.fulfillmentQuote, before.fulfillmentQuote);
  }
});

test('delivery progress revokes ready when the stored film or its recorded payment becomes invalid', async () => {
  for (const change of ['refund', 'media', 'account']) {
    const f = await fixture(); await f.checkout(); await f.confirmPayment(); await f.finish();
    assert.equal((await f.status()).progress.percent, 100);
    if (change === 'refund') { const path = `payments/orders/${f.order().id}.json`; f.seed(path, { ...(await f.read(path)).value, refundedCents: 1 }); }
    if (change === 'media') { const value = (await f.read(f.jobPath)).value; f.seed(f.jobPath, { ...value, media: { ...value.media, pathname: 'unverified.mp4' } }); }
    if (change === 'account') f.seed(userPath(actor.email), { ...actor, status: 'suspended' });
    const state = await f.status(); assert.equal(state.mediaReady, false); assert.equal(state.needsAttention, true);
    assert.equal(state.progress.stage, 'attention'); assert.equal(state.progress.percent, null);
  }
});

test('insufficient provider funding prevents an invoice and any production submission', async () => {
  const f = await fixture(); f.setCredits(0);
  await assert.rejects(f.checkout(), error => error.code === 'PRODUCTION_FUNDING_UNAVAILABLE');
  assert.equal(f.calls.accounting.filter(op => op.method === 'POST' && op.path === '/invoice').length, 0);
  assert.equal(f.calls.submits.length, 0); assert.equal(await f.read(f.path), null);
});

test('visual mismatch and uncertain claimed reviews pause immediately without replaying model calls', async () => {
  for (const visualResult of ['mismatch', 'uncertain']) {
    const f = await fixture({ visualResult }); await f.checkout(); await f.confirmPayment();
    assert.equal((await f.finish()).state, 'attention'); assert.equal(f.calls.visualReviews, 1);
    assert.equal((await f.read(f.jobPath)).value.status, 'awaiting-assembly');
    assert.equal((await f.status()).progress.stage, 'attention');
    f.advance(400_000); assert.equal((await f.step()).state, 'skipped'); assert.equal(f.calls.visualReviews, 1);
  }
});

test('visual service unavailability before a model claim remains a bounded retry', async () => {
  const f = await fixture({ visualResult: 'unavailable' }); await f.checkout(); await f.confirmPayment();
  for (let i = 0; i < 10 && !f.calls.assemblies; i++) await f.step();
  const ticket = (await f.read(f.path)).value;
  assert.equal(ticket.state, 'pending'); assert.equal(ticket.lastResult, 'RETRYABLE_FAILURE'); assert.ok(ticket.nextAttemptAt > f.now());
  assert.equal(f.calls.visualReviews, 0);
  assert.equal([...f.records.keys()].filter(path => path.startsWith('production/visual-reviews/')).length, 0);
});
