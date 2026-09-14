import { randomBytes, randomUUID } from "node:crypto";
import { list } from "@vercel/blob";
import { digest, readRecord, writeRecord } from "./auth.mjs";
import { OWNER_EMAIL, roleForUser } from "./access.mjs";

export const PRICING_PATH = "settings/pricing.json";
export function validEmail(value) {
  const email = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    throw new Error("Enter a valid email address.");
  return email;
}
export function safeUser(user) {
  return { email:user.email, name:user.name || "", role:roleForUser({...user,status:"active"}),
    status:user.status === "suspended" ? "suspended" : "active",
    createdAt:user.createdAt || null, lastLoginAt:user.lastLoginAt || null };
}
export async function recordPage(prefix, {cursor, limit=50}={}, dependencies={list,readRecord}) {
  const page=await dependencies.list({prefix,limit:Math.min(100,Math.max(1,limit)),...(cursor?{cursor}:{})});
  const records=await Promise.all(page.blobs.map(blob=>dependencies.readRecord(blob.pathname)));
  return {records:records.filter(Boolean).map(record=>record.value),...(page.hasMore?{cursor:page.cursor}:{})};
}
export async function audit(actor,action,target,details={}) {
  const event={id:randomUUID(),at:new Date().toISOString(),actor,action,target,details};
  await writeRecord(`admin/audit/${String(9_999_999_999_999-Date.now()).padStart(13,"0")}-${event.id}.json`,event);
  return event;
}
export function markupFromPercent(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1000)
    throw new Error("Choose a markup from 0% to 1,000%.");
  const basisPoints=Math.round(value*100);
  if (Math.abs(basisPoints-value*100)>0.000001)
    throw new Error("Use no more than two decimal places for the markup.");
  return basisPoints;
}
export async function readPricingSettings(read=readRecord) {
  const record=await read(PRICING_PATH);
  if (!record) return {markupBasisPoints:0,revision:0,updatedAt:null,updatedBy:null};
  const value=record.value;
  if (!Number.isInteger(value.markupBasisPoints) || value.markupBasisPoints<0 || value.markupBasisPoints>100_000
      || !Number.isInteger(value.revision) || value.revision<1)
    throw new Error("The saved pricing settings need administrator attention.");
  return {markupBasisPoints:value.markupBasisPoints,revision:value.revision,updatedAt:value.updatedAt,updatedBy:value.updatedBy};
}
export function validateUserAction(actor, target, action) {
  if (!target) throw new Error("That account was not found.");
  if (target.email===OWNER_EMAIL) throw new Error("The owner account cannot be suspended or demoted.");
  if (actor.email===target.email) throw new Error("You cannot remove your own administrative access.");
  if (action==="revokeAdmin" && roleForUser(actor)!=="owner") throw new Error("Only the owner can change administrator access.");
  if (target.role==="admin" && roleForUser(actor)!=="owner") throw new Error("Only the owner can manage another administrator.");
}
export function newInvitation(email,actor, now=Date.now()) {
  const token=randomBytes(32).toString("hex");
  return {token,path:`admin/invitations/${digest(token)}.json`,record:{
    id:randomUUID(),email,role:"admin",createdAt:new Date(now).toISOString(),
    expiresAt:new Date(now+7*24*3600_000).toISOString(),createdBy:actor,usedAt:null,usedBy:null,
  }};
}
export function validateInvitation(invitation, user, now=Date.now()) {
  if (!invitation || invitation.revokedAt || !Number.isFinite(Date.parse(invitation.expiresAt)) || Date.parse(invitation.expiresAt)<=now)
    throw new Error("This administrator invitation has expired or is no longer available.");
  if (invitation.email!==user.email || user.email===OWNER_EMAIL)
    throw new Error("Sign in with the email address named in this invitation.");
  if (invitation.usedBy && invitation.usedBy!==user.email)
    throw new Error("This administrator invitation has already been used.");
  if (user.adminRevokedAt && Date.parse(invitation.createdAt)<=Date.parse(user.adminRevokedAt))
    throw new Error("This administrator invitation is no longer available. Ask the owner for a new invitation.");
}
export function validateRefund(order, body) {
  if (!order || !["paid","partially-refunded"].includes(order.status)) throw new Error("Only a confirmed paid order can be refunded.");
  if (order.provider!=="quickbooks" || order.currency!=="USD" || !order.providerChargeId)
    throw new Error("This order has no verified QuickBooks charge reference.");
  if (!Number.isSafeInteger(order.amountCents) || order.amountCents<1 || !Number.isSafeInteger(order.refundedCents ?? 0)
      || (order.refundedCents??0)<0 || (order.refundedCents??0)>order.amountCents)
    throw new Error("This order's payment totals need review.");
  const remaining=order.amountCents-(order.refundedCents??0);
  if (!Number.isSafeInteger(body.amountCents) || body.amountCents<1 || body.amountCents>remaining)
    throw new Error("The refund must not exceed the unrefunded purchase amount.");
  if (typeof body.reason!=="string" || !body.reason.trim() || body.reason.length>500)
    throw new Error("Enter a refund reason of no more than 500 characters.");
  if (typeof body.idempotencyKey!=="string" || !/^[a-zA-Z0-9-]{16,80}$/.test(body.idempotencyKey))
    throw new Error("A unique refund request reference is required.");
  return {amountCents:body.amountCents,reason:body.reason.trim(),idempotencyKey:body.idempotencyKey};
}
