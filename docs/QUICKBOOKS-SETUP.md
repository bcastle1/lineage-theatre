# QuickBooks setup and activation

The user selected Intuit Payments for BROCO Technologies LLC and authorized implementation and deployment. The existing Intuit Developer workspace is BROCOTech; its Lineage Theater application is the one to continue. Do not create duplicate apps or confuse an Intuit Developer workspace ID with a QuickBooks company/realm ID.

## Verified setup on September 14, 2026

The Intuit app details and developer profile are complete. Production credentials remain locked pending the unsubmitted assessment. The development callback is saved with the exact URL below.

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

The connection code can exchange an authorization code and save encrypted tokens once matching sandbox credentials and the separate token-encryption key are configured. A server-only refresh service and an owner-initiated read-only company check are also implemented, as described below. It is not an enabled merchant or checkout integration. No refresh action, card tokenization, payment capture, refunds, or accounting writes are exposed by the HTTP route. No customer amount is accepted. Missing configuration and any uncertainty keep payment and refund readiness false.

The owner must disconnect a saved authorization before starting another. Disconnect removes local tokens and invalidates pending callbacks before attempting Intuit revocation. An uncertain exchange or revocation needs review in Intuit's connected-app controls; never retry a money-moving operation or claim remote access was revoked without evidence.

## Read-only company verification

The owner can use `POST /api/quickbooks` with `{ "action": "verifyCompany", "expectedRevision": <current revision> }` from the canonical app origin. The request cannot select a realm, token, URL, or environment. The server uses the realm inside the saved encrypted token and the configured environment to perform exactly one Accounting GET:

- Sandbox: `https://sandbox-quickbooks.api.intuit.com/v3/company/{savedRealm}/companyinfo/{savedRealm}`
- Production: `https://quickbooks.api.intuit.com/v3/company/{savedRealm}/companyinfo/{savedRealm}`

The request uses a Bearer token only in server memory, an `Accept: application/json` header, a 15-second timeout, and no redirects. It never calls token refresh, revocation, Payments endpoints, or Accounting writes. A known token scope must include Accounting; when the original token response omitted scopes, the actual CompanyInfo GET can establish Accounting read access without upgrading claims about the complete grant or Payments access.

An HTTP 200 JSON response must contain a valid `CompanyInfo` object and a nonempty company name. Only company name, optional legal name, optional country, and the verification time are saved. `CompanyInfo.Id` may be the entity ID `1`; it is not compared with the OAuth realm. The successful authenticated saved-realm route supplies realm-access evidence. The owner still reviews the returned name: this does not independently certify that the company is the intended BROCO business or an enabled merchant.

Before saving, the service rechecks owner/password, access expiry, server credentials, original record ETag/revision and encrypted token version. A concurrent disconnect, refresh, credential change or newer company check rejects stale evidence. Status returns `companyVerification: null` or `{ verifiedAt, companyName, legalName, country, accountingAccessVerified: true }`; evidence is shown only while the same token/configuration is connected and has no pending or review state. Token rotation, expiry, disconnect, or configuration changes hide the evidence.

Read failures do not revoke tokens, modify authorization, retry, or set monetary uncertainty flags. Prior successful evidence retains its timestamp. Raw responses, addresses, email, card data, and secrets are not returned or stored. `scopeVerification` and the original `realmVerification` provenance remain unchanged, and `paymentReady`/`refundReady` remain false even after a successful company check. Automated tests use fabricated provider responses; an actual company read is a separate runtime verification step.

## Serialized token refresh

`quickbooks.refresh(owner, { expectedRevision })` is an internal server service. It requires the active owner with completed password setup and returns only sanitized connection status plus `refreshed: true|false`. The current HTTP route rejects a `refresh` action. Reading status, opening Administration, and scheduled jobs do not refresh tokens. A future authenticated caller must deliberately invoke this service; it must never return decrypted tokens to the browser.

The service skips refresh while access remains valid for more than 60 seconds. Otherwise it requires a known, unexpired refresh lifetime and honors an optional earlier hard expiry. It atomically claims the stored connection revision before sending one `grant_type=refresh_token` request. Competing workers receive a conflict or busy result; they must re-read status rather than replay the request. A claimed operation never expires into permission for a second refresh, because an abandoned request may already have rotated the provider token.

The latest returned access and refresh tokens are encrypted together and written with the claimed ETag. Omitted scope/company assertions retain their original evidence level; requested scopes are never treated as granted scopes. Omitted lifetime fields preserve known deadlines. Invalid lifetimes are rejected, and a known hard expiry is never extended. Token requests opt into `x_refresh_token_hard_expires_in` using Intuit's documented `x-include-refresh-token-hard-expires-in: true` header. Responses that omit this optional field remain explicitly without a known hard-expiry claim.

During refresh the old encrypted pair is retained solely so cancellation can dispose of the grant; the connection is unusable. A disconnect removes local tokens immediately and defers revocation until the refresh response arrives, then revokes the returned rotated token. Owner/password or server configuration changes after the request prevent saving that response. Returned tokens that cannot be retained are revoked once. A final put that commits but loses its response is identified by its refresh attempt ID and cleaned up without revoking an unrelated newer grant. Audit failure after a confirmed token save does not revoke the saved pair.

`invalid_grant` requires reconnection; explicit credential rejection requires server configuration review. Network errors, ambiguous provider responses, malformed responses without a usable returned token, and unconfirmed revocation set a durable review requirement. No refresh request is automatically retried. Old ciphertext may remain for explicit disconnect only; its presence does not make the connection usable. An abandoned operation or unresolved remote grant requires operator reconciliation with actual Intuit evidence. There is no UI override that silently clears this block.

New authorization records bind a private digest of the configured app credentials and encryption key. Changing those values makes refresh fail closed; existing records without this version acquire it after their first successful refresh. Key/credential rotation therefore needs a controlled reconciliation or reconnect, not a silent overwrite. A worker cannot detect an out-of-band portal credential change before Intuit rejects it, and runtime verification remains necessary.

Status adds `refreshStatus` (`idle`, `refreshing`, `refreshed`, `reconnect-required`, `credentials-rejected`, or `uncertain`) and `lastRefreshedAt`. Refreshing sets `pending: true` and `connected: false`. `paymentReady` and `refundReady` remain false in every state. Automated tests use fabricated credentials and responses; no live refresh or transaction was performed to validate this implementation.

## Before production authorization

1. Keep using the completed existing developer profile and app details. The user confirmed legal name BROCO Technologies LLC, 5513 W 11000 North #104, Highland, UT 84003, and business phone 801-948-9048. The production deployment's function region was verified as `iad1`; no fixed outbound IP was claimed.
2. Complete the Intuit assessment accurately. Company regulatory history, legal-counsel involvement, sanctions disclosures, legal certifications, and operational evidence require actual company information. Do not mark controls implemented merely because they are planned, or submit unverified certifications.
3. Resolve the currently linked Intuit Password Policy requirements before a production-security attestation: letter/dictionary/username checks, consecutive-failure lockout, password history, change frequency, and expiry differ from the current app's length/rate-limit controls. Clarify applicability to this private merchant integration if Intuit uses newer standards. MFA/email verification and server-side logout revocation are not currently implemented.
4. Preserve the matching sandbox credentials and dedicated encryption key in the server vault and the exact registered callback. Sandbox consent and code exchange were verified above; complete actual company-read, denial, refresh, revocation and reconnect checks. Tests with fabricated tokens do not prove runtime behavior.
5. Complete production approval and obtain explicit merchant consent for Payments and Accounting scopes. Verify the intended company/merchant and capabilities before any transaction. Callback realm IDs and absent response scopes are reported as unverified; they are not merchant proof.
6. Verify serialized refresh-token rotation with the intended sandbox grant, then implement verified tokenization, durable quote/order idempotency, charge/refund reconciliation, and approved accounting mappings. Keep provider charges, customer revenue, fees and MagicLight usage expense separate. Verify sandbox transactions before a bounded real transaction approved by the user.

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
