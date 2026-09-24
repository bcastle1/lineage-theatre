import test from "node:test";
import assert from "node:assert/strict";
import {createHostedCheckoutService,HostedCheckoutError,HOSTED_CHECKOUT_SETTINGS_PATH} from "../api/_lib/hosted-checkout.mjs";
import {digest,userPath} from "../api/_lib/auth.mjs";
import {OWNER_EMAIL} from "../api/_lib/access.mjs";

const OWNER={email:OWNER_EMAIL,role:"owner"};
const CUSTOMER={email:"customer@example.invalid",role:"customer",status:"active",approvedAt:"2026-09-01T00:00:00Z",approvedBy:OWNER_EMAIL};
const OTHER={...CUSTOMER,email:"other@example.invalid"};
const NOW=Date.parse("2026-09-23T18:00:00Z"),BINDING={environment:"production",grantId:"a".repeat(64),realmId:"1234"};
const MANIFEST=digest("fictional-film"),PREPARED="fictional-prepared-film-123",KEY="fictional-price-request-123",CHECKOUT="fictional-checkout-request-123";
const TERMS={deliveryTerms:"Your finished film will be delivered within 24 hours after payment.",refundTerms:"You may request a full refund within 10 calendar days after payment by contacting admin@brocotech.ai with your order reference."};
const settings={revision:1,enabled:true,serviceItemId:"2",serviceItemName:"Film production",taxCode:"NON",...TERMS,merchantConfirmed:true,pciAcknowledged:true,automaticInvoiceEmailDisabled:true,merchantBinding:BINDING};
const json=data=>new Response(JSON.stringify(data),{status:200});
function fixture(options={}) {
  let serial=0,time=NOW,binding=structuredClone(BINDING),dispatch=options.dispatch,manifest=MANIFEST;
  const records=new Map(),requests=[],bindings=[],quotes=[];
  const seed=(path,value)=>records.set(path,{value:structuredClone(value),etag:`etag-${++serial}`});
  for(const actor of [OWNER,CUSTOMER,OTHER])seed(userPath(actor.email),actor);
  if(options.configured!==false)seed(HOSTED_CHECKOUT_SETTINGS_PATH,settings);
  const read=async path=>structuredClone(records.get(path)||null);
  const write=async(path,value,etag)=>{
    await options.beforeWrite?.(path,value);
    const previous=records.get(path);if(previous?previous.etag!==etag:Boolean(etag))throw Error("CAS conflict");
    seed(path,value);await options.afterWrite?.(path,value);return read(path);
  };
  let invoice=null,customer=null,invoiceCount=0;
  const transport={binding:async options=>{bindings.push(options);return structuredClone(binding);},request:async(expected,operation)=>{
    assert.deepEqual(expected,binding);requests.push(structuredClone(operation));
    if(dispatch){const overridden=await dispatch(operation,expected);if(overridden!==undefined)return overridden;}
    if(operation.path==="/query")return json({QueryResponse:operation.query.entity==="Item"?{Item:[{Id:"2",Name:"Film production",Active:true,Type:"Service",Taxable:false}]}:{Customer:customer?[customer]:[]}});
    if(operation.path==="/item/2")return json({Item:{Id:"2",Name:"Film production",Type:"Service",Active:true,Taxable:false}});
    if(operation.path==="/customer") {customer={Id:"20",Active:true,...operation.body};return json({Customer:customer});}
    if(operation.path==="/customer/20")return json({Customer:customer});
    if(operation.path==="/invoice") {
      invoice={...structuredClone(operation.body),Id:String(30+invoiceCount++),DocNumber:"1001",TotalAmt:15,Balance:15,InvoiceLink:"https://connect.intuit.com/portal/app/example",LinkedTxn:[],...options.invoiceOverrides};return json({Invoice:invoice});
    }
    if(operation.path==="/invoice/30")return json({Invoice:invoice});
    if(operation.path==="/payment/40")return json({Payment:{Id:"40",CustomerRef:{value:"20"},CurrencyRef:{value:"USD"},TotalAmt:15,TxnDate:"2026-09-23",Line:[{Amount:15,LinkedTxn:[{TxnId:"30",TxnType:"Invoice"}]}]}});
    assert.fail(`Unexpected operation ${operation.method} ${operation.path}`);
  }};
  const dependencies={read,write,transport,receiptDelivery:options.receiptDelivery||{deliver:async()=>{}},now:()=>time,env:{QUICKBOOKS_ENVIRONMENT:"production",LINEAGE_PAYMENT_ACCESS:"owner",...options.env},
    pricingSettings:async()=>({revision:0,markupBasisPoints:5000}),quoteProvider:async(project,actor,request)=>{
      quotes.push({project,actor,request});return {preparedId:PREPARED,manifestHash:manifest,filmId:"fictional-film",filmTitle:"Private fictional story",currency:"USD",providerCostCents:1000,
        pricingBasis:"planning-rate",pricingRevision:0,quoteReference:"fictional-reference",environment:binding.environment,expiresAt:new Date(time+300_000).toISOString(),...options.quoteOverrides};}};
  const service=createHostedCheckoutService(dependencies),makeQuote=(actor=OWNER,key=KEY)=>service.quote(actor,{project:{title:"Private source material"},preparedId:PREPARED,idempotencyKey:key});
  const checkout=async(actor=OWNER)=>{const q=await makeQuote(actor);return service.checkout(actor,{quoteId:q.id,idempotencyKey:CHECKOUT,consent:true});};
  return {service,records,requests,bindings,quotes,read,write,seed,makeQuote,checkout,peer:()=>createHostedCheckoutService(dependencies),advance:n=>time+=n,setBinding:b=>binding=b,setDispatch:d=>dispatch=d,
    invoice:()=>invoice,editInvoice:changes=>invoice={...invoice,...changes},setManifest:value=>manifest=value,editCustomer:changes=>customer={...customer,...changes}};
}
const error=(promise,code)=>assert.rejects(promise,e=>e instanceof HostedCheckoutError&&(!code||e.code===code));
const mutationRequests=h=>h.requests.filter(r=>r.method==="POST");

test("hosted settings default disabled; read-only configuration does not refresh and draft saves require explicit fields",async()=>{
  const h=fixture({configured:false});const initial=await h.service.settings(OWNER);assert.equal(initial.enabled,false);assert.equal(initial.configured,false);assert.equal(initial.serviceItemId,"");
  assert.deepEqual(await h.service.configuration(OWNER),{available:false});assert.equal(h.bindings.length,0);
  const draft=await h.service.saveSettings(OWNER,{expectedRevision:0,enabled:false,serviceItemId:"",taxCode:"NON",deliveryTerms:"",refundTerms:TERMS.refundTerms,merchantConfirmed:false,pciAcknowledged:false,automaticInvoiceEmailDisabled:false});
  assert.equal(draft.revision,1);assert.equal(draft.configured,false);assert.equal(h.requests.length,0);
  await error(h.service.saveSettings(OWNER,{expectedRevision:1,enabled:true,serviceItemId:"",taxCode:"NON",deliveryTerms:"",refundTerms:TERMS.refundTerms,merchantConfirmed:false,pciAcknowledged:false,automaticInvoiceEmailDisabled:false}));
  const configured=fixture();assert.equal((await configured.service.configuration(OWNER)).available,true);assert.deepEqual(configured.bindings,[{allowRefresh:false}]);assert.equal(configured.requests.length,0);
});

test("hosted owner settings validate actual active service item, explicit NON/terms/attestations and CAS",async()=>{
  const h=fixture({configured:false}),body={expectedRevision:0,enabled:true,serviceItemId:"2",taxCode:"NON",...TERMS,merchantConfirmed:true,pciAcknowledged:true,automaticInvoiceEmailDisabled:true};
  const result=await h.service.saveSettings(OWNER,body);assert.equal(result.configured,true);assert.equal(result.serviceItemName,"Film production");assert.equal(mutationRequests(h).length,0);
  assert.deepEqual(h.records.get(HOSTED_CHECKOUT_SETTINGS_PATH).value.merchantBinding,BINDING);
  await error(h.service.saveSettings(OWNER,body),"PAYMENT_CONFLICT");
  for(const change of [{taxCode:"TAX"},{merchantConfirmed:false},{pciAcknowledged:false},{automaticInvoiceEmailDisabled:false},{deliveryTerms:""},{refundTerms:""}])await error(fixture({configured:false}).service.saveSettings(OWNER,{...body,...change}));
  for(const item of [{Id:"2",Name:"Wrong",Active:false,Type:"Service"},{Id:"2",Name:"Wrong",Active:true,Type:"Inventory"},{Id:"9",Name:"Wrong",Active:true,Type:"Service"}]) {
    const bad=fixture({configured:false,dispatch:op=>op.path==="/item/2"?json({Item:item}):undefined});await error(bad.service.saveSettings(OWNER,body));assert.equal(bad.records.has(HOSTED_CHECKOUT_SETTINGS_PATH),false);
  }
});

test("hosted current owner gate runs before any refresh, denies suspended/stale roles and invalid access mode",async()=>{
  for(const actor of [CUSTOMER,OTHER]) {const h=fixture();assert.deepEqual(await h.service.configuration(actor,{allowRefresh:true}),{available:false});assert.equal(h.bindings.length,0);await error(h.makeQuote(actor));await error(h.service.catalog(actor));assert.equal(h.requests.length,0);}
  for(const value of [{...OWNER,status:"suspended"},{...OWNER,role:"customer"},{...OWNER,mustChangePassword:true}]) {
    const h=fixture();h.seed(userPath(OWNER.email),value);assert.deepEqual(await h.service.configuration(OWNER,{allowRefresh:true}),{available:false});assert.equal(h.bindings.length,0);await error(h.service.settings(OWNER));
  }
  const bad=fixture({env:{LINEAGE_PAYMENT_ACCESS:"everyone"}});assert.deepEqual(await bad.service.configuration(OWNER,{allowRefresh:true}),{available:false});assert.equal(bad.bindings.length,0);
  const approved=fixture({env:{LINEAGE_PAYMENT_ACCESS:"approved"}});assert.equal((await approved.service.configuration(CUSTOMER)).available,true);
});

test("catalog returns only active Service projections and does not mutate accounting",async()=>{
  const h=fixture({dispatch:op=>op.path==="/query"?json({QueryResponse:{Item:[{Id:"2",Name:"Good",Active:true,Type:"Service",Taxable:false,Secret:"discard"},{Id:"3",Name:"Inactive",Active:false,Type:"Service"},{Id:"4",Name:"Stock",Active:true,Type:"Inventory"}]}}):undefined});
  assert.deepEqual(await h.service.catalog(OWNER),{environment:"production",items:[{id:"2",name:"Good",active:true,type:"Service",taxable:false}],truncated:false});assert.equal(mutationRequests(h).length,0);assert.deepEqual(h.bindings,[{allowRefresh:true}]);
});

test("fixed hosted quotes retain exact retail math, terms snapshot and do not expose private costs",async()=>{
  const h=fixture(),q=await h.makeQuote();assert.equal(q.amountCents,1500);assert.equal(q.orderId,digest(`${OWNER.email}:production:${MANIFEST}`));assert.equal(q.method,"quickbooks-hosted-invoice");assert.equal(q.deliveryTerms,TERMS.deliveryTerms);assert.deepEqual(await h.makeQuote(),q);
  assert.doesNotMatch(JSON.stringify(q),/providerCost|grantId|markupCents/);assert.equal(h.requests.length,0);assert.equal(h.quotes[0].request.environment,"production");
  for(const change of [{providerCostCents:-1},{currency:"EUR"},{pricingRevision:2},{expiresAt:"bad"},{preparedId:"mismatch"},{environment:"sandbox"},{pricingBasis:"provider-quote",apiVerified:false}])await error(fixture({quoteOverrides:change}).makeQuote());
  h.advance(300_001);await error(h.makeQuote(),"QUOTE_EXPIRED");
});

test("hosted checkout creates exactly one minimal customer and fixed invoice with no send or private film data",async()=>{
  const h=fixture(),order=await h.checkout();assert.equal(order.status,"awaiting-payment");assert.equal(order.charged,false);assert.equal(order.requiresReview,false);assert.equal(order.receiptAvailable,false);
  assert.equal(order.invoiceUrl,"https://connect.intuit.com/portal/app/example");assert.equal(order.invoiceNumber,"1001");assert.equal(Object.hasOwn(order,"confirmationSource"),false);
  const posts=mutationRequests(h);assert.equal(posts.length,2);assert.deepEqual(posts.map(x=>x.path),["/customer","/invoice"]);
  assert.deepEqual(Object.keys(posts[0].body).sort(),["DisplayName","PrimaryEmailAddr"]);assert.equal(posts[0].body.PrimaryEmailAddr.Address,OWNER.email);
  assert.equal(posts[1].body.Line[0].Amount,15);assert.equal(posts[1].body.Line[0].Description,"Film production");assert.equal(posts[1].body.EmailStatus,"NotSet");assert.equal(posts[1].body.Line[0].SalesItemLineDetail.TaxCodeRef.value,"NON");
  assert.doesNotMatch(JSON.stringify(h.requests),/Private fictional story|Private source material|\/send|cvc|cardNumber|paymentToken/);
  assert.ok(posts.every(p=>/^[a-f0-9]{8}-[a-f0-9]{4}-5[a-f0-9]{3}-8[a-f0-9]{3}-[a-f0-9]{12}$/.test(p.requestId)));
  assert.deepEqual(await h.checkout(),order);assert.equal(mutationRequests(h).length,2);assert.equal(await h.service.ownsOrder(order.id),true);
  await error(h.service.authorizeProduction({orderId:order.id}));
});

test("concurrent hosted checkouts across service instances produce one invoice and customer",async()=>{
  const h=fixture(),q=await h.makeQuote(),body={quoteId:q.id,idempotencyKey:CHECKOUT,consent:true};
  const outcomes=await Promise.allSettled([h.service.checkout(OWNER,body),h.peer().checkout(OWNER,body),h.service.checkout(OWNER,{...body,idempotencyKey:"another-checkout-key-123"})]);
  assert.ok(outcomes.some(r=>r.status==="fulfilled"&&r.value.status==="awaiting-payment"));assert.equal(mutationRequests(h).filter(r=>r.path==="/invoice").length,1);assert.equal(mutationRequests(h).filter(r=>r.path==="/customer").length,1);
});

test("invoice creation without a link reads the same invoice to obtain its secure payment page",async()=>{
  const link="https://connect.intuit.com/portal/app/CommerceNetwork/view/scs-v1-fixture";
  let h;h=fixture({invoiceOverrides:{InvoiceLink:undefined},dispatch:op=>op.path==="/invoice/30"?json({Invoice:{...h.invoice(),InvoiceLink:link}}):undefined});
  const order=await h.checkout();
  assert.equal(order.status,"awaiting-payment");assert.equal(order.requiresReview,false);assert.equal(order.charged,false);assert.equal(order.invoiceUrl,link);
  assert.equal(h.requests.filter(r=>r.method==="GET"&&r.path==="/invoice/30").length,1);
  assert.equal(mutationRequests(h).filter(r=>r.path==="/invoice").length,1);
});

test("canonical Intuit short invoice links are payable and recover an existing rejected invoice without another POST",async()=>{
  for(const suffix of ["","?locale=en_US","?locale=en_us","?locale=EN_us"]) {
    const link=`https://connect.intuit.com/t/scs-v1-${"aB09".repeat(24)}${suffix}`;
    const h=fixture({invoiceOverrides:{InvoiceLink:link}}),order=await h.checkout();
    assert.equal(order.status,"awaiting-payment");assert.equal(order.invoiceUrl,link);assert.equal(order.charged,false);assert.equal(order.requiresReview,false);
    const path=`payments/orders/${order.id}.json`,saved=h.records.get(path).value,before=mutationRequests(h).length;
    h.seed(path,{...saved,status:"uncertain",invoiceUrl:null,invoiceLinkStatus:"invalid"});
    assert.equal((await h.service.order(OWNER,order.id)).invoiceUrl,null);
    const recovered=await h.service.check(OWNER,{orderId:order.id});
    assert.equal(recovered.id,order.id);assert.equal(recovered.status,"awaiting-payment");assert.equal(recovered.invoiceUrl,link);
    assert.equal(recovered.requiresReview,false);assert.equal(recovered.receiptAvailable,false);assert.equal(h.records.get(path).value.invoiceId,saved.invoiceId);
    assert.equal((await h.checkout()).invoiceUrl,link);assert.equal(mutationRequests(h).length,before);
    assert.equal(h.requests.filter(r=>r.method==="GET"&&r.path==="/invoice/30").length,1);
  }
});

test("short invoice links reject malformed tokens, alternate origins and unapproved query parameters",async()=>{
  const token="a".repeat(96),base=`https://connect.intuit.com/t/scs-v1-${token}`;
  const invalid=[base.slice(0,-1),`${base}a`,base.replace(token,"g".repeat(96)),base.replace("scs-v1-","scs-v2-"),base.replace("/t/","/other/"),
    `${base}/`,`${base}/next`,`${base}#payment`,`${base}?`,`${base}?locale=en-US`,`${base}?locale=en`,`${base}?locale=en_US&locale=fr_CA`,
    `${base}?redirect=https://evil.example`,`${base}?locale=en_US&redirect=https://evil.example`,`${base}?Locale=en_US`,`${base}?locale=en%5fUS`,
    base.replace("https:","http:"),base.replace("connect.intuit.com","connect.intuit.com.evil.example"),base.replace("connect.intuit.com","user@connect.intuit.com"),
    base.replace("connect.intuit.com","connect.intuit.com:443"),base.replace("/t/","/portal/../t/"),base.replace("/t/","/t/%2E%2E/t/"),
    base.replace(token,`%61${token.slice(1)}`),`${base}\\other`,` ${base}`,`${base}\n`];
  for(const link of invalid) {
    const h=fixture({invoiceOverrides:{InvoiceLink:link}}),order=await h.checkout();
    assert.equal(order.status,"uncertain",link);assert.equal(order.invoiceUrl,null);assert.equal(order.requiresReview,true);assert.equal(order.receiptAvailable,false);
    const checked=await h.service.check(OWNER,{orderId:order.id});
    assert.equal(checked.status,"uncertain",link);assert.equal(checked.invoiceUrl,null);
    assert.equal(mutationRequests(h).filter(r=>r.path==="/invoice").length,1);
  }
});

test("an unpaid invoice waiting for its link recovers through status reads without another invoice",async()=>{
  for(const missing of [undefined,null]) {
    const h=fixture({invoiceOverrides:{InvoiceLink:missing}}),order=await h.checkout();
    assert.equal(order.status,"awaiting-payment");assert.equal(order.requiresReview,false);assert.equal(order.charged,false);assert.equal(order.receiptAvailable,false);
    assert.equal(order.invoiceUrl,null);assert.equal(order.retryAllowed,false);
    const saved=h.records.get(`payments/orders/${order.id}.json`).value;
    assert.equal(saved.invoiceId,"30");assert.equal(saved.invoiceLinkStatus,"pending");
    assert.equal(Object.hasOwn(order,"invoiceLinkStatus"),false);
    await error(h.service.receipt(OWNER,order.id));
    // Recover an order saved by the previous release as well as newly created orders.
    if(missing===undefined)h.seed(`payments/orders/${order.id}.json`,{...saved,status:"uncertain",invoiceLinkStatus:undefined});
    const before=mutationRequests(h).length;
    const pending=await h.service.check(OWNER,{orderId:order.id});
    assert.equal(pending.status,"awaiting-payment");assert.equal(pending.invoiceUrl,null);assert.equal(pending.charged,false);
    const link="https://connect.intuit.com/portal/app/CommerceNetwork/view/scs-v1-delayed";h.editInvoice({InvoiceLink:link});
    const ready=await h.service.check(OWNER,{orderId:order.id});
    assert.equal(ready.id,order.id);assert.equal(ready.status,"awaiting-payment");assert.equal(ready.invoiceUrl,link);assert.equal(ready.requiresReview,false);
    assert.equal(h.records.get(`payments/orders/${order.id}.json`).value.invoiceId,"30");
    assert.equal((await h.checkout()).id,order.id);assert.equal(mutationRequests(h).length,before);
    assert.equal(h.requests.filter(r=>r.method==="GET"&&r.path==="/invoice/30").length,3);
  }
});

test("a missing invoice link never masks changed financial details or an unsafe returned URL",async()=>{
  const h=fixture({invoiceOverrides:{InvoiceLink:undefined}}),order=await h.checkout();
  for(const change of [{TotalAmt:14},{Balance:14},{CustomerRef:{value:"99"}},{CurrencyRef:{value:"EUR"}},{BillEmail:{Address:OTHER.email}},{AllowOnlineCreditCardPayment:false},
    {InvoiceLink:""},{InvoiceLink:"https://evil.example/portal/pay"},{InvoiceLink:"https://connect.intuit.com/portal/pay#unexpected"}]) {
    const original=structuredClone(h.invoice());h.editInvoice(change);
    const checked=await h.service.check(OWNER,{orderId:order.id});
    assert.equal(checked.status,"uncertain",JSON.stringify(change));assert.equal(checked.requiresReview,true);assert.equal(checked.invoiceUrl,null);assert.equal(checked.receiptAvailable,false);
    h.editInvoice(original);
  }
  assert.equal(mutationRequests(h).filter(r=>r.path==="/invoice").length,1);
});

test("ambiguous customer and invoice create results never replay POST or issue a second order",async()=>{
  for(const failingPath of ["/customer","/invoice"]) {
    const h=fixture({dispatch:op=>{if(op.method==="POST"&&op.path===failingPath)throw Error("synthetic timeout containing no real secrets");}}),first=await h.checkout();assert.equal(first.status,"uncertain");assert.equal(first.charged,null);assert.equal(first.invoiceUrl,null);
    const before=mutationRequests(h).length;const again=await h.checkout();assert.equal(again.id,first.id);assert.equal(again.status,"uncertain");assert.equal(mutationRequests(h).length,before);assert.equal(mutationRequests(h).filter(p=>p.path===failingPath).length,1);
    assert.doesNotMatch(JSON.stringify([...h.records.values()]),/synthetic timeout/);
  }
});

test("durable claim failure occurs before any customer/invoice mutation",async()=>{
  const h=fixture({beforeWrite:path=>{if(path.startsWith("payments/orders/"))throw Error("storage failed");}});await error(h.checkout(),"PAYMENT_CONFLICT");assert.equal(mutationRequests(h).length,0);
});

test("stale grant, terms, legacy production identity and direct-card collision prevent new invoices",async()=>{
  const h=fixture(),q=await h.makeQuote();h.setBinding({...BINDING,grantId:"b".repeat(64)});await error(h.service.checkout(OWNER,{quoteId:q.id,idempotencyKey:CHECKOUT,consent:true}));assert.equal(h.requests.length,0);
  const terms=fixture(),tq=await terms.makeQuote();terms.seed(HOSTED_CHECKOUT_SETTINGS_PATH,{...settings,revision:2,deliveryTerms:"Different terms"});await error(terms.service.checkout(OWNER,{quoteId:tq.id,idempotencyKey:CHECKOUT,consent:true}),"QUOTE_EXPIRED");assert.equal(terms.requests.length,0);
  for(const legacy of [true,false]) {const collision=fixture();collision.seed(`payments/orders/${legacy?digest(`${OWNER.email}:${MANIFEST}`):digest(`${OWNER.email}:production:${MANIFEST}`)}.json`,{customerEmail:OWNER.email,manifestHash:MANIFEST,merchantBinding:BINDING,status:"captured"});await error(collision.makeQuote(),"PAYMENT_CONFLICT");assert.equal(collision.requests.length,0);}
});

test("invalid invoice amount/customer/item/tax and unsafe links never expose a payable link",async()=>{
  for(const change of [{TotalAmt:14},{CustomerRef:{value:"99"}},{BillEmail:{Address:OTHER.email}},{CurrencyRef:{value:"EUR"}},{TxnTaxDetail:{TotalTax:1}},{EmailStatus:"EmailSent"},
    ...["https://evil.example/portal/pay","https://connect.intuit.com.evil.example/portal/pay","https://connect.intuit.com:443/portal/pay","https://user@connect.intuit.com/portal/pay","https://connect.intuit.com/portal/pay#secret","https://connect.intuit.com/portal/../evil","https://connect.intuit.com/portal/"," https://connect.intuit.com/portal/pay"].map(InvoiceLink=>({InvoiceLink}))]) {
    const h=fixture({dispatch:op=>op.path==="/invoice"?json({Invoice:{...op.body,Id:"30",DocNumber:"1001",TotalAmt:15,Balance:15,InvoiceLink:"https://connect.intuit.com/portal/app/example",LinkedTxn:[],...change}}):undefined});
    const o=await h.checkout();assert.equal(o.status,"uncertain",JSON.stringify(change));assert.equal(o.invoiceUrl,null);assert.equal(o.receiptAvailable,false);
  }
});

test("storage-only order reads enforce tenant ownership and remain usable when production access is restricted",async()=>{
  const h=fixture({env:{LINEAGE_PAYMENT_ACCESS:"approved"}}),o=await h.checkout(CUSTOMER),before=h.requests.length;
  assert.deepEqual(await h.service.order(CUSTOMER,o.id),o);await error(h.service.order(OTHER,o.id));assert.equal((await h.service.order(OWNER,o.id)).id,o.id);assert.equal(h.requests.length,before);
  h.seed(HOSTED_CHECKOUT_SETTINGS_PATH,{...settings,enabled:false});assert.equal((await h.service.order(CUSTOMER,o.id)).id,o.id);assert.equal(h.requests.length,before);
});

test("zero balance is not paid until matching linked Accounting Payment allocations are verified",async()=>{
  const h=fixture(),o=await h.checkout();h.editInvoice({Balance:0});let checked=await h.service.check(OWNER,{orderId:o.id});assert.equal(checked.status,"uncertain");await error(h.service.receipt(OWNER,o.id));
  h.editInvoice({LinkedTxn:[{TxnType:"Payment",TxnId:"40"}]});checked=await h.service.check(OWNER,{orderId:o.id});assert.equal(checked.status,"captured");assert.equal(checked.charged,true);assert.equal(checked.confirmationSource,"quickbooks-accounting");assert.equal(checked.invoiceUrl,null);
  const receipt=await h.service.receipt(OWNER,o.id);assert.equal(receipt.confirmationSource,"quickbooks-accounting");assert.equal(receipt.checkoutMethod,"quickbooks-hosted-invoice");assert.equal(receipt.transactionId,"40");assert.match(receipt.notice,/recorded by QuickBooks/);assert.match(receipt.notice,/settlement are not verified/);
  const saved=h.records.get(`payments/orders/${o.id}.json`).value;assert.equal(saved.providerChargeId,null);assert.equal(saved.settlementVerified,false);assert.equal(saved.accountingPayments[0].allocatedCents,1500);await error(h.service.authorizeProduction({orderId:o.id}));
});

test("partial/mismatched/manual-credit/void allocations remain unconfirmed and never map to Payments refund",async()=>{
  const invalids=[{CustomerRef:{value:"99"}},{CurrencyRef:{value:"EUR"}},{TotalAmt:1},{Voided:true},{Line:[{Amount:14,LinkedTxn:[{TxnId:"30",TxnType:"Invoice"}]}]},
    {Line:[{Amount:15,LinkedTxn:[{TxnId:"31",TxnType:"Invoice"}]}]},{Line:[{Amount:15,LinkedTxn:[{TxnId:"30",TxnType:"Invoice"},{TxnId:"90",TxnType:"CreditMemo"}]}]}];
  for(const change of invalids) {
    const h=fixture(),o=await h.checkout();h.editInvoice({Balance:0,LinkedTxn:[{TxnType:"Payment",TxnId:"40"}]});h.setDispatch(op=>op.path==="/payment/40"?json({Payment:{Id:"40",CustomerRef:{value:"20"},CurrencyRef:{value:"USD"},TotalAmt:15,Line:[{Amount:15,LinkedTxn:[{TxnId:"30",TxnType:"Invoice"}]}],...change}}):undefined);
    const checked=await h.service.check(OWNER,{orderId:o.id});assert.equal(checked.status,"uncertain");assert.equal(checked.charged,null);await error(h.service.receipt(OWNER,o.id));assert.equal(mutationRequests(h).length,2);
  }
  const credit=fixture(),order=await credit.checkout();credit.editInvoice({Balance:0,LinkedTxn:[{TxnType:"CreditMemo",TxnId:"40"}]});assert.equal((await credit.service.check(OWNER,{orderId:order.id})).status,"uncertain");
});

test("an older overlapping status response cannot overwrite a newer confirmed accounting payment",async()=>{
  const h=fixture(),o=await h.checkout();let release,started;const waiting=new Promise(resolve=>started=resolve),blocked=new Promise(resolve=>release=resolve);let first=true;
  h.setDispatch(async op=>{if(op.path==="/invoice/30"&&first){first=false;const stale=structuredClone(h.invoice());started();await blocked;return json({Invoice:stale});}});
  const old=h.service.check(OWNER,{orderId:o.id});await waiting;h.editInvoice({Balance:0,LinkedTxn:[{TxnType:"Payment",TxnId:"40"}]});const newer=await h.peer().check(OWNER,{orderId:o.id});assert.equal(newer.status,"captured");release();await error(old,"PAYMENT_CONFLICT");assert.equal((await h.service.order(OWNER,o.id)).status,"captured");
});

test("oversized/malformed provider replies are not persisted and cause no repeat mutations",async()=>{
  for(const reply of [()=>new Response("x".repeat(262145)),()=>new Response("not JSON"),()=>new Response("private error",{status:500})]) {
    const h=fixture({dispatch:op=>op.path==="/invoice"?reply():undefined});const o=await h.checkout();assert.equal(o.status,"uncertain");await h.checkout();assert.equal(mutationRequests(h).filter(r=>r.path==="/invoice").length,1);assert.doesNotMatch(JSON.stringify([...h.records.values()]),/private error|not JSON/);
  }
});

test("different quote or checkout identity for the same saved film cannot persist a mismatched order reference",async()=>{
  const h=fixture(),q=await h.makeQuote(),o=await h.checkout();await error(h.makeQuote(OWNER,"another-quote-request-123"),"ORDER_ALREADY_EXISTS");
  await error(h.service.checkout(OWNER,{quoteId:q.id,idempotencyKey:"another-checkout-key-123",consent:true}),"ORDER_ALREADY_EXISTS");
  assert.equal(mutationRequests(h).length,2);assert.equal(h.records.get(`payments/orders/${o.id}.json`).value.version,1);assert.equal(h.records.get(`payments/orders/${o.id}.json`).value.provider,"quickbooks");
});

test("same-company reconnect revalidates cached customer and safely reuses it for a different film",async()=>{
  const h=fixture();await h.checkout();const fresh={...BINDING,grantId:"b".repeat(64)};h.setBinding(fresh);h.seed(HOSTED_CHECKOUT_SETTINGS_PATH,{...settings,revision:2,merchantBinding:fresh});
  h.setManifest(digest("another-film"));const q=await h.makeQuote(OWNER,"another-quote-request-123");const order=await h.service.checkout(OWNER,{quoteId:q.id,idempotencyKey:CHECKOUT,consent:true});
  assert.equal(order.status,"awaiting-payment");assert.equal(mutationRequests(h).filter(r=>r.path==="/customer").length,1);assert.equal(mutationRequests(h).filter(r=>r.path==="/invoice").length,2);assert.ok(h.requests.some(r=>r.path==="/customer/20"));
  const map=[...h.records.entries()].find(([path])=>path.startsWith("payments/hosted-customers/"))[1].value;assert.equal(map.merchantBinding.grantId,fresh.grantId);
});

test("changed or deactivated cached customer blocks the next invoice without creating a duplicate customer",async()=>{
  for(const changed of [{Active:false},{PrimaryEmailAddr:{Address:OTHER.email}},{DisplayName:"Another customer"}]) {
    const h=fixture();await h.checkout();h.editCustomer(changed);h.setManifest(digest("another-film"));const q=await h.makeQuote(OWNER,"another-quote-request-123");
    const order=await h.service.checkout(OWNER,{quoteId:q.id,idempotencyKey:CHECKOUT,consent:true});assert.equal(order.status,"uncertain");assert.equal(order.retryAllowed,true);assert.equal(mutationRequests(h).length,2);
  }
});

test("two films racing the first customer creation can resume only the order without an invoice attempt",async()=>{
  const h=fixture(),q1=await h.makeQuote();h.setManifest(digest("second-film"));const q2=await h.makeQuote(OWNER,"second-quote-request-123");let release,started;
  const waiting=new Promise(resolve=>started=resolve),blocked=new Promise(resolve=>release=resolve);let first=true;
  h.setDispatch(async op=>{if(op.path==="/customer"&&first){first=false;started();await blocked;}});
  const a=h.service.checkout(OWNER,{quoteId:q1.id,idempotencyKey:CHECKOUT,consent:true});await waiting;
  const b=await h.peer().checkout(OWNER,{quoteId:q2.id,idempotencyKey:CHECKOUT,consent:true});assert.equal(b.status,"uncertain");assert.equal(b.retryAllowed,true);release();assert.equal((await a).status,"awaiting-payment");
  const retried=await h.service.checkout(OWNER,{quoteId:q2.id,idempotencyKey:CHECKOUT,consent:true});assert.equal(retried.status,"awaiting-payment");assert.equal(retried.retryAllowed,false);assert.equal(retried.id,b.id);
  assert.equal(mutationRequests(h).filter(r=>r.path==="/customer").length,1);assert.equal(mutationRequests(h).filter(r=>r.path==="/invoice").length,2);
});

test("safe pre-invoice retry keeps original expiry, settings, grant and consent requirements",async()=>{
  for(const change of ["expired","settings","grant","consent"]) {
    const h=fixture();let fail=true;h.setDispatch(op=>{if(op.path==="/item/2"&&fail){fail=false;throw Error("temporary read failure");}});
    const q=await h.makeQuote(),first=await h.service.checkout(OWNER,{quoteId:q.id,idempotencyKey:CHECKOUT,consent:true});assert.equal(first.retryAllowed,true);
    if(change==="expired")h.advance(300_001);if(change==="settings")h.seed(HOSTED_CHECKOUT_SETTINGS_PATH,{...settings,revision:2});if(change==="grant")h.setBinding({...BINDING,grantId:"b".repeat(64)});
    if(["expired","settings"].includes(change))assert.equal((await h.service.order(OWNER,first.id)).retryAllowed,false);
    await error(h.service.checkout(OWNER,{quoteId:q.id,idempotencyKey:CHECKOUT,consent:change!=="consent"}));assert.equal(mutationRequests(h).filter(r=>r.path==="/invoice").length,0);
  }
});

test("disabling checkout or revoking the account during final claim prevents the invoice POST",async()=>{
  for(const disable of [true,false]) {
    let h;h=fixture({afterWrite:async(path,value)=>{if(path.startsWith("payments/orders/")&&value.invoiceAttemptedAt&&value.status==="submitting") {
      if(disable)h.seed(HOSTED_CHECKOUT_SETTINGS_PATH,{...settings,enabled:false,revision:2});else h.seed(userPath(OWNER.email),{...OWNER,status:"suspended"});
    }}});
    const order=await h.checkout();assert.equal(order.status,"uncertain");assert.equal(order.retryAllowed,false);assert.equal(mutationRequests(h).filter(r=>r.path==="/invoice").length,0);
  }
});

test("existing invoice checks survive pause and same-company reconnect without changing original creation binding",async()=>{
  const h=fixture(),o=await h.checkout(),fresh={...BINDING,grantId:"b".repeat(64)};h.setBinding(fresh);h.seed(HOSTED_CHECKOUT_SETTINGS_PATH,{...settings,enabled:false});h.editInvoice({Balance:0,LinkedTxn:[{TxnType:"Payment",TxnId:"40"}]});
  assert.equal((await h.service.check(OWNER,{orderId:o.id})).status,"captured");const saved=h.records.get(`payments/orders/${o.id}.json`).value;assert.deepEqual(saved.merchantBinding,BINDING);assert.deepEqual(saved.lastCheckedBinding,fresh);assert.equal(mutationRequests(h).length,2);
  h.setBinding({...fresh,realmId:"9999"});const count=h.requests.length;await error(h.service.check(OWNER,{orderId:o.id}),"PAYMENT_CONFLICT");assert.equal(h.requests.length,count);
});

test("merchant terms reject unsupported markup characters and normalize line endings",async()=>{
  const body={expectedRevision:0,enabled:true,serviceItemId:"2",taxCode:"NON",...TERMS,merchantConfirmed:true,pciAcknowledged:true,automaticInvoiceEmailDisabled:true};
  await error(fixture({configured:false}).service.saveSettings(OWNER,{...body,deliveryTerms:"Delivery < 24 hours"}));
  const saved=await fixture({configured:false}).service.saveSettings(OWNER,{...body,deliveryTerms:"Delivery\r\nwithin 24 hours"});assert.equal(saved.deliveryTerms,"Delivery\nwithin 24 hours");
});

test("confirmed payment persists before receipt delivery and mail failure preserves payment",async()=>{
  let h,attempts=0;
  h=fixture({receiptDelivery:{deliver:async order=>{
    attempts++;
    assert.equal((await h.read(`payments/orders/${order.id}.json`)).value.status,"captured");
    assert.equal(order.accountingPayments[0].allocatedCents,order.amountCents);
    throw new Error("Synthetic mail unavailable");
  }}});
  const order=await h.checkout();
  await h.service.check(OWNER,{orderId:order.id});
  assert.equal(attempts,0);
  h.editInvoice({Balance:0,LinkedTxn:[{TxnId:"40",TxnType:"Payment"}]});
  const paid=await h.service.check(OWNER,{orderId:order.id});
  assert.equal(paid.status,"captured");
  assert.equal(paid.receiptAvailable,true);
  assert.equal(attempts,1);
});
