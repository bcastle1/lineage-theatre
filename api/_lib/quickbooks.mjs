import { randomBytes, randomUUID, createCipheriv, createDecipheriv, timingSafeEqual } from "node:crypto";
import { digest, readRecord, writeRecord, userPath } from "./auth.mjs";
import { isOwner, OWNER_EMAIL } from "./access.mjs";
import { audit } from "./admin.mjs";
import { INTUIT_PAYMENT_ORIGINS, paymentAuthorizationMatches } from "./payment-authorization.mjs";
import { paymentReadiness } from "./payment-readiness.mjs";

// Verified against Intuit's official oauth-jsclient, src/OAuthClient.js.
// These URLs are never derived from a request, callback query, or environment override.
export const QUICKBOOKS_ORIGIN = "https://lineagetheater.com";
export const QUICKBOOKS_CALLBACK = `${QUICKBOOKS_ORIGIN}/api/quickbooks?action=callback`;
export const INTUIT_AUTHORIZE = "https://appcenter.intuit.com/connect/oauth2";
export const INTUIT_TOKEN = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";
export const INTUIT_REVOKE = "https://developer.api.intuit.com/v2/oauth2/tokens/revoke";
const INTUIT_ACCOUNTING_ORIGINS = Object.freeze({ sandbox: "https://sandbox-quickbooks.api.intuit.com", production: "https://quickbooks.api.intuit.com" });
export const QUICKBOOKS_SCOPES = Object.freeze(["com.intuit.quickbooks.payment", "com.intuit.quickbooks.accounting"]);
export const QUICKBOOKS_CONNECTION_PATH = "integrations/quickbooks/connection.json";
export const QUICKBOOKS_STATE_COOKIE = "__Host-lineage_quickbooks_state";
const STATE_TTL = 10 * 60_000;
const TOKEN_PATTERN = /^[a-f0-9]{64}$/;
const REALM_PATTERN = /^[0-9]{1,30}$/;

// A support correlation ID is useful; bodies, OAuth codes and credentials are not logs.
export function intuitDiagnostic(operation,response,code="HTTP_RESPONSE",at=Date.now()) {
  const raw=response?.headers?.get?.("intuit_tid");
  const intuitTid=typeof raw==="string"&&/^[a-fA-F0-9-]{8,128}$/.test(raw)?raw:null;
  return {operation,at:new Date(at).toISOString(),httpStatus:Number.isInteger(response?.status)?response.status:null,
    intuitTid,code,outcome:response?[200,201,204].includes(response.status)?"response-received":"http-error":"network-or-connection-error"};
}

export async function verifyQuickBooksDiscovery({environment="sandbox",fetchImpl=fetch,now=Date.now}={}) {
  if(!["sandbox","production"].includes(environment))throw new QuickBooksError("Choose a supported connection environment.");
  const url=`https://developer.intuit.com/.well-known/${environment==="sandbox"?"openid_sandbox_configuration":"openid_configuration"}/`;
  const response=await fetchImpl(url,{method:"GET",redirect:"error",signal:AbortSignal.timeout(10_000),headers:{Accept:"application/json"}});
  if(!response.ok)throw new QuickBooksError("The authorization discovery document could not be verified.",503,"QUICKBOOKS_DISCOVERY_UNAVAILABLE");
  const raw=await response.text();if(raw.length>65_536)throw new QuickBooksError("The authorization discovery document could not be verified.",503,"QUICKBOOKS_DISCOVERY_INVALID");
  let data;try{data=JSON.parse(raw);}catch{throw new QuickBooksError("The authorization discovery document could not be verified.",503,"QUICKBOOKS_DISCOVERY_INVALID");}
  if(data.issuer!=="https://oauth.platform.intuit.com/op/v1"||data.authorization_endpoint!==INTUIT_AUTHORIZE
    ||data.token_endpoint!==INTUIT_TOKEN||data.revocation_endpoint!==INTUIT_REVOKE)throw new QuickBooksError("The authorization endpoints changed and need administrator review.",503,"QUICKBOOKS_DISCOVERY_CHANGED");
  return {environment,verifiedAt:new Date(now()).toISOString(),source:url,issuer:data.issuer,authorizationEndpoint:INTUIT_AUTHORIZE,tokenEndpoint:INTUIT_TOKEN,revocationEndpoint:INTUIT_REVOKE};
}

export class QuickBooksError extends Error {
  constructor(message, status = 400, code = "QUICKBOOKS_REQUEST_FAILED") {
    super(message); this.status = status; this.code = code;
  }
}
const setupError = () => new QuickBooksError("QuickBooks connection setup is incomplete. Add the app credentials and a dedicated encryption key on the server.", 503, "QUICKBOOKS_SETUP_REQUIRED");
const conflictError = () => new QuickBooksError("The QuickBooks connection changed. Refresh its status before trying again.", 409, "QUICKBOOKS_CONFLICT");
const callbackError = () => new QuickBooksError("This QuickBooks authorization is expired or no longer current. Start a new connection from Administration.", 400, "QUICKBOOKS_STATE_INVALID");
const stamp = (now) => new Date(now).toISOString();
export const quickbooksStatePath = (state) => `integrations/quickbooks/states/${digest(state)}.json`;

export function quickbooksConfig(env = process.env) {
  const environment = env.QUICKBOOKS_ENVIRONMENT;
  const clientId = env.QUICKBOOKS_CLIENT_ID;
  const clientSecret = env.QUICKBOOKS_CLIENT_SECRET;
  const encodedKey = env.QUICKBOOKS_TOKEN_ENCRYPTION_KEY;
  if (!["sandbox", "production"].includes(environment)
      || typeof clientId !== "string" || !clientId.trim() || clientId.length > 500 || /[\s\x00-\x1f]/.test(clientId)
      || typeof clientSecret !== "string" || !clientSecret.trim() || clientSecret.length > 1000 || /[\r\n]/.test(clientSecret)
      || typeof encodedKey !== "string" || !/^[A-Za-z0-9+/]{43}=$/.test(encodedKey)) throw setupError();
  const key = Buffer.from(encodedKey, "base64");
  if (key.length !== 32 || key.toString("base64") !== encodedKey) throw setupError();
  return { environment, clientId, clientSecret, key, fingerprint: digest(`${environment}:${clientId}`),
    credentialVersion: digest(`${environment}:${clientId}:${clientSecret}:${encodedKey}`) };
}
function sameSecret(left, right) {
  return typeof left === "string" && typeof right === "string" && left.length === right.length
    && timingSafeEqual(Buffer.from(left), Buffer.from(right));
}
function aad(config, secretId, version) { return Buffer.from(`lineage-quickbooks-v${version}:${QUICKBOOKS_CONNECTION_PATH}:${config.fingerprint}:${secretId}`); }
function sealTokenValue(value, config, secretId, version) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", config.key, iv);
  cipher.setAAD(aad(config, secretId, version));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return { version, secretId, iv: iv.toString("base64"), ciphertext: ciphertext.toString("base64"), tag: cipher.getAuthTag().toString("base64") };
}
// Process memory only: never serialize this map into Blob, a database, a
// response, or a log. An exact durable envelope and current credentials are
// required to retrieve its encrypted access token. Cold workers renew by CAS.
const volatileAccessTokens = new Map();
const accessKey = (envelope, config) => digest(`${config.credentialVersion}:${JSON.stringify(envelope)}`);
export function forgetQuickBooksAccessToken(envelope, config) {
  volatileAccessTokens.delete(accessKey(envelope, config));
}
export function readQuickBooksAccessToken(envelope, config, now = Date.now()) {
  const key = accessKey(envelope, config), cached = volatileAccessTokens.get(key);
  if (!cached) return null;
  if (!Number.isFinite(cached.expiresAt) || cached.expiresAt <= now) {
    volatileAccessTokens.delete(key); return null;
  }
  return decryptQuickBooksTokens(cached.encrypted, config).accessToken;
}
export function encryptQuickBooksTokens(value, config, secretId = randomUUID()) {
  // Explicit allowlist prevents new provider fields from persisting credentials.
  const durable = Object.fromEntries(["refreshToken", "tokenType", "realmId", "accessTokenExpiresAt", "refreshTokenExpiresAt",
    "refreshTokenHardExpiresAt", "grantedScopes", "scopeVerification", "realmVerification"].map(key => [key, value[key]]));
  const envelope = sealTokenValue(durable, config, secretId, 2);
  if (typeof value.accessToken === "string") {
    while (volatileAccessTokens.size >= 64) volatileAccessTokens.delete(volatileAccessTokens.keys().next().value);
    volatileAccessTokens.set(accessKey(envelope, config), { expiresAt: Date.parse(value.accessTokenExpiresAt),
      encrypted: sealTokenValue({ accessToken: value.accessToken }, config, randomUUID(), 2) });
  }
  return envelope;
}
export function decryptQuickBooksTokens(envelope, config) {
  try {
    if (![1, 2].includes(envelope?.version) || typeof envelope.secretId !== "string"
        || typeof envelope.ciphertext !== "string" || envelope.ciphertext.length > 65_536) throw new Error();
    const iv = Buffer.from(envelope.iv, "base64"), tag = Buffer.from(envelope.tag, "base64");
    if (iv.length !== 12 || tag.length !== 16) throw new Error();
    const decipher = createDecipheriv("aes-256-gcm", config.key, iv);
    decipher.setAAD(aad(config, envelope.secretId, envelope.version)); decipher.setAuthTag(tag);
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, "base64")), decipher.final()]).toString("utf8"));
  } catch { throw new QuickBooksError("The saved QuickBooks authorization cannot be read. Disconnect it locally and reconnect after checking server setup.", 503, "QUICKBOOKS_TOKEN_UNREADABLE"); }
}
export function quickbooksStateCookie(value, clear = false) {
  return `${QUICKBOOKS_STATE_COOKIE}=${clear ? "" : value}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${clear ? 0 : STATE_TTL / 1000}`;
}
export function readQuickBooksStateCookie(req) {
  const values = String(req.headers.cookie || "").split(";").map(v => v.trim()).filter(v => v.startsWith(`${QUICKBOOKS_STATE_COOKIE}=`));
  if (values.length !== 1) return null;
  const value = values[0].slice(QUICKBOOKS_STATE_COOKIE.length + 1);
  return TOKEN_PATTERN.test(value) ? value : null;
}
export function callbackLocation(result) {
  const safeResult = ["connected", "denied", "error"].includes(result) ? result : "error";
  return `${QUICKBOOKS_ORIGIN}/#admin/payments?quickbooks=${safeResult}`;
}
function validateTokenReply(data, realmId, now) {
  if (!data || typeof data !== "object" || Array.isArray(data)
      || ![data.access_token, data.refresh_token].every(v => typeof v === "string" && v.length >= 8 && v.length <= 16_384 && !/[\s\x00-\x1f]/.test(v))
      || typeof data.token_type !== "string" || data.token_type.toLowerCase() !== "bearer"
      || !Number.isFinite(data.expires_in) || data.expires_in <= 0 || data.expires_in > 86_400)
    throw new QuickBooksError("Intuit did not return a usable authorization. No payment connection was enabled.", 502, "QUICKBOOKS_TOKEN_INVALID");
  if (data.realmId !== undefined && String(data.realmId) !== realmId)
    throw new QuickBooksError("Intuit returned a different company reference. No payment connection was enabled.", 502, "QUICKBOOKS_REALM_MISMATCH");
  let grantedScopes = null;
  if (data.scope !== undefined) {
    if (typeof data.scope !== "string") throw new QuickBooksError("Intuit returned invalid authorization scopes.", 502, "QUICKBOOKS_SCOPE_INVALID");
    grantedScopes = [...new Set(data.scope.trim().split(/\s+/))].sort();
    if (grantedScopes.length !== QUICKBOOKS_SCOPES.length || QUICKBOOKS_SCOPES.some(scope => !grantedScopes.includes(scope)))
      throw new QuickBooksError("Intuit did not grant exactly the requested Payments and Accounting access. Reconnect from Administration.", 502, "QUICKBOOKS_SCOPE_INVALID");
  }
  return {
    accessToken: data.access_token, refreshToken: data.refresh_token, tokenType: "Bearer", realmId,
    accessTokenExpiresAt: stamp(now + data.expires_in * 1000),
    refreshTokenExpiresAt: tokenExpiry(data.x_refresh_token_expires_in, now),
    refreshTokenHardExpiresAt: tokenExpiry(data.x_refresh_token_hard_expires_in, now),
    grantedScopes, scopeVerification: grantedScopes ? "token-response" : "not-returned",
    realmVerification: data.realmId !== undefined ? "token-response-matched" : "callback-only",
  };
}
function tokenExpiry(seconds, now) {
  if (seconds === undefined) return null;
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 10 * 366 * 86_400)
    throw new QuickBooksError("Intuit returned an invalid token expiry. The authorization needs review.", 502, "QUICKBOOKS_TOKEN_INVALID");
  return stamp(now + seconds * 1000);
}
function checkRevision(record, expectedRevision) {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || expectedRevision !== (record?.value.revision ?? 0)) throw conflictError();
}
function companyFields(data) {
  const company = data?.CompanyInfo;
  const invalid = () => new QuickBooksError("Intuit did not return usable company information. The saved authorization was not changed.", 502, "QUICKBOOKS_COMPANY_INVALID");
  if (!company || typeof company !== "object" || Array.isArray(company) || data.Fault || (company.domain !== undefined && company.domain !== "QBO")) throw invalid();
  const field = (name, max, required = false) => {
    const value = company[name];
    if (!required && (value === undefined || value === null || value === "")) return null;
    if (typeof value !== "string" || !value.trim() || value.length > max || /[\x00-\x1f\x7f]/.test(value)) throw invalid();
    return value.trim();
  };
  // CompanyInfo.Id can be the entity ID "1", not the OAuth realm. Identity is
  // established by the authenticated saved-realm route, never by that field.
  return { companyName: field("CompanyName", 1024, true), legalName: field("LegalName", 1024), country: field("Country", 80) };
}

export function createQuickBooksService(overrides = {}) {
  const { read = readRecord, write = writeRecord, fetchImpl = fetch, now = Date.now,
    env = process.env, auditImpl = audit } = overrides;
  const configFor = () => quickbooksConfig(env);
  async function observedFetch(operation,...args) {
    let response;
    try {response=await fetchImpl(...args);}
    catch(error) {
      try{await auditImpl(OWNER_EMAIL,"quickbooks.provider.request","merchant-connection",intuitDiagnostic(operation,null,"NETWORK_ERROR",now()));}catch{}
      throw error;
    }
    try{await auditImpl(OWNER_EMAIL,"quickbooks.provider.request","merchant-connection",intuitDiagnostic(operation,response,"HTTP_RESPONSE",now()));}catch{}
    return response;
  }
  async function saveConnection(previous, value) {
    let result;
    try { result = await write(QUICKBOOKS_CONNECTION_PATH, value, previous?.etag); }
    catch { throw conflictError(); }
    // The successful conditional put is authoritative; use its ETag so an
    // unrelated read failure cannot turn a confirmed save into an ambiguous one.
    if (typeof result?.etag === "string" && result.etag) return { value, etag: result.etag };
    const saved = await read(QUICKBOOKS_CONNECTION_PATH);
    if (!saved || saved.value.revision !== value.revision || saved.value.changeId !== value.changeId) throw conflictError();
    return saved;
  }
  async function ownerStillValid(email, version) {
    const account = await read(userPath(email));
    if (!account || !isOwner(account.value) || account.value.mustChangePassword || !sameSecret(digest(account.value.passwordHash || ""), version)) throw callbackError();
    return account.value;
  }
  async function status() {
    let config;
    try { config = configFor(); } catch { /* Return setup state without revealing values. */ }
    const record = await read(QUICKBOOKS_CONNECTION_PATH), value = record?.value;
    const output = {
      provider: "quickbooks", configured: Boolean(config), environment: config?.environment || null,
      authorizationStatus: config ? "disconnected" : "not-configured", connected: false,
      hasSavedAuthorization: Boolean(value?.encryptedTokens), remoteReviewRequired: Boolean(value?.remoteReviewRequired),
      refreshStatus: value?.refreshOperation ? "refreshing" : value?.refreshStatus || "idle", lastRefreshedAt: value?.lastRefreshedAt || null,
      revision: value?.revision ?? 0, pending: Boolean(value?.pending && (value.pending.stage === "exchanging" || Date.parse(value.pending.expiresAt) > now())),
      lastConnectedAt: value?.connectedAt || null, tokenExpiresAt: null, realmId: null,
      requestedScopes: [...QUICKBOOKS_SCOPES], grantedScopes: null, scopeVerification: "not-returned",
      realmVerification: "unverified", revocationStatus: value?.revocationStatus || "not-requested",
      companyVerification: null,
      accessTokenStorage: value?.encryptedTokens ? value.encryptedTokens.version === 2 ? "memory-only" : "migration-required" : "none",
      accessTokenAvailable: false,
      paymentReady: false, refundReady: false, callbackUrl: QUICKBOOKS_CALLBACK,
      message: config ? "QuickBooks is not connected. Customer payments and refunds remain unavailable." : setupError().message,
    };
    const configurationChanged = Boolean(config && value?.fingerprint && (value.fingerprint !== config.fingerprint
      || (value.credentialVersion && value.credentialVersion !== config.credentialVersion)));
    if (configurationChanged) {
      output.authorizationStatus = "configuration-changed";
      output.message = "The configured QuickBooks app, environment or credentials have changed. Reconcile the saved authorization and server setup before reconnecting; payments remain unavailable.";
    }
    if (config && !configurationChanged && value?.status === "authorized" && value.encryptedTokens) {
      try {
        const token = decryptQuickBooksTokens(value.encryptedTokens, config);
        output.realmId = token.realmId; output.grantedScopes = token.grantedScopes;
        output.scopeVerification = token.scopeVerification; output.realmVerification = token.realmVerification;
        output.tokenExpiresAt = token.accessTokenExpiresAt;
        output.accessTokenAvailable = Boolean(readQuickBooksAccessToken(value.encryptedTokens, config, now()));
        const expired = !Number.isFinite(Date.parse(token.accessTokenExpiresAt)) || Date.parse(token.accessTokenExpiresAt) <= now();
        output.connected = !expired && output.accessTokenStorage === "memory-only"; output.authorizationStatus = expired ? "expired" : "authorized";
        output.message = expired
          ? "The previous access token has expired. Renew authorization before checking the company; customer checkout remains unavailable."
          : "Intuit authorization is saved. Access tokens are held only in server memory and renewed when needed. Customer payments and refunds remain unavailable.";
        if (output.accessTokenStorage === "migration-required") output.message = "Refresh authorization to remove the legacy stored access token and use memory-only access tokens. Payments remain unavailable.";
      } catch { output.authorizationStatus = "needs-attention"; output.message = "The saved authorization cannot be read. Disconnect it locally and check server setup before reconnecting."; }
    }
    if (output.pending) { output.connected = false; output.authorizationStatus = "authorizing"; output.message = "An owner authorization is in progress. Customer payments and refunds remain unavailable."; }
    if (value?.revocationStatus === "pending" || value?.remoteCleanup?.status === "pending") {
      output.connected = false; output.pending = true; output.message = "Local access is disabled while Intuit revocation is being checked.";
    }
    if (value?.refreshOperation) {
      output.connected = false; output.pending = true; output.authorizationStatus = "authorizing";
      output.message = "A token refresh is being verified. The saved tokens cannot be used until that operation completes.";
    } else if (value?.status === "refresh-blocked") {
      output.connected = false; output.authorizationStatus = "needs-attention";
      output.message = "Token refresh is blocked. Review the connection and server configuration before disconnecting and reconnecting.";
    }
    if (output.remoteReviewRequired) {
      output.connected = false; output.authorizationStatus = "needs-attention";
      output.message = "A previous Intuit operation could not be verified. Review the app in Intuit connected apps and contact the administrator to reconcile the connection before starting another authorization.";
    }
    const evidence = value?.companyVerification;
    if (output.connected && !output.pending && evidence && evidence.credentialVersion === config?.credentialVersion
        && evidence.tokenVersion === digest(JSON.stringify(value.encryptedTokens)) && Number.isFinite(Date.parse(evidence.verifiedAt))) {
      output.companyVerification = { verifiedAt: evidence.verifiedAt, companyName: evidence.companyName,
        legalName: evidence.legalName, country: evidence.country, accountingAccessVerified: true };
      output.message = "Accounting access to the connected company was verified. Merchant readiness and customer payments or refunds remain unverified and unavailable.";
    }
    return output;
  }
  async function verifyCompany(actor, body = {}) {
    try {
      if (!isOwner(actor) || actor.mustChangePassword) throw new QuickBooksError("Only the owner with a completed password setup can verify the QuickBooks company.", 403);
      const config = configFor(); let previous = await read(QUICKBOOKS_CONNECTION_PATH);
      checkRevision(previous, body.expectedRevision);
      let value = previous?.value;
      if (value?.status !== "authorized" || !value?.encryptedTokens || value.pending || value.refreshOperation
          || value.remoteReviewRequired || value.revocationStatus === "pending" || value.remoteCleanup?.status === "pending")
        throw new QuickBooksError("The QuickBooks connection is not ready for a company check. Refresh its status first.", 409, "QUICKBOOKS_COMPANY_BLOCKED");
      if (value.fingerprint !== config.fingerprint || (value.credentialVersion && value.credentialVersion !== config.credentialVersion))
        throw new QuickBooksError("QuickBooks server credentials changed. Reconcile the saved authorization before checking the company.", 409, "QUICKBOOKS_CONFIGURATION_CHANGED");
      if (value.encryptedTokens.version !== 2) throw new QuickBooksError("Refresh authorization to update token storage before checking the company.", 409, "QUICKBOOKS_STORAGE_MIGRATION_REQUIRED");
      let token = decryptQuickBooksTokens(value.encryptedTokens, config);
      if (typeof token.realmId !== "string" || !REALM_PATTERN.test(token.realmId))
        throw new QuickBooksError("The saved QuickBooks company reference is invalid.", 409, "QUICKBOOKS_REALM_MISMATCH");
      if (token.grantedScopes != null && (!Array.isArray(token.grantedScopes) || !token.grantedScopes.includes("com.intuit.quickbooks.accounting")))
        throw new QuickBooksError("The saved authorization does not include Accounting access.", 403, "QUICKBOOKS_SCOPE_INVALID");
      const validAccess = () => Number.isFinite(Date.parse(token.accessTokenExpiresAt)) && Date.parse(token.accessTokenExpiresAt) > now();
      if (!validAccess()) throw new QuickBooksError("The previous access token expired. Refresh authorization before checking the company.", 409, "QUICKBOOKS_ACCESS_EXPIRED");
      const passwordVersion = digest(actor.passwordHash || "");
      await ownerStillValid(actor.email, passwordVersion);
      if (!readQuickBooksAccessToken(value.encryptedTokens, config, now())) {
        const authorizationAttemptId = value.authorizationAttemptId;
        await refresh(actor, { expectedRevision: value.revision });
        previous = await read(QUICKBOOKS_CONNECTION_PATH); value = previous?.value;
        if (value?.status !== "authorized" || value.pending || value.refreshOperation || value.remoteReviewRequired
            || !value.encryptedTokens || value.authorizationAttemptId !== authorizationAttemptId
            || value.fingerprint !== config.fingerprint || value.credentialVersion !== config.credentialVersion)
          throw conflictError();
      }
      token = { ...decryptQuickBooksTokens(value.encryptedTokens, config), accessToken: readQuickBooksAccessToken(value.encryptedTokens, config, now()) };
      const tokenVersion = digest(JSON.stringify(value.encryptedTokens));
      if (typeof token.accessToken !== "string" || token.accessToken.length < 8 || token.accessToken.length > 16_384 || /[\s\x00-\x1f]/.test(token.accessToken))
        throw new QuickBooksError("The saved QuickBooks access token cannot be used for a company check.", 409, "QUICKBOOKS_TOKEN_INVALID");
      await ownerStillValid(actor.email, passwordVersion);
      const response = await observedFetch("company-read",`${INTUIT_ACCOUNTING_ORIGINS[config.environment]}/v3/company/${token.realmId}/companyinfo/${token.realmId}`, {
        method: "GET", redirect: "error", signal: AbortSignal.timeout(15_000), headers: { Authorization: `Bearer ${token.accessToken}`, Accept: "application/json" },
      });
      if (response.status !== 200 || !/^application\/json(?:\s*;|$)/i.test(response.headers.get("content-type") || ""))
        throw new QuickBooksError("Intuit did not complete the company check. The saved authorization was not changed.", 502, "QUICKBOOKS_COMPANY_UNAVAILABLE");
      const raw = await response.text();
      if (raw.length > 65_536) throw new QuickBooksError("Intuit returned too much company information to verify safely.", 502, "QUICKBOOKS_COMPANY_INVALID");
      const fields = companyFields(JSON.parse(raw));
      // Never propagate accidentally echoed bearer/refresh/client secrets, even
      // if a provider response places them inside an otherwise allowed field.
      const secrets = [token.accessToken, token.refreshToken, config.clientSecret, config.key.toString("base64")];
      if (Object.values(fields).some(text => text && secrets.some(secret => typeof secret === "string" && text.includes(secret))))
        throw new QuickBooksError("Intuit returned company information that cannot be displayed safely.", 502, "QUICKBOOKS_COMPANY_INVALID");
      await ownerStillValid(actor.email, passwordVersion);
      if (!validAccess()) throw new QuickBooksError("The access token expired during the company check. No verification was saved.", 409, "QUICKBOOKS_ACCESS_EXPIRED");
      if (!sameSecret(configFor().credentialVersion, config.credentialVersion)) throw new QuickBooksError("QuickBooks configuration changed during the company check.", 409, "QUICKBOOKS_CONFIGURATION_CHANGED");
      const current = await read(QUICKBOOKS_CONNECTION_PATH);
      if (!current || current.etag !== previous.etag || current.value.revision !== value.revision
          || digest(JSON.stringify(current.value.encryptedTokens)) !== tokenVersion) throw conflictError();
      const revision = value.revision + 1;
      await saveConnection(previous, { ...value, revision, changeId: randomUUID(),
        companyVerification: { ...fields, verifiedAt: stamp(now()), credentialVersion: config.credentialVersion, tokenVersion }, updatedAt: stamp(now()) });
      await auditImpl(actor.email, "quickbooks.company.verified", "merchant-connection", { environment: config.environment, revision, accountingAccessVerified: true });
      return await status();
    } catch (error) {
      if (error instanceof QuickBooksError) throw error;
      throw new QuickBooksError("The company check could not be verified. Refresh its status before trying again; no payment was enabled.", 502, "QUICKBOOKS_COMPANY_UNAVAILABLE");
    }
  }
  async function start(actor, body) {
    if (!isOwner(actor) || actor.mustChangePassword) throw new QuickBooksError("Only the owner with a completed password setup can connect QuickBooks.", 403);
    const config = configFor(), previous = await read(QUICKBOOKS_CONNECTION_PATH);
    checkRevision(previous, body.expectedRevision);
    const value = previous?.value;
    if (value?.pending?.stage === "exchanging" || value?.refreshOperation || value?.revocationStatus === "pending" || value?.remoteCleanup?.status === "pending")
      throw new QuickBooksError("A QuickBooks connection operation is still being verified. Refresh before starting another.", 409, "QUICKBOOKS_BUSY");
    if (value?.remoteReviewRequired)
      throw new QuickBooksError("Review the previous grant in Intuit connected apps and reconcile the connection with the administrator before authorizing again.", 409, "QUICKBOOKS_REMOTE_REVIEW_REQUIRED");
    if (value?.encryptedTokens)
      throw new QuickBooksError("Disconnect the saved QuickBooks authorization before reconnecting.", 409, "QUICKBOOKS_DISCONNECT_REQUIRED");
    const state = randomBytes(32).toString("hex"), browserSecret = randomBytes(32).toString("hex"), attemptId = randomUUID();
    const revision = (value?.revision || 0) + 1, expiresAt = stamp(now() + STATE_TTL);
    const stateRecord = { version: 1, ownerEmail: actor.email, passwordVersion: digest(actor.passwordHash || ""),
      browserHash: digest(browserSecret), fingerprint: config.fingerprint, environment: config.environment,
      attemptId, connectionRevision: revision, createdAt: stamp(now()), expiresAt, consumedAt: null };
    // The state is useless until the connection CAS selects it as the current attempt.
    await write(quickbooksStatePath(state), stateRecord);
    await saveConnection(previous, { ...value, revision, changeId: attemptId, status: value?.status || "disconnected",
      pending: { attemptId, stateHash: digest(state), expiresAt, stage: "authorizing" }, updatedAt: stamp(now()) });
    await auditImpl(actor.email, "quickbooks.authorization.started", "merchant-connection", { environment: config.environment, revision });
    const url = new URL(INTUIT_AUTHORIZE);
    url.search = new URLSearchParams({ client_id: config.clientId, response_type: "code", redirect_uri: QUICKBOOKS_CALLBACK,
      scope: QUICKBOOKS_SCOPES.join(" "), state }).toString();
    return { authorizationUrl: url.toString(), stateCookie: quickbooksStateCookie(browserSecret), revision, expiresAt };
  }
  async function clearPending(attemptId) {
    const current = await read(QUICKBOOKS_CONNECTION_PATH);
    if (current?.value.pending?.attemptId !== attemptId) return;
    try { await saveConnection(current, { ...current.value, revision: current.value.revision + 1, changeId: randomUUID(), pending: null, updatedAt: stamp(now()) }); }
    catch { /* A newer connection operation owns the record. */ }
  }
  async function revokeToken(token, config) {
    try {
      const response = await observedFetch("token-revoke",INTUIT_REVOKE, { method: "POST", redirect: "error", signal: AbortSignal.timeout(15_000),
        headers: { Authorization: `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64")}`,
          Accept: "application/json", "Content-Type": "application/json" }, body: JSON.stringify({ token }) });
      return response.ok ? "confirmed" : "unconfirmed";
    } catch { return "unconfirmed"; }
  }
  async function failedExchangeCleanup(attempt, token, config, exchangeSent) {
    if (!exchangeSent) { await clearPending(attempt.attemptId); return; }
    let current = await read(QUICKBOOKS_CONNECTION_PATH);
    const matches = entry => {
      if (!entry || entry.value.refreshOperation || entry.value.lastRefreshAttemptId) return false;
      if (entry.value.pending) return entry.value.pending.attemptId === attempt.attemptId;
      if (entry.value.remoteCleanup) return entry.value.remoteCleanup.attemptId === attempt.attemptId;
      return entry.value.status === "authorized" && entry.value.authorizationAttemptId === attempt.attemptId;
    };
    if (!matches(current)) return; // A refresh or newer authorization now owns this grant.
    // Claim and disable this exact generation before revocation. The final
    // authorization put may have committed even when its response was lost.
    const { encryptedTokens: removed, ...rest } = current.value;
    await saveConnection(current, { ...rest, revision: current.value.revision + 1, changeId: randomUUID(), status: "disconnected",
      pending: null, remoteCleanup: { attemptId: attempt.attemptId, status: "pending" }, updatedAt: stamp(now()) });
    const result = token ? await revokeToken(token, config) : "unconfirmed";
    current = await read(QUICKBOOKS_CONNECTION_PATH);
    if (!matches(current)) return;
    await saveConnection(current, { ...current.value, revision: current.value.revision + 1, changeId: randomUUID(),
      remoteCleanup: { attemptId: attempt.attemptId, status: result },
      remoteReviewRequired: current.value.remoteReviewRequired || result !== "confirmed", updatedAt: stamp(now()) });
    await auditImpl(attempt.ownerEmail, "quickbooks.authorization.cleanup", "merchant-connection", { revocationStatus: result, remoteReviewRequired: result !== "confirmed" });
  }
  async function callback(query, browserSecret) {
    const config = configFor();
    const state = query.get("state");
    if (!TOKEN_PATTERN.test(state || "") || !TOKEN_PATTERN.test(browserSecret || "")
        || ["state", "code", "realmId", "error"].some(key => query.getAll(key).length > 1)) throw callbackError();
    const stored = await read(quickbooksStatePath(state)), value = stored?.value;
    if (!value || value.consumedAt || Date.parse(value.expiresAt) <= now() || !Number.isFinite(Date.parse(value.expiresAt))
        || value.fingerprint !== config.fingerprint || value.environment !== config.environment
        || value.ownerEmail !== OWNER_EMAIL || !sameSecret(value.browserHash, digest(browserSecret))) throw callbackError();
    await ownerStillValid(value.ownerEmail, value.passwordVersion);
    const connection = await read(QUICKBOOKS_CONNECTION_PATH);
    if (connection?.value.revision !== value.connectionRevision || connection?.value.pending?.attemptId !== value.attemptId
        || connection.value.pending.stateHash !== digest(state)) throw callbackError();
    // Claim before any provider request: losing callbacks never exchange or retry a code.
    try { await write(quickbooksStatePath(state), { ...value, consumedAt: stamp(now()) }, stored.etag); }
    catch { throw callbackError(); }
    if (query.has("error")) { await clearPending(value.attemptId); return { result: "denied" }; }
    const code = query.get("code"), realmId = query.get("realmId");
    if (typeof code !== "string" || code.length < 1 || code.length > 4096 || /[\x00-\x20]/.test(code) || !REALM_PATTERN.test(realmId || "")) {
      await clearPending(value.attemptId); throw callbackError();
    }
    let locked, acquiredToken = null, exchangeSent = false, persisted = false;
    try {
      locked = await saveConnection(connection, { ...connection.value, revision: connection.value.revision + 1, changeId: randomUUID(),
        pending: { ...connection.value.pending, stage: "exchanging" }, updatedAt: stamp(now()) });
      exchangeSent = true;
      const response = await observedFetch("token-exchange",INTUIT_TOKEN, { method: "POST", redirect: "error", signal: AbortSignal.timeout(15_000),
        headers: { Authorization: `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64")}`,
          Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded", "x-include-refresh-token-hard-expires-in": "true" },
        body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: QUICKBOOKS_CALLBACK }).toString() });
      if (!response.ok) throw new QuickBooksError("Intuit authorization could not be completed. Refresh the connection status and start again; no payment was enabled.", 502, "QUICKBOOKS_EXCHANGE_FAILED");
      const raw = await response.text();
      if (raw.length > 65_536) throw new Error("Oversized provider response");
      const data = JSON.parse(raw);
      acquiredToken = [data?.refresh_token, data?.access_token].find(v => typeof v === "string" && v.length >= 8 && v.length <= 16_384 && !/[\s\x00-\x1f]/.test(v)) || null;
      const token = validateTokenReply(data, realmId, now());
      await ownerStillValid(value.ownerEmail, value.passwordVersion);
      const revision = locked.value.revision + 1;
      await saveConnection(locked, { version: 1, revision, changeId: randomUUID(), status: "authorized", environment: config.environment,
        fingerprint: config.fingerprint, credentialVersion: config.credentialVersion, authorizationAttemptId: value.attemptId, encryptedTokens: encryptQuickBooksTokens(token, config), connectedAt: stamp(now()),
        connectedBy: value.ownerEmail, updatedAt: stamp(now()), pending: null, revocationStatus: "not-requested" });
      persisted = true;
      await auditImpl(value.ownerEmail, "quickbooks.authorization.saved", "merchant-connection", { environment: config.environment, revision,
        scopeVerification: token.scopeVerification, realmVerification: token.realmVerification });
      return { result: "connected" };
    } catch (error) {
      if (!persisted) await failedExchangeCleanup(value, acquiredToken, config, exchangeSent);
      if (error instanceof QuickBooksError) throw error;
      throw new QuickBooksError("Intuit authorization could not be verified. Refresh the connection status before starting again; no payment was enabled.", 502, "QUICKBOOKS_EXCHANGE_UNCERTAIN");
    }
  }
  async function settleRefreshFailure(attemptId, actor, originalToken, acquiredToken, config, outcome) {
    let current = await read(QUICKBOOKS_CONNECTION_PATH);
    const matches = entry => {
      if (!entry) return false;
      if (entry.value.refreshOperation) return entry.value.refreshOperation.attemptId === attemptId;
      if (entry.value.remoteCleanup) return entry.value.remoteCleanup.attemptId === attemptId;
      return entry.value.status === "authorized" && entry.value.lastRefreshAttemptId === attemptId;
    };
    if (!matches(current)) return; // A newer operation has already disposed of this saved generation.
    // A final put may have committed even when its response was lost. Lock that
    // exact generation before revoking it; never revoke an unrelated newer grant.
    if (current.value.lastRefreshAttemptId === attemptId && !current.value.refreshOperation && !current.value.remoteCleanup) {
      current = await saveConnection(current, { ...current.value, revision: current.value.revision + 1, changeId: randomUUID(), status: "refreshing",
        refreshOperation: { attemptId, stage: "cleanup" }, updatedAt: stamp(now()) });
    }
    const cancelled = current.value.remoteCleanup?.attemptId === attemptId;
    let revocation = null;
    if (acquiredToken || cancelled) revocation = await revokeToken(acquiredToken || originalToken, config);
    current = await read(QUICKBOOKS_CONNECTION_PATH);
    if (!matches(current)) return;
    // Re-read cancellation after the provider request: disconnect may have
    // removed the local pair while this attempt was cleaning up.
    const disconnected = current.value.remoteCleanup?.attemptId === attemptId;
    if (disconnected && !revocation) revocation = await revokeToken(originalToken, config);
    const uncertain = outcome === "uncertain" || revocation === "unconfirmed";
    const removeTokens = Boolean(acquiredToken || disconnected);
    const { encryptedTokens, ...rest } = current.value;
    await saveConnection(current, { ...rest, ...(!removeTokens && encryptedTokens ? { encryptedTokens } : {}),
      revision: current.value.revision + 1, changeId: randomUUID(), status: removeTokens ? "disconnected" : "refresh-blocked",
      refreshOperation: null, refreshStatus: uncertain ? "uncertain" : outcome,
      ...(disconnected || acquiredToken ? { remoteCleanup: { attemptId, status: uncertain ? "unconfirmed" : "confirmed" },
        revocationStatus: revocation || "unconfirmed" } : {}),
      remoteReviewRequired: Boolean(current.value.remoteReviewRequired || uncertain), updatedAt: stamp(now()) });
    await auditImpl(actor.email, "quickbooks.refresh.failed", "merchant-connection", { outcome, revocationStatus: revocation, remoteReviewRequired: uncertain });
  }
  async function refresh(actor, body = {}) {
    try { return await performRefresh(actor, body); }
    catch (error) {
      if (error instanceof QuickBooksError) throw error;
      throw new QuickBooksError("QuickBooks refresh could not be verified. Review connection status before another operation; no automatic retry was sent.", 502, "QUICKBOOKS_REFRESH_UNCERTAIN");
    }
  }
  async function performRefresh(actor, body) {
    if (!isOwner(actor) || actor.mustChangePassword) throw new QuickBooksError("Only the owner with a completed password setup can refresh QuickBooks.", 403);
    const config = configFor(); let previous = await read(QUICKBOOKS_CONNECTION_PATH);
    checkRevision(previous, body.expectedRevision);
    let value = previous?.value;
    if (value?.refreshOperation || value?.pending || value?.revocationStatus === "pending" || value?.remoteCleanup?.status === "pending")
      throw new QuickBooksError("A QuickBooks connection operation is still being verified.", 409, "QUICKBOOKS_BUSY");
    if (value?.remoteReviewRequired || value?.status !== "authorized" || !value?.encryptedTokens)
      throw new QuickBooksError("The QuickBooks authorization cannot be refreshed. Review its status before reconnecting.", 409, "QUICKBOOKS_REFRESH_BLOCKED");
    if (value.fingerprint !== config.fingerprint || (value.credentialVersion && value.credentialVersion !== config.credentialVersion))
      throw new QuickBooksError("QuickBooks server credentials changed. Reconcile the saved authorization before refreshing.", 409, "QUICKBOOKS_CONFIGURATION_CHANGED");
    const token = decryptQuickBooksTokens(value.encryptedTokens, config), passwordVersion = digest(actor.passwordHash || "");
    await ownerStillValid(actor.email, passwordVersion);
    if (value.encryptedTokens.version !== 2) {
      previous = await saveConnection(previous, { ...value, revision: value.revision + 1, changeId: randomUUID(),
        encryptedTokens: encryptQuickBooksTokens(token, config), companyVerification: null, updatedAt: stamp(now()) });
      value = previous.value;
      await auditImpl(actor.email, "quickbooks.storage.migrated", "merchant-connection", { accessTokenStorage: "memory-only", revision: value.revision });
    }
    if (readQuickBooksAccessToken(value.encryptedTokens, config, now()) && Date.parse(token.accessTokenExpiresAt) > now() + 60_000)
      return { ...(await status()), refreshed: false };
    const refreshExpiry = Date.parse(token.refreshTokenExpiresAt), hardExpiry = token.refreshTokenHardExpiresAt ? Date.parse(token.refreshTokenHardExpiresAt) : null;
    if (!Number.isFinite(refreshExpiry) || refreshExpiry <= now() || (hardExpiry !== null && (!Number.isFinite(hardExpiry) || hardExpiry <= now()))) {
      await saveConnection(previous, { ...value, revision: value.revision + 1, changeId: randomUUID(), status: "refresh-blocked",
        refreshStatus: "reconnect-required", updatedAt: stamp(now()) });
      throw new QuickBooksError("The refresh token expiry cannot be validated or has passed. Disconnect and reconnect QuickBooks.", 409, "QUICKBOOKS_REFRESH_EXPIRED");
    }
    const attemptId = randomUUID();
    const locked = await saveConnection(previous, { ...value, revision: value.revision + 1, changeId: randomUUID(), status: "refreshing",
      refreshOperation: { attemptId, stage: "exchanging", startedAt: stamp(now()) }, updatedAt: stamp(now()) });
    let acquiredToken = null, persisted = false, outcome = "uncertain";
    try {
      const response = await observedFetch("token-refresh",INTUIT_TOKEN, { method: "POST", redirect: "error", signal: AbortSignal.timeout(15_000),
        headers: { Authorization: `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64")}`,
          Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded", "x-include-refresh-token-hard-expires-in": "true" },
        body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: token.refreshToken }).toString() });
      const raw = await response.text();
      if (raw.length > 65_536) throw new Error("Oversized provider response");
      const data = JSON.parse(raw);
      if (!response.ok) {
        if ([400, 401].includes(response.status) && data?.error === "invalid_grant") outcome = "reconnect-required";
        if ([400, 401].includes(response.status) && ["invalid_client", "unauthorized_client"].includes(data?.error)) outcome = "credentials-rejected";
        throw new QuickBooksError("Intuit did not complete token refresh. Review the connection status; no automatic retry was sent.", 502, "QUICKBOOKS_REFRESH_FAILED");
      }
      acquiredToken = [data?.refresh_token, data?.access_token].find(v => typeof v === "string" && v.length >= 8 && v.length <= 16_384 && !/[\s\x00-\x1f]/.test(v)) || null;
      if (acquiredToken) outcome = "reconnect-required";
      const rotated = validateTokenReply(data, token.realmId, now());
      if (data.scope === undefined) { rotated.grantedScopes = token.grantedScopes; rotated.scopeVerification = token.scopeVerification; }
      if (data.realmId === undefined) rotated.realmVerification = token.realmVerification;
      if (data.x_refresh_token_expires_in === undefined) rotated.refreshTokenExpiresAt = token.refreshTokenExpiresAt;
      // A hard expiry is an absolute limit, not a rolling lifetime. Never extend
      // a known deadline or erase it when the provider omits the optional field.
      if (hardExpiry !== null) rotated.refreshTokenHardExpiresAt = stamp(Math.min(hardExpiry,
        rotated.refreshTokenHardExpiresAt ? Date.parse(rotated.refreshTokenHardExpiresAt) : hardExpiry));
      if (Date.parse(rotated.refreshTokenExpiresAt) <= now() || (rotated.refreshTokenHardExpiresAt && Date.parse(rotated.refreshTokenHardExpiresAt) <= now()))
        throw new QuickBooksError("The refreshed authorization has already expired.", 502, "QUICKBOOKS_TOKEN_INVALID");
      await ownerStillValid(actor.email, passwordVersion);
      if (!sameSecret(configFor().credentialVersion, config.credentialVersion)) throw new QuickBooksError("QuickBooks server configuration changed during refresh.", 409, "QUICKBOOKS_CONFIGURATION_CHANGED");
      await saveConnection(locked, { ...locked.value, revision: locked.value.revision + 1, changeId: randomUUID(), status: "authorized",
        credentialVersion: config.credentialVersion, encryptedTokens: encryptQuickBooksTokens(rotated, config),
        refreshOperation: null, lastRefreshAttemptId: attemptId, refreshStatus: "refreshed", lastRefreshedAt: stamp(now()), updatedAt: stamp(now()) });
      persisted = true;
      forgetQuickBooksAccessToken(value.encryptedTokens, config);
      await auditImpl(actor.email, "quickbooks.refresh.saved", "merchant-connection", { environment: config.environment, revision: locked.value.revision + 1 });
      return { ...(await status()), refreshed: true };
    } catch (error) {
      if (!persisted) {
        try { await settleRefreshFailure(attemptId, actor, token.refreshToken, acquiredToken, config, outcome); }
        catch { /* The durable operation remains blocked if reconciliation storage is unavailable. */ }
      }
      if (error instanceof QuickBooksError) throw error;
      throw new QuickBooksError("QuickBooks refresh could not be verified. Review connection status before another operation; no automatic retry was sent.", 502, "QUICKBOOKS_REFRESH_UNCERTAIN");
    }
  }
  async function disconnect(actor, body) {
    if (!isOwner(actor) || actor.mustChangePassword) throw new QuickBooksError("Only the owner with a completed password setup can disconnect QuickBooks.", 403);
    const previous = await read(QUICKBOOKS_CONNECTION_PATH);
    checkRevision(previous, body.expectedRevision);
    const value = previous?.value, revision = (value?.revision || 0) + 1;
    if (value?.revocationStatus === "pending" || value?.remoteCleanup?.status === "pending") throw new QuickBooksError("A disconnect is still being verified. Refresh its status before trying again.", 409, "QUICKBOOKS_BUSY");
    // Remove local tokens and invalidate in-flight callbacks before contacting Intuit.
    const disconnectId = randomUUID(), deferredRefresh = value?.refreshOperation;
    await saveConnection(previous, { version: 1, revision, changeId: randomUUID(), disconnectId, status: "disconnected", pending: null,
      connectedAt: value?.connectedAt || null, updatedAt: stamp(now()), disconnectedAt: stamp(now()),
      remoteCleanup: deferredRefresh ? { attemptId: deferredRefresh.attemptId, status: "pending" }
        : value?.pending?.stage === "exchanging" ? { attemptId: value.pending.attemptId, status: "pending" } : value?.remoteCleanup || null,
      remoteReviewRequired: Boolean(value?.remoteReviewRequired),
      revocationStatus: value?.encryptedTokens ? "pending" : "not-needed" });
    if (value?.encryptedTokens) { try { forgetQuickBooksAccessToken(value.encryptedTokens, configFor()); } catch {} }
    let revocationStatus = deferredRefresh ? "pending" : value?.encryptedTokens ? "unconfirmed" : "not-needed";
    if (value?.encryptedTokens && !deferredRefresh) {
      try {
        const config = configFor();
        if (value.fingerprint !== config.fingerprint) throw new Error("Configuration changed");
        const token = decryptQuickBooksTokens(value.encryptedTokens, config);
        revocationStatus = await revokeToken(token.refreshToken, config);
      } catch { /* Local disable is final even if provider revocation is uncertain. No retry. */ }
      const current = await read(QUICKBOOKS_CONNECTION_PATH);
      if (current?.value.disconnectId !== disconnectId) throw conflictError();
      await saveConnection(current, { ...current.value, revision: current.value.revision + 1, changeId: randomUUID(), revocationStatus,
        remoteReviewRequired: current.value.remoteReviewRequired || revocationStatus !== "confirmed", updatedAt: stamp(now()) });
    }
    await auditImpl(actor.email, "quickbooks.authorization.disconnected", "merchant-connection", { revocationStatus });
    return { ...(await status()), message: revocationStatus === "unconfirmed"
      ? "QuickBooks access is disabled locally and its saved tokens were removed. Intuit revocation could not be confirmed; review connected apps in Intuit before reconnecting. No retry was sent."
      : "QuickBooks authorization is disconnected. Customer payments and refunds remain unavailable." };
  }
  return { status, start, callback, disconnect, refresh, verifyCompany };
}

export const quickbooks = createQuickBooksService();

// Server-only Payments transport. No HTTP action exposes the decrypted grant.
// Paths and methods follow Intuit's official PHP Payments SDK ChargeOperations.
// Both environments require current signed review evidence. The default
// verifier cannot be enabled by an environment selection alone.
export function createQuickBooksPaymentsTransport(overrides={}) {
  const {read=readRecord,fetchImpl=fetch,env=process.env,now=Date.now,
    connection=quickbooks,authorizeProduction=paymentReadiness.authorizeTransport,
    authorizeSandbox=paymentReadiness.authorizeTransport}=overrides;
  const unavailable=()=>new QuickBooksError("The payment connection needs administrator review.",503,"PAYMENT_CONNECTION_UNAVAILABLE");
  async function authorize(binding,operation) {
    const authorizeBinding=binding?.environment==="production"?authorizeProduction:authorizeSandbox;
    const authorization=await authorizeBinding({binding,operation});
    if(!paymentAuthorizationMatches(authorization,binding,operation,now()))
      throw new QuickBooksError(binding?.environment==="production"?"Production payments are not enabled.":"Sandbox payment testing is not enabled.",
        503,binding?.environment==="production"?"PRODUCTION_PAYMENTS_DISABLED":"SANDBOX_PAYMENTS_DISABLED");
  }
  async function inspect(allowRefresh=false, requireAccess=false) {
    const config=quickbooksConfig(env), record=await read(QUICKBOOKS_CONNECTION_PATH), value=record?.value;
    if(value?.status!=="authorized"||value.encryptedTokens?.version!==2||value.pending||value.refreshOperation||value.remoteReviewRequired
      ||value.revocationStatus==="pending"||value.remoteCleanup?.status==="pending"
      ||value.fingerprint!==config.fingerprint||value.credentialVersion!==config.credentialVersion
      ||typeof value.authorizationAttemptId!=="string"||!value.authorizationAttemptId)throw unavailable();
    const owner=(await read(userPath(value.connectedBy||OWNER_EMAIL)))?.value;
    if(!isOwner(owner)||owner.mustChangePassword)throw unavailable();
    const token={...decryptQuickBooksTokens(value.encryptedTokens,config),accessToken:readQuickBooksAccessToken(value.encryptedTokens,config,now())};
    if(token.accessToken!==null&&(typeof token.accessToken!=="string"||token.accessToken.length<8||token.accessToken.length>16_384||/[\s\x00-\x1f]/.test(token.accessToken)))throw unavailable();
    if(!REALM_PATTERN.test(token.realmId||"")
      ||(token.grantedScopes!==null&&(!Array.isArray(token.grantedScopes)||!token.grantedScopes.includes("com.intuit.quickbooks.payment"))))throw unavailable();
    const grantId=digest(`${config.credentialVersion}:${token.realmId}:${value.authorizationAttemptId}`);
    const expires=Date.parse(token.accessTokenExpiresAt);
    if(!Number.isFinite(expires))throw unavailable();
    if(expires<=now()+60_000 || ((allowRefresh || requireAccess) && !token.accessToken)) {
      if(!allowRefresh)throw unavailable();
      await authorize({environment:config.environment,grantId},"refresh");
      await connection.refresh(owner,{expectedRevision:value.revision});
      const fresh=await inspect(false,true);
      if(fresh.binding.grantId!==grantId)throw unavailable();
      return fresh;
    }
    return {record,config,token,binding:{environment:config.environment,grantId}};
  }
  async function binding({allowRefresh=false}={}) {return (await inspect(allowRefresh)).binding;}
  async function request(expected,{method,path,requestId,body}) {
    if(!expected||!Object.hasOwn(INTUIT_PAYMENT_ORIGINS,expected.environment))throw unavailable();
    const operation=method==="GET"?"read":path==="/charges"?"charge":"refund";
    await authorize(expected,operation);
    const allowed=(method==="POST"&&/^\/charges(?:\/[A-Za-z0-9_-]{1,128}\/refunds)?$/.test(path))
      ||(method==="GET"&&/^\/charges\/[A-Za-z0-9_-]{1,128}(?:\/refunds\/[A-Za-z0-9_-]{1,128})?$/.test(path));
    if(!allowed||typeof requestId!=="string"||!/^[-A-Za-z0-9]{16,50}$/.test(requestId))throw unavailable();
    if(method==="POST") {
      const fields=path==="/charges"?["amount","currency","token","capture","context"]:["amount","description"];
      if(!body||typeof body!=="object"||Array.isArray(body)||Object.keys(body).some(key=>!fields.includes(key)))throw unavailable();
      if(path==="/charges"&&(body.capture!==true||body.currency!=="USD"||typeof body.token!=="string"
        ||body.token.length<8||body.token.length>2048||!/[A-Za-z]/.test(body.token)||!/^[A-Za-z0-9_.=-]+$/.test(body.token)
        ||body.context?.mobile!==false||body.context?.isEcommerce!==true||Object.keys(body.context).some(key=>!["mobile","isEcommerce"].includes(key))))throw unavailable();
    }
    const current=await inspect(true);
    if(current.binding.environment!==expected.environment||current.binding.grantId!==expected.grantId)throw unavailable();
    // Revalidate time-bounded evidence after any token refresh and before send.
    await authorize(current.binding,operation);
    // Re-read immediately before sending; a changed or disconnected grant is never reused.
    const latest=await read(QUICKBOOKS_CONNECTION_PATH);
    if(latest?.etag!==current.record.etag||quickbooksConfig(env).credentialVersion!==current.config.credentialVersion)throw unavailable();
    return fetchImpl(`${INTUIT_PAYMENT_ORIGINS[current.binding.environment]}/quickbooks/v4/payments${path}`,{
      method,redirect:"error",signal:AbortSignal.timeout(20_000),
      headers:{Authorization:`Bearer ${current.token.accessToken}`,Accept:"application/json","Content-Type":"application/json","Request-Id":requestId},
      ...(method==="POST"?{body:JSON.stringify(body)}:{}),
    });
  }
  return {binding,request};
}
