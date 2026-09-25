import test from 'node:test';
import assert from 'node:assert/strict';
import { checkSavedMagicLightTest } from '../scripts/check-saved-magiclight-test.mjs';

test('operator check never creates a missing test', async () => {
  const result = await checkSavedMagicLightTest({ read: async () => null, service: { check() { assert.fail('No saved test to check'); } } });
  assert.equal(result.savedTest, false);
  assert.equal(result.generationSubmitted, false);
});

test('operator check uses persisted owner and returns only safe status metadata', async () => {
  const actor = { email: 'owner@example.invalid', role: 'owner' };
  let reads = 0;
  const result = await checkSavedMagicLightTest({ read: async () => ({ value: reads++ === 0 ? { ownerEmail: actor.email } : actor }),
    service: { async check(value) { assert.equal(value, actor); return { test: { status: 'completed', providerCode: 10000,
      taskStatus: 2, outputOrigin: 'https://cdn.example.invalid', taskId: 'private-task', videoUrl: 'https://cdn.example.invalid/secret', ownerEmail: actor.email } }; } } });
  assert.equal(result.status, 'completed');
  assert.equal(result.productionReady, false);
  assert.equal(result.generationSubmitted, false);
  assert.doesNotMatch(JSON.stringify(result), /private-task|\/secret|owner@example/);
});
