import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { digest } from '../api/_lib/auth.mjs';
import { runVisualEditorialRecovery, EDITORIAL_APPLY_FLAG } from '../scripts/recover-film-visual-editorial.mjs';

test('operator command defaults to read-only and requires the explicit application flag', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lineage-editorial-cli-')), filename = join(dir, 'fictional-plan.json');
  const plan = { email: 'fictional@example.com', id: '00000000-0000-4000-8000-000000000099',
    manifestHash: digest('fictional manifest'), priorBindingHash: digest('fictional binding'), priorReceiptHash: digest('fictional receipt'),
    jobHash: digest('fictional job'), queueHash: digest('fictional queue'), originalAction: 'At the last letter she lifts her finger; they exchange a smile.', revisedAction: 'After the writing, they exchange a smile.' };
  const calls = [], service = async (input, options) => { calls.push({ input, options }); return { status: options.apply ? 'resumed' : 'planned' }; };
  try {
    await writeFile(filename, JSON.stringify(plan));
    assert.equal((await runVisualEditorialRecovery([filename], service)).status, 'planned');
    assert.equal((await runVisualEditorialRecovery(['plan', filename], service)).status, 'planned');
    assert.ok(calls.every(call => call.options.apply === false));
    assert.equal((await runVisualEditorialRecovery(['apply', filename, EDITORIAL_APPLY_FLAG], service)).status, 'resumed');
    assert.deepEqual(calls[2], { input: plan, options: { apply: true } });
    for (const args of [[], ['apply', filename], ['apply', filename, '--yes'], ['plan', filename, EDITORIAL_APPLY_FLAG],
      ['apply', filename, EDITORIAL_APPLY_FLAG, 'extra'], ['retry', filename]]) {
      await assert.rejects(runVisualEditorialRecovery(args, service), { code: 'VISUAL_EDITORIAL_USAGE' });
    }
    assert.equal(calls.length, 3);
    for (const bytes of [JSON.stringify({ ...plan, orderId: digest('unapproved order') }), 'null', '[]', '{', 'x'.repeat(16001)]) {
      await writeFile(filename, bytes); await assert.rejects(runVisualEditorialRecovery([filename], service));
    }
    assert.equal(calls.length, 3);
  } finally {
    assert.ok(resolve(dir).startsWith(resolve(tmpdir()) + sep));
    assert.ok(dir.includes('lineage-editorial-cli-'));
    await rm(dir, { recursive: true, force: true });
  }
});
