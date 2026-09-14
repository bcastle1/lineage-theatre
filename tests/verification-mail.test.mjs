import test from "node:test";
import assert from "node:assert/strict";
import { createVerificationMail } from "../api/_lib/verification-mail.mjs";
const env = { LINEAGE_MAIL_TENANT_ID:"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", LINEAGE_MAIL_CLIENT_ID:"bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
  LINEAGE_MAIL_CLIENT_SECRET:"synthetic-secret-only", LINEAGE_MAIL_SENDER:"verify@example.invalid" };
const token = "c".repeat(64);

test("verification mail is unavailable without dedicated configuration and never calls a provider", async () => {
  let calls=0;
  for (const settings of [{}, {...env,LINEAGE_MAIL_SENDER:"sender@example.invalid/../../me"}, {...env,LINEAGE_MAIL_TENANT_ID:"common"}]) {
    const mail=createVerificationMail({env:settings,fetchImpl:async()=>{calls++;}});
    assert.equal(mail.available(),false);
    await assert.rejects(mail.send({to:"user@example.invalid",token}),/unavailable/);
  }
  assert.equal(calls,0);
});

test("verification mail uses the fixed Graph token, sender, template and fragment URL", async () => {
  const requests=[];
  const mail=createVerificationMail({env,fetchImpl:async(url,options)=>{
    requests.push({url,options});
    return requests.length===1?Response.json({token_type:"Bearer",access_token:"synthetic-access-token"}):new Response(null,{status:202});
  }});
  assert.deepEqual(await mail.send({to:"user@example.invalid",token}),{accepted:true});
  assert.equal(requests.length,2);
  assert.equal(requests[0].url,`https://login.microsoftonline.com/${env.LINEAGE_MAIL_TENANT_ID}/oauth2/v2.0/token`);
  assert.equal(new URLSearchParams(requests[0].options.body).get("scope"),"https://graph.microsoft.com/.default");
  assert.equal(requests[1].url,"https://graph.microsoft.com/v1.0/users/verify%40example.invalid/sendMail");
  const body=JSON.parse(requests[1].options.body);
  assert.deepEqual(body.message.toRecipients,[{emailAddress:{address:"user@example.invalid"}}]);
  assert.match(body.message.body.content,new RegExp(`https://lineagetheater.com/#verify-email=${token}`));
  for(const request of requests) assert.equal(request.options.redirect,"error");
});

test("verification mail rejects malformed recipients/tokens and hides provider errors without retries", async () => {
  let calls=0;
  const mail=createVerificationMail({env,fetchImpl:async()=>{calls++;throw new Error("SECRET RESPONSE");}});
  await assert.rejects(mail.send({to:"victim@example.invalid\r\nBcc:attacker@example.invalid",token}),/unavailable/);
  await assert.rejects(mail.send({to:"user@example.invalid",token:"not-a-token"}),/unavailable/);
  assert.equal(calls,0);
  await assert.rejects(mail.send({to:"user@example.invalid",token}),error=>!error.message.includes("SECRET"));
  assert.equal(calls,1);
});

test("Graph 200 or send failure is not claimed accepted and token responses are bounded",async()=>{
  for(const outcome of [200,400,500]) {
    let calls=0;
    const mail=createVerificationMail({env,fetchImpl:async()=>++calls===1?Response.json({token_type:"Bearer",access_token:"synthetic-access-token"}):new Response("private error",{status:outcome})});
    await assert.rejects(mail.send({to:"user@example.invalid",token}),/unavailable/);
    assert.equal(calls,2);
  }
  const oversized=createVerificationMail({env,fetchImpl:async()=>new Response("x".repeat(40000))});
  await assert.rejects(oversized.send({to:"user@example.invalid",token}),/unavailable/);
});
