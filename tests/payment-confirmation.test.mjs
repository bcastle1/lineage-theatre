import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
const compile = async path => ts.transpileModule(await readFile(new URL(path, import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
}).outputText;
const url = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const contract = url((await compile('../src/studio/checkout-contract.ts')).replaceAll('"./hosted-invoice-url.mjs"', JSON.stringify(new URL('../src/studio/hosted-invoice-url.mjs', import.meta.url).href)));
const library = url(await compile('../src/studio/film-library.ts'));
const { initialWorkspaceView } = await import(library);
const { readPaymentConfirmation, readPaymentFilm, watchPaymentConfirmation, paymentProductionSummary } = await import(url((await compile('../src/studio/payment-confirmation.ts')).replaceAll('"./checkout-contract"', JSON.stringify(contract)).replaceAll('"./film-library"', JSON.stringify(library))));
const { reservePaymentWindow, paymentReturnLink, paymentReturnOrder, rememberPaymentWindow, completePaymentWindow, releasePaymentWindows } = await import(url((await compile('../src/studio/payment-window.ts')).replaceAll('"./checkout-contract"', JSON.stringify(contract))));
const id = 'b'.repeat(64), stamp = '2026-10-08T12:00:00Z';
const invoiceUrl = 'https://connect.intuit.com/portal/app/CommerceNetwork/view/scs-v1-fixture';
const order = (status = 'captured') => ({ id, quoteId:'a'.repeat(64), preparedId:'00000000-0000-4000-8000-000000000001', filmId:'00000000-0000-4000-8000-000000000002', filmTitle:'SAMPLE ONLY', status, currency:'USD', amountCents:378, refundedCents:0,
  charged:status === 'captured', requiresReview:false, receiptAvailable:status === 'captured', createdAt:stamp, updatedAt:stamp, sandbox:false,
  checkoutMethod:'quickbooks-hosted-invoice', invoiceUrl, invoiceNumber:'SAMPLE', ...(status==='captured'?{confirmationSource:'quickbooks-accounting'}:{}) });
const film = () => ({kind:'plan', id:order().preparedId, filmId:order().filmId, title:'SAMPLE ONLY', durationSeconds:30,createdAt:stamp,updatedAt:stamp,libraryState:'active',revision:1,manifestHash:'c'.repeat(64),
  production:{status:'prepared',completedShots:0,shotCount:4,mediaReady:false,needsAttention:false},payments:[order()]});
const settle = async () => { for(let i=0;i<12;i++) await Promise.resolve(); };

test('payment return routes never interpret a URL as proof of payment', async()=>{
  assert.equal(paymentReturnOrder(paymentReturnLink(id)),id);
  assert.equal(initialWorkspaceView(paymentReturnLink(id),'member'),'payment');
  for(const hash of ['#paid-film?paid=true',paymentReturnLink(id)+'&paid=true','#paid-film?order=../admin']) assert.equal(paymentReturnOrder(hash),null);
  let requests=0;
  await assert.rejects(readPaymentConfirmation(async()=>{requests++;},'invalid'));
  assert.equal(requests,0);
});
test('return reconciles only the saved invoice and rejects changed payment bindings', async()=>{
  const calls=[];
  assert.equal((await readPaymentConfirmation(async(path,body)=>{calls.push({path,body}); return order(body?'captured':'awaiting-payment');},id)).status,'captured');
  assert.deepEqual(calls.map(x=>x.body).filter(Boolean),[{action:'checkPayment',orderId:id}]);
  for(const change of [{id:'d'.repeat(64)},{amountCents:379},{preparedId:'00000000-0000-4000-8000-000000000003'},{sandbox:true}]) {
    await assert.rejects(readPaymentConfirmation(async(_path,body)=>body?{...order(),...change}:order('awaiting-payment'),id));
  }
});
test('confirmed film must belong to the order before progress or media is shown',async()=>{
  assert.equal((await readPaymentFilm(async()=>({entry:film()}),order())).id,order().preparedId);
  for(const change of [{filmId:'00000000-0000-4000-8000-000000000003'},{payments:[]},{payments:[{...order(),amountCents:379}]}])
    await assert.rejects(readPaymentFilm(async()=>({entry:{...film(),...change}}),order()));
  assert.match(paymentProductionSummary(order(),film(),false),/production is currently unavailable.*has not started/);
  assert.doesNotMatch(paymentProductionSummary(order(),film(),false),/in production|minutes/);
});
test('background payment checks outlast two minutes and notify once only after verified payment', async()=>{
  let clock=0, callback, checks=0, paid=0, captured=false, current;
  const watcher=watchPaymentConfirmation({id,request:async(_path,body)=>{if(body) checks++;return order(captured?'captured':'awaiting-payment');},
    now:()=>clock,setTimer:fn=>(callback=fn,1),clearTimer:()=>{},isVisible:()=>false,onPaid:()=>paid++,onOrder:o=>current=o,onError:assert.fail});
  await settle();
  for(let i=0;i<6;i++){clock+=30000;callback();await settle();}
  assert.equal(checks,7);assert.equal(paid,0);assert.equal(current.status,'awaiting-payment');
  captured=true;clock+=30000;callback();await settle();assert.equal(paid,1);
  clock+=30000;callback();await settle();assert.equal(paid,1);watcher.stop();
});
test('logout cancels late responses and session failures stop polling', async()=>{
  let resolve, paid=0, notifications=0;
  const watcher=watchPaymentConfirmation({id,request:()=>new Promise(r=>resolve=r),onPaid:()=>paid++,onOrder:()=>notifications++,onError:assert.fail});
  watcher.stop();resolve(order());await settle();assert.equal(paid,0);assert.equal(notifications,0);
  let scheduled=0,message='';
  watchPaymentConfirmation({id,request:async()=>{throw {status:401};},setTimer:()=>{scheduled++;return 1;},onPaid:assert.fail,onOrder:assert.fail,onError:m=>message=m});
  await settle();assert.equal(scheduled,0);assert.match(message,/Sign in/);
});
test('pending checks are bounded and unavailable payment never triggers a return',async()=>{
  let clock=0, callback, checks=0, error='';
  const watcher=watchPaymentConfirmation({id,request:async()=>{checks++;return order('awaiting-payment');},now:()=>clock,setTimer:fn=>(callback=fn,1),clearTimer:()=>{},onPaid:assert.fail,onOrder:()=>{},onError:m=>error=m});
  await settle();clock=24*60000;callback();await settle();assert.equal(checks,2);assert.match(error,/paused/);watcher.stop();
});
test('payment windows return only once to the current app and survive checkout unmount',()=>{
  globalThis.window={location:{origin:'https://lineagetheater.com'}};
  try {
    const navigations=[];let closed=0;
    const tab={opener:{},document:{body:{}},closed:false,location:{replace:value=>navigations.push(value)},close:()=>closed++};
    const handle=reservePaymentWindow(()=>tab);
    assert.equal(handle.complete(id),false);assert.equal(handle.open(invoiceUrl),true);handle.close();assert.equal(closed,0);
    rememberPaymentWindow(id,handle);assert.equal(completePaymentWindow(id),true);assert.equal(completePaymentWindow(id),false);
    assert.deepEqual(navigations,[invoiceUrl,'https://lineagetheater.com/'+paymentReturnLink(id)]);assert.equal(closed,0);assert.ok(tab.opener);
    rememberPaymentWindow(id,reservePaymentWindow(()=>tab));releasePaymentWindows();assert.equal(completePaymentWindow(id),false);
  }finally{delete globalThis.window;}
});
test('browser isolation and closed windows safely retain the confirmation page fallback',()=>{
  globalThis.window={location:{origin:'https://lineagetheater.com'}};
  try {
    const tab={opener:{},document:{body:{}},closed:false,location:{replace:()=>{}},close:()=>{}};
    const handle=reservePaymentWindow(()=>tab);handle.open(invoiceUrl);
    tab.location.replace=()=>{throw new Error('isolated window');};assert.equal(handle.complete(id),false);
    const next=reservePaymentWindow(()=>tab);tab.location.replace=()=>{};next.open(invoiceUrl);tab.closed=true;assert.equal(next.complete(id),false);
  }finally{delete globalThis.window;}
});
