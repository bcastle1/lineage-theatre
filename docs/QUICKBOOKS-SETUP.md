# QuickBooks setup and activation

The user selected Intuit Payments for BROCO Technologies LLC and authorized implementation and deployment. The existing Intuit Developer workspace is BROCOTech; its Lineage Theater application is the one to continue. Do not create duplicate apps or confuse an Intuit Developer workspace ID with a QuickBooks company/realm ID.

## Connection URLs

- Host domain: `lineagetheater.com`
- Launch: `https://lineagetheater.com/#admin/payments`
- Connect/reconnect: `https://lineagetheater.com/#admin/payments`
- Disconnect: `https://lineagetheater.com/#admin/payments`
- OAuth redirect: `https://lineagetheater.com/api/quickbooks?action=callback`
- Terms: `https://lineagetheater.com/terms.html`
- Privacy: `https://lineagetheater.com/privacy.html`

Connect and disconnect URLs open the authenticated owner controls. A GET or callback hash never changes authorization or payment state. Customers cannot access these controls; delegated administrators can read status only. A browser authorization return is checked against durable state, a dedicated browser cookie, and the owner's current server account.

## Current boundary

The connection code can exchange an authorization code and save encrypted tokens once matching sandbox credentials and the separate token-encryption key are configured. It is not an enabled merchant or checkout integration. No token refresh, card tokenization, payment capture, refunds, or accounting transactions are implemented by this route. No customer amount is accepted. Missing configuration and any uncertainty keep payment and refund readiness false.

The owner must disconnect a saved authorization before starting another. Disconnect removes local tokens and invalidates pending callbacks before attempting Intuit revocation. An uncertain exchange or revocation needs review in Intuit's connected-app controls; never retry a money-moving operation or claim remote access was revoked without evidence.

## Before production authorization

1. Finish the existing developer profile and app details. The user confirmed legal name BROCO Technologies LLC, 5513 W 11000 North #104, Highland, UT 84003, and business phone 801-948-9048. The production deployment's function region was verified as `iad1`; no fixed outbound IP was claimed.
2. Complete the Intuit assessment accurately. Company regulatory history, legal-counsel involvement, sanctions disclosures, legal certifications, and operational evidence require actual company information. Do not mark controls implemented merely because they are planned, or submit unverified certifications.
3. Resolve the currently linked Intuit Password Policy requirements before a production-security attestation: letter/dictionary/username checks, consecutive-failure lockout, password history, change frequency, and expiry differ from the current app's length/rate-limit controls. Clarify applicability to this private merchant integration if Intuit uses newer standards. MFA/email verification and server-side logout revocation are not currently implemented.
4. Store matching sandbox credentials and a new dedicated encryption key only in the server vault. Register the exact callback in the same environment. Verify real sandbox consent, denial, callback, company identity, and revocation. Tests with fabricated tokens do not prove real authorization.
5. Complete production approval and obtain explicit merchant consent for Payments and Accounting scopes. Verify the intended company/merchant and capabilities before any transaction. Callback realm IDs and absent response scopes are reported as unverified; they are not merchant proof.
6. Implement serialized refresh-token rotation, verified tokenization, durable quote/order idempotency, charge/refund reconciliation, and approved accounting mappings. Keep provider charges, customer revenue, fees and MagicLight usage expense separate. Verify sandbox transactions before a bounded real transaction approved by the user.

## Official references

- [Intuit OAuth SDK and scopes](https://github.com/intuit/oauth-jsclient)
- [Intuit security requirements](https://static.developer.intuit.com/output_html/qbo/docs/go-live/publish-app/security-requirements.html)
- [Linked Password Policy](https://static.developer.intuit.com/output_html/qbo/docs/legal-agreements/password-policy-for-intuit-developer-services.html)
- [Intuit App Partner Program Guide](https://static.developer.intuit.com/resources/Intuit_App_Partner_Program_Guide.pdf)

The security page describes App Store review; the Partner Program also requires an approved assessment for production access. Do not infer that completing developer registration alone unlocks production credentials.
