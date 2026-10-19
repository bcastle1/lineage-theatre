import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { join, resolve } from 'node:path';
import { digest, readRecord, writeRecord, userPath } from '../api/_lib/auth.mjs';
import { OWNER_EMAIL, isOwner } from '../api/_lib/access.mjs';
import { comparisonPath } from '../api/_lib/fal-comparison.mjs';
import { createFalClient, FAL_MODELS, FAL_MEDIA_HOSTS, falMediaUrl } from '../api/_lib/fal-client.mjs';
import { falShotInput, FAL_RECIPE_VERSION, FAL_PROMPT_VERSION, falPlan } from '../api/_lib/fal-production.mjs';
import { downloadProductionClip } from './production-worker.mjs';

// An explicit bounded editorial pass. No automatic retries of completed or
// uncertain requests, and no customer order or production job is modified.
const [orderId, outputDirectory] = process.argv.slice(2);
if (!/^[a-f0-9]{64}$/.test(orderId || '') || !outputDirectory) throw new Error('Choose a saved comparison and output directory.');
process.env.BLOB_READ_WRITE_TOKEN = parseEnv(await readFile(process.env.LINEAGE_BLOB_ENV_FILE, 'utf8')).BLOB_READ_WRITE_TOKEN;
async function context(){
  const comparison=(await readRecord(comparisonPath(orderId)))?.value;
  const order=(await readRecord(`payments/orders/${orderId}.json`))?.value;
  const owner=(await readRecord(userPath(OWNER_EMAIL)))?.value;
  if(!comparison || comparison.approvedBy!==OWNER_EMAIL || comparison.maximumCostCents!==10000 || Date.parse(comparison.expiresAt)<=Date.now()
    || !isOwner(owner) || owner.mustChangePassword || order?.status!=='captured' || order.refundedCents!==0 || order.refundOperation || order.checkOperation
    || order.manifestHash!==comparison.manifestHash || order.amountCents!==comparison.customerAmountCents) throw new Error('Editorial spending authorization changed.');
  const job=(await readRecord(`production/jobs/${digest(order.customerEmail)}/${order.preparedId}.json`))?.value;
  if(!job || job.status!=='prepared' || job.shots.some(s=>s.status!=='prepared') || digest(JSON.stringify(job.manifest))!==comparison.manifestHash) throw new Error('Production already changed.');
  // Include one complete Wan size-correction pass as a conservative reserve.
  const total=comparison.estimatedCostCents+Math.ceil(falPlan(job.manifest,'seedance').generatedSeconds*(comparison.rates.seedance+comparison.rates.wan)/10000);
  if(total>comparison.maximumCostCents)throw new Error('The editorial pass exceeds the approved merchant budget.');
  return {comparison,order,job,total};
}
const {comparison,job,total}=await context(),client=createFalClient();
const ledgerPath=`production/fal/refinements/${orderId}/seedance-v2.json`;
let ledger=await readRecord(ledgerPath);
if(!ledger){await writeRecord(ledgerPath,{version:1,approvedBy:OWNER_EMAIL,orderId,manifestHash:job.manifestHash,promptVersion:FAL_PROMPT_VERSION,maximumTotalCostCents:total,approvedAt:new Date().toISOString()});ledger=await readRecord(ledgerPath);}
if(ledger.value.manifestHash!==job.manifestHash || ledger.value.promptVersion!==FAL_PROMPT_VERSION || ledger.value.maximumTotalCostCents!==total)throw new Error('The editorial ledger changed.');
const refs={};
for(const c of falPlan(job.manifest,'seedance').characters){
  const r=await client.get(digest(`${FAL_RECIPE_VERSION}:cast:${job.id}:${job.manifestHash}:${c.id}`));
  if(r?.state!=='completed'||r.result?.images?.length!==1)throw new Error('Character reference is incomplete.');refs[c.id]=r.result.images[0].url;
}
await mkdir(resolve(outputDirectory),{recursive:true});const results=[];
for(const shot of job.manifest.shots){
  const key=job.shots.find(s=>s.id===shot.id).requestKey;
  const originalIdentity=digest(`${FAL_RECIPE_VERSION}:seedance:${key}`),identity=digest(`${originalIdentity}:editorial-v2`);
  let result=await client.get(identity);
  if(!result){await context();const input=falShotInput(job.manifest,shot,'seedance',refs);
    input.prompt += shot.id===job.manifest.shots[0].id
      ? '\nThis is the 1777 scene. Nathan is the teenage boy on the left of @Image1, exclusively. No elderly Nathan. His wound is suggested only by a hand on clean unbroken clothing: absolutely no blood or visible injury.'
      : '\nThis scene is in the early 1830s. Use ONLY the elderly gray-haired Nathan from @Image1. Never include teenage Nathan.'
        + (shot.characterIds.includes('hannah') ? ' Hannah is the woman in muted blue from @Image2. Only elderly Nathan and Hannah appear.' : ' Nathan, Leonard, and David are three different men; only these three appear.');
    result=await client.submit({identity,endpoint:FAL_MODELS.seedance,input});
  }else if(!['completed','failed'].includes(result.state)&&result.requestId)result=await client.poll(identity);
  results.push({shotId:shot.id,originalIdentity,identity,requestId:result.requestId,state:result.state});
  if(result.state==='completed'){
    const url=falMediaUrl(result.result.video.url),r=await fetch(url,{method:'HEAD',redirect:'error',credentials:'omit',signal:AbortSignal.timeout(20000)});
    if(!r.ok)throw new Error('Editorial output cannot be verified.');
    const output={url,contentType:r.headers.get('content-type')?.split(';')[0],sizeBytes:Number(r.headers.get('content-length')),durationSeconds:Math.ceil(shot.targetDurationMs/1000)};
    const path=join(resolve(outputDirectory),`${shot.id}.mp4`);
    const old=await readFile(path).catch(()=>null);
    if(!old)await writeFile(path,await downloadProductionClip(output,FAL_MEDIA_HOSTS),{flag:'wx'});
    else if(old.length!==output.sizeBytes)throw new Error('Saved editorial clip changed.');
  }
}
await writeFile(join(resolve(outputDirectory),'receipts.json'),JSON.stringify({orderId,productionId:job.id,manifestHash:job.manifestHash,promptVersion:FAL_PROMPT_VERSION,results},null,2));
console.log(JSON.stringify({maximumTotalCostCents:total,results}));
