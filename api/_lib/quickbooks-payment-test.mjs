import {randomUUID} from "node:crypto";
import {digest,readRecord,writeRecord,userPath} from "./auth.mjs";
import {isOwner} from "./access.mjs";
import {createQuickBooksPaymentsTransport,quickbooksConfig,QuickBooksError} from "./quickbooks.mjs";
import {createIntuitPaymentsAdapter} from "./payments.mjs";
import {tokenizeSandboxFixture} from "./intuit-sandbox-fixture.mjs";

// Owner-operated, fictional-money verification of the existing Payments adapter.
// It cannot accept card data, choose a merchant, change an amount, create a film
// order, or authorize customer checkout. Each sandbox grant gets one saved test.
const amountCents=100;
const operations=["charge","refund","read","refresh"];
const pathFor=binding=>`integrations/quickbooks/payment-tests/${binding.grantId}.json`;
const stamp=now=>new Date(now).toISOString();
const sameBinding=(a,b)=>a?.environment==="sandbox"&&b?.environment==="sandbox"&&a.grantId===b.grantId;
const tokenizationFailedMessage="The fictional card could not be tokenized. No charge was attempted. You can retry this test.";
const invalid=message=>new QuickBooksError(message,400,"PAYMENT_TEST_INVALID");
const conflict=()=>new QuickBooksError("The test changed or is already running. Refresh its status before continuing.",409,"PAYMENT_TEST_CONFLICT");

export function createQuickBooksPaymentTestService(overrides={}) {
  const {read=readRecord,write=writeRecord,now=Date.now,env=process.env,
    environment=()=>quickbooksConfig(env).environment,
    tokenize=tokenizeSandboxFixture,
    createProvider=options=>createIntuitPaymentsAdapter({now,transport:createQuickBooksPaymentsTransport({read,env,now,...options})})}=overrides;

  async function owner(actor) {
    const current=actor?.email?(await read(userPath(actor.email)))?.value:null;
    // Shared owner authorization includes suspension and legacy records;
    // both the session and the current private account must still qualify.
    if(!isOwner(actor)||actor.mustChangePassword
      ||!isOwner(current)||current.mustChangePassword)
      throw new QuickBooksError("Only the active owner can run the payment connection test.",403,"PAYMENT_TEST_OWNER_REQUIRED");
  }
  async function context(actor,allowRefresh) {
    await owner(actor);
    if(environment()!=="sandbox")
      throw new QuickBooksError("This test requires the QuickBooks sandbox connection. Production payments cannot be tested with a fictional card.",409,"PAYMENT_TEST_SANDBOX_REQUIRED");
    let pinnedBinding;
    const authorizeSandbox=async({binding,operation})=>{
      await owner(actor);
      if(environment()!=="sandbox"||binding?.environment!=="sandbox"||!operations.includes(operation)
        ||(pinnedBinding&&!sameBinding(pinnedBinding,binding)))return null;
      pinnedBinding={...binding};
      // This narrowly scoped permission exists only inside this fixed fixture
      // service. It is never persisted as a review or shared with checkout.
      return {...binding,evidenceHash:digest(`fictional-one-dollar-test:${actor.email}:${binding.grantId}`),
        validatedAt:stamp(now()),expiresAt:stamp(now()+60_000),operations};
    };
    const provider=createProvider({authorizeSandbox,authorizeProduction:async()=>null});
    const binding=await provider.binding({allowRefresh});
    if(binding?.environment!=="sandbox"||!/^[a-f0-9]{64}$/.test(binding.grantId||"")
      ||(pinnedBinding&&!sameBinding(pinnedBinding,binding)))throw conflict();
    pinnedBinding={...binding};
    return {provider,binding,path:pathFor(binding)};
  }
  async function save(path,previous,value) {
    const next={...value,changeId:randomUUID(),updatedAt:stamp(now())};
    try {
      const result=await write(path,next,previous?.etag);
      if(result?.etag)return {value:next,etag:result.etag};
    }catch {/* Confirm a lost write response; never retry a processor mutation. */}
    const saved=await read(path);
    if(saved?.value?.changeId!==next.changeId)throw conflict();
    return saved;
  }
  function result(record,message="") {
    const value=record?.value;
    return {available:true,environment:"sandbox",amountCents,currency:"USD",
      message:message||(value?.status==="tokenization-failed"?tokenizationFailedMessage:""),
      test:value?{status:value.status,chargeVerified:Boolean(value.chargeVerifiedAt),refundVerified:Boolean(value.refundVerifiedAt),
        chargeId:value.chargeId||null,refundId:value.refundId||null,requestId:value.chargeRequestId,refundRequestId:value.refundRequestId,
        createdAt:value.createdAt,updatedAt:value.updatedAt}:null};
  }
  async function status(actor) {
    await owner(actor);
    try {
      const ctx=await context(actor,false);
      return result(await read(ctx.path));
    }catch(error) {
      if(error instanceof QuickBooksError&&error.status===403)throw error;
      return {available:false,environment:null,amountCents,currency:"USD",test:null,
        message:error?.code==="PAYMENT_TEST_SANDBOX_REQUIRED"?error.message:
          "Connect or renew the QuickBooks sandbox authorization before running this test."};
    }
  }
  async function run(actor,body) {
    if(!body||typeof body!=="object"||Array.isArray(body)||Object.keys(body).some(key=>key!=="operation")
      ||!["charge","refund","check"].includes(body.operation))throw invalid("Select a supported payment test action only.");
    const ctx=await context(actor,true);
    let record=await read(ctx.path);
    if(record&&!sameBinding(record.value.binding,ctx.binding))throw conflict();
    if(body.operation==="charge") {
      if(record&&record.value.status!=="tokenization-failed")
        return result(record,"This connection already has a saved test. Check its status instead of creating another charge.");
      // A saved tokenization failure proves no charge was attempted. Claim its
      // retry conditionally, preserving request IDs. Every other saved state
      // prohibits another charge, including lost processor replies or crashes.
      record=await save(ctx.path,record,record?{...record.value,status:"submitting"}:
        {binding:ctx.binding,status:"submitting",createdAt:stamp(now()),chargeRequestId:randomUUID(),refundRequestId:randomUUID()});
      let paymentToken;
      try {paymentToken=await tokenize({now});}
      catch {
        record=await save(ctx.path,record,{...record.value,status:"tokenization-failed"});
        return result(record,tokenizationFailedMessage);
      }
      let outcome;
      try {
        outcome=await ctx.provider.charge(ctx.binding,{amountCents,paymentToken,requestId:record.value.chargeRequestId});
      }catch {
        record=await save(ctx.path,record,{...record.value,status:"uncertain"});
        return result(record,"The test result needs review. No second charge will be submitted.");
      }
      const captured=outcome.verified&&outcome.status==="CAPTURED";
      const declined=outcome.verified&&["DECLINED","CANCELLED"].includes(outcome.status);
      record=await save(ctx.path,record,{...record.value,status:captured?"captured":declined?"declined":"uncertain",
        ...(outcome.verified&&outcome.id?{chargeId:outcome.id}:{})});
      return result(record,captured?"The sandbox charge was captured. Check its status to verify the saved transaction before refunding it.":
        declined?"Intuit declined this sandbox test charge.":"The test result needs review. No second charge will be submitted.");
    }
    if(!record)throw invalid("Create the sandbox test charge first.");
    if(body.operation==="refund") {
      if(record.value.status==="refunded"||record.value.status==="refund-pending")
        return result(record,"A refund was already submitted. Check its status; no second refund will be submitted.");
      if(record.value.status!=="captured"||!record.value.chargeVerifiedAt||!record.value.chargeId)
        throw invalid("Verify the captured sandbox charge before refunding it.");
      record=await save(ctx.path,record,{...record.value,status:"refund-pending"});
      let outcome;
      try {outcome=await ctx.provider.refund(ctx.binding,{chargeId:record.value.chargeId,amountCents,requestId:record.value.refundRequestId});}
      catch {return result(record,"The refund result needs review. No second refund will be submitted.");}
      const refunded=outcome.verified&&outcome.status==="ISSUED";
      record=await save(ctx.path,record,{...record.value,status:refunded?"refunded":"refund-pending",
        ...(outcome.verified&&outcome.id?{refundId:outcome.id}:{})});
      return result(record,refunded?"The sandbox refund was issued. Check its status to complete verification.":"The refund result needs review. No second refund will be submitted.");
    }
    // Readback is safe to repeat. Missing IDs need provider-side investigation;
    // Request-Id is kept for that investigation, never for an automatic retry.
    if(record.value.status==="tokenization-failed")return result(record,tokenizationFailedMessage);
    const refundStage=["refund-pending","refunded"].includes(record.value.status);
    if(!record.value.chargeId||(refundStage&&!record.value.refundId))
      return result(record,"No transaction reference was confirmed. Review this test in the Intuit sandbox; do not submit it again.");
    let outcome;
    try {
      outcome=refundStage
        ?await ctx.provider.readRefund(ctx.binding,{chargeId:record.value.chargeId,refundId:record.value.refundId,amountCents})
        :await ctx.provider.readCharge(ctx.binding,{chargeId:record.value.chargeId,amountCents});
    }catch {return result(record,"Intuit could not confirm the transaction status. Try checking again later.");}
    const matches=outcome.verified&&outcome.id===(refundStage?record.value.refundId:record.value.chargeId);
    if(!matches||outcome.status!==(refundStage?"ISSUED":"CAPTURED"))
      return result(record,"The transaction readback did not confirm the expected result. Review it in the Intuit sandbox.");
    record=await save(ctx.path,record,{...record.value,status:refundStage?"refunded":"captured",
      [refundStage?"refundVerifiedAt":"chargeVerifiedAt"]:stamp(now())});
    return result(record,refundStage?"The $1 sandbox charge and refund are verified. This confirms the test connection, not live customer payments.":
      "The $1 sandbox charge is verified. You can now refund the test payment.");
  }
  return {status,run};
}
export const quickbooksPaymentTest=createQuickBooksPaymentTestService();
