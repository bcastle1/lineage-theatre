import { json, readBody, sameOrigin, getSession, readRecord, writeRecord, userPath, publicUser, digest, limitAction } from "./_lib/auth.mjs";
import { hasAdminAccess, isOwner, OWNER_EMAIL, accessStatusForUser, hasRecordedApproval } from "./_lib/access.mjs";
import { recordPage, safeUser, validEmail, audit, newInvitation, validateInvitation, validateUserAction, validateRefund, readPricingSettings, pricingSettingsFromRecord, validatePlanningSettings, markupFromPercent, PRICING_PATH } from "./_lib/admin.mjs";
import { productionReadiness } from "./_lib/production.mjs";
import { connections } from "./studio.mjs";
import { filmProduction, FilmProductionError } from "./_lib/film-production.mjs";
import { payments, PaymentError } from "./_lib/payments.mjs";
import { hostedCheckout } from "./_lib/hosted-checkout.mjs";
import { readRegistrationPolicy as readPolicy, REGISTRATION_POLICY_PATH } from "./_lib/registration-policy.mjs";
import { createSourceAgreementService, SourceAgreementError } from "./_lib/source-agreement.mjs";
import { createReceiptDeliveryService, ReceiptDeliveryError } from "./_lib/receipt-delivery.mjs";

const isTestOrder=order=>order.merchantBinding?.environment==="sandbox"||order.sandbox===true;
const isManagedOrder=order=>order.version===1&&/^[a-f0-9]{64}$/.test(order.id||"")
  &&/^[a-f0-9]{64}$/.test(order.manifestHash||"")&&/^[a-f0-9]{64}$/.test(order.merchantBinding?.grantId||"");
const safeOrder=(order)=>({id:order.id,customerEmail:order.customerEmail,filmTitle:order.filmTitle||"",status:order.status,
  currency:order.currency,amountCents:order.amountCents,refundedCents:order.refundedCents??0,createdAt:order.createdAt,provider:order.provider,
  sandbox:isTestOrder(order),managedPayment:isManagedOrder(order),requiresReview:["submitting","uncertain","refund-pending"].includes(order.status)});
function resultError(res,status,message) { return json(res,status,{message}); }

export function createAdminHandler(overrides={}) {
 const hosted=overrides.hostedCheckout||(overrides.payments?null:hostedCheckout);
 const dependencies={getSession,readRecord,writeRecord,limitAction,audit,recordPage,readPricingSettings,connections,filmProduction,payments,
   readRegistrationPolicy:()=>readPolicy(overrides.readRecord || readRecord),...overrides};
 const sourceAgreement=overrides.sourceAgreement||createSourceAgreementService({readRecord:dependencies.readRecord,writeRecord:dependencies.writeRecord,...(overrides.now?{now:overrides.now}:{})});
 const receipts=overrides.receiptDelivery||createReceiptDeliveryService({read:dependencies.readRecord,write:dependencies.writeRecord,...(overrides.now?{now:overrides.now}:{})});
 return async function handler(req,res) {
  const {getSession,readRecord,writeRecord,limitAction,audit,recordPage,readPricingSettings,connections,filmProduction,payments,readRegistrationPolicy}=dependencies;
  try {
    if (req.method==="POST" && !sameOrigin(req)) return resultError(res,403,"Begin this action inside Lineage Theatre.");
    const url=new URL(req.url,`https://${req.headers.host}`);
    const body=req.method==="POST"?await readBody(req,32_000):null;
    const action=body?.action || url.searchParams.get("action") || "overview";
    // Pending users can claim their exact owner-issued invitation, but cannot
    // read administrator data or skip a required password change.
    const session=await getSession(req,req.method==="POST" && action==="acceptInvite");
    if (!session || session.user.mustChangePassword) return resultError(res,401,"Sign in and complete password setup to continue.");
    const actor=session.user;
    if (req.method==="POST" && action==="acceptInvite") {
      if (!(await limitAction(`admin-invite-claim:${actor.email}`,10,3600_000))) return resultError(res,429,"Please wait before trying another invitation.");
      if (typeof body.token!=="string" || !/^[a-f0-9]{64}$/.test(body.token)) return resultError(res,400,"This administrator invitation is invalid.");
      const path=`admin/invitations/${digest(body.token)}.json`;
      const record=await readRecord(path);
      validateInvitation(record?.value,actor);
      if (!record.value.usedBy) await writeRecord(path,{...record.value,usedBy:actor.email,usedAt:new Date().toISOString()},record.etag);
      const current=await readRecord(userPath(actor.email));
      if (!current || current.value.status==="suspended") return resultError(res,403,"This account is not active.");
      validateInvitation(record.value,current.value);
      if (current.value.role!=="admin" || !hasRecordedApproval(current.value)) {
        const now=new Date().toISOString();
        const updated={...current.value,role:"admin",status:"active",adminGrantedBy:record.value.createdBy,
          ...(!hasRecordedApproval(current.value)?{approvedAt:now,approvedBy:record.value.createdBy,approvalSource:"administrator-invitation"}:{}),updatedAt:now};
        await writeRecord(userPath(actor.email),updated,current.etag);
        await audit(actor.email,"administrator.invitation.accepted",actor.email,{invitationId:record.value.id});
        return json(res,200,{user:publicUser(updated),message:"Administrator access is active."});
      }
      return json(res,200,{user:publicUser(current.value),message:"Administrator access is active."});
    }
    if (!hasAdminAccess(actor)) return resultError(res,403,"Administrator access is required.");
    if (req.method==="GET") {
      if(action==="receiptSettings") return json(res,200,await receipts.settings(actor));
      if(action==="hostedCheckout") return json(res,200,await hosted.settings(actor));
      if(action==="agreement") return json(res,200,{agreement:url.searchParams.has("version")?await sourceAgreement.version(url.searchParams.get("version")):await sourceAgreement.current()});
      if(action==="registrationPolicy") return json(res,200,await readRegistrationPolicy());
      if(action==="productionReadiness") return json(res,200,filmProduction.readiness());
      if(["paymentDiagnostics","accountingExport"].includes(action)) {
        const id=url.searchParams.get("id");
        if(hosted&&await hosted.ownsOrder(id)) {
          const order=await hosted.order(actor,id);
          return json(res,200,{orderId:order.id,status:order.status,invoiceNumber:order.invoiceNumber||null,
            checkoutMethod:order.checkoutMethod,currency:order.currency,amountCents:order.amountCents,
            requiresReview:order.requiresReview,confirmationSource:order.confirmationSource||null,
            settlementVerified:false,postingReady:false,
            ...(action==="paymentDiagnostics"?{diagnostics:await hosted.adminDiagnostics(actor,id)}:{}),
            note:"Review the existing hosted invoice in QuickBooks. This export does not post to your books or verify settlement or refunds."});
        }
        return json(res,200,await payments[action==="paymentDiagnostics"?"adminDiagnostics":"accountingExport"](actor,id));
      }
      const cursor=url.searchParams.get("cursor")||undefined;
      if (cursor && cursor.length>2048) return resultError(res,400,"Invalid page reference.");
      if(action==="users") {
        const page=await recordPage("auth/users/",{cursor});
        return json(res,200,{users:page.records.map(safeUser),cursor:page.cursor});
      }
      if(action==="payments") {
        const page=await recordPage("payments/orders/",{cursor});
        const ready=hosted?await hosted.configuration(actor):{available:false};
        return json(res,200,{orders:page.records.map(order=>({...safeOrder(order),checkoutMethod:order.checkoutMethod||null})),cursor:page.cursor,connectionReady:ready.available===true,
          reason:ready.available?"Hosted checkout is configured. Customers complete payment on QuickBooks; refunds for hosted invoices are managed in QuickBooks. Film production is verified separately.":"Complete the hosted checkout setup below. Existing payment records remain available; no new invoice or payment is created by viewing this page."});
      }
      if(action==="audit") {
        const page=await recordPage("admin/audit/",{cursor});
        return json(res,200,{events:page.records,cursor:page.cursor});
      }
      if(action==="pricing") {
        const settings=await readPricingSettings();
        const pricing=productionReadiness({pricingSettings:settings}).pricing;
        return json(res,200,{...settings,currency:"USD",referenceRate:pricing.referenceRate});
      }
      if(action==="overview") {
        const [users,orders,films,settings]=await Promise.all([recordPage("auth/users/",{limit:100}),recordPage("payments/orders/",{limit:100}),recordPage("archive/metadata/",{limit:100}),readPricingSettings()]);
        const ready=await connections({pricingSettings:settings,...(hosted?{checkoutConfiguration:await hosted.configuration(actor)}:{})});
        const paid=orders.records.filter(order=>!isTestOrder(order)&&["paid","captured","partially-refunded","refunded"].includes(order.status)&&order.currency==="USD");
        return json(res,200,{stats:{users:users.records.length,administrators:users.records.filter(hasAdminAccess).length,
          pending:users.records.filter(u=>accessStatusForUser(u)==="pending").length,
          suspended:users.records.filter(u=>u.status==="suspended").length,films:films.records.length,paidOrders:paid.length,
          paymentTotalCents:paid.reduce((sum,o)=>sum+(Number.isSafeInteger(o.amountCents)?o.amountCents:0),0),
          refundTotalCents:paid.filter(o=>o.checkoutMethod!=="quickbooks-hosted-invoice").reduce((sum,o)=>sum+(Number.isSafeInteger(o.refundedCents)?o.refundedCents:0),0),
          hostedRefundsUnverified:paid.filter(o=>o.checkoutMethod==="quickbooks-hosted-invoice").length,
          testOrders:orders.records.filter(isTestOrder).length,currency:"USD"},
          statsPartial:Boolean(users.cursor||orders.cursor||films.cursor),connections:ready.connections,pricing:ready.pricing,quality:ready.quality});
      }
      return resultError(res,400,"Unknown administrator view.");
    }
    if(req.method!=="POST") return resultError(res,405,"Method not allowed.");
    if(!(await limitAction(`admin-write:${actor.email}`,60,3600_000))) return resultError(res,429,"Please wait before making more administrator changes.");
    if(action==="saveReceiptSettings") {
      const {action,...input}=body;
      const settings=await receipts.saveSettings(actor,input);
      await audit(actor.email,"payment.receipts.updated","merchant-receipt-email",{revision:settings.revision,merchantReceiptEmail:settings.merchantReceiptEmail});
      return json(res,200,settings);
    }
    if(action==="hostedCheckoutCatalog") {
      if(!isOwner(actor))return resultError(res,403,"Only the owner can manage hosted checkout.");
      if(Object.keys(body).some(key=>key!=="action"))return resultError(res,400,"The catalog request is invalid.");
      return json(res,200,await hosted.catalog(actor));
    }
    if(action==="saveHostedCheckout") {
      if(!isOwner(actor))return resultError(res,403,"Only the owner can manage hosted checkout.");
      const {action,...input}=body;
      const settings=await hosted.saveSettings(actor,input);
      await audit(actor.email,"checkout.hosted.updated","quickbooks-hosted",{revision:settings.revision,enabled:settings.enabled,serviceItemId:settings.serviceItemId});
      return json(res,200,settings);
    }
    if(action==="updateAgreement") {
      const {action,...input}=body;
      const agreement=await sourceAgreement.update(actor,input);
      await audit(actor.email,"source.agreement.updated",agreement.version,{revision:agreement.revision,contentHash:agreement.contentHash});
      return json(res,200,{agreement});
    }
    if(action==="updateRegistrationPolicy") {
      if(typeof body.approvalRequired!=="boolean") return resultError(res,400,"Choose whether administrator approval is required.");
      const record=await readRecord(REGISTRATION_POLICY_PATH);
      const current=await readPolicy(async()=>record);
      if(!Number.isSafeInteger(body.expectedRevision) || body.expectedRevision!==current.revision)
        return resultError(res,409,"Registration settings were changed by another administrator. Refresh before saving.");
      if(body.approvalRequired===current.approvalRequired) return json(res,200,current);
      const policy={approvalRequired:body.approvalRequired,revision:current.revision+1,updatedAt:new Date().toISOString(),updatedBy:actor.email};
      await writeRecord(REGISTRATION_POLICY_PATH,policy,record?.etag);
      await audit(actor.email,"registration.policy.updated","registration-approval",{previousApprovalRequired:current.approvalRequired,
        approvalRequired:policy.approvalRequired,revision:policy.revision});
      return json(res,200,await readRegistrationPolicy());
    }
    if(action==="approve") {
      const email=validEmail(body.email),path=userPath(email),record=await readRecord(path);
      validateUserAction(actor,record?.value,action);
      if(accessStatusForUser(record.value)==="approved") return json(res,200,{user:safeUser(record.value)});
      if(record.value.status==="suspended") return resultError(res,400,"Only pending accounts can be approved. Reactivate this account first.");
      const now=new Date().toISOString();
      const updated={...record.value,status:"active",approvedAt:now,approvedBy:actor.email,approvalSource:"administrator",updatedAt:now};
      await writeRecord(path,updated,record.etag);
      await audit(actor.email,"account.approve",email,{approvedAt:now,approvedBy:actor.email});
      const saved=await readRecord(path);
      if(!saved) throw new Error("Approved account readback failed.");
      return json(res,200,{user:safeUser(saved.value)});
    }
    if(action==="prepareProductionTest") {
      if(!isOwner(actor)) return resultError(res,403,"Only the owner can prepare a production test.");
      const job=await filmProduction.prepareOperatorTest({actor,idempotencyKey:body.idempotencyKey});
      await audit(actor.email,"production.test.prepared",job.id,{manifestHash:job.manifestHash});
      return json(res,201,{...job,message:"Fictional test plan saved. No render request or charge has been sent."});
    }
    if(action==="reconcilePayment") return json(res,200,hosted&&await hosted.ownsOrder(body.orderId)
      ?await hosted.check(actor,{orderId:body.orderId}):await payments.reconcile(actor,{orderId:body.orderId}));
    if(action==="invite") {
      if(!isOwner(actor)) return resultError(res,403,"Only the owner can invite administrators.");
      const email=validEmail(body.email);
      if(email===OWNER_EMAIL) return resultError(res,400,"The owner already has administrator access.");
      const invite=newInvitation(email,actor.email);
      await writeRecord(invite.path,invite.record);
      await audit(actor.email,"administrator.invitation.created",email,{expiresAt:invite.record.expiresAt});
      return json(res,201,{inviteUrl:`https://lineagetheater.com/#admin-invite=${invite.token}`,expiresAt:invite.record.expiresAt,
        message:"Share this private one-time invitation with the named person. It expires in seven days."});
    }
    if(["revokeAdmin","suspend","activate"].includes(action)) {
      const email=validEmail(body.email),path=userPath(email),record=await readRecord(path);
      validateUserAction(actor,record?.value,action);
      const now=new Date().toISOString();
      // Removing admin permissions deliberately retains approved studio access.
      // Reactivating a suspended applicant does not itself approve registration.
      const update=action==="revokeAdmin"?{role:"customer",status:record.value.status==="suspended"?"suspended":"active",adminRevokedAt:now,
        ...(!hasRecordedApproval(record.value)?{approvedAt:now,approvedBy:actor.email,approvalSource:"administrator"}:{})}
        :{status:action==="suspend"?"suspended":accessStatusForUser({...record.value,status:"active"})==="approved"?"active":"pending"};
      const updated={...record.value,...update,updatedAt:new Date().toISOString()};
      await writeRecord(path,updated,record.etag);
      await audit(actor.email,`account.${action}`,email,update);
      return json(res,200,{user:safeUser(updated)});
    }
    if(action==="updatePricing") {
      const markupBasisPoints=markupFromPercent(body.markupPercent);
      const record=await readRecord(PRICING_PATH);
      const current=pricingSettingsFromRecord(record);
      if(!Number.isInteger(body.expectedRevision) || body.expectedRevision!==current.revision)
        return resultError(res,409,"Pricing was changed by another administrator. Refresh before saving.");
      const planning=validatePlanningSettings(Object.fromEntries(["planningCreditsPerClip","planningSecondsPerClip","planningRendersPerClip"]
        .map(field=>[field,Object.hasOwn(body,field)?body[field]:current[field]])));
      const settings={markupBasisPoints,...planning,revision:current.revision+1,updatedAt:new Date().toISOString(),updatedBy:actor.email};
      await writeRecord(PRICING_PATH,settings,record?.etag);
      await audit(actor.email,"pricing.updated","customer-markup",{previousBasisPoints:current.markupBasisPoints,markupBasisPoints,...planning,revision:settings.revision});
      return json(res,200,{...settings,currency:"USD",referenceRate:productionReadiness({pricingSettings:settings}).pricing.referenceRate});
    }
    if(action==="refund") {
      if(typeof body.orderId!=="string" || !/^[a-zA-Z0-9-]{16,80}$/.test(body.orderId)) return resultError(res,400,"Invalid order reference.");
      const record=await readRecord(`payments/orders/${body.orderId}.json`);
      if(record?.value?.checkoutMethod==="quickbooks-hosted-invoice")return json(res,409,{code:"HOSTED_REFUND_IN_QUICKBOOKS",refunded:false,message:"Manage this invoice's refund in QuickBooks. No refund has been submitted by Lineage Theatre."});
      if(record?.value&&isManagedOrder(record.value)) {
        const {action,...input}=body;
        return json(res,200,await payments.refund(actor,input));
      }
      validateRefund(record?.value,body);
      // No request is sent and no order is marked refunded without the real
      // merchant connection. Browser success is never proof of a refund.
      return json(res,503,{code:"QUICKBOOKS_CONNECTION_REQUIRED",refunded:false,message:"QuickBooks merchant authorization for this app is pending. No refund has been issued."});
    }
    return resultError(res,400,"Unknown administrator action.");
  }catch(error){
    if(error instanceof ReceiptDeliveryError) return json(res,error.status,{code:error.code,message:error.message});
    if(error instanceof SourceAgreementError) return json(res,error.status,{code:error.code,message:error.message});
    if(error instanceof FilmProductionError) return json(res,error.status,{code:error.code,message:error.message,charged:false});
    if(error instanceof PaymentError) return json(res,error.status,{code:error.code,message:error.message,charged:error.charged});
    const text=error instanceof Error?error.message:"";
    if(/^(Enter |Choose |Use no more|Only |The owner|You cannot|Sign in with|This administrator|That account|The refund|A unique refund|This order|The saved pricing)/.test(text)) return resultError(res,400,text);
    return resultError(res,503,"The administrator action could not complete. Refresh to verify the current state before retrying.");
  }
}
}
export default createAdminHandler();
