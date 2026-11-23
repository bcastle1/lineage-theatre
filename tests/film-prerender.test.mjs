import test from 'node:test';
import assert from 'node:assert/strict';
import { digest, userPath } from '../api/_lib/auth.mjs';
import { createFilmPreRenderService, preRenderPath, preRenderPresentation, authorizeFilmProduction, PRERENDER_FLOW } from '../api/_lib/film-prerender.mjs';
import { requireFinishedFilmPayment } from '../api/_lib/production-media.mjs';
import { createProductionQueue } from '../api/_lib/production-queue.mjs';
import { createFilmProductionService, fictionalOperatorProject } from '../api/_lib/film-production.mjs';
import { SEEDANCE_RECIPE_VERSION } from '../api/_lib/fal-production.mjs';
import { createProductionWorkerHandler } from '../api/production-worker.mjs';
import { createFalFunding, FAL_FUNDING_PATH } from '../api/_lib/fal-funding.mjs';

const email = 'customer@example.invalid', id = '12345678-1234-5678-9876-123456789012', otherId = '22345678-1234-5678-9876-123456789012';
const actor = { email, role: 'customer', status: 'active', approvedAt: '2026-11-01T00:00:00Z', approvedBy: 'owner@example.invalid' };
const now = Date.parse('2026-11-22T18:00:00Z'), env = { QUICKBOOKS_ENVIRONMENT: 'production', LINEAGE_PAYMENT_ACCESS: 'approved' };
function fixture(options = {}) {
  const records = new Map(), writes = [], fundingCalls = [], fundingChecks = [], quotes = []; let serial = 0;
  const seed = (path, value) => records.set(path, { value: structuredClone(value), etag: String(++serial) });
  const read = async path => structuredClone(records.get(path) || null);
  const write = async (path, value, etag) => {
    if (records.get(path)?.etag !== etag) throw Error('precondition failed');
    writes.push(path); seed(path, value); await options.afterWrite?.(path, value); return read(path);
  };
  seed(userPath(email), actor);
  seed('production/worker-health.json', { version: 1, ready: true, model: 'seedance', recipe: 'fixture-seedance-v1',
    preRenderAuthorizationVersion: 1, deliveryChecksVersion: 1, checkedAt: new Date(now).toISOString() });
  function plan(preparedId = id) {
    const manifest = { filmId: preparedId, title: 'Fictional garden', targetDurationSeconds: 15, shots: [{ id: 'shot-001' }] };
    const job = { id: preparedId, ownerHash: digest(email), filmId: preparedId, manifest, manifestHash: digest(JSON.stringify(manifest)),
      mode: 'customer', status: 'prepared', shots: [{ id: 'shot-001', status: 'prepared' }], provider: { id: 'fal', model: 'seedance', recipe: 'fixture-seedance-v1' } };
    seed(`production/jobs/${digest(email)}/${preparedId}.json`, job); return job;
  }
  const job = plan(), jobPath = value => `production/jobs/${digest(email)}/${value}.json`;
  const film = {
    getPrepared: async ({ email: owner, id: preparedId }) => {
      if (owner !== email) throw Error('wrong owner');
      return (await read(jobPath(preparedId)))?.value;
    },
    quoteForProductionBudget: async input => {
      quotes.push(input);
      return { ...input, currency: 'USD', providerCostCents: 1000, maximumCostCents: 1000, quoteReference: 'fixture-price-v1',
        expiresAt: new Date(now + 60000).toISOString(), apiVerified: true, qualityVerified: true, commercialTermsVerified: true, ...options.quote };
    },
    status: async ({ id: preparedId }) => ({ ...(await read(jobPath(preparedId))).value, preparationOnly: false }),
    readiness: () => ({ available: true }),
  };
  const funding = {
    reserve: async input => { fundingCalls.push(structuredClone(input)); if (options.fundingFailure) throw Error('private budget response'); return { recheck: async () => true }; },
    verifyReservation: async input => {
      fundingChecks.push(structuredClone(input));
      if (options.fundingVerificationFailure) throw Error('missing original budget hold');
      assert.deepEqual(input, fundingCalls.find(saved => saved.orderId === input.orderId), 'Continuation must verify its exact original allowance');
      return true;
    },
  };
  const deps = { read, write, now: () => now, env: { ...env, ...options.env }, film, funding, pricingSettings: async () => ({ revision: 2, markupBasisPoints: 5000 }),
    headBlob: async pathname => {
      const media = [...records.values()].map(record => record.value.media).find(media => media?.pathname === pathname);
      if (!media || options.missingArtifact) throw Error('not found');
      return { pathname, size: media.sizeBytes, contentType: media.contentType };
    } };
  const service = createFilmPreRenderService(deps);
  const start = (preparedId = id) => service.start(actor, { preparedId, acceptedPriceCents: 1500, productionConsent: true });
  async function complete(preparedId = id) {
    const grant = (await read(preRenderPath(email, preparedId))).value;
    const saved = (await read(jobPath(preparedId))).value, sha256 = digest(`existing demonstration ${preparedId}`);
    const completed = { ...saved, status: 'completed', shots: saved.shots.map(shot => ({ ...shot, status: 'completed' })),
      authorization: { environment: 'production', manifestHash: saved.manifestHash, budgetCents: grant.maximumCostCents, quoteReference: grant.quoteReference },
      media: { pathname: `production/media/${digest(email)}/${preparedId}/${sha256}.mp4`, sha256, contentType: 'video/mp4', sizeBytes: 400, durationSeconds: 15 } };
    seed(jobPath(preparedId), completed); return completed;
  }
  function paid(completed, changes = {}) {
    const grant = records.get(preRenderPath(email, completed.id)).value;
    const order = { id: grant.orderId, customerEmail: email, preparedId: completed.id, manifestHash: completed.manifestHash,
      filmId: completed.filmId, status: 'captured', capturedAt: new Date(now).toISOString(), currency: 'USD', amountCents: 1500, providerCostCents: 1000,
      refundedCents: 0, provider: 'quickbooks', merchantBinding: { environment: 'production', grantId: 'a'.repeat(64), realmId: '12' },
      checkoutMethod: 'quickbooks-hosted-invoice', confirmationSource: 'quickbooks-accounting', invoiceId: '10', balanceCents: 0,
      accountingCheckedAt: new Date(now).toISOString(), accountingPayments: [{ id: '20', allocatedCents: 1500 }],
      deliveryFlow: PRERENDER_FLOW, preRenderGrantId: grant.id, artifactSha256: completed.media.sha256, ...changes };
    seed(`payments/orders/${grant.orderId}.json`, order); return order;
  }
  return { ...deps, service, seed, records, writes, fundingCalls, fundingChecks, quotes, job, plan, start, complete, paid, jobPath, peer: () => createFilmPreRenderService(deps) };
}

function reservedBudgetFixture() {
  const h = fixture(), billingAccount = 'offline-studio';
  let balanceCents = 1000, balanceReads = 0;
  const funding = createFalFunding({ read: h.read, write: h.write, now: h.now,
    env: { FAL_BILLING_KEY: 'offline-billing-read-only', FAL_BILLING_ACCOUNT: billingAccount },
    listBlobs: async ({ prefix }) => ({ blobs: [...h.records.keys()].filter(path => path.startsWith(prefix)).map(pathname => ({ pathname })), hasMore: false }),
    fetchImpl: async (url, request) => {
      assert.equal(url, 'https://api.fal.ai/v1/account/billing?expand=credits'); assert.equal(request.method, 'GET');
      balanceReads++;
      return Response.json({ username: billingAccount, credits: { current_balance: balanceCents / 100, currency: 'USD' } });
    } });
  const film = { ...h.film, getPrepared: async ({ email: owner, id: preparedId }) =>
    (await h.read(`production/jobs/${digest(owner)}/${preparedId}.json`))?.value };
  const service = createFilmPreRenderService({ ...h, film, funding });
  const start = () => service.start(actor, { preparedId: id, acceptedPriceCents: 1500, productionConsent: true });
  async function lease() {
    const path = `production/queue/${digest(email)}/${id}.json`, ticket = (await h.read(path)).value;
    h.seed(path, { ...ticket, lease: { token: 'same-film-worker-lease', expiresAt: now + 60000 } });
    return { email, preparedId: id, manifestHash: h.job.manifestHash, orderId: ticket.orderId };
  }
  return { ...h, service, start, lease, funding, billingAccount, balanceReads: () => balanceReads,
    debit: cents => { balanceCents -= cents; assert.ok(balanceCents >= 0); } };
}

test('pre-render creates only a studio grant, budget hold and exact queue ticket; restart is idempotent', async () => {
  const h = fixture(), first = await h.start(); await h.start();
  assert.equal(first.deliveryFlow, PRERENDER_FLOW); assert.equal(first.purchaseReady, false); assert.equal(first.paymentLocked, true);
  assert.equal(h.fundingCalls.length, 1); assert.ok(h.writes.every(path => !path.startsWith('payments/')));
  const grant = (await h.read(preRenderPath(email, id))).value;
  assert.equal(grant.amountCents, 1500); assert.equal(grant.maximumCostCents, 1000);
  assert.notEqual(grant.fundingId, grant.orderId); assert.equal(h.fundingCalls[0].orderId, grant.fundingId);
  const ticket = (await h.read(`production/queue/${digest(email)}/${id}.json`)).value;
  assert.equal(ticket.authorizationKind, PRERENDER_FLOW); assert.equal(ticket.preRenderGrantId, grant.id);
  await assert.rejects(h.service.purchaseQuote({ email, preparedId: id }), error => error.code === 'FILM_NOT_READY_FOR_PAYMENT');
});

test('concurrent different films cannot spend twice for one unpaid customer', async () => {
  const h = fixture(); h.plan(otherId);
  const results = await Promise.allSettled([h.start(), h.peer().start(actor, { preparedId: otherId, acceptedPriceCents: 1500, productionConsent: true })]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(h.fundingCalls.length, 1);
  assert.equal([...h.records.keys()].filter(path => path.startsWith('production/queue/')).length, 1);
});

test('an abandoned completed film stays private and blocks another free film until genuine payment', async () => {
  const h = fixture(); await h.start(); const completed = await h.complete(); h.plan(otherId);
  const view = await preRenderPresentation({ email, id, job: completed, read: h.read, now: h.now });
  assert.equal(view.artifactReady, true); assert.equal(view.purchaseReady, true); assert.equal(view.paymentLocked, true);
  assert.equal(view.mediaUrl, undefined);
  await assert.rejects(h.start(otherId), error => error.code === 'UNPAID_FILM_EXISTS');
  await assert.rejects(requireFinishedFilmPayment({ job: completed, email, actor, read: h.read, now: h.now }));
  h.paid(completed); await h.start(otherId);
  assert.equal(h.fundingCalls.length, 2);
});

test('funding failure cannot queue rendering and does not create any payment record', async () => {
  const h = fixture({ fundingFailure: true }); await assert.rejects(h.start());
  assert.equal([...h.records.keys()].some(path => path.startsWith('production/queue/') || path.startsWith('payments/')), false);
  assert.equal(h.fundingCalls.length, 1);
});

test('an old or stale worker cannot begin prepayment production, and missing private media cannot be sold', async () => {
  for (const health of [{ preRenderAuthorizationVersion: undefined }, { checkedAt: new Date(now - 180001).toISOString() }, { recipe: 'old-recipe' }]) {
    const h=fixture(),path='production/worker-health.json';
    h.seed(path,{...(await h.read(path)).value,...health});
    await assert.rejects(h.start(),error=>error.code==='PRERENDER_WORKER_REQUIRED');assert.equal(h.fundingCalls.length,0);
    assert.equal([...h.records.keys()].some(path=>path.startsWith('production/queue/')),false);
  }
  const h=fixture({missingArtifact:true});await h.start();await h.complete();
  await assert.rejects(h.service.purchaseQuote({email,preparedId:id}),error=>error.code==='FILM_NOT_READY_FOR_PAYMENT');
  assert.equal([...h.records.keys()].some(path=>path.startsWith('payments/')),false);
});

test('price drift, absent consent, suspended accounts, restricted access and existing orders stop before expense', async () => {
  for (const change of [{ acceptedPriceCents: 1400 }, { productionConsent: false }]) {
    const h = fixture();
    await assert.rejects(h.service.start(actor, { preparedId: id, acceptedPriceCents: 1500, productionConsent: true, ...change }));
    assert.equal(h.fundingCalls.length, 0); assert.equal(h.writes.length, 0);
  }
  for (const access of ['owner', 'invalid']) {
    const h = fixture({ env: { LINEAGE_PAYMENT_ACCESS: access } });
    await assert.rejects(h.start(), error => error.code === 'PRODUCTION_ACCESS_REQUIRED'); assert.equal(h.fundingCalls.length, 0);
  }
  const h = fixture(); h.seed(userPath(email), { ...actor, status: 'suspended' }); await assert.rejects(h.start()); assert.equal(h.writes.length, 0);
  const old = fixture(); old.seed(`payments/orders/${digest(`${email}:production:${old.job.manifestHash}`)}.json`, { status: 'awaiting-payment' });
  await assert.rejects(old.start(), error => error.code === 'ORDER_ALREADY_EXISTS'); assert.equal(old.fundingCalls.length, 0);
});

test('provider authorization derives the exact trusted queue grant and never falls back to a sale', async () => {
  const h = fixture(); await h.start();
  const grant = (await h.read(preRenderPath(email, id))).value;
  const input = { email, preparedId: id, manifestHash: h.job.manifestHash, orderId: grant.orderId };
  const ticketPath = `production/queue/${digest(email)}/${id}.json`;
  h.seed(ticketPath, { ...(await h.read(ticketPath)).value, lease: { token: 'active-worker-lease', expiresAt: now + 60000 } });
  let payments = 0;
  const deps = { read: h.read, preRenderService: h.service, paymentService: { authorizeProduction: async () => { payments++; return {}; } } };
  const permission = await authorizeFilmProduction(input, deps);
  assert.equal(permission.allowed, true); assert.equal(permission.fictionalOnly, false); assert.equal(permission.budgetCents, 1000);
  assert.equal(payments, 0); assert.equal(h.fundingCalls.length, 1); assert.equal(h.fundingChecks.length, 1);
  await authorizeFilmProduction(input, { ...deps, spending: false });
  assert.equal(h.fundingCalls.length, 1, 'Neither video nor visual/finishing permission reserves the original budget again');
  assert.equal(h.fundingChecks.length, 2, 'Both video and visual/finishing permission verify the existing exact hold');
  await assert.rejects(authorizeFilmProduction({ ...input, manifestHash: 'b'.repeat(64) }, deps)); assert.equal(payments, 0);
  h.seed(userPath(email), { ...actor, status: 'suspended' }); await assert.rejects(authorizeFilmProduction(input, deps)); assert.equal(payments, 0);
});

test('an admitted film continues after provider debits without rechecking the full balance, while new admission stays blocked', async () => {
  const h = reservedBudgetFixture(); await h.start(); const input = await h.lease();
  assert.equal(h.balanceReads(), 1);
  const ledgerBefore = structuredClone(h.records.get(FAL_FUNDING_PATH)), writesBefore = h.writes.length;
  h.debit(600); // The provider charged part of this already-reserved $10 allowance.
  for (const spending of [true, false]) {
    const permission = await h.service.authorize(input, { spending });
    assert.equal(permission.allowed, true); assert.equal(permission.budgetCents, 1000);
  }
  assert.equal(h.balanceReads(), 1, 'Continuing the same film must not require its spent budget to remain in the wallet');
  assert.equal(h.writes.length, writesBefore, 'Reservation verification is read-only');
  assert.deepEqual(h.records.get(FAL_FUNDING_PATH), ledgerBefore);

  const nextActor = { ...actor, email: 'next-customer@example.invalid' }, next = h.plan(otherId);
  h.seed(userPath(nextActor.email), nextActor);
  h.seed(`production/jobs/${digest(nextActor.email)}/${otherId}.json`, { ...next, ownerHash: digest(nextActor.email) });
  await assert.rejects(h.service.start(nextActor, { preparedId: otherId, acceptedPriceCents: 1500, productionConsent: true }),
    error => error.code === 'FAL_FUNDING_UNAVAILABLE');
  assert.equal(h.balanceReads(), 2, 'A new admission still checks the available provider balance');
  assert.equal(h.records.has(`production/queue/${digest(nextActor.email)}/${otherId}.json`), false);
  assert.deepEqual(h.records.get(FAL_FUNDING_PATH), ledgerBefore, 'Rejected admission cannot change the existing allowance');
  assert.equal([...h.records.keys()].some(path => path.startsWith('payments/')), false);
  assert.equal((await h.service.authorize(input)).allowed, true, 'Failed new admission does not revoke an exact active reservation');
  assert.equal(h.balanceReads(), 2);
});

test('missing, released, foreign-account or changed durable holds block both video and visual authorization', async () => {
  const changes = [
    h => h.records.delete(FAL_FUNDING_PATH),
    h => { const ledger = h.records.get(FAL_FUNDING_PATH).value; ledger.entries = []; },
    h => { h.records.get(FAL_FUNDING_PATH).value.account = 'another-studio'; },
    h => { h.records.get(FAL_FUNDING_PATH).value.entries[0].maximumCostCents = 999; },
    h => { h.records.get(FAL_FUNDING_PATH).value.entries[0].ownerHash = digest('other@example.invalid'); },
    h => { h.records.get(FAL_FUNDING_PATH).value.entries[0].preparedId = otherId; },
    h => { h.records.get(FAL_FUNDING_PATH).value.entries[0].manifestHash = 'b'.repeat(64); },
    h => { h.records.get(FAL_FUNDING_PATH).value.entries[0].quoteId = 'b'.repeat(64); },
    h => {
      const entry = h.records.get(FAL_FUNDING_PATH).value.entries[0];
      h.seed(`production/fal/funding-releases/${entry.orderId}/${entry.quoteId}.json`, { version: 1,
        kind: 'unattempted-funding-cycle-release', orderId: entry.orderId, ownerHash: entry.ownerHash,
        preparedId: entry.preparedId, manifestHash: entry.manifestHash, quoteId: entry.quoteId,
        releaseId: otherId, releasedAt: new Date(now).toISOString() });
    },
  ];
  for (const change of changes) {
    const h = reservedBudgetFixture(); await h.start(); const input = await h.lease(); change(h);
    const writesBefore = h.writes.length, balanceReadsBefore = h.balanceReads();
    for (const spending of [true, false]) await assert.rejects(h.service.authorize(input, { spending }),
      error => error.code === 'FAL_FUNDING_UNAVAILABLE');
    assert.equal(h.balanceReads(), balanceReadsBefore); assert.equal(h.writes.length, writesBefore);
  }
});

test('verified film price survives later pricing changes; only exact paid artifact unlocks', async () => {
  const h = fixture(); await h.start(); const completed = await h.complete();
  const quote = await h.service.purchaseQuote({ email, preparedId: id });
  assert.equal(quote.amountCents, 1500); assert.equal(quote.artifactSha256, completed.media.sha256);
  const q = { ...quote, customerEmail: email };
  await h.service.verifyPurchase(q);
  await assert.rejects(h.service.verifyPurchase({ ...q, artifactSha256: 'b'.repeat(64) }));
  for (const change of [{ status: 'awaiting-payment' }, { accountingPayments: [] }, { artifactSha256: 'b'.repeat(64) }, { preRenderGrantId: 'c'.repeat(64) }, { refundedCents: 1500 }]) {
    h.paid(completed, change); await assert.rejects(requireFinishedFilmPayment({ job: completed, email, actor, read: h.read, now: h.now }));
  }
  h.paid(completed);
  await requireFinishedFilmPayment({ job: completed, email, actor, read: h.read, now: h.now });
  assert.equal((await preRenderPresentation({ email, id, job: completed, read: h.read, now: h.now })).paymentLocked, false);
});

test('completed unpaid pre-render reports completion without pretending playback is unlocked', async () => {
  const h = fixture(); await h.start(); await h.complete();
  const queue = createProductionQueue({ read: h.read, write: h.write, now: h.now, film: h.film });
  const view = await queue.status({ email, id });
  assert.equal(view.status, 'completed'); assert.equal(view.artifactReady, true); assert.equal(view.purchaseReady, true);
  assert.equal(view.mediaReady, false); assert.notEqual(view.needsAttention, true);
});

test('real production and queue services render the immutable unpaid plan once, verify assembly, then wait for purchase', async () => {
  const h=fixture();let time=now,submits=0,polls=0,assemblies=0,reservations=0,reservationChecks=0,reservedInput,preRender;
  const adapter={id:'fal',model:'seedance',modelVersion:SEEDANCE_RECIPE_VERSION,available:true,environment:'production',outputHosts:['media.example.invalid'],
    evidence:{apiVerified:true,qualityVerified:true,commercialTermsVerified:true,reconciliationVerified:true},
    validateManifest:async()=>({ready:true,maximumCostCents:1000}),
    quote:async({manifestHash})=>({manifestHash,currency:'USD',providerCostCents:1000,quoteReference:'exact-studio-execution',
      expiresAt:new Date(time+60000).toISOString()}),
    submitShot:async request=>{assert.equal(await request.authorizeSpend(),true);submits++;return{status:'queued',providerJobId:request.shot.id};},
    reconcileShot:async()=>assert.fail('No uncertain result is injected'),
    pollShot:async({shot})=>{polls++;return{status:'completed',providerJobId:shot.id,output:{url:'https://media.example.invalid/demo.mp4',
      contentType:'video/mp4',sizeBytes:400,durationSeconds:shot.targetDurationMs/1000}};}};
  const film=createFilmProductionService({readRecordImpl:h.read,writeRecordImpl:h.write,now:()=>time,adapter,
    authorize:({email,id,manifestHash,authorizationReference})=>preRender.authorize({email,preparedId:id,manifestHash,orderId:authorizationReference}),
    verifyAssembledMedia:async({artifact})=>artifact});
  preRender=createFilmPreRenderService({...h,film,now:()=>time,funding:{
    reserve:async input=>{reservations++;reservedInput=structuredClone(input);return{recheck:async()=>true};},
    verifyReservation:async input=>{reservationChecks++;assert.deepEqual(input,reservedInput);return true;},
  }});
  h.seed('production/worker-health.json',{version:1,ready:true,model:'seedance',recipe:SEEDANCE_RECIPE_VERSION,
    preRenderAuthorizationVersion:1,deliveryChecksVersion:1,checkedAt:new Date(time).toISOString()});
  const plan=await film.prepare({email,project:fictionalOperatorProject(),idempotencyKey:'new-render-first-pipeline',preparationConsent:true});
  await preRender.start(actor,{preparedId:plan.id,productionConsent:true,acceptedPriceCents:1500});
  const queue=createProductionQueue({read:h.read,write:h.write,film,now:()=>time}),path=`production/queue/${digest(email)}/${plan.id}.json`;
  const sha256=digest('in-memory verified demonstration');
  const assemble=async({job})=>{assemblies++;assert.equal([...h.records.keys()].some(path=>path.startsWith('payments/')),false);
    return{playable:true,manifestHash:job.manifestHash,pathname:`production/media/${digest(email)}/${plan.id}/${sha256}.mp4`,
      sha256,contentType:'video/mp4',sizeBytes:400,durationSeconds:15,width:1920,height:1080,frameRate:24};};
  for(let pass=0;pass<12&&(await film.getPrepared({email,id:plan.id})).status!=='completed';pass++) {
    await queue.runTicket(path,{assemble});time+=6000;
  }
  const completed=await film.getPrepared({email,id:plan.id}),status=await queue.status({email,id:plan.id});
  assert.equal(completed.status,'completed');assert.equal(submits,plan.shotCount);assert.equal(polls,plan.shotCount);assert.equal(assemblies,1);
  assert.equal(status.purchaseReady,true);assert.equal(status.mediaReady,false);assert.equal(status.paymentLocked,true);
  assert.equal([...h.records.keys()].some(path=>path.startsWith('payments/')),false);
  assert.equal(reservations,1,'The whole pipeline reserves only once before admission');
  assert.ok(reservationChecks>=submits,'Every new provider submission verifies the original allowance');
  await queue.runTicket(path,{assemble});assert.equal(submits,plan.shotCount);assert.equal(assemblies,1);
  const quote=await preRender.purchaseQuote({email,preparedId:plan.id});assert.equal(quote.artifactSha256,sha256);
});

test('worker web authorization requires the matching new queue lease and preserves legacy payment dispatch', async () => {
  const h=fixture();await h.start();
  const job={...h.job,manifest:{...h.job.manifest,productionPlan:{provider:'seedance',version:1}},
    provider:{id:'fal',model:'seedance',recipe:SEEDANCE_RECIPE_VERSION}};
  // A separately prepared, internally consistent model plan is used for this
  // route-only check; grant validation remains covered by the service tests.
  job.manifestHash=digest(JSON.stringify(job.manifest));
  h.seed(h.jobPath(id),job);
  const orderId=digest(`${email}:production:${job.manifestHash}`),ticketPath=`production/queue/${digest(email)}/${id}.json`;
  h.seed(ticketPath,{version:1,email,id,orderId,manifestHash:job.manifestHash,authorizationKind:PRERENDER_FLOW,
    preRenderGrantId:digest('route-test-grant'),state:'pending',lease:{token:'owned-worker-lease',expiresAt:now+60000}});
  let studioCalls=0,paymentCalls=0;
  const handler=createProductionWorkerHandler({read:h.read,now:h.now,env:{LINEAGE_WORKER_SECRET:'a'.repeat(64)},
    adapter:{model:'seedance',modelVersion:SEEDANCE_RECIPE_VERSION,available:true},limiter:async()=>true,
    preRenderService:{authorize:async input=>{studioCalls++;assert.equal(input.orderId,orderId);return{allowed:true,manifestHash:job.manifestHash};}},
    paymentService:{authorizeProduction:async()=>{paymentCalls++;return{allowed:false};}}});
  const invoke=async()=>{const res={setHeader(){},end(value){this.body=JSON.parse(value);}};
    await handler({method:'POST',headers:{authorization:`Bearer ${'a'.repeat(64)}`},body:{email,preparedId:id,manifestHash:job.manifestHash,orderId,
      model:'seedance',recipe:SEEDANCE_RECIPE_VERSION,workerProtocol:2}},res);return res;};
  assert.equal((await invoke()).body.allowed,true);assert.equal(studioCalls,1);assert.equal(paymentCalls,0);
  const ticket=(await h.read(ticketPath)).value;h.seed(ticketPath,{...ticket,lease:{...ticket.lease,expiresAt:now-1}});
  assert.equal((await invoke()).statusCode,409);assert.equal(studioCalls,1);
  h.seed(ticketPath,{...ticket,authorizationKind:undefined});assert.equal((await invoke()).body.allowed,false);assert.equal(paymentCalls,1);
});
