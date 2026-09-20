# QuickBooks setup and activation

The user selected Intuit Payments for BROCO Technologies LLC and authorized implementation and deployment. The existing Intuit Developer workspace is BROCOTech; its Lineage Theater application is the one to continue. Do not create duplicate apps or confuse an Intuit Developer workspace ID with a QuickBooks company/realm ID.

## Current assessment evidence — September 20, 2026

The signed-in existing BROCOTech / Lineage Theater compliance page displayed **Submission Completed** and **Results Approved**. Its approved, read-only Payments questionnaire selects **In-App** receipt delivery with payment amount, total amount, date, transaction ID and processor disclosure. Email delivery, fees and card last-four are unselected. The declined/voided/refunded testing answer remains **No**. This supersedes the earlier pending-assessment status below; no new assessment was submitted during this inspection.

Approval is not evidence of an activated production merchant, installed production credentials, a migrated live authorization record, or actual sandbox lifecycle verification. Those remain separate checks; customer charges and refunds remain disabled. See [the assessment rollout record](RECAPTCHA-SETUP.md).

## Verified setup on September 14, 2026

The Intuit app details and developer profile are complete. At this checkpoint, production credentials remained locked pending the assessment. The development callback is saved with the exact URL below.

**September 16 update — case 00227847:** Intuit Developer Support reported that the submitted assessment was rejected for missing Payment ReCaptcha, and unlocked the questionnaire for correction and resubmission. See [the reCAPTCHA implementation and rollout record](RECAPTCHA-SETUP.md). Code or credential creation alone is not evidence of a deployed control or Intuit approval.

With the owner's explicit approval, the matching sandbox client ID and secret, `QUICKBOOKS_ENVIRONMENT=sandbox`, and a new dedicated 32-byte token-encryption key were saved as server-only Vercel secrets for the existing `lineage-theater` project. No credential values were saved in the repository or printed.

At approximately 05:52 UTC, the owner approved and connected Sandbox Company US ed68, realm `9341457908644571`. The callback exchanged the code successfully, encrypted tokens were verified at rest, and owner status returned configured, authorized, connected, and sandbox. The token response omitted scopes (`scopeVerification: not-returned`); the stored company reference remains `realmVerification: callback-only` until an independent company read. Actual company reads, refresh, revocation, and reconnect remain unverified at this implementation checkpoint. All payment/refund readiness flags remain false. Sandbox authorization is not production merchant activation.

## Connection URLs

- Host domain: `lineagetheater.com`
- Launch: `https://lineagetheater.com/#admin/payments`
- Connect/reconnect: `https://lineagetheater.com/#admin/payments`
- Disconnect: `https://lineagetheater.com/#admin/payments`
- OAuth redirect: `https://lineagetheater.com/api/quickbooks?action=callback`
- Terms: `https://lineagetheater.com/terms.html`
- Privacy: `https://lineagetheater.com/privacy.html`

Connect and disconnect URLs open the authenticated owner controls. Opening those pages or changing the callback hash does not change authorization or payment state. The separate OAuth callback endpoint validates and consumes an authorization return. Customers cannot access these controls; delegated administrators can read status only. A browser authorization return is checked against durable state, a dedicated browser cookie, and the owner's current server account.

## Current boundary

The connection code exchanges authorization codes, saves only encrypted refresh tokens and grant metadata, and holds encrypted access tokens in volatile process memory. Owner-only same-origin refresh and company-check actions are implemented. The separate studio checkout flow requires trusted readiness evidence; production payments remain disabled. No client-supplied payment amount is accepted, and Accounting writes remain unavailable.

Version 2 encrypted envelopes explicitly omit access tokens. The memory cache is bounded, bound to the exact envelope and credential version, checked for expiry on use, and never serialized or returned to the browser. Status exposes `accessTokenStorage` and `accessTokenAvailable` as safe metadata. A valid saved grant may survive a cold worker even when its access token does not; guarded renewal recreates that temporary access. Legacy version 1 records are blocked from company and Payments requests until the owner uses **Refresh authorization**, which conditionally replaces them with refresh-only storage before any token exchange. Deploying this code alone does not prove an existing record was migrated.

The owner must disconnect a saved authorization before starting another. Disconnect removes local tokens and invalidates pending callbacks before attempting Intuit revocation. An uncertain exchange or revocation needs review in Intuit's connected-app controls; never retry a money-moving operation or claim remote access was revoked without evidence.

## Read-only company verification

The owner can use `POST /api/quickbooks` with `{ "action": "verifyCompany", "expectedRevision": <current revision> }` from the canonical app origin. The request cannot select a realm, token, URL, or environment. The server uses the realm inside the saved encrypted token and the configured environment to perform exactly one Accounting GET:

- Sandbox: `https://sandbox-quickbooks.api.intuit.com/v3/company/{savedRealm}/companyinfo/{savedRealm}`
- Production: `https://quickbooks.api.intuit.com/v3/company/{savedRealm}/companyinfo/{savedRealm}`

The request uses a Bearer token only in server memory, an `Accept: application/json` header, a 15-second timeout, and no redirects. If a valid grant has lost its in-memory access token, this owner action performs serialized renewal once before reading the company. An already expired grant requires **Refresh authorization** first. It never calls Payments endpoints or Accounting writes. A known token scope must include Accounting; when the original token response omitted scopes, the actual CompanyInfo GET can establish Accounting read access without upgrading claims about the complete grant or Payments access.

An HTTP 200 JSON response must contain a valid `CompanyInfo` object and a nonempty company name. Only company name, optional legal name, optional country, and the verification time are saved. `CompanyInfo.Id` may be the entity ID `1`; it is not compared with the OAuth realm. The successful authenticated saved-realm route supplies realm-access evidence. The owner still reviews the returned name: this does not independently certify that the company is the intended BROCO business or an enabled merchant.

Before saving, the service rechecks owner/password, access expiry, server credentials, original record ETag/revision and encrypted token version. A concurrent disconnect, refresh, credential change or newer company check rejects stale evidence. Status returns `companyVerification: null` or `{ verifiedAt, companyName, legalName, country, accountingAccessVerified: true }`; evidence is shown only while the same token/configuration is connected and has no pending or review state. Token rotation, expiry, disconnect, or configuration changes hide the evidence.

Private JSON record reads bypass the Blob cache and request `Accept-Encoding: identity` to retain the original strong ETag for conditional writes. A synthetic Blob check reproduced compressed reads returning a weak ETag that rejected an otherwise valid update; identity reads allowed the update and still rejected a stale writer. The code forwards the returned ETag unchanged, including quotes; it never removes a weak-validator prefix. This storage check does not establish successful company verification.

Company GET failures do not revoke tokens, retry, or set monetary uncertainty flags. Any preceding access-token renewal follows the separate failure rules below. Prior evidence retains its timestamp and is hidden after rotation. Raw responses, addresses, email, card data, and secrets are not returned or stored. `scopeVerification` and the original `realmVerification` provenance remain unchanged, and `paymentReady`/`refundReady` remain false even after a successful company check. Automated tests use fabricated provider responses; an actual company read is a separate runtime verification step.

## Serialized token refresh

`quickbooks.refresh(owner, { expectedRevision })` requires the active owner with completed password setup and returns only sanitized connection status plus `refreshed: true|false`. The HTTP route exposes an owner-only, same-origin, rate-limited POST with action `refresh` and the exact expected revision. Reading status and opening Administration do not refresh tokens. A company read or trusted internal payment operation may renew lost memory access; decrypted tokens never enter HTTP responses.

The service skips refresh only while matching access exists in this worker's memory and remains valid for more than 60 seconds. Otherwise it requires a known, unexpired refresh lifetime and honors an optional earlier hard expiry. It atomically claims the stored connection revision before sending one `grant_type=refresh_token` request. Competing workers receive a conflict or busy result; they must re-read status rather than replay the request. A claimed operation never expires into permission for a second refresh, because an abandoned request may already have rotated the provider token.

The latest refresh token and metadata are encrypted and written with the claimed ETag; access is encrypted separately in memory only. Omitted scope/company assertions retain their original evidence level; requested scopes are never treated as granted scopes. Omitted lifetime fields preserve known deadlines. Invalid lifetimes are rejected, and a known hard expiry is never extended. Token requests opt into `x_refresh_token_hard_expires_in` using Intuit's documented `x-include-refresh-token-hard-expires-in: true` header. Responses that omit this optional field remain explicitly without a known hard-expiry claim.

During refresh the old encrypted refresh material is retained solely so cancellation can dispose of the grant; the connection is unusable. A disconnect removes saved refresh material and this worker's memory entry immediately, then defers revocation until any pending refresh response arrives. Other workers cannot use stale memory because each operation rechecks the current durable grant. Owner/password or server configuration changes after the request prevent saving that response. Returned tokens that cannot be retained are revoked once. A final put that commits but loses its response is identified by its refresh attempt ID and cleaned up without revoking an unrelated newer grant. Audit failure after a confirmed token save does not revoke the saved authorization.

`invalid_grant` requires reconnection; explicit credential rejection requires server configuration review. Network errors, ambiguous provider responses, malformed responses without a usable returned token, and unconfirmed revocation set a durable review requirement. No refresh request is automatically retried. Old ciphertext may remain for explicit disconnect only; its presence does not make the connection usable. An abandoned operation or unresolved remote grant requires operator reconciliation with actual Intuit evidence. There is no UI override that silently clears this block.

New authorization records bind a private digest of the configured app credentials and encryption key. Changing those values makes refresh fail closed; existing records without this version acquire it after their first successful refresh. Key/credential rotation therefore needs a controlled reconciliation or reconnect, not a silent overwrite. A worker cannot detect an out-of-band portal credential change before Intuit rejects it, and runtime verification remains necessary.

Status adds `refreshStatus` (`idle`, `refreshing`, `refreshed`, `reconnect-required`, `credentials-rejected`, or `uncertain`) and `lastRefreshedAt`. Refreshing sets `pending: true` and `connected: false`. `paymentReady` and `refundReady` remain false in every state. Automated tests use fabricated credentials and responses; no live refresh or transaction was performed to validate this implementation.

## Before production authorization

1. Keep using the completed existing developer profile and app details. The user confirmed legal name BROCO Technologies LLC, 5513 W 11000 North #104, Highland, UT 84003, and business phone 801-948-9048. The production deployment's function region was verified as `iad1`; no fixed outbound IP was claimed.
2. Retain the approved assessment and keep its answers accurate as the app changes. Company regulatory history, legal-counsel involvement, sanctions disclosures, legal certifications, and operational evidence require actual company information. Do not mark controls implemented merely because they are planned, or submit unverified certifications.
3. Resolve the currently linked Intuit Password Policy requirements before a production-security attestation and clarify applicability if Intuit uses newer standards. The earlier deployed app had only length/rate-limit controls. The September 14 integration branch now implements password screening, lockout, history, change frequency, expiry, optional MFA/email verification and server-side logout revocation; its local tests do not establish deployment, exhaustive dictionary coverage or policy compliance. A dedicated Production MFA encryption secret was saved, but deployed operation and real-account enrollment remain unverified. See [the readiness record](INTEGRATION-READINESS.md) for exact controls and evidence.
4. Preserve the matching sandbox credentials and dedicated encryption key in the server vault and the exact registered callback. Sandbox consent and code exchange were verified above; complete actual company-read, denial, refresh, revocation and reconnect checks. Tests with fabricated tokens do not prove runtime behavior.
5. Following the verified assessment approval, establish production credential availability and merchant activation, and obtain explicit merchant consent for Payments and Accounting scopes. Verify the intended company/merchant and capabilities before any transaction. Callback realm IDs and absent response scopes are reported as unverified; they are not merchant proof.
6. Verify serialized refresh-token rotation with the intended sandbox grant, supported hosted card entry, charge/refund lifecycle and approved accounting mappings. The integration branch implements disabled-by-default durable quote/order idempotency and reconciliation; these are tested with synthetic responses, not actual captures or refunds. A September 14 driver successfully tokenized Intuit's published fabricated card through the actual sandbox endpoint and discarded the token without charging it. That is not browser card-entry, hosted-fields or PCI approval. Keep provider charges, customer revenue, fees and MagicLight usage expense separate. Verify sandbox transactions before a bounded real transaction approved by the user.

## Official references

- [Intuit OAuth SDK and scopes](https://github.com/intuit/oauth-jsclient)
- [Official refresh request implementation](https://github.com/intuit/oauth-jsclient/blob/master/src/OAuthClient.js)
- [Intuit hard-expiry opt-in and response fields](https://github.com/intuit/oauth-pythonclient/blob/master/intuitlib/client.py)
- [Official CompanyInfo GET and headers](https://github.com/intuit/oauth-pythonclient/blob/master/docs/user-guide.rst)
- [Official CompanyInfo fixture with entity Id 1](https://github.com/intuit/QuickBooks-V3-PHP-SDK/blob/master/src/Utility.Test/XmlObjectSerializerTest.php)
- [Intuit security requirements](https://static.developer.intuit.com/output_html/qbo/docs/go-live/publish-app/security-requirements.html)
- [Linked Password Policy](https://static.developer.intuit.com/output_html/qbo/docs/legal-agreements/password-policy-for-intuit-developer-services.html)
- [Intuit App Partner Program Guide](https://static.developer.intuit.com/resources/Intuit_App_Partner_Program_Guide.pdf)

The security page describes App Store review; the Partner Program also requires an approved assessment for production access. Do not infer that completing developer registration alone unlocks production credentials.
