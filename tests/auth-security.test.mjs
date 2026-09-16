import { captchaStub } from "./fixtures/captcha.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createAuthHandler } from "../api/auth.mjs";
import { createAccountSecurityService } from "../api/_lib/account-security-service.mjs";
import { digest, getSession, hashPassword, publicUser, sessionCookie, userPath, verifyPassword } from "../api/_lib/auth.mjs";
import { validatePassword, passwordUpdate, passwordSetupRequired, PASSWORD_MAX_AGE_MS, LOGIN_LOCK_MS,
  SESSION_IDLE_MS, SESSION_MAX_MS, totpCode, verifyTotp, encryptMfaSecret, decryptMfaSecret, newRecoveryCodes,
  mfaProof, EMAIL_VERIFICATION_MS, MFA_SETUP_MS, MFA_CHALLENGE_MS } from "../api/_lib/auth-security.mjs";

process.env.LINEAGE_SESSION_SECRET = "isolated-auth-security-test-key-never-used-in-production";
const password = "Cedar lantern rivers wander";
const baseUser = { email: "ada@example.invalid", name: "Fictional Ada Example", passwordHash: hashPassword(password),
  status: "active", role: "customer", mustChangePassword: false, emailVerified: false,
  approvedAt: "2026-09-01T00:00:00.000Z", approvedBy: "erik@brocotech.ai" };
const env = { LINEAGE_MFA_ENCRYPTION_KEY: "ab".repeat(32) };
const clone = value => structuredClone(value);
const request = (body, cookie, method = "POST") => ({ method, url: "/api/auth", body,
  headers: { host: "lineagetheater.com", origin: "https://lineagetheater.com", cookie,
    "x-forwarded-for": "198.51.100.17" } });
const cookieFrom = (response, prefix = "lineage_session=") =>
  [response.headers["Set-Cookie"]].flat().find(value => value?.startsWith(prefix))?.split(";")[0];

function harness(overrides = {}) {
  let time = Date.now(), revision = 0;
  const records = new Map(), sends = [], limits = [];
  const read = async path => records.has(path) ? clone(records.get(path)) : null;
  const write = async (path, value, etag) => {
    const prior = records.get(path);
    if (prior ? etag !== prior.etag : Boolean(etag)) throw new Error("Conditional write conflict");
    records.set(path, { value: clone(value), etag: `version-${++revision}` });
  };
  const mail = { available: () => true, send: async message => { sends.push(message); return { accepted: true }; } };
  const deps = { readRecord: read, writeRecord: write, verifyPassword, verificationMail: mail,
    now: () => time, env, ...overrides };
  const service = createAccountSecurityService(deps);
  const handler = createAuthHandler({ captcha: captchaStub, ...deps,
    getSession: (req, allowSetup) => getSession(req, allowSetup, { readRecordImpl: deps.readRecord,
      writeRecordImpl: deps.writeRecord, now: time }),
    publicUser: user => publicUser({ ...user, mustChangePassword: passwordSetupRequired(user, time) }),
    limitAction: async (...args) => { limits.push(args); return true; }, ...overrides });
  async function run(req) {
    const response = { status: 0, headers: {}, body: null };
    await handler(req, { set statusCode(value) { response.status = value; },
      setHeader(name, value) { response.headers[name] = value; }, end(value) { response.body = JSON.parse(value); } });
    return response;
  }
  async function user(extra = {}) {
    const value = { ...clone(baseUser), ...extra };
    await write(userPath(value.email), value, (await read(userPath(value.email)))?.etag);
    return value;
  }
  const currentUser = async () => (await read(userPath(baseUser.email))).value;
  const session = async cookie => getSession(request(undefined, cookie, "GET"), false,
    { readRecordImpl: read, writeRecordImpl: write, now: time });
  return { records, sends, limits, read, write, run, service, user, currentUser, session,
    now: () => time, advance: milliseconds => { time += milliseconds; },
    cookie: user => sessionCookie(user, { now: time }).split(";")[0] };
}

test("new passwords reject common, repeated, letter-free, and username-derived choices", () => {
  for (const value of ["12345678901234", "Password123456!", "P@ssw0rd12345!", "basketball123!",
    "abcabcabcabcabc", "aaaaaaaaaaab", "ada-Orchard-123", "4d4-Long-Secret", "Fictional-river-lantern"])
    assert.throws(() => validatePassword(value, baseUser), undefined, value);
  for (const value of [password, "Copper forest windmills travel", "Jade!Lantern.8426^", "Érable lune argent rivière"])
    assert.equal(validatePassword(value, baseUser), value);
  assert.throws(() => validatePassword("fr3d999-Lanterns!", { email: "fred123@example.invalid" }), /username/);
  assert.notEqual(hashPassword("MixedCasePassphrase"), hashPassword("mixedcasepassphrase"));
});

test("password changes retain five old hashes, enforce change frequency and expiry, and require reauthentication", async () => {
  const h = harness(), original = await h.user(), cookie = h.cookie(original);
  const changed = await h.run(request({ action: "password", currentPassword: password,
    password: "Copper forest windmills travel" }, cookie));
  assert.equal(changed.status, 200);
  const saved = await h.currentUser();
  assert.equal(saved.passwordHistory[0], original.passwordHash);
  assert.equal(Date.parse(saved.passwordExpiresAt) - Date.parse(saved.passwordChangedAt), PASSWORD_MAX_AGE_MS);
  assert.equal(await h.session(cookie), null);
  const nextCookie = cookieFrom(changed);
  assert.ok(await h.session(nextCookie));
  assert.equal((await h.run(request({ action: "password", currentPassword: "Copper forest windmills travel",
    password: "Orchard mountain copper lantern" }, nextCookie))).status, 429);
  h.advance(3600_000);
  const current = saved;
  assert.throws(() => passwordUpdate(current, password, { hashPassword, verifyPassword, now: h.now() }), /last five/);
  const oldHashes = Array.from({length: 7}, (_, index) => hashPassword(`Historical cedar lantern ${index} phrase`));
  const updated = passwordUpdate({ ...original, passwordHistory: oldHashes }, "Orchard mountain copper lantern",
    { hashPassword, verifyPassword, now: h.now() });
  assert.deepEqual(updated.passwordHistory, [original.passwordHash, ...oldHashes].slice(0, 5));
  assert.equal(verifyPassword("Orchard mountain copper lantern", updated.passwordHash), true);
});

test("password expiry requires a fresh password-authenticated setup session; undated legacy accounts keep access", async () => {
  const h = harness(), legacy = await h.user();
  assert.equal(passwordSetupRequired(legacy, h.now()), false);
  assert.ok(await h.session(h.cookie(legacy)));
  const expiring = await h.user({ passwordExpiresAt: new Date(h.now() + 1000).toISOString() });
  const oldCookie = h.cookie(expiring);
  h.advance(1001);
  assert.equal(await h.session(oldCookie), null);
  const oldSetup = await h.run(request(undefined, oldCookie, "GET"));
  assert.equal(oldSetup.body.user, null);
  const login = await h.run(request({ action: "login", email: legacy.email, password }));
  assert.equal(login.status, 200); assert.equal(login.body.user.mustChangePassword, true);
  const setupCookie = cookieFrom(login);
  assert.equal(await h.session(setupCookie), null);
  const changed = await h.run(request({ action: "password", password: "Copper forest windmills travel" }, setupCookie));
  assert.equal(changed.status, 200); assert.equal(changed.body.user.mustChangePassword, false);
});

test("persistent lockout resets only on success and locks the tenth consecutive failure for 24 hours", async () => {
  const h = harness(); await h.user();
  for (let i = 0; i < 9; i++) assert.equal((await h.run(request({ action: "login", email: baseUser.email, password: "wrong" }))).status, 401);
  assert.equal((await h.run(request({ action: "login", email: baseUser.email, password }))).status, 200);
  for (let i = 0; i < 9; i++) await h.run(request({ action: "login", email: baseUser.email, password: "wrong" }));
  const tenth = await h.run(request({ action: "login", email: baseUser.email, password: "wrong" }));
  assert.equal(tenth.status, 429); assert.equal(tenth.body.code, "ACCOUNT_LOCKED");
  assert.equal((await h.run(request({ action: "login", email: baseUser.email, password }))).status, 429);
  h.advance(LOGIN_LOCK_MS - 1);
  assert.equal((await h.run(request({ action: "login", email: baseUser.email, password }))).status, 429);
  h.advance(1);
  assert.equal((await h.run(request({ action: "login", email: baseUser.email, password }))).status, 200);
});

test("logout durably revokes only its session; replay, idle expiry, and absolute expiry are rejected", async () => {
  const h = harness(), user = await h.user(), first = h.cookie(user), second = h.cookie(user);
  assert.ok(await h.session(first)); assert.ok(await h.session(second));
  assert.equal((await h.run(request({ action: "logout" }, first))).status, 200);
  assert.equal(await h.session(first), null); assert.ok(await h.session(second));
  h.advance(SESSION_IDLE_MS);
  assert.equal(await h.session(second), null);
  const active = h.cookie(user);
  for (let elapsed = 0; elapsed < SESSION_MAX_MS; elapsed += 25 * 60_000) {
    assert.ok(await h.session(active)); h.advance(25 * 60_000);
  }
  assert.equal(await h.session(active), null);
});

test("session storage failure cannot claim successful logout and cannot grant an untracked session", async () => {
  const h = harness(), user = await h.user(), cookie = h.cookie(user);
  const failingWrite = async () => { throw new Error("Synthetic storage outage"); };
  assert.equal(await getSession(request(undefined, cookie, "GET"), false,
    { readRecordImpl: h.read, writeRecordImpl: failingWrite, now: h.now() }), null);
  const fail = createAuthHandler({ captcha: captchaStub, readRecord: h.read, writeRecord: failingWrite, verificationMail: {available:()=>false}, now:h.now });
  let status, body, headers = {};
  await fail(request({action:"logout"},cookie), {set statusCode(value){status=value;},setHeader(name,value){headers[name]=value;},end(value){body=JSON.parse(value);}});
  assert.equal(status,503);assert.equal(headers["Set-Cookie"],undefined);assert.doesNotMatch(body.message,/Synthetic/);
});

test("signed malformed session claims and unknown or revoked MFA security versions fail closed", async () => {
  const h = harness(), user = await h.user();
  for (const patch of [{exp:null},{iat:h.now()+1},{nonce:"invalid"},{securityVersion:7}]) {
    const claims={sub:user.email,version:digest(user.passwordHash),iat:h.now(),exp:h.now()+SESSION_MAX_MS,nonce:"ab".repeat(12),...patch};
    const payload=Buffer.from(JSON.stringify(claims)).toString("base64url");
    const signature=createHmac("sha256",process.env.LINEAGE_SESSION_SECRET).update(payload).digest("base64url");
    assert.equal(await h.session(`lineage_session=${payload}.${signature}`),null);
  }
});

test("TOTP follows RFC 6238 SHA-1 vectors, rejects replay and wrong accounts, and encrypts secrets", () => {
  const secret="GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
  for(const [seconds,expected] of [[59,"94287082"],[1111111109,"07081804"],[1111111111,"14050471"],[1234567890,"89005924"],[2000000000,"69279037"]])
    assert.equal(totpCode(secret,Math.floor(seconds/30),8),expected);
  const now=1234567890000,counter=Math.floor(now/30000),code=totpCode(secret,counter);
  assert.equal(verifyTotp(secret,code,now),counter);assert.equal(verifyTotp(secret,code,now,counter),null);
  const encrypted=encryptMfaSecret(secret,baseUser.email,env);
  assert.equal(decryptMfaSecret(encrypted,baseUser.email,env),secret);
  assert.doesNotMatch(JSON.stringify(encrypted),new RegExp(secret));
  assert.throws(()=>decryptMfaSecret(encrypted,"different@example.invalid",env));
  assert.throws(()=>decryptMfaSecret({...encrypted,data:"AA=="},baseUser.email,env));
});

async function enroll(h) {
  const user=await h.user(),cookie=h.cookie(user);
  const begin=await h.run(request({action:"mfaBegin",currentPassword:password},cookie));
  assert.equal(begin.status,200);
  const code=totpCode(begin.body.secret,Math.floor(h.now()/30000));
  const confirmed=await h.run(request({action:"mfaConfirm",code},cookie));
  assert.equal(confirmed.status,200);
  return {secret:begin.body.secret,cookie:cookieFrom(confirmed),oldCookie:cookie,codes:confirmed.body.recoveryCodes};
}

test("MFA enrollment requires current password and code, revokes old sessions, and exposes recovery codes once", async () => {
  const h=harness(),user=await h.user(),cookie=h.cookie(user);
  assert.equal((await h.run(request({action:"mfaBegin",currentPassword:"wrong"},cookie))).status,401);
  const begin=await h.run(request({action:"mfaBegin",currentPassword:password},cookie));
  assert.equal(begin.status,200);assert.match(begin.body.otpauthUri,/otpauth:\/\/totp\//);
  assert.equal((await h.currentUser()).mfa,undefined);
  assert.equal((await h.run(request({action:"mfaConfirm",code:"invalid"},cookie))).status,401);
  const confirmed=await h.run(request({action:"mfaConfirm",code:totpCode(begin.body.secret,Math.floor(h.now()/30000))},cookie));
  assert.equal(confirmed.status,200);assert.equal(confirmed.body.recoveryCodes.length,10);
  assert.equal(confirmed.body.user.mfaEnabled,true);assert.equal(confirmed.body.user.mfa,undefined);
  assert.equal(await h.session(cookie),null);assert.ok(await h.session(cookieFrom(confirmed)));
  const stored=JSON.stringify([...h.records.values()]);
  assert.equal(stored.includes(begin.body.secret),false);
  for(const code of confirmed.body.recoveryCodes) assert.equal(stored.includes(code),false);
});

test("MFA login grants no session until verification and rejects challenge/code reuse and password changes", async () => {
  const h=harness(),enabled=await enroll(h);h.advance(30000);
  const login=await h.run(request({action:"login",email:baseUser.email,password}));
  assert.equal(login.body.mfaRequired,true);assert.equal(login.body.user,undefined);
  const challenge=cookieFrom(login,"lineage_mfa_challenge=");
  const code=totpCode(enabled.secret,Math.floor(h.now()/30000));
  const completed=await h.run(request({action:"mfaChallenge",code},challenge));
  assert.equal(completed.status,200);assert.ok(await h.session(cookieFrom(completed)));
  assert.equal((await h.run(request({action:"mfaChallenge",code},challenge))).status,401);
  const another=await h.run(request({action:"login",email:baseUser.email,password}));
  assert.equal((await h.run(request({action:"mfaChallenge",code},cookieFrom(another,"lineage_mfa_challenge=")))).status,401);
  const stored=await h.currentUser();await h.user({...stored,passwordHash:hashPassword("Copper forest windmills travel")});
  assert.equal((await h.run(request({action:"mfaChallenge",recoveryCode:enabled.codes[0]},cookieFrom(another,"lineage_mfa_challenge=")))).status,401);
});

test("recovery codes are consumed atomically across concurrent challenges and remain usable without the MFA key", async () => {
  const h=harness(),enabled=await enroll(h);
  const first=await h.service.beginChallenge(await h.currentUser()),second=await h.service.beginChallenge(await h.currentUser());
  const results=await Promise.allSettled([first,second].map(cookie=>h.service.completeChallenge(request({},cookie),{recoveryCode:enabled.codes[0]})));
  assert.equal(results.filter(result=>result.status==="fulfilled").length,1);
  const user=await h.currentUser();
  assert.throws(()=>mfaProof(user,{recoveryCode:enabled.codes[0]},{env:{}}),/incorrect or already used/);
  const recovered=mfaProof(user,{recoveryCode:enabled.codes[1]},{env:{}});
  assert.equal(recovered.recoveryHashes.length,user.mfa.recoveryHashes.length-1);
});

test("MFA setup/challenges expire, bind to the initiating session, and cancel durably on logout", async () => {
  const h=harness(),user=await h.user(),cookie=h.cookie(user),other=h.cookie(user);
  const begin=await h.run(request({action:"mfaBegin",currentPassword:password},cookie));
  assert.equal((await h.run(request({action:"mfaConfirm",code:totpCode(begin.body.secret,Math.floor(h.now()/30000))},other))).status,409);
  h.advance(MFA_SETUP_MS);
  assert.equal((await h.run(request({action:"mfaConfirm",code:"123456"},cookie))).status,409);
  const enrolled=await enroll(h);
  const challenge=await h.service.beginChallenge(await h.currentUser());
  assert.equal((await h.run(request({action:"logout"},challenge))).status,200);
  assert.equal((await h.run(request({action:"mfaChallenge",recoveryCode:enrolled.codes[0]},challenge))).status,401);
  const expires=await h.service.beginChallenge(await h.currentUser());h.advance(MFA_CHALLENGE_MS);
  assert.equal((await h.run(request({action:"mfaChallenge",recoveryCode:enrolled.codes[0]},expires))).status,401);
});

test("replacing recovery codes and disabling MFA require current password plus a fresh second factor", async () => {
  const h=harness(),enabled=await enroll(h);
  const bad=await h.run(request({action:"mfaDisable",currentPassword:password,code:"invalid"},enabled.cookie));
  assert.equal(bad.status,401);assert.equal((await h.currentUser()).mfa.enabled,true);
  const renewed=await h.run(request({action:"mfaRecoveryCodes",currentPassword:password,recoveryCode:enabled.codes[0]},enabled.cookie));
  assert.equal(renewed.status,200);assert.equal(renewed.body.recoveryCodes.length,10);
  assert.equal(await h.session(enabled.cookie),null);
  const nextCookie=cookieFrom(renewed),current=await h.currentUser();
  assert.throws(()=>mfaProof(current,{recoveryCode:enabled.codes[1]},{env}),/incorrect or already used/);
  assert.equal((await h.run(request({action:"mfaDisable",currentPassword:"wrong",recoveryCode:renewed.body.recoveryCodes[0]},nextCookie))).status,401);
  const disabled=await h.run(request({action:"mfaDisable",currentPassword:password,recoveryCode:renewed.body.recoveryCodes[0]},nextCookie));
  assert.equal(disabled.status,200);assert.equal(disabled.body.user.mfaEnabled,false);
  assert.equal(await h.session(nextCookie),null);assert.ok(await h.session(cookieFrom(disabled)));
  assert.deepEqual((await h.currentUser()).mfa,{enabled:false});
  const login=await h.run(request({action:"login",email:baseUser.email,password}));
  assert.equal(login.status,200);assert.equal(login.body.mfaRequired,undefined);
});

test("absent MFA and mail configuration is explicit while existing users retain normal sign-in", async () => {
  const h=harness({env:{},verificationMail:{available:()=>false,send:async()=>{throw new Error("must not send");}}}),user=await h.user();
  const login=await h.run(request({action:"login",email:user.email,password}));assert.equal(login.status,200);
  const cookie=cookieFrom(login), req=request(undefined,cookie,"GET");req.url="/api/auth?action=security";
  const status=await h.run(req);
  assert.deepEqual(status.body,{emailVerified:false,emailVerificationAvailable:false,mfaAvailable:false,mfaEnabled:false,passwordExpiresAt:null});
  assert.equal((await h.run(request({action:"mfaBegin",currentPassword:password},cookie))).body.code,"MFA_UNAVAILABLE");
  assert.equal((await h.run(request({action:"emailVerificationRequest"},cookie))).body.code,"EMAIL_VERIFICATION_UNAVAILABLE");
  assert.equal((await h.currentUser()).emailVerified,false);
});

test("verification email tokens are hashed, session-account bound, expiring, and one-time", async () => {
  const h=harness(),user=await h.user(),cookie=h.cookie(user);
  const sent=await h.run(request({action:"emailVerificationRequest"},cookie));
  assert.equal(sent.status,200);assert.match(sent.body.message,/requested/);assert.doesNotMatch(sent.body.message,/delivered/);
  assert.equal(h.sends.length,1);const token=h.sends[0].token;
  assert.equal(JSON.stringify([...h.records.values()]).includes(token),false);
  assert.equal(JSON.stringify(sent.body).includes(token),false);
  const other=await h.user({email:"different@example.invalid"});
  assert.equal((await h.run(request({action:"emailVerificationConfirm",token},h.cookie(other)))).status,400);
  const confirmed=await h.run(request({action:"emailVerificationConfirm",token},cookie));
  assert.equal(confirmed.status,200);assert.equal(confirmed.body.user.emailVerified,true);
  assert.equal((await h.currentUser()).emailVerified,true);
  assert.equal((await h.run(request({action:"emailVerificationConfirm",token},cookie))).status,400);
});

test("expired, replaced, unaccepted or concurrently consumed verification links cannot verify an account", async () => {
  const h=harness(),user=await h.user(),cookie=h.cookie(user);
  await h.run(request({action:"emailVerificationRequest"},cookie));const old=h.sends[0].token;
  await h.run(request({action:"emailVerificationRequest"},cookie));const recent=h.sends[1].token;
  assert.equal((await h.run(request({action:"emailVerificationConfirm",token:old},cookie))).status,400);
  const results=await Promise.all([h.run(request({action:"emailVerificationConfirm",token:recent},cookie)),h.run(request({action:"emailVerificationConfirm",token:recent},cookie))]);
  assert.equal(results.filter(result=>result.status===200).length,1);
  const expires=harness(),fresh=await expires.user(),freshCookie=expires.cookie(fresh);
  await expires.run(request({action:"emailVerificationRequest"},freshCookie));
  expires.advance(EMAIL_VERIFICATION_MS);
  const signed=expires.cookie(fresh);
  assert.equal((await expires.run(request({action:"emailVerificationConfirm",token:expires.sends[0].token},signed))).status,400);
  const failed=harness({verificationMail:{available:()=>true,send:async()=>({accepted:false})}}),failedUser=await failed.user();
  assert.equal((await failed.run(request({action:"emailVerificationRequest"},failed.cookie(failedUser)))).status,503);
  assert.equal((await failed.currentUser()).emailVerified,false);
});

test("security mutations require authenticated same-origin requests and per-account rate limits", async () => {
  const h=harness(),user=await h.user(),cookie=h.cookie(user);
  for(const action of ["mfaBegin","mfaConfirm","mfaDisable","mfaRecoveryCodes","emailVerificationRequest","emailVerificationConfirm"]){
    assert.equal((await h.run(request({action}))).status,401);
    const cross=request({action},cookie);cross.headers.origin="https://other.example.invalid";
    assert.equal((await h.run(cross)).status,403);
  }
  const blocked=harness({limitAction:async()=>false}),blockedUser=await blocked.user();
  assert.equal((await blocked.run(request({action:"emailVerificationRequest"},blocked.cookie(blockedUser)))).status,429);
  assert.equal(blocked.sends.length,0);
});
