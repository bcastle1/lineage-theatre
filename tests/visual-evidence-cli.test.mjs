import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { digest } from '../api/_lib/auth.mjs';
import { runVisualEvidenceRecovery, EVIDENCE_APPLY_FLAG } from '../scripts/recover-film-visual-evidence.mjs';

test('operator command defaults to read-only and requires the explicit application flag', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lineage-evidence-cli-')), filename = join(dir, 'fictional-plan.json');
  const plan = { email: 'fictional@example.com', id: '00000000-0000-4000-8000-000000000099',
    manifestHash: digest('fictional manifest'), priorBindingHash: digest('fictional binding'), priorReceiptHash: digest('fictional receipt'),
    jobHash: digest('fictional job'), queueHash: digest('fictional queue') };
  const calls = [], service = async (input, options) => { calls.push({ input, options }); return { status: options.apply ? 'resumed' : 'planned' }; };
  try {
    await writeFile(filename, JSON.stringify(plan));
    assert.equal((await runVisualEvidenceRecovery([filename], service)).status, 'planned');
    assert.equal((await runVisualEvidenceRecovery(['plan', filename], service)).status, 'planned');
    assert.ok(calls.every(call => call.options.apply === false));
    assert.equal((await runVisualEvidenceRecovery(['apply', filename, EVIDENCE_APPLY_FLAG], service)).status, 'resumed');
    assert.deepEqual(calls[2], { input: plan, options: { apply: true } });
    for (const args of [[], ['apply', filename], ['apply', filename, '--yes'], ['plan', filename, EVIDENCE_APPLY_FLAG],
      ['apply', filename, EVIDENCE_APPLY_FLAG, 'extra'], ['retry', filename]]) {
      await assert.rejects(runVisualEvidenceRecovery(args, service), { code: 'VISUAL_EVIDENCE_USAGE' });
    }
    assert.equal(calls.length, 3);
    for (const bytes of [JSON.stringify({ ...plan, orderId: digest('unapproved order') }), 'null', '[]', '{', 'x'.repeat(16001)]) {
      await writeFile(filename, bytes); await assert.rejects(runVisualEvidenceRecovery([filename], service));
    }
    assert.equal(calls.length, 3);
  } finally {
    assert.ok(resolve(dir).startsWith(resolve(tmpdir()) + sep));
    assert.ok(dir.includes('lineage-evidence-cli-'));
    await rm(dir, { recursive: true, force: true });
  }
});
