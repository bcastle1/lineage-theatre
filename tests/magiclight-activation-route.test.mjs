import test from 'node:test';
import assert from 'node:assert/strict';
import { createAdminHandler } from '../api/admin.mjs';
import { OWNER_EMAIL } from '../api/_lib/access.mjs';

const owner = { email: OWNER_EMAIL, role: 'owner', status: 'active' };
function fixture(actor = owner, limit = () => true) {
  const calls = [], events = [], limits = [];
  const result = { generationSubmitted: false, productionReady: false, test: null };
  const handler = createAdminHandler({ getSession: async () => actor ? { user: actor } : null,
    limitAction: async (...args) => { limits.push(args); return limit(...args); },
    audit: async (...args) => events.push(args),
    magiclightActivationStatus: Object.fromEntries(['status', 'check'].map(method => [method, async current => {
      calls.push([method, current]); return result;
    }])),
  });
  return { calls, events, limits, async run({ method = 'POST', fields = {}, query = '', origin = 'https://lineagetheater.com' } = {}) {
    const action = method === 'GET' ? 'magicLightActivationStatus' : 'checkMagicLightActivationStatus';
    const headers = {}; let body;
    const res = { statusCode: 0, setHeader: (name, value) => { headers[name] = value; }, end: value => { body = JSON.parse(value); } };
    await handler({ method, url: `/api/admin?action=${action}${query}`, headers: { host: 'lineagetheater.com', origin },
      ...(method === 'POST' ? { body: { action, ...fields } } : {}) }, res);
    return { status: res.statusCode, body, headers };
  } };
}

test('activation status is owner-only and uses existing session and same-origin guards', async () => {
  for (const actor of [null, { ...owner, role: 'admin' }, { ...owner, role: 'customer' },
    { ...owner, status: 'suspended' }, { ...owner, mustChangePassword: true }]) {
    const h = fixture(actor);
    assert.ok([401, 403].includes((await h.run()).status));
    assert.ok([401, 403].includes((await h.run({ method: 'GET' })).status));
    assert.equal(h.calls.length, 0);
  }
  const h = fixture();
  assert.equal((await h.run({ origin: 'https://elsewhere.invalid' })).status, 403);
  assert.equal(h.calls.length, 0);
});

test('activation route accepts no caller task, key, path, payment or generation input', async () => {
  const h = fixture();
  for (const name of ['taskId', 'apiKey', 'pathname', 'consent', 'orderId', 'prompt']) {
    assert.equal((await h.run({ fields: { [name]: 'untrusted' } })).status, 400);
    for (const method of ['GET', 'POST']) assert.equal((await h.run({ method, query: `&${name}=untrusted` })).status, 400);
  }
  assert.equal(h.calls.length, 0);
  const get = await h.run({ method: 'GET' });
  assert.equal(get.status, 200); assert.match(get.headers['Cache-Control'], /no-store/);
  assert.equal((await h.run()).status, 200);
  assert.deepEqual(h.calls, [['status', owner], ['check', owner]]);
  assert.equal(h.events.length, 1);
  assert.equal(h.events[0][1], 'production.activation_test.checked');
  assert.deepEqual(h.limits.at(-1), [`magiclight-activation-check:${owner.email}`, 6, 60_000]);
});

test('global and activation-specific limits prevent provider polling', async () => {
  for (const limit of [() => false, key => !key.startsWith('magiclight-activation-check:')]) {
    const h = fixture(owner, limit);
    assert.equal((await h.run()).status, 429); assert.equal(h.calls.length, 0);
  }
});
