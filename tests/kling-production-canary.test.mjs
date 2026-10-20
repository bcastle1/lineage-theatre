import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../scripts/test-kling-production.mjs', import.meta.url));
function run(...args) {
  return spawnSync(process.execPath,[script,...args],{encoding:'utf8',
    env:{PATH:process.env.PATH,SYSTEMROOT:process.env.SYSTEMROOT,NODE_ENV:'test'}});
}
test('canary planning is offline, fixed fictional content and bounded at three dollars',()=>{
  const result=run('plan');
  assert.equal(result.status,0,result.stderr);
  const value=JSON.parse(result.stdout);
  assert.equal(value.kind,'fictional-kling-production-canary-v1');
  assert.equal(value.durationSeconds,15);assert.equal(value.providerSeconds,16);
  assert.equal(value.videoRequests,3);assert.equal(value.referenceRequests,2);
  assert.equal(value.maximumCostCents,300);assert.equal(value.invoiceCreated,false);
  assert.equal(value.customerPaymentCreated,false);assert.match(value.manifestHash,/^[a-f0-9]{64}$/);
});
test('every mutating canary action requires the exact explicit fixed-budget switch',()=>{
  for(const action of ['prepare','step','finish']){
    for(const args of [[action],[action,'--execute-approved-301-cents'],[action,'--execute-approved-300-cents','extra']]){
      const result=run(...args);assert.equal(result.status,1);
      assert.equal(JSON.parse(result.stdout).code,'CANARY_USAGE');
    }
  }
});
