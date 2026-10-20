import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { klingReferenceData } from '../api/_lib/fal-reference.mjs';

const photo = async (width,height) => `data:image/jpeg;base64,${(await sharp({create:{width,height,channels:3,background:'#a04020'}}).jpeg().toBuffer()).toString('base64')}`;
const bytes = data => Buffer.from(data.split(',')[1],'base64');

test('Kling photo derivatives meet size bounds while preserving the complete portrait proportions',async()=>{
  const small=await photo(202,280), result=await klingReferenceData(small,{fetchImpl:()=>assert.fail('Selected photo stays local')});
  const info=await sharp(bytes(result)).metadata();
  assert.equal(info.width,300);assert.equal(info.height,416);assert.equal(info.format,'jpeg');
  assert.equal(await klingReferenceData(small),result);
  for(const [width,height] of [[100,1000],[1000,100],[4000,3000],[400,600]]) {
    const normalized=await klingReferenceData(await photo(width,height)),meta=await sharp(bytes(normalized)).metadata();
    assert.ok(meta.width>=300&&meta.height>=300&&meta.width<=1600&&meta.height<=1600);
    assert.ok(meta.width/meta.height>=.4&&meta.width/meta.height<=2.5);
    assert.ok(bytes(normalized).length<=2*1024*1024);
  }
});

test('Kling references reject untrusted remote origins and invalid images before use',async()=>{
  for(const value of ['https://evil.invalid/photo.jpg','http://v3.fal.media/photo.jpg','data:image/jpeg;base64,bm90YW5pbWFnZQ==']){
    await assert.rejects(klingReferenceData(value,{fetchImpl:()=>assert.fail('No request to an untrusted origin')}));
  }
});

test('generated reference downloads use the same bounded Kling derivative',async()=>{
  const source=await photo(202,280);let requests=0;
  const result=await klingReferenceData('https://v3.fal.media/kling-reference-fixture.jpg',{fetchImpl:async(url,options)=>{
    requests++;assert.equal(options.redirect,'error');assert.equal(options.credentials,'omit');
    return new Response(bytes(source),{headers:{'content-type':'image/jpeg'}});
  }});
  const info=await sharp(bytes(result)).metadata();
  assert.equal(requests,1);assert.equal(info.width,300);assert.equal(info.height,416);
});
