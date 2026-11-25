import test from 'node:test';
import assert from 'node:assert/strict';
import { digest } from '../api/_lib/auth.mjs';
import { createRemoteVisualFinalEditorialAuthorization } from '../api/_lib/remote-visual-final-editorial-authorization.mjs';

const now = () => Date.parse('2026-12-01T12:00:00Z');
const hash = value => digest(JSON.stringify(value));
const plan = { email: 'fictional@example.com', id: '00000000-0000-4000-8000-000000000099',
  manifestHash: digest('fictional manifest'), priorBindingHash: digest('fictional binding'), priorReceiptHash: digest('fictional receipt'),
  jobHash: digest('fictional stopped job'), queueHash: digest('fictional stopped queue'), originalAction: 'He turns the pencil around and offers it, eraser first.', revisedAction: 'He offers the pencil to the child.' };
const permission = () => ({ allowed: true, environment: 'production', manifestHash: plan.manifestHash,
  recoveryRequestHash: hash(plan), expiresAt: new Date(now() + 60000).toISOString() });

test('final-scene editorial recovery transport sends only the exact plan to the fixed plan-only authorization route', async () => {
  const calls = [], expected = permission();
  const authorize = createRemoteVisualFinalEditorialAuthorization({ now, env: { LINEAGE_WORKER_SECRET: 'a'.repeat(64) },
    fetchImpl: async (url, options) => { calls.push({ url, options }); return Response.json(expected); } });
  assert.deepEqual(await authorize({ recoveryPlan: plan, orderId: 'never-forwarded' }), expected);
  assert.equal(calls.length, 1); assert.equal(calls[0].url, 'https://lineagetheater.com/api/production-worker');
  assert.equal(calls[0].options.method, 'POST'); assert.equal(calls[0].options.redirect, 'error');
  assert.equal(calls[0].options.credentials, 'omit'); assert.equal(calls[0].options.cache, 'no-store');
  assert.deepEqual(JSON.parse(calls[0].options.body), { action: 'authorize-visual-final-editorial-recovery', recoveryPlan: plan, workerProtocol: 2 });
  assert.doesNotMatch(calls[0].options.body, /never-forwarded|aaaaa/);
});

test('missing credentials, missing plan and expanded plan cannot make a request', async () => {
  let calls = 0;
  for (const [env, recoveryPlan] of [[{}, plan], [{ LINEAGE_WORKER_SECRET: 'a'.repeat(64) }, null],
    [{ LINEAGE_WORKER_SECRET: 'a'.repeat(64) }, { ...plan, apply: true }]]) {
    await assert.rejects(createRemoteVisualFinalEditorialAuthorization({ env, now,
      fetchImpl: async () => { calls++; } })({ recoveryPlan }), { code: 'VISUAL_REVIEW_AUTH_REQUIRED' });
  }
  assert.equal(calls, 0);
});

test('revoked, expired, foreign or malformed grants stop after one request without leaking upstream text', async () => {
  const cases = [
    () => new Response('private upstream details', { status: 409 }),
    () => new Response('not json'), () => new Response('x'.repeat(4097)),
    () => Response.json({ ...permission(), allowed: false }),
    () => Response.json({ ...permission(), environment: 'sandbox' }),
    () => Response.json({ ...permission(), manifestHash: digest('other') }),
    () => Response.json({ ...permission(), recoveryRequestHash: digest('other plan') }),
    () => Response.json({ ...permission(), expiresAt: new Date(now()).toISOString() }),
    () => Response.json({ ...permission(), expiresAt: 'invalid date' }),
    () => { throw Error('private transport details'); },
  ];
  for (const reply of cases) {
    let calls = 0;
    const authorize = createRemoteVisualFinalEditorialAuthorization({ now, env: { LINEAGE_WORKER_SECRET: 'a'.repeat(64) },
      fetchImpl: async () => { calls++; return reply(); } });
    await assert.rejects(authorize({ recoveryPlan: plan }), error => error.code === 'VISUAL_REVIEW_AUTH_REQUIRED'
      && !error.message.includes('private'));
    assert.equal(calls, 1);
  }
});

test('a reply that expires while its body is being read cannot authorize a final-scene editorial recovery', async () => {
  let clock = now(); const expected = permission();
  const authorize = createRemoteVisualFinalEditorialAuthorization({ now: () => clock, env: { LINEAGE_WORKER_SECRET: 'a'.repeat(64) },
    fetchImpl: async () => new Response(new ReadableStream({ pull(controller) {
      clock += 60001; controller.enqueue(new TextEncoder().encode(JSON.stringify(expected))); controller.close();
    } })) });
  await assert.rejects(authorize({ recoveryPlan: plan }), { code: 'VISUAL_REVIEW_AUTH_REQUIRED' });
});
