import { randomBytes, randomUUID, createCipheriv, createDecipheriv, timingSafeEqual } from "node:crypto";
import { digest, readRecord, writeRecord, userPath } from "./auth.mjs";
import { isOwner, OWNER_EMAIL } from "./access.mjs";
import { audit } from "./admin.mjs";

// Verified against Intuit's official oauth-jsclient, src/OAuthClient.js.
// These URLs are never derived from a request, callback query, or environment override.
export const QUICKBOOKS_ORIGIN = "https://lineagetheater.com";
export const QUICKBOOKS_CALLBACK = `${QUICKBOOKS_ORIGIN}/api/quickbooks?action=callback`;
export const INTUIT_AUTHORIZE = "https://appcenter.intuit.com/connect/oauth2";
export const INTUIT_TOKEN = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";
export const INTUIT_REVOKE = "https://developer.api.intuit.com/v2/oauth2/tokens/revoke";
export const QUICKBOOKS_SCOPES = Object.freeze(["com.intuit.quickbooks.payment", "com.intuit.quickbooks.accounting"]);
export const QUICKBOOKS_CONNECTION_PATH = "integrations/quickbooks/connection.json";
export const QUICKBOOKS_STATE_COOKIE = "__Host-lineage_quickbooks_state";
const STATE_TTL = 10 * 60_000;
const TOKEN_PATTERN = /^[a-f0-9]{64}$/;
const REALM_PATTERN = /^[0-9]{1,30}$/;

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
function aad(config, secretId) { return Buffer.from(`lineage-quickbooks-v1:${QUICKBOOKS_CONNECTION_PATH}:${config.fingerprint}:${secretId}`); }
export function encryptQuickBooksTokens(value, config, secretId = randomUUID()) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", config.key, iv);
  cipher.setAAD(aad(config, secretId));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return { version: 1, secretId, iv: iv.toString("base64"), ciphertext: ciphertext.toString("base64"), tag: cipher.getAuthTag().toString("base64") };
}
export function decryptQuickBooksTokens(envelope, config) {
  try {
    if (envelope?.version !== 1 || typeof envelope.secretId !== "string"
        || typeof envelope.ciphertext !== "string" || envelope.ciphertext.length > 65_536) throw new Error();
    const iv = Buffer.from(envelope.iv, "base64"), tag = Buffer.from(envelope.tag, "base64");
    if (iv.length !== 12 || tag.length !== 16) throw new Error();
    const decipher = createDecipheriv("aes-256-gcm", config.key, iv);
    decipher.setAAD(aad(config, envelope.secretId)); decipher.setAuthTag(tag);
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

export function createQuickBooksService(overrides = {}) {
  const { read = readRecord, write = writeRecord, fetchImpl = fetch, now = Date.now,
    env = process.env, auditImpl = audit } = overrides;
  const configFor = () => quickbooksConfig(env);
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
        const expired = Date.parse(token.accessTokenExpiresAt) <= now();
        output.connected = !expired; output.authorizationStatus = expired ? "expired" : "authorized";
        output.message = expired
          ? "The saved access token has expired. A server-authorized token refresh or reconnection is required; customer checkout remains unavailable."
          : "Intuit authorization is saved. Company/merchant readiness and customer payments or refunds have not been verified or enabled.";
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
    return output;
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
      const response = await fetchImpl(INTUIT_REVOKE, { method: "POST", redirect: "error", signal: AbortSignal.timeout(15_000),
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
      const response = await fetchImpl(INTUIT_TOKEN, { method: "POST", redirect: "error", signal: AbortSignal.timeout(15_000),
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
    const config = configFor(), previous = await read(QUICKBOOKS_CONNECTION_PATH);
    checkRevision(previous, body.expectedRevision);
    const value = previous?.value;
    if (value?.refreshOperation || value?.pending || value?.revocationStatus === "pending" || value?.remoteCleanup?.status === "pending")
      throw new QuickBooksError("A QuickBooks connection operation is still being verified.", 409, "QUICKBOOKS_BUSY");
    if (value?.remoteReviewRequired || value?.status !== "authorized" || !value?.encryptedTokens)
      throw new QuickBooksError("The QuickBooks authorization cannot be refreshed. Review its status before reconnecting.", 409, "QUICKBOOKS_REFRESH_BLOCKED");
    if (value.fingerprint !== config.fingerprint || (value.credentialVersion && value.credentialVersion !== config.credentialVersion))
      throw new QuickBooksError("QuickBooks server credentials changed. Reconcile the saved authorization before refreshing.", 409, "QUICKBOOKS_CONFIGURATION_CHANGED");
    const token = decryptQuickBooksTokens(value.encryptedTokens, config), passwordVersion = digest(actor.passwordHash || "");
    await ownerStillValid(actor.email, passwordVersion);
    if (Date.parse(token.accessTokenExpiresAt) > now() + 60_000) return { ...(await status()), refreshed: false };
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
      const response = await fetchImpl(INTUIT_TOKEN, { method: "POST", redirect: "error", signal: AbortSignal.timeout(15_000),
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
  return { status, start, callback, disconnect, refresh };
}

export const quickbooks = createQuickBooksService();
