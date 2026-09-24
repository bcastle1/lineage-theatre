/**
 * SYNTHETIC LOCAL TEST ONLY. Never deploy this server or load production credentials.
 * Start: node scripts/test-workflow-server.mjs
 * Route proof, then exit: node scripts/test-workflow-server.mjs --check
 * Checkout UI fixtures: node scripts/test-workflow-server.mjs --checkout-fixtures
 * Checkout route proof: node scripts/test-workflow-server.mjs --checkout-fixtures --check
 * Finished-film playback fixture: node scripts/test-workflow-server.mjs --delivery-fixture
 * Private media route proof: node scripts/test-workflow-server.mjs --delivery-fixture --check
 * URL: http://127.0.0.1:5178
 * Route checks use an ephemeral loopback port so browser QA can remain open.
 * Customer: customer@example.invalid / Cedar lantern rivers wander
 * Owner fixture: erik@brocotech.ai / Copper forest windmills travel
 * Agreement QA: registration loads the real public agreement handler; edit it
 * in owner Administration to test stale acceptance in a second browser tab.
 * The owner address is the app's reserved identifier, backed here ONLY by a fictional
 * in-memory record. These passwords are public test fixtures, never real credentials.
 * All records disappear on exit. Browser fixture drafts stay on this local origin.
 */
import { createServer, request as httpRequest } from "node:http";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";

const HOST = "127.0.0.1";
let PORT = 5178, origin = `http://${HOST}:${PORT}`;
const root = fileURLToPath(new URL("../", import.meta.url));
const checkOnly = process.argv.includes("--check");
const checkoutFixtures = process.argv.includes("--checkout-fixtures");
const deliveryFixture = process.argv.includes("--delivery-fixture");
if (checkoutFixtures && deliveryFixture) throw new Error("Choose either checkout fixtures or the delivery fixture for this local run.");
if (process.argv.some(argument => argument.startsWith("--env-file"))) throw new Error("Test server must not load environment files.");

// Remove inherited provider settings before importing application services.
for (const name of Object.keys(process.env)) {
  if (/^(?:OPENAI_|MAGICLIGHT_|QUICKBOOKS_|PAYMENT_|RECAPTCHA_|BLOB_|LINEAGE_|MICROSOFT_|GRAPH_|VERCEL_|VITE_|GITHUB_)/.test(name)) delete process.env[name];
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
  { OWNER_EMAIL }, { createFilmProductionService, fictionalOperatorProject, productionJobPath },
  { createPaymentsService }, { productionReadiness }, securityHelpers, { parseRange },
  { readPricingSettings }, { createFilmPricingService }] = await Promise.all([
  import("../api/auth.mjs"), import("../api/studio.mjs"), import("../api/admin.mjs"),
  import("../api/_lib/auth.mjs"), import("../api/_lib/access.mjs"),
  import("../api/_lib/film-production.mjs"), import("../api/_lib/payments.mjs"),
  import("../api/_lib/production.mjs"), import("../api/_lib/auth-security.mjs"),
  import("../api/_lib/archive.mjs"),
  import("../api/_lib/admin.mjs"), import("../api/_lib/film-pricing.mjs"),
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
const pricingSettings = () => readPricingSettings(read);
const registrationPolicy = async () => (await read("settings/registration.json"))?.value || { approvalRequired: true, revision: 0, updatedAt: null, updatedBy: null };
const connections = async () => ({ story: false, ...productionReadiness({ env: {}, pricingSettings: await pricingSettings() }),
  connections: { ...productionReadiness({ env: {} }).connections,
    story: { available: false, reason: "SYNTHETIC LOCAL TEST: story provider calls are disabled." } } });
const refuseProvider = async () => { throw new Error("Synthetic test cannot call an external provider."); };
const filmProduction = createFilmProductionService({ readRecordImpl: read, writeRecordImpl: write });
const filmPricing = createFilmPricingService({ filmProduction, pricingSettings, env: {} });
let deliveryMedia, deliveryProject;
let deliveryBlobReads = 0;
const getDeliveryBlob = async (pathname, options) => {
  assert.equal(deliveryFixture, true);
  assert.equal(options.access, "private");
  assert.equal(options.useCache, false);
  deliveryBlobReads++;
  if (!deliveryMedia || pathname !== deliveryMedia.pathname) return null;
  const range = parseRange(options.headers?.Range, deliveryMedia.bytes.length);
  const bytes = range ? deliveryMedia.bytes.subarray(range.start, range.end + 1) : deliveryMedia.bytes;
  return { statusCode: 200, stream: new Response(bytes).body,
    headers: new Headers({ "content-type": "video/mp4", "content-length": String(bytes.length), ...(range ? { "content-range": range.contentRange } : {}) }),
    blob: { pathname, contentType: "video/mp4", size: bytes.length } };
};
let syntheticCharges = 0;
const syntheticChargeAmounts = [];
const simulatedBinding = { environment: "sandbox", grantId: "c".repeat(64) };
const fakePaymentsProvider = {
  binding: async () => simulatedBinding,
  charge: async (_binding, { amountCents, paymentToken }) => {
    if (!["fixture_card_captured", "fixture_card_declined", "fixture_card_uncertain"].includes(paymentToken)) throw new Error("Only fabricated fixture tokens are accepted.");
    syntheticCharges++;
    syntheticChargeAmounts.push(amountCents);
    if (paymentToken === "fixture_card_uncertain") throw new Error("Simulated unknown processor outcome.");
    return { id: `fixture_charge_${syntheticCharges}`, amountCents, currency: "USD", verified: true,
      status: paymentToken === "fixture_card_declined" ? "DECLINED" : "CAPTURED" };
  },
  readCharge: async (_binding, { chargeId, amountCents }) => ({ id: chargeId, amountCents, currency: "USD", verified: true, status: "CAPTURED" }),
  refund: async (_binding, { amountCents }) => ({ id: `fixture_refund_${randomUUID()}`, amountCents, currency: "USD", verified: true, status: "ISSUED" }),
  readRefund: refuseProvider,
};
const payments = createPaymentsService({ read, write, pricingSettings,
  quoteProvider: (...args) => filmPricing.quoteForPayment(...args),
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
  connections, readPricingSettings: pricingSettings, readRegistrationPolicy: registrationPolicy, filmProduction, filmPricing, payments, captcha };
const handlers = {
  "/api/auth": createAuthHandler({ ...shared,
    verificationMail: { available: () => false, send: refuseProvider } }),
  "/api/studio": createStudioHandler({ ...shared, generateStory: refuseProvider, ...(deliveryFixture ? { getBlob: getDeliveryBlob } : {}) }),
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
if (deliveryFixture) {
  // Exercise delivery of an existing public illustration, never claim this is
  // provider-generated output of the fictional screenplay or a paid transaction.
  const bytes = await readFile(new URL("../public/assets/the-journey-of-thomas-wilson.mp4", import.meta.url));
  const sha256 = auth.digest(bytes);
  assert.equal(sha256, "68f017454bf2619b972db7b062badf765829e85f0d8f315ca0f674d763bc708d");
  assert.equal(bytes.length, 17_193_754);
  const { default: ts } = await import("typescript");
  const modelSource = await readFile(new URL("../src/studio/model.ts", import.meta.url), "utf8");
  const compiled = ts.transpileModule(modelSource, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;
  const { normalizeFilm, productionPreparationInput, productionInputHash } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
  deliveryProject = normalizeFilm({ ...structuredClone(fixture), id: "00000000-0000-4000-8000-000000000021", duration: 79,
    title: "SAMPLE ONLY - illustrative playback fixture",
    logline: "Fictional garden screenplay. Playback reuses the existing Thomas Wilson demonstration video solely to verify private delivery; it is not a generated result of this plan." });
  const requestId = randomUUID();
  const prepared = await filmProduction.prepare({ email: accounts[0].email, project: deliveryProject, idempotencyKey: requestId, preparationConsent: true });
  const path = productionJobPath(accounts[0].email, prepared.id), record = await read(path);
  const timestamp = new Date().toISOString();
  deliveryMedia = { bytes, pathname: `production/media/${auth.digest(accounts[0].email)}/${prepared.id}/${sha256}.mp4`, sha256 };
  // These production-shaped records exist only in this local memory map to
  // exercise the real delivery gate. No provider ran and no real payment exists.
  await write(path, { ...record.value, status: "completed", updatedAt: timestamp,
    authorization: { manifestHash: prepared.manifestHash, environment: "production", budgetCents: 100,
      quoteReference: "synthetic-delivery-only-no-provider", authorizedAt: timestamp },
    shots: record.value.shots.map(shot => ({ ...shot, status: "completed" })),
    media: { pathname: deliveryMedia.pathname, sha256, contentType: "video/mp4", sizeBytes: bytes.length, durationSeconds: 78.506 },
    syntheticFixture: { purpose: "existing-sample-playback-only", providerGenerated: false },
  }, record.etag);
  const quoteId = auth.digest("synthetic-delivery-fixture-quote"), orderId = auth.digest(`${accounts[0].email}:production:${prepared.manifestHash}`);
  await write(`payments/orders/${orderId}.json`, { id: orderId, quoteId, preparedId: prepared.id, manifestHash: prepared.manifestHash,
    customerEmail: accounts[0].email, filmId: deliveryProject.id, filmTitle: deliveryProject.title, status: "captured",
    currency: "USD", amountCents: 100, refundedCents: 0, createdAt: timestamp, updatedAt: timestamp, capturedAt: timestamp,
    provider: "quickbooks", merchantBinding: { ...simulatedBinding, environment: "production" },
    providerChargeId: "synthetic_delivery_only_no_charge", syntheticFixture: { memoryOnly: true, realPayment: false },
  });
  deliveryProject.productionPreparation = { ...prepared, inputHash: await productionInputHash(JSON.stringify(productionPreparationInput(deliveryProject))),
    requestId, status: "completed", issues: [] };
  deliveryProject.paymentReference = { preparedId: prepared.id, manifestHash: prepared.manifestHash, quoteId, orderId,
    checkoutKey: "synthetic-delivery-checkout", submittedAt: timestamp, sandbox: false };
  assert.deepEqual(normalizeFilm(deliveryProject).paymentReference, deliveryProject.paymentReference);
  assert.equal(normalizeFilm(deliveryProject).productionPreparation.inputHash, deliveryProject.productionPreparation.inputHash);
}
const seedMarker = `lineage-${deliveryFixture ? "delivery" : "checkout"}-fixture:${randomUUID()}`;
const seedScript = deliveryFixture ? `// SYNTHETIC PLAYBACK ONLY: existing illustrative sample, no new render or charge.
if(!localStorage.getItem(${JSON.stringify(seedMarker)})) {
  for(const email of ${JSON.stringify(accounts.map(account=>account.email))}) localStorage.setItem('lineage-studio-v3:'+email,JSON.stringify(email===${JSON.stringify(accounts[0].email)}?[${JSON.stringify(deliveryProject)}]:[${JSON.stringify(fixture)}]));
  localStorage.setItem(${JSON.stringify(seedMarker)},'seeded');
}
const originalFetch=window.fetch.bind(window);
window.fetch=(input,options)=>{
  const url=new URL(typeof input==='string'?input:input.url,location.href);
  if(url.origin!==location.origin) throw new Error('Synthetic playback fixture forbids external fetch requests.');
  return originalFetch(input,options);
};` : checkoutFixtures ? `// SYNTHETIC LOCAL TEST ONLY. This script is never in an application build.
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
      blockedExternalCalls, recordCount: records.size, syntheticCharges, checkoutFixtures, deliveryFixture, deliveryBlobReads,
      ...(deliveryFixture ? { deliveryPreparedId: deliveryProject.productionPreparation.id, illustrativePlaybackOnly: true } : {}),
      preparedFilms: [...records.keys()].filter(key=>key.startsWith("production/jobs/")).length,
    });
    if (path === "/__workflow/fixture") return auth.json(res, 200, { synthetic: true, project: deliveryFixture ? deliveryProject : fixture });
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
      if (deliveryFixture) return res.end(`<!doctype html><html><head><title>Illustrative private playback fixture</title></head><body><h1>SYNTHETIC PLAYBACK FIXTURE ONLY</h1><p>This local fixture reuses the existing Thomas Wilson demonstration MP4 to exercise private delivery. It is not a newly generated film, does not depict the fictional garden screenplay, and represents no real payment.</p><p>Sign in with customer@example.invalid and the public fixture password below, then open Create &amp; watch. The prepared job and fabricated confirmed payment use the live record format solely to test payment-gated delivery. Every record exists only in memory; there is no real transaction, production credential, or external provider call.</p><table><tr><th>Account</th><th>Public test password</th><th>Current fixture authenticator code</th></tr>${visible.join("")}</table><p><a href="/">Open app</a> · <a href="/__workflow/status">Read test status</a></p></body></html>`);
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
        .replace("<body>", `<body style="padding-bottom:38px"><div role="note" style="position:fixed;bottom:0;left:0;right:0;z-index:2147483647;background:#641c24;color:white;padding:9px 16px;text-align:center;font:13px Arial,sans-serif">${deliveryFixture ? "SYNTHETIC PLAYBACK FIXTURE · EXISTING DEMONSTRATION VIDEO · NO NEW RENDER OR REAL CHARGE · MEMORY ONLY" : "SYNTHETIC LOCAL TEST · FICTIONAL DATA · MEMORY-ONLY STORAGE · EMAIL, AI, VIDEO AND PAYMENTS DISABLED"}</div>`);
    } }],
    server: { middlewareMode: true, host: HOST, hmr: { server }, fs: { strict: true, allow: [root] } },
  });
}
await new Promise((resolve, reject) => { server.once("error", reject); server.listen(checkOnly ? 0 : PORT, HOST, resolve); });
PORT = server.address().port;
origin = `http://${HOST}:${PORT}`;
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
async function currentAgreementConsent() {
  const response = await route("/api/auth?action=agreement");
  assert.equal(response.status, 200);
  const agreement = response.body.agreement;
  assert.ok(agreement && typeof agreement.body === "string" && agreement.body.length > 0);
  return { sourceAgreementAccepted: true, sourceAgreementVersion: agreement.version, sourceAgreementHash: agreement.contentHash };
}
// Three five-second shots use three six-second planning clips: 858 credits at
// $88/80,000 = 94 cents rounded, plus the default 50% markup = 141 cents.
const expectedFixturePriceCents = 141;
function assertPlanningPrice(price, prepared) {
  assert.equal(price.status, 200);
  assert.equal(price.body.preparedId, prepared.id);
  assert.equal(price.body.manifestHash, prepared.manifestHash);
  assert.equal(price.body.currency, "USD");
  assert.equal(price.body.amountCents, expectedFixturePriceCents);
  assert.equal(price.body.kind, "confirmed");
  assert.equal(price.body.pricingBasis, "planning-rate");
  assert.match(price.body.note, /fixed price/i);
  assert.doesNotMatch(JSON.stringify(price.body), /providerCostCents|planningCreditsPerClip|markupBasisPoints|apiVerified/);
}
async function check() {
  assert.equal((await route("/api/studio?action=capabilities")).status, 401);
  const customer = await login(accounts[0]), owner = await login(accounts[1]), other = await login(accounts[2]);
  assert.equal((await route("/api/admin?action=overview", { cookie: customer })).status, 403);
  assert.equal((await route("/api/admin?action=overview", { cookie: owner })).status, 200);
  const capabilities = await route("/api/studio?action=capabilities", { cookie: customer });
  assert.equal(capabilities.body.production, false); assert.equal(capabilities.body.billing, false);
  assert.deepEqual(await pricingSettings(), { markupBasisPoints: 5000, planningCreditsPerClip: 286,
    planningSecondsPerClip: 6, planningRendersPerClip: 1, revision: 0, updatedAt: null, updatedBy: null });
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
  const priced = await route("/api/studio", { cookie: customer, body: { action: "price", project: fixture,
    preparedId: job.id, idempotencyKey: "synthetic-workflow-price-001" } });
  assertPlanningPrice(priced, job);
  assert.equal((await route("/api/studio?action=checkoutConfiguration", { cookie: customer })).body.available, false);
  assert.equal(syntheticCharges, 0);
  assert.equal([...records.keys()].some(path => path.startsWith("payments/")), false, "Pricing cannot create a payment quote or order");
  assert.equal((await route("/api/studio", { cookie: customer, body: { action: "quote", project: fixture, idempotencyKey: "synthetic-workflow-quote-001" } })).status, 503);
  assert.equal((await route("/api/studio", { cookie: customer, body: { action: "checkout", quoteId: "a".repeat(64), idempotencyKey: "synthetic-workflow-pay-001", paymentToken: "synthetic_token_never_real", consent: true } })).status, 403);
  assert.equal((await route("/api/studio", { cookie: customer, body: { action: "generate" } })).status, 503);
  assert.equal((await route("/api/admin", { cookie: customer, body: { action: "prepareProductionTest", idempotencyKey: "synthetic-operator-test-001" } })).status, 403);
  assert.equal((await route("/api/admin", { cookie: owner, body: { action: "prepareProductionTest", idempotencyKey: "synthetic-operator-test-001" } })).status, 201);
  await checkSourceAgreement(owner, customer);
  await checkRegistrationAccess(owner);
  assert.equal((await route("/api/auth", { cookie: customer, body: { action: "logout" } })).status, 200);
  assert.equal((await route("/api/studio?action=capabilities", { cookie: customer })).status, 401);
  assert.equal(blockedExternalCalls, 0);
  console.log("PASS: real-handler synthetic workflow, fixed $1.41 planning price with 50% markup while billing is disabled, required versioned source agreement and administrator edits, registration approval and policy changes, shared payment/film access, consent, idempotency, ownership, disabled providers, and logout replay; zero outbound calls.");
}
async function checkSourceAgreement(owner, customer) {
  const published = await route("/api/auth?action=agreement");
  assert.equal(published.status, 200);
  const initial = published.body.agreement;
  assert.match(initial.contentHash, /^[a-f0-9]{64}$/);
  assert.equal(typeof initial.version, "string");
  assert.ok(initial.title && initial.body && initial.consentLabel);
  assert.equal((await route("/api/auth?action=acceptedAgreement")).status, 401);
  assert.equal((await route("/api/auth?action=acceptedAgreement", { cookie: customer })).body.acceptance, null,
    "Existing accounts must not be treated as having accepted the new agreement");
  assert.equal((await route("/api/admin?action=agreement", { cookie: customer })).status, 403);
  assert.deepEqual((await route("/api/admin?action=agreement", { cookie: owner })).body.agreement, initial);
  const consent = { sourceAgreementAccepted: true, sourceAgreementVersion: initial.version, sourceAgreementHash: initial.contentHash };
  const registration = email => ({ action: "register", name: "Fictional Agreement Signer", email,
    password: "Meadow lantern copper hillside", termsAccepted: true, ...consent });
  const invalidAcceptance = [
    { sourceAgreementAccepted: false },
    { sourceAgreementHash: undefined },
    { sourceAgreementHash: "0".repeat(64) },
  ];
  for (const [index, invalid] of invalidAcceptance.entries()) {
    const email = `agreement-rejected-${index}@example.invalid`;
    const result = await route("/api/auth", { body: { ...registration(email), ...invalid } });
    assert.ok([400, 409].includes(result.status), `Invalid agreement acceptance must be denied, got ${result.status}`);
    assert.equal(await read(auth.userPath(email)), null, "Rejected consent cannot create an account");
    assert.equal(result.cookies.length, 0, "Rejected consent cannot create a session");
  }
  const email = "agreement-accepted@example.invalid";
  const accepted = await route("/api/auth", { body: registration(email) });
  assert.equal(accepted.status, 201);
  assert.equal(Object.hasOwn(accepted.body.user, "sourceAgreementAcceptance"), false);
  const user = (await read(auth.userPath(email))).value;
  const acceptance = structuredClone(user.sourceAgreementAcceptance);
  assert.deepEqual(acceptance.agreement, initial);
  assert.equal(acceptance.accountEmail, email);
  assert.equal(acceptance.signedName, "Fictional Agreement Signer");
  assert.equal(acceptance.signatureMethod, "account-name-checkbox");
  assert.ok(Number.isFinite(Date.parse(acceptance.acceptedAt)));
  const acceptedCookie = accepted.cookies.find(cookie => cookie.startsWith("lineage_session=")).split(";")[0];
  assert.deepEqual((await route("/api/auth?action=acceptedAgreement", { cookie: acceptedCookie })).body.acceptance, acceptance);
  assert.equal((await route(`/api/auth?action=acceptedAgreement&email=${encodeURIComponent(email)}`, { cookie: customer })).body.acceptance, null,
    "An account cannot request another person's signature record");
  const update = { action: "updateAgreement", revision: initial.revision, title: initial.title,
    body: `${initial.body}\n\nSYNTHETIC LOCAL TEST: this new revision exercises consent refresh.`, consentLabel: initial.consentLabel };
  assert.equal((await route("/api/admin", { cookie: customer, body: update })).status, 403);
  assert.equal((await route("/api/admin", { cookie: owner, body: update, suppliedOrigin: "https://other.example.invalid" })).status, 403);
  assert.deepEqual((await route("/api/auth?action=agreement")).body.agreement, initial);
  const changed = await route("/api/admin", { cookie: owner, body: update });
  assert.equal(changed.status, 200);
  const current = changed.body.agreement;
  assert.equal(current.revision, initial.revision + 1);
  assert.notEqual(current.version, initial.version);
  assert.notEqual(current.contentHash, initial.contentHash);
  assert.equal(current.body, update.body);
  assert.deepEqual((await route("/api/auth?action=agreement")).body.agreement, current);
  assert.equal((await route("/api/admin", { cookie: owner, body: update })).status, 409, "A stale editor cannot overwrite a new agreement");
  assert.deepEqual((await route(`/api/auth?action=agreement&version=${encodeURIComponent(initial.version)}`)).body.agreement, initial);
  assert.deepEqual((await read(auth.userPath(email))).value.sourceAgreementAcceptance, acceptance, "Editing an agreement cannot rewrite existing consent");
  const staleEmail = "agreement-stale@example.invalid";
  assert.equal((await route("/api/auth", { body: registration(staleEmail) })).status, 409);
  assert.equal(await read(auth.userPath(staleEmail)), null);
  const refreshed = await route("/api/auth", { body: { ...registration(staleEmail), ...await currentAgreementConsent() } });
  assert.equal(refreshed.status, 201);
  assert.deepEqual((await read(auth.userPath(staleEmail))).value.sourceAgreementAcceptance.agreement, current);
}
async function checkRegistrationAccess(owner) {
  const waiting = await login(accounts[3]), administrator = await login(accounts[4]);
  assert.equal((await route("/api/auth", { cookie: waiting })).body.user.accessStatus, "pending");
  assert.equal((await route("/api/auth?action=security", { cookie: waiting })).status, 200);
  for (const action of ["prepare", "price", "quote", "checkout", "generate"]) {
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
  const register = async email => route("/api/auth", { body: { action: "register", name: "Fictional registration policy check", email,
    password: "Meadow lantern copper hillside", termsAccepted: true, ...await currentAgreementConsent() } });
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
    const priced = await route("/api/studio", { cookie: customer, body: { action: "price", project: checkoutProjects[index],
      preparedId: prepared.body.id, idempotencyKey: `checkout-fixture-price-${index}` } });
    assertPlanningPrice(priced, prepared.body);
    const paymentsBeforeQuote = [...records.values()].filter(record => record.value?.filmId === checkoutProjects[index].id
      && record.value?.merchantBinding);
    assert.equal(paymentsBeforeQuote.length, 0, "Viewing the film price cannot create a billable quote or order");
    const quoted = await route("/api/studio", { cookie: customer, body: { action: "quote", project: checkoutProjects[index], preparedId: prepared.body.id, idempotencyKey: `checkout-fixture-quote-${index}` } });
    assert.equal(quoted.status, 200);
    assert.equal(quoted.body.preparedId, prepared.body.id);
    assert.equal(quoted.body.manifestHash, prepared.body.manifestHash);
    assert.equal(quoted.body.amountCents, priced.body.amountCents);
    assert.equal(quoted.body.sandbox, true);
    const preflight = await route("/api/studio", { cookie: customer, body: { action: "checkoutCheck", quoteId: quoted.body.id, captchaToken: fixtureCaptchaToken("checkout") } });
    assert.equal(preflight.status, 200);
    const body = { action: "checkout", quoteId: quoted.body.id, checkoutProof: preflight.body.checkoutProof, idempotencyKey: `checkout-fixture-charge-${index}`, paymentToken: `fixture_card_${status}`, consent: true };
    const paid = await route("/api/studio", { cookie: customer, body });
    assert.equal(paid.status, 200);
    assert.equal(paid.body.id, quoted.body.orderId);
    assert.equal(paid.body.status, status);
    assert.equal(paid.body.sandbox, true);
    assert.equal(paid.body.amountCents, expectedFixturePriceCents);
    assert.equal(syntheticChargeAmounts[index], expectedFixturePriceCents, "The displayed fixed price must reach the processor unchanged");
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
    if (status === "captured") {
      firstOrder = paid.body; assert.equal(receipt.body.sandbox, true);
      assert.equal(receipt.body.amountCents, expectedFixturePriceCents);
    }
  }
  assert.equal(syntheticCharges, 3);
  assert.ok(firstOrder);
  assert.equal(blockedExternalCalls, 0);
  assert.doesNotMatch(JSON.stringify([...records.values()]), /fixture_card_|4111111111111111|4000000000009995|"cvc"/);
  console.log("PASS: actual-handler fixed $1.41 planning price through checkout, processor and receipt; captured/declined/uncertain outcomes, GET-only recovery, sandbox receipts, ownership, no stored card tokens, and zero outbound calls.");
}
function mediaRoute(path, { cookie, method = "GET", headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(`${origin}${path}`, { method, headers: { ...(cookie ? { Cookie: cookie } : {}), ...headers } }, res => {
      const chunks = [];
      res.on("data", value => chunks.push(value));
      res.on("error", reject);
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, bytes: Buffer.concat(chunks) }));
    });
    req.on("error", reject); req.end();
  });
}
async function checkDelivery() {
  const customer = await login(accounts[0]), other = await login(accounts[2]);
  const preparation = deliveryProject.productionPreparation, payment = deliveryProject.paymentReference;
  const statusUrl = `/api/studio?action=productionStatus&id=${preparation.id}`;
  const mediaUrl = `/api/studio?action=productionMedia&id=${preparation.id}`;
  const status = await route(statusUrl, { cookie: customer });
  assert.equal(status.status, 200); assert.equal(status.body.id, preparation.id);
  assert.equal(status.body.manifestHash, preparation.manifestHash);
  assert.equal(status.body.status, "completed"); assert.equal(status.body.mediaReady, true);
  assert.equal(status.body.completedShots, status.body.shotCount);
  assert.doesNotMatch(JSON.stringify(status.body), /production\/media|vercel-storage|providerJobId/);
  const order = await route(`/api/studio?action=order&id=${payment.orderId}`, { cookie: customer });
  assert.equal(order.status, 200); assert.equal(order.body.status, "captured");
  assert.equal(order.body.preparedId, preparation.id); assert.equal(order.body.quoteId, payment.quoteId);
  assert.equal(order.body.receiptAvailable, true); assert.equal(order.body.sandbox, false);
  assert.equal((await route(`/api/studio?action=receipt&id=${payment.orderId}`, { cookie: customer })).body.sandbox, false);
  assert.equal((await route(statusUrl, { cookie: other })).status, 404);
  const reads = deliveryBlobReads;
  assert.equal((await mediaRoute(mediaUrl)).status, 401);
  assert.equal((await mediaRoute(mediaUrl, { cookie: other })).status, 404);
  assert.equal(deliveryBlobReads, reads, "Unauthorized requests must never reach private media storage");
  const paymentPath = `payments/orders/${payment.orderId}.json`, confirmed = (await read(paymentPath)).value;
  assert.equal(confirmed.syntheticFixture.realPayment, false, "The live-shaped record is fabricated test data, not a real payment");
  for (const patch of [{ status: "awaiting-payment", capturedAt: null }, { status: "uncertain" }, { merchantBinding: simulatedBinding }]) {
    await write(paymentPath, { ...confirmed, ...patch }, (await read(paymentPath)).etag);
    const denied = await mediaRoute(`${mediaUrl}&download=1&paid=true&orderId=${payment.orderId}`, { cookie: customer });
    assert.equal(denied.status, 402); assert.equal(deliveryBlobReads, reads, "Unpaid, uncertain and sandbox payments cannot read generated media");
  }
  await write(paymentPath, confirmed, (await read(paymentPath)).etag);
  const partial = await mediaRoute(mediaUrl, { cookie: customer, headers: { Range: "bytes=0-63" } });
  assert.equal(partial.status, 206); assert.deepEqual(partial.bytes, deliveryMedia.bytes.subarray(0, 64));
  assert.equal(partial.headers["content-range"], `bytes 0-63/${deliveryMedia.bytes.length}`);
  assert.equal(partial.headers["content-length"], "64"); assert.equal(partial.headers["content-type"], "video/mp4");
  assert.equal(partial.headers["cache-control"], "private, no-store"); assert.equal(partial.headers.vary, "Cookie");
  const head = await mediaRoute(mediaUrl, { cookie: customer, method: "HEAD" });
  assert.equal(head.status, 200); assert.equal(head.bytes.length, 0);
  assert.equal(head.headers["content-length"], String(deliveryMedia.bytes.length));
  const invalid = await mediaRoute(mediaUrl, { cookie: customer, headers: { Range: "bytes=0-1,3-4" } });
  assert.equal(invalid.status, 416); assert.equal(invalid.headers["content-range"], `bytes */${deliveryMedia.bytes.length}`);
  const download = await mediaRoute(`${mediaUrl}&download=1`, { cookie: customer });
  assert.equal(download.status, 200); assert.equal(auth.digest(download.bytes), deliveryMedia.sha256);
  assert.equal(download.headers["content-disposition"], `attachment; filename="${preparation.id}.mp4"`);
  assert.equal(blockedExternalCalls, 0); assert.equal(syntheticCharges, 0);
  console.log("PASS: actual-handler completed status, synthetic confirmed live-format payment, unpaid/uncertain/sandbox denial, private MP4 playback/ranges, HEAD, verified download bytes, ownership denial, and zero outbound calls or charges. Media and payment are local fixtures, not new provider output or a real transaction.");
}
if (checkOnly) {
  try { if (deliveryFixture) await checkDelivery(); else if (checkoutFixtures) await checkCheckout(); else await check(); } finally { await close(); }
} else {
  console.log(`Synthetic ${deliveryFixture ? "illustrative playback fixture" : "workflow test"} running at ${origin}. Fictional account helpers: ${origin}/__workflow . No production data or provider calls.`);
}
