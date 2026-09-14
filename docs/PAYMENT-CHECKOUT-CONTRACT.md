# Shared payment checkout contract

September 14, 2026. This describes implemented plumbing and the remaining activation evidence. It does not certify merchant approval or authorize a transaction.

Approved customers, employees and administrators use the same studio quote, checkout, order and receipt actions. Registration approval governs account access. Administrator permissions are required for refunds, reconciliation and diagnostic details, not for purchases.

## Card entry

Intuit's [official Node Payments sample](https://github.com/IntuitDeveloper/SampleApp-Payments-Nodejs/blob/master/public/js/index.js) sends browser AJAX directly to the token endpoint. It submits JSON `{card:{name,number,expMonth,expYear,cvc,address:{region,postalCode,streetAddress,country,city}}}` with `Content-Type: application/json`. The [official .NET sample](https://github.com/IntuitDeveloper/SampleApp-Dotnet_Payments/blob/master/OAuth2-Dotnet_Payments/OAuth2-Dotnet_Payments/Default.aspx.cs) confirms that token creation needs no OAuth authorization header and reads the returned token from `value`.

This is browser-direct tokenization, not hosted fields. Lineage Theatre's DOM and JavaScript handle the card information. Direct submission avoids sending that information to this application's API, but cannot support an attestation that the application never handles card data or a claim of PCI exemption. Merchant and application review must cover the actual form, scripts and operational controls before real card entry is enabled. No current hosted-fields contract was established during this review; do not substitute an obsolete application-token script or a different vendor.

The supported fixed hosts are `https://sandbox.api.intuit.com` and `https://api.intuit.com`, followed by `/quickbooks/v4/payments/tokens`; see the [official PHP client](https://github.com/intuit/PHP-Payments-SDK/blob/master/src/PaymentClient.php). Sandbox OPTIONS from the production app origin returned allowed POST and content-type/request-id headers on September 14 at 21:45:35 UTC. This proves preflight support only, not browser token creation, merchant approval or a charge. No real card or payment transaction was used in this check.

## Customer API

- GET `checkoutConfiguration`: unavailable returns only `{available:false}`. When a trusted server verifier authorizes card entry for the current grant, returns `{available:true,environment,tokenization:{method:'intuit-browser-direct',url}}`. It does not refresh credentials, expose a grant, or submit a payment.
- POST `quote`: `{project,preparedId,idempotencyKey}` loads and checks the saved preparation through the film service. The response includes `id`, `orderId`, `preparedId`, `manifestHash`, film display details, currency, total amount, expiry and sandbox status. The server supplies the provider quote and markup; clients cannot supply costs, totals or evidence.
- POST `checkout`: `{quoteId,idempotencyKey,paymentToken,consent:true}`. An immutable order claim precedes any processor request. Tokens are neither persisted nor returned.
- GET `order&id=...` and `receipt&id=...` are scoped to the signed-in account (or an administrator). The quoted `orderId` is known before checkout, so a timeout or reload can recover by GET without replaying a POST. A missing order immediately after a timeout is not proof that no request is still running. A declined or uncertain same-manifest order does not automatically create another charge attempt.
- POST `startProduction`: `{preparedId,orderId,productionConsent:true}` advances the saved plan only after the film service checks trusted payment authorization. The client supplies no grant, environment, amount or manifest evidence. This route requires the approved account session, same origin and a per-user rate limit.

Existing sandbox order IDs are retained. Production orders use a separate identity for the same customer and manifest, excluding the OAuth grant so reconnecting cannot trigger another charge. Existing unscoped production orders, or records whose environment cannot be established, remain readable by their original ID but block creation of a new production order. The UI must match the recovered order's environment and quote/preparation references before treating it as this purchase.

## Server activation boundary

`createPaymentsService` defaults to unavailable. Its server-only `readiness` dependency can supply a short-lived `authorization` from a trusted evidence verifier. Production transport separately requires `authorizeProduction({binding,operation})`; its default returns null. No HTTP action, application setting or environment switch manufactures this authorization.

The authorization contract binds an evidence hash to the exact current OAuth grant and environment, validation and expiry times (at most 24 hours apart), and the allowed operations: quote, charge, refund, read, render, card-entry and refresh. The contract validator checks those bindings; it does **not** independently establish that merchant or compliance evidence is genuine. No production evidence verifier is implemented or wired yet. Wiring one requires reviewed actual approval evidence, rather than setting booleans or copying synthetic test output into storage.

The transport uses the fixed environment endpoint and existing encrypted OAuth lifecycle. Production authorization is checked before dispatch and again after any refresh. The saved connection and credential version are re-read before sending. Unknown results remain blocked; no automatic POST retry or guessed transaction lookup is introduced. Receipts distinguish sandbox tests from actual captures and never claim settlement or film delivery from a capture alone.

## Evidence still required

Intuit production app approval, an eligible merchant account for the intended company, production credentials and scope consent, verified merchant capability, reviewed card-entry/PCI responsibilities, and successful sandbox lifecycle/payment/refund tests remain required. The actual film API, price, quality, commercial terms and durable delivery implementation must also be verified before offering a paid film. OAuth authorization or a company-information response alone is not merchant capability.

Intuit documents distinct [production credentials and Payments scope](https://developers.intuit.com/app/developer/qbpayments/docs/develop/authentication-and-authorization/oauth-2.0). Its [merchant terms](https://www.intuit.com/legal/terms/en-us/quickbooks/online/) require underwriting approval and bona fide transactions and prohibit processing the merchant's own cards. Internal registration restrictions do not replace these requirements. No live charge, refund, merchant activation or production readiness evidence was created by this implementation.
