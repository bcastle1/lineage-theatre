import test from 'node:test';
import assert from 'node:assert/strict';
import { digest, userPath } from '../api/_lib/auth.mjs';
import { OWNER_EMAIL } from '../api/_lib/access.mjs';
import { createFalReviewedDelivery } from '../api/_lib/fal-reviewed-delivery.mjs';
import { FAL_MODELS } from '../api/_lib/fal-client.mjs';

function fixture() {
  const actor = { email: OWNER_EMAIL, role: 'owner', status: 'active' }, at = new Date().toISOString();
  const id = '11111111-1111-4111-8111-111111111111', filmId = '22222222-2222-4222-8222-222222222222';
  const manifest = { version: 1, filmId, targetDurationSeconds: 30, shots: [{ id: 'shot-001' }] }, manifestHash = digest(JSON.stringify(manifest));
  const orderId = digest(`${OWNER_EMAIL}:production:${manifestHash}`), bytes = Buffer.alloc(1024, 7), sha = digest(bytes), identity = 'b'.repeat(64);
  const job = { id, ownerHash: digest(OWNER_EMAIL), filmId, manifest, manifestHash, mode: 'customer', status: 'prepared', shots: [{ id: 'shot-001', status: 'prepared' }] };
  const artifact = { pathname: `production/media/${job.ownerHash}/${id}/${sha}.mp4`, sha256: sha, manifestHash, sizeBytes: bytes.length, durationSeconds: 30,
    width: 1920, height: 1080, frameRate: 24, contentType: 'video/mp4', playable: true, hasAudio: true, technicalSample: false, verification: 'full-video-and-audio-decode' };
  const candidate = { version: 1, orderId, model: 'seedance', manifestHash, artifact, review: { approvedBy: OWNER_EMAIL, artifactSha256: sha, visual: true, speech: true, privatePlayback: true, reviewedAt: at },
    sources: [{ shotId: 'shot-001', identity, requestId: 'request-fixture', model: 'wan' }] };
  const order = { id: orderId, customerEmail: OWNER_EMAIL, preparedId: id, filmId, manifestHash, status: 'captured', capturedAt: at, currency: 'USD', amountCents: 378,
    refundedCents: 0, provider: 'quickbooks', merchantBinding: { environment: 'production', grantId: 'a'.repeat(64), realmId: '123' }, checkoutMethod: 'quickbooks-hosted-invoice',
    confirmationSource: 'quickbooks-accounting', invoiceId: '456', balanceCents: 0, accountingCheckedAt: at, accountingPayments: [{ id: '789', allocatedCents: 378 }] };
  const jobPath = `production/jobs/${job.ownerHash}/${id}.json`, candidatePath = `production/fal/candidates/${orderId}/seedance.json`;
  const records = new Map([[userPath(OWNER_EMAIL), actor], [jobPath, job], [candidatePath, candidate], [`payments/orders/${orderId}.json`, order],
    [`production/fal/comparisons/${orderId}.json`, { approvedBy: OWNER_EMAIL, customerEmail: OWNER_EMAIL, preparedId: id, manifestHash, customerAmountCents: 378 }],
    [`production/fal/requests/${identity}.json`, { state: 'completed', requestId: 'request-fixture', endpoint: FAL_MODELS.wan }]].map(([path,value]) => [path,{value:structuredClone(value),etag:'initial'}]));
  let paymentCalls = 0, writes = 0;
  const options = { read: async path => structuredClone(records.get(path)),
    write: async(path,value,etag) => { assert.equal(etag,records.get(path).etag); writes++;records.set(path,{value,etag:String(writes)}); },
    getBlob: async path => ({ blob: { pathname: path, size: bytes.length, contentType: 'video/mp4' }, stream: new Response(bytes).body }),
    checkPayment: async() => { paymentCalls++;return {...order, sandbox:false, requiresReview:false, receiptAvailable:true}; } };
  return { records, jobPath, candidatePath, order, orderId, sha, options, paymentCalls:()=>paymentCalls, writes:()=>writes };
}
test('reviewed edit rechecks live payment and exact private bytes, publishes once without changing order or inventing shots', async()=>{
  const f=fixture(),service=createFalReviewedDelivery(f.options),input={orderId:f.orderId,artifactSha256:f.sha};
  assert.equal((await service.deliver(input)).status,'completed');assert.equal(f.paymentCalls(),1);assert.equal(f.writes(),1);
  assert.deepEqual(f.records.get(`payments/orders/${f.orderId}.json`).value,f.order);
  assert.equal(f.records.get(f.jobPath).value.shots[0].status,'prepared');
  assert.equal((await service.deliver(input)).status,'completed');assert.equal(f.writes(),1);
});
test('unreviewed, foreign, unpaid, corrupted and concurrently changed candidates cannot complete a film',async()=>{
  for(const mutate of [
    f=>{f.records.get(f.candidatePath).value.review.privatePlayback=false;},
    f=>{f.records.get(f.candidatePath).value.review.approvedBy='other@example.invalid';},
    f=>{f.records.get(`payments/orders/${f.orderId}.json`).value.refundedCents=378;},
    f=>{f.options.checkPayment=async()=>({...f.order,sandbox:true});},
    f=>{f.options.getBlob=async path=>({blob:{pathname:path,size:1024,contentType:'video/mp4'},stream:new Response(Buffer.alloc(1024)).body});},
    f=>{const original=f.options.getBlob;f.options.getBlob=async path=>{f.records.get(f.candidatePath).etag='changed';return original(path);};},
  ]) { const f=fixture();mutate(f);await assert.rejects(createFalReviewedDelivery(f.options).deliver({orderId:f.orderId,artifactSha256:f.sha}));assert.equal(f.writes(),0); }
});

function replacementFixture() {
  const f=fixture(),oldSha='e'.repeat(64),job=f.records.get(f.jobPath).value;
  Object.assign(job,{status:'completed',media:{pathname:`previous/${oldSha}.mp4`,sha256:oldSha},
    authorization:{kind:'owner-reviewed-fal-edit',orderId:f.orderId,artifactSha256:oldSha},
    completedAt:'2026-10-01T00:00:00Z',editorialReview:{notes:['Original reviewed film']}});
  f.records.get(f.candidatePath).value.replacement={previousArtifactSha256:oldSha,approvedBy:OWNER_EMAIL,
    requestedAt:'2026-10-02T00:00:00Z',reason:'user-requested-photorealism'};
  return {...f,old:structuredClone(job),input:{orderId:f.orderId,artifactSha256:f.sha,previousArtifactSha256:oldSha}};
}
test('a reviewed visual correction preserves the old playable artifact and paid manifest atomically',async()=>{
  const f=replacementFixture(),service=createFalReviewedDelivery(f.options);
  assert.equal((await service.deliver(f.input)).status,'completed');
  const saved=f.records.get(f.jobPath).value;
  assert.equal(saved.media.sha256,f.sha);
  assert.deepEqual(saved.manifest,f.old.manifest);assert.deepEqual(saved.shots,f.old.shots);
  assert.deepEqual(saved.editorialHistory[0].media,f.old.media);
  assert.deepEqual(saved.editorialHistory[0].authorization,f.old.authorization);
  assert.deepEqual(saved.editorialHistory[0].editorialReview,f.old.editorialReview);
  assert.deepEqual(f.records.get(`payments/orders/${f.orderId}.json`).value,f.order);
  assert.equal((await service.deliver(f.input)).status,'completed');assert.equal(f.writes(),1);
});
test('replacing a delivered film requires the exact previous artifact, owner request and unchanged job',async()=>{
  for(const mutate of [
    f=>{delete f.input.previousArtifactSha256;},
    f=>{f.input.previousArtifactSha256='f'.repeat(64);},
    f=>{f.records.get(f.candidatePath).value.replacement.approvedBy='other@example.invalid';},
    f=>{f.records.get(f.candidatePath).value.replacement.reason='unknown';},
    f=>{f.records.get(f.candidatePath).value.replacement.requestedAt='2999-01-01T00:00:00Z';},
    f=>{f.records.get(f.jobPath).value.authorization.orderId='a'.repeat(64);},
    f=>{const get=f.options.getBlob;f.options.getBlob=async path=>{f.records.get(f.jobPath).etag='changed';return get(path);};},
  ]) {const f=replacementFixture();mutate(f);await assert.rejects(createFalReviewedDelivery(f.options).deliver(f.input));assert.equal(f.writes(),0);}
});
