/**
 * SYNTHETIC LOCAL TEST ONLY. Never deploy this server or load production credentials.
 * Start: node scripts/test-workflow-server.mjs
 * Route proof, then exit: node scripts/test-workflow-server.mjs --check
 * Checkout UI fixtures: node scripts/test-workflow-server.mjs --checkout-fixtures
 * Checkout route proof: node scripts/test-workflow-server.mjs --checkout-fixtures --check
 * URL: http://127.0.0.1:5178
 * Customer: customer@example.invalid / Cedar lantern rivers wander
 * Owner fixture: erik@brocotech.ai / Copper forest windmills travel
 * The owner address is the app's reserved identifier, backed here ONLY by a fictional
 * in-memory record. These passwords are public test fixtures, never real credentials.
 * All records disappear on exit. Browser fixture drafts stay on this local origin.
 */
import { createServer, request as httpRequest } from "node:http";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const HOST = "127.0.0.1", PORT = 5178, origin = `http://${HOST}:${PORT}`;
const root = fileURLToPath(new URL("../", import.meta.url));
const checkOnly = process.argv.includes("--check");
const checkoutFixtures = process.argv.includes("--checkout-fixtures");
if (process.argv.some(argument => argument.startsWith("--env-file"))) throw new Error("Test server must not load environment files.");

// Remove inherited provider settings before importing application services.
for (const name of Object.keys(process.env)) {
  if (/^(?:OPENAI_|MAGICLIGHT_|QUICKBOOKS_|RECAPTCHA_|BLOB_|LINEAGE_|MICROSOFT_|GRAPH_|VERCEL_|VITE_|GITHUB_)/.test(name)) delete process.env[name];
}
process.env.LINEAGE_SESSION_SECRET = "synthetic-workflow-session-key-local-only-never-production";
process.env.LINEAGE_MFA_ENCRYPTION_KEY = "cd".repeat(32);
process.env.NODE_ENV = "development";
let blockedExternalCalls = 0;
globalThis.fetch = async () => {
  blockedExternalCalls++;
  throw new Error("Synthetic workflow server forbids outbound fetch requests.");
};

const [{ createAuthHandler }, { createStudioHandler }, { createAdminHandler }, auth,
  { OWNER_EMAIL }, { createFilmProductionService, fictionalOperatorProject },
  { createPaymentsService }, { productionReadiness }, securityHelpers] = await Promise.all([
  import("../api/auth.mjs"), import("../api/studio.mjs"), import("../api/admin.mjs"),
  import("../api/_lib/auth.mjs"), import("../api/_lib/access.mjs"),
  import("../api/_lib/film-production.mjs"), import("../api/_lib/payments.mjs"),
  import("../api/_lib/production.mjs"), import("../api/_lib/auth-security.mjs"),
]);
const records = new Map();
let revision = 0;
const read = async path => records.has(path) ? structuredClone(records.get(path)) : null;
const write = async (path, value, etag) => {
  const previous = records.get(path);
  if (previous ? etag !== previous.etag : Boolean(etag)) {
    const error = new Error("Synthetic Blob precondition failed: record ETag changed.");
    error.name = "BlobPreconditionFailedError"; throw error;
  }
  const next = { value: structuredClone(value), etag: `"synthetic-${++revision}"` };
  records.set(path, next);
  return { etag: next.etag };
};
// Real verification/proof logic, explicitly injected fake Google transport and
// memory storage. No application environment flag can enable this fixture.
const { createCaptchaService } = await import("../api/_lib/captcha.mjs");
const fixtureCaptchaToken = action => `synthetic_captcha_${action}_${randomUUID()}`;
const seenCaptchaTokens = new Set();
const captcha = createCaptchaService({ read, write,
  env: { RECAPTCHA_SITE_KEY: "synthetic-site-key-local-only", RECAPTCHA_SECRET_KEY: "synthetic-secret-local-only", RECAPTCHA_ALLOWED_HOSTNAMES: HOST },
  fetchImpl: async (url, options) => {
    assert.equal(url, "https://www.google.com/recaptcha/api/siteverify");
    const token = options.body.get("response"), match = /^synthetic_captcha_(login|register|mfa|checkout)_/.exec(token || "");
    const valid = Boolean(match) && !seenCaptchaTokens.has(token);
    seenCaptchaTokens.add(token);
    return new Response(JSON.stringify({ success: valid, action: match?.[1], hostname: HOST, score: 0.9, challenge_ts: new Date().toISOString() }));
  },
});
const limit = async (key, maximum, windowMs) => {
  const path = `limits/${auth.digest(key)}-${Math.floor(Date.now() / windowMs)}.json`;
  for (let attempt = 0; attempt < 4; attempt++) {
    const previous = await read(path), count = previous?.value.count || 0;
    if (count >= maximum) return false;
    try { await write(path, { count: count + 1 }, previous?.etag); return true; }
    catch (error) { if (attempt === 3) throw error; }
  }
  return false;
};
const session = (req, allowSetup) => auth.getSession(req, allowSetup, { readRecordImpl: read, writeRecordImpl: write });
const pricingSettings = async () => (await read("settings/pricing.json"))?.value || { markupBasisPoints: 0, revision: 0 };
const registrationPolicy = async () => (await read("settings/registration.json"))?.value || { approvalRequired: true, revision: 0, updatedAt: null, updatedBy: null };
const connections = async () => ({ story: false, ...productionReadiness({ env: {}, pricingSettings: await pricingSettings() }),
  connections: { ...productionReadiness({ env: {} }).connections,
    story: { available: false, reason: "SYNTHETIC LOCAL TEST: story provider calls are disabled." } } });
const refuseProvider = async () => { throw new Error("Synthetic test cannot call an external provider."); };
const filmProduction = createFilmProductionService({ readRecordImpl: read, writeRecordImpl: write });
let syntheticCharges = 0;
const simulatedBinding = { environment: "sandbox", grantId: "c".repeat(64) };
const fakePaymentsProvider = {
  binding: async () => simulatedBinding,
  charge: async (_binding, { amountCents, paymentToken }) => {
    if (!["fixture_card_captured", "fixture_card_declined", "fixture_card_uncertain"].includes(paymentToken)) throw new Error("Only fabricated fixture tokens are accepted.");
    syntheticCharges++;
    if (paymentToken === "fixture_card_uncertain") throw new Error("Simulated unknown processor outcome.");
    return { id: `fixture_charge_${syntheticCharges}`, amountCents, currency: "USD", verified: true,
      status: paymentToken === "fixture_card_declined" ? "DECLINED" : "CAPTURED" };
  },
  readCharge: async (_binding, { chargeId, amountCents }) => ({ id: chargeId, amountCents, currency: "USD", verified: true, status: "CAPTURED" }),
  refund: async (_binding, { amountCents }) => ({ id: `fixture_refund_${randomUUID()}`, amountCents, currency: "USD", verified: true, status: "ISSUED" }),
  readRefund: refuseProvider,
};
const payments = createPaymentsService({ read, write, pricingSettings,
  quoteProvider: checkoutFixtures ? async (project, actor, { preparedId }) => {
    const saved = await filmProduction.status({ email: actor.email, id: preparedId });
    return { preparedId: saved.id, filmId: project.id, filmTitle: project.title, manifestHash: saved.manifestHash,
      environment: "sandbox", currency: "USD", providerCostCents: 100, quoteReference: "synthetic_local_quote",
      expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(), apiVerified: true, qualityVerified: true, commercialTermsVerified: true };
  } : (...args) => filmProduction.quoteForPayment(...args),
  readiness: checkoutFixtures ? async () => ({ sandboxEnabled: true, merchantVerified: true, authorization: {
    ...simulatedBinding, evidenceHash: "d".repeat(64), validatedAt: new Date(Date.now() - 1000).toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(), operations: ["quote", "charge", "refund", "read", "card-entry"],
  } }) : async () => ({ sandboxEnabled: false, merchantVerified: false }),
  provider: checkoutFixtures ? fakePaymentsProvider : { binding: refuseProvider, charge: refuseProvider, readCharge: refuseProvider,
    refund: refuseProvider, readRefund: refuseProvider } });
const audit = async (actor, action, target, details = {}) => {
  const id = randomUUID(), event = { id, actor, action, target, details, at: new Date().toISOString() };
  await write(`admin/audit/${id}.json`, event); return event;
};
const recordPage = async (prefix, { cursor, limit: size = 50 } = {}) => {
  const offset = cursor ? Number(cursor) : 0;
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("Invalid synthetic page cursor.");
  const all = [...records.entries()].filter(([path]) => path.startsWith(prefix)).sort(([a], [b]) => a.localeCompare(b));
  const page = all.slice(offset, offset + size).map(([, record]) => structuredClone(record.value));
  return { records: page, ...(offset + size < all.length ? { cursor: String(offset + size) } : {}) };
};
const shared = { getSession: session, readRecord: read, writeRecord: write, limitAction: limit,
  connections, readPricingSettings: pricingSettings, readRegistrationPolicy: registrationPolicy, filmProduction, payments, captcha };
const handlers = {
  "/api/auth": createAuthHandler({ ...shared,
    verificationMail: { available: () => false, send: refuseProvider } }),
  "/api/studio": createStudioHandler({ ...shared, generateStory: refuseProvider }),
  "/api/admin": createAdminHandler({ ...shared, audit, recordPage }),
};

const accounts = [
  { email: "customer@example.invalid", name: "SAMPLE ONLY - FICTIONAL CUSTOMER", role: "customer", password: "Cedar lantern rivers wander" },
  { email: OWNER_EMAIL, name: "SAMPLE ONLY - FICTIONAL OWNER", role: "owner", password: "Copper forest windmills travel" },
  { email: "second-customer@example.invalid", name: "SAMPLE ONLY - SECOND FICTIONAL CUSTOMER", role: "customer", password: "Orchard mountain copper lantern" },
  { email: "waiting@example.invalid", name: "SAMPLE ONLY - WAITING CUSTOMER", role: "customer", pending: true, password: "Birch harvest lantern sunset" },
  { email: "admin@example.invalid", name: "SAMPLE ONLY - FICTIONAL ADMIN", role: "admin", password: "Silver fountain cedar twilight" },
];
for (const account of accounts) {
  const { password, pending, ...user } = account;
  await write(auth.userPath(user.email), { ...user, passwordHash: auth.hashPassword(password),
    status: pending ? "pending" : "active", mustChangePassword: false, emailVerified: false, createdAt: new Date().toISOString(),
    ...(!pending ? { approvedAt: new Date().toISOString(), approvedBy: OWNER_EMAIL } : {}) });
}
const fixture = fictionalOperatorProject();
fixture.scenes = fixture.scenes.map((scene, index) => ({ ...scene, id: `synthetic-scene-${index + 1}` }));
fixture.selectedThemes = fixture.selectedThemes.map((theme, index) => ({ ...theme, id: `synthetic-theme-${index + 1}` }));
fixture.themes = structuredClone(fixture.selectedThemes);
fixture.sources = fixture.sources.map(source => ({ ...source, size: Buffer.byteLength(source.text), extraction: "Synthetic fixture text" }));
Object.assign(fixture, { providerId: "magiclight", quality: "highest", generatedBy: "Lineage Theatre", updatedAt: new Date().toISOString() });
const checkoutProjects = ["captured", "declined", "uncertain"].map((scenario, index) => ({ ...structuredClone(fixture), id: `00000000-0000-4000-8000-${String(index + 11).padStart(12, "0")}`, title: `SAMPLE ONLY - ${scenario} payment: The shared garden` }));
const seedMarker = `lineage-checkout-fixture:${randomUUID()}`;
const seedScript = checkoutFixtures ? `// SYNTHETIC LOCAL TEST ONLY. This script is never in an application build.
if(!localStorage.getItem(${JSON.stringify(seedMarker)})) {
  for(const email of ${JSON.stringify(accounts.map(account=>account.email))}) localStorage.setItem('lineage-studio-v3:'+email,${JSON.stringify(JSON.stringify(checkoutProjects))});
  localStorage.setItem(${JSON.stringify(seedMarker)},'seeded');
}
const originalFetch=window.fetch.bind(window);
window.fetch=async(input,options)=>{
  const url=new URL(typeof input==='string'?input:input.url,location.href);
  if(url.href==='https://sandbox.api.intuit.com/quickbooks/v4/payments/tokens') {
    const fields=JSON.parse(options.body); const number=fields.card?.number;
    const outcome={'4111111111111111':'captured','4000000000000002':'declined','4000000000009995':'uncertain'}[number];
    if(!outcome) throw new Error('Only displayed fabricated test card numbers are allowed. No external request was made.');
    return new Response(JSON.stringify({value:'fixture_card_'+outcome}),{status:200,headers:{'Content-Type':'application/json'}});
  }
  if(url.origin!==location.origin) throw new Error('Synthetic browser fixture forbids all external fetch requests.');
  return originalFetch(input,options);
};` : `// SYNTHETIC LOCAL TEST ONLY\nconst fixture=${JSON.stringify(fixture)};\nfor(const email of ${JSON.stringify(accounts.map(account=>account.email))}){const key='lineage-studio-v3:'+email;if(!localStorage.getItem(key))localStorage.setItem(key,JSON.stringify([fixture]));}`;

let vite;
const server = createServer(async (req, res) => {
  try {
    if (req.headers.host !== `${HOST}:${PORT}` && req.headers.host !== `localhost:${PORT}`) {
      res.statusCode = 403; return res.end("This synthetic server accepts only its local origin.");
    }
    const url = new URL(req.url, origin), path = url.pathname;
    res.setHeader("Cache-Control", "no-store");
    if (handlers[path]) return await handlers[path](req, res);
    if (path.startsWith("/api/")) return auth.json(res, 503, {
      code: "SYNTHETIC_SERVICE_DISABLED", message: "This service is disabled in the synthetic local workflow test." });
    if (path === "/__workflow/status") return auth.json(res, 200, {
      synthetic: true, memoryOnly: true, providersEnabled: false, mailEnabled: false,
      blockedExternalCalls, recordCount: records.size, syntheticCharges, checkoutFixtures,
      preparedFilms: [...records.keys()].filter(key=>key.startsWith("production/jobs/")).length,
    });
    if (path === "/__workflow/fixture") return auth.json(res, 200, { synthetic: true, project: fixture });
    if (path === "/__workflow/seed.js") {
      res.setHeader("Content-Type", "text/javascript; charset=utf-8"); return res.end(seedScript);
    }
    if (path === "/__workflow/captcha.js") {
      res.setHeader("Content-Type", "text/javascript; charset=utf-8");
      return res.end('/* SYNTHETIC LOCAL TEST ONLY: no Google service call. */ window.grecaptcha={ready:callback=>callback(),execute:async(_key,{action})=>"synthetic_captcha_"+action+"_"+crypto.randomUUID()};');
    }
    if (path === "/__workflow") {
      // This helper exposes only the intentionally public fixture accounts, never real users.
      const visible = [];
      for (const account of accounts) {
        const saved = await read(auth.userPath(account.email)), pending = await read(`auth/mfa-enrollments/${auth.digest(account.email)}.json`);
        const encrypted = saved?.value.mfa?.enabled ? saved.value.mfa.secret : pending?.value.secret;
        const code = encrypted ? securityHelpers.totpCode(securityHelpers.decryptMfaSecret(encrypted, account.email), Math.floor(Date.now()/30000)) : "Enroll first";
        visible.push(`<tr><td>${account.email}</td><td>${account.password}</td><td>${code}</td></tr>`);
      }
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      return res.end(`<!doctype html><html><head><title>Synthetic workflow test</title></head><body><h1>SYNTHETIC LOCAL TEST ONLY</h1><p>Public test credentials and authenticator codes. Every account is fictional and stored in memory. No external provider or email can be called.</p><table><tr><th>Account</th><th>Public test password</th><th>Current fixture authenticator code</th></tr>${visible.join("")}</table>${checkoutFixtures ? '<h2>Fake checkout fixtures — no real card data</h2><p>Use separate preloaded films for each payment. Card 4111111111111111 captures; 4000000000000002 declines; 4000000000009995 stays uncertain. Expiry 12/2030, CVC 123, Sample Person, 1 Fictional Street, Test City, UT 84003. The browser intercepts fabricated tokenization locally. No card data or payment request leaves this computer.</p>' : ''}<p><a href="/">Open app</a> · <a href="/__workflow/status">Read test status</a> · <a href="/__workflow">Refresh authenticator codes</a></p></body></html>`);
    }
    if (checkOnly) { res.statusCode = 404; return res.end("Synthetic route-check mode."); }
    vite.middlewares(req, res);
  } catch {
    auth.json(res, 500, { code: "SYNTHETIC_SERVER_ERROR", message: "The local synthetic test request failed." });
  }
});

if (!checkOnly) {
  const [{ createServer: createViteServer }, { default: react }] = await Promise.all([import("vite"), import("@vitejs/plugin-react")]);
  vite = await createViteServer({ root, configFile: false, envFile: false, appType: "spa",
    define: { __BUILD_COMMIT__: JSON.stringify("synthetic-local-test") },
    plugins: [react(), { name: "synthetic-workflow-label",
    transform(code, id) {
      if (id.replaceAll("\\", "/").endsWith("/src/lib/captcha.ts"))
        return code.replace("https://www.google.com/recaptcha/api.js?render=", "/__workflow/captcha.js?render=");
    },
    transformIndexHtml(html) {
      return html.replace(/<meta\s+http-equiv="Content-Security-Policy"[\s\S]*?\/>/i,
        `<meta http-equiv="Content-Security-Policy" content="default-src 'self'; base-uri 'self'; object-src 'none'; form-action 'self'; script-src 'self' 'unsafe-inline'; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self' data:; connect-src 'self' blob: ws://${HOST}:${PORT}">`)
        .replace("</head>", '<script src="/__workflow/seed.js"></script></head>')
        .replace("<body>", '<body style="padding-bottom:38px"><div role="note" style="position:fixed;bottom:0;left:0;right:0;z-index:2147483647;background:#641c24;color:white;padding:9px 16px;text-align:center;font:13px Arial,sans-serif">SYNTHETIC LOCAL TEST · FICTIONAL DATA · MEMORY-ONLY STORAGE · EMAIL, AI, VIDEO AND PAYMENTS DISABLED</div>');
    } }],
    server: { middlewareMode: true, host: HOST, hmr: { server }, fs: { strict: true, allow: [root] } },
  });
}
await new Promise((resolve, reject) => { server.once("error", reject); server.listen(PORT, HOST, resolve); });
async function close() {
  await vite?.close();
  await new Promise(resolve => server.close(resolve));
}
process.once("SIGINT", () => void close());
process.once("SIGTERM", () => void close());

function route(path, { body, cookie, suppliedOrigin = origin } = {}) {
  return new Promise((resolve, reject) => {
    if (["login", "register", "mfaChallenge"].includes(body?.action))
      body = { ...body, captchaToken: fixtureCaptchaToken(body.action === "mfaChallenge" ? "mfa" : body.action) };
    const data = body ? JSON.stringify(body) : null;
    const req = httpRequest(`${origin}${path}`, { method: data ? "POST" : "GET",
      headers: { Origin: suppliedOrigin, ...(cookie ? { Cookie: cookie } : {}),
        ...(data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {}) } }, res => {
      let text = ""; res.setEncoding("utf8"); res.on("data", value => { text += value; });
      res.on("end", () => { try { resolve({ status: res.statusCode, body: JSON.parse(text), cookies: res.headers["set-cookie"] || [] }); } catch (error) { reject(error); } });
    });
    req.on("error", reject); if (data) req.write(data); req.end();
  });
}
const login = async account => {
  const result = await route("/api/auth", { body: { action: "login", email: account.email, password: account.password } });
  assert.equal(result.status, 200); assert.equal(result.body.user.email, account.email);
  return result.cookies.find(cookie=>cookie.startsWith("lineage_session=")).split(";")[0];
};
async function check() {
  assert.equal((await route("/api/studio?action=capabilities")).status, 401);
  const customer = await login(accounts[0]), owner = await login(accounts[1]), other = await login(accounts[2]);
  assert.equal((await route("/api/admin?action=overview", { cookie: customer })).status, 403);
  assert.equal((await route("/api/admin?action=overview", { cookie: owner })).status, 200);
  const capabilities = await route("/api/studio?action=capabilities", { cookie: customer });
  assert.equal(capabilities.body.production, false); assert.equal(capabilities.body.billing, false);
  const prepare = { action: "prepare", project: fixture, idempotencyKey: "synthetic-workflow-prepare-001", preparationConsent: true };
  assert.equal((await route("/api/studio", { cookie: customer, body: { ...prepare, preparationConsent: false } })).status, 400);
  assert.equal((await route("/api/studio", { cookie: customer, body: prepare, suppliedOrigin: "https://other.example.invalid" })).status, 403);
  const first = await route("/api/studio", { cookie: customer, body: prepare });
  assert.equal(first.status, 201);
  const job = first.body.production || first.body.job || first.body;
  assert.equal(job.status, "prepared");
  const repeated = await route("/api/studio", { cookie: customer, body: prepare });
  assert.deepEqual(repeated.body, first.body);
  assert.equal((await route(`/api/studio?action=productionStatus&id=${job.id}`, { cookie: customer })).status, 200);
  assert.equal((await route(`/api/studio?action=manifest&id=${job.id}`, { cookie: customer })).status, 200);
  assert.equal((await route(`/api/studio?action=productionStatus&id=${job.id}`, { cookie: other })).status, 404);
  assert.equal((await route("/api/studio", { cookie: customer, body: { action: "quote", project: fixture, idempotencyKey: "synthetic-workflow-quote-001" } })).status, 503);
  assert.equal((await route("/api/studio", { cookie: customer, body: { action: "checkout", quoteId: "a".repeat(64), idempotencyKey: "synthetic-workflow-pay-001", paymentToken: "synthetic_token_never_real", consent: true } })).status, 403);
  assert.equal((await route("/api/studio", { cookie: customer, body: { action: "generate" } })).status, 503);
  assert.equal((await route("/api/admin", { cookie: customer, body: { action: "prepareProductionTest", idempotencyKey: "synthetic-operator-test-001" } })).status, 403);
  assert.equal((await route("/api/admin", { cookie: owner, body: { action: "prepareProductionTest", idempotencyKey: "synthetic-operator-test-001" } })).status, 201);
  await checkRegistrationAccess(owner);
  assert.equal((await route("/api/auth", { cookie: customer, body: { action: "logout" } })).status, 200);
  assert.equal((await route("/api/studio?action=capabilities", { cookie: customer })).status, 401);
  assert.equal(blockedExternalCalls, 0);
  console.log("PASS: real-handler synthetic workflow, registration approval and policy changes, shared payment/film access, consent, idempotency, ownership, disabled providers, and logout replay; zero outbound calls.");
}
async function checkRegistrationAccess(owner) {
  const waiting = await login(accounts[3]), administrator = await login(accounts[4]);
  assert.equal((await route("/api/auth", { cookie: waiting })).body.user.accessStatus, "pending");
  assert.equal((await route("/api/auth?action=security", { cookie: waiting })).status, 200);
  for (const action of ["prepare", "quote", "checkout", "generate"]) {
    assert.equal((await route("/api/studio", { cookie: waiting, body: { action } })).status, 401, `Pending ${action}`);
  }
  assert.equal((await route("/api/admin", { cookie: waiting, body: { action: "approve", email: accounts[3].email } })).status, 401);
  const approval = await route("/api/admin", { cookie: administrator, body: { action: "approve", email: accounts[3].email } });
  assert.equal(approval.status, 200);
  assert.equal(approval.body.user.accessStatus, "approved");
  assert.equal(approval.body.user.role, "customer");
  // The existing cookie must pick up the persisted approval without granting admin rights.
  assert.equal((await route("/api/auth", { cookie: waiting })).body.user.accessStatus, "approved");
  assert.equal((await route("/api/admin?action=overview", { cookie: waiting })).status, 403);
  for (const cookie of [owner, administrator, waiting]) {
    const capabilities = await route("/api/studio?action=capabilities", { cookie });
    assert.equal(capabilities.status, 200);
    assert.equal(capabilities.body.production, false);
    assert.equal(capabilities.body.billing, false);
    assert.equal((await route("/api/studio", { cookie, body: { action: "generate" } })).status, 503);
    assert.equal((await route("/api/studio", { cookie, body: { action: "quote", project: fixture, idempotencyKey: "synthetic-same-workflow-quote" } })).status, 503);
  }
  const initial = await route("/api/admin?action=registrationPolicy", { cookie: administrator });
  assert.equal(initial.status, 200);
  assert.equal(initial.body.approvalRequired, true);
  assert.equal((await route("/api/admin", { cookie: waiting, body: { action: "updateRegistrationPolicy", approvalRequired: false, expectedRevision: initial.body.revision } })).status, 403);
  const register = async email => route("/api/auth", { body: { action: "register", name: "Fictional registration policy check", email, password: "Meadow lantern copper hillside", termsAccepted: true } });
  const pending = await register("new-waiting@example.invalid");
  assert.equal(pending.status, 201);
  assert.equal(pending.body.user.accessStatus, "pending");
  const disabled = await route("/api/admin", { cookie: administrator, body: { action: "updateRegistrationPolicy", approvalRequired: false, expectedRevision: initial.body.revision } });
  assert.equal(disabled.status, 200);
  assert.equal(disabled.body.approvalRequired, false);
  const automatic = await register("automatic@example.invalid");
  assert.equal(automatic.status, 201);
  assert.equal(automatic.body.user.accessStatus, "approved");
  assert.equal(automatic.body.user.role, "customer");
  const waitingCookie = pending.cookies.find(cookie=>cookie.startsWith("lineage_session=")).split(";")[0];
  assert.equal((await route("/api/auth", { cookie: waitingCookie })).body.user.accessStatus, "pending");
  const enabled = await route("/api/admin", { cookie: administrator, body: { action: "updateRegistrationPolicy", approvalRequired: true, expectedRevision: disabled.body.revision } });
  assert.equal(enabled.status, 200);
  assert.equal(enabled.body.approvalRequired, true);
  const automaticCookie = automatic.cookies.find(cookie=>cookie.startsWith("lineage_session=")).split(";")[0];
  assert.equal((await route("/api/auth", { cookie: automaticCookie })).body.user.accessStatus, "approved");
  assert.equal((await register("waiting-again@example.invalid")).body.user.accessStatus, "pending");
}
async function checkCheckout() {
  const customer = await login(accounts[0]), other = await login(accounts[2]);
  const configuration = await route("/api/studio?action=checkoutConfiguration", { cookie: customer });
  assert.equal(configuration.status, 200);
  assert.equal(configuration.body.available, true);
  assert.equal(configuration.body.environment, "sandbox");
  let firstOrder;
  for (const [index, status] of ["captured", "declined", "uncertain"].entries()) {
    const prepared = await route("/api/studio", { cookie: customer, body: { action: "prepare", project: checkoutProjects[index], preparationConsent: true, idempotencyKey: `checkout-fixture-prepare-${index}` } });
    assert.equal(prepared.status, 201);
    const quoted = await route("/api/studio", { cookie: customer, body: { action: "quote", project: checkoutProjects[index], preparedId: prepared.body.id, idempotencyKey: `checkout-fixture-quote-${index}` } });
    assert.equal(quoted.status, 200);
    assert.equal(quoted.body.preparedId, prepared.body.id);
    assert.equal(quoted.body.manifestHash, prepared.body.manifestHash);
    assert.equal(quoted.body.amountCents, 100);
    assert.equal(quoted.body.sandbox, true);
    const preflight = await route("/api/studio", { cookie: customer, body: { action: "checkoutCheck", quoteId: quoted.body.id, captchaToken: fixtureCaptchaToken("checkout") } });
    assert.equal(preflight.status, 200);
    const body = { action: "checkout", quoteId: quoted.body.id, checkoutProof: preflight.body.checkoutProof, idempotencyKey: `checkout-fixture-charge-${index}`, paymentToken: `fixture_card_${status}`, consent: true };
    const paid = await route("/api/studio", { cookie: customer, body });
    assert.equal(paid.status, 200);
    assert.equal(paid.body.id, quoted.body.orderId);
    assert.equal(paid.body.status, status);
    assert.equal(paid.body.sandbox, true);
    const charges = syntheticCharges;
    assert.equal((await route("/api/studio", { cookie: customer, body })).status, 403);
    assert.equal(syntheticCharges, charges, "Replaying a consumed CAPTCHA proof must not call the processor");
    for (let readNumber = 0; readNumber < 2; readNumber++) {
      const checked = await route(`/api/studio?action=order&id=${paid.body.id}`, { cookie: customer });
      assert.equal(checked.status, 200); assert.equal(checked.body.status, status);
    }
    assert.equal(syntheticCharges, charges);
    assert.equal((await route(`/api/studio?action=order&id=${paid.body.id}`, { cookie: other })).status, 404);
    const receipt = await route(`/api/studio?action=receipt&id=${paid.body.id}`, { cookie: customer });
    assert.equal(receipt.status, status === "captured" ? 200 : 409);
    if (status === "captured") { firstOrder = paid.body; assert.equal(receipt.body.sandbox, true); }
  }
  assert.equal(syntheticCharges, 3);
  assert.ok(firstOrder);
  assert.equal(blockedExternalCalls, 0);
  assert.doesNotMatch(JSON.stringify([...records.values()]), /fixture_card_|4111111111111111|4000000000009995|"cvc"/);
  console.log("PASS: actual-handler synthetic checkout quotes, captured/declined/uncertain outcomes, GET-only recovery, sandbox receipts, ownership, no stored card tokens, and zero outbound calls.");
}
if (checkOnly) {
  try { if (checkoutFixtures) await checkCheckout(); else await check(); } finally { await close(); }
} else {
  console.log(`Synthetic workflow test running at ${origin}. Fictional account helpers: ${origin}/__workflow . No production data or provider calls.`);
}
