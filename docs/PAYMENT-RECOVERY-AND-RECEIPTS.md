# Hosted payment recovery and receipt delivery

## Observed incident

On September 23, 2026, the production security diagnostics reported `expired_token` after Google had accepted fresh checkout tokens. Google's `challenge_ts` is challenge loading time. Treating that timestamp as token issuance incorrectly rejected a customer who left the page open for more than two minutes. The application now relies on Google's token expiry/single-use decision, retains timestamp sanity, action, score and hostname checks, and keeps its own two-minute single-use checkout proof.

The subsequent $3.30 order created QuickBooks invoice 207. Read-only provider and private-order checks found it fully unpaid with no hosted invoice URL. Successful status requests therefore kept returning the old generic review state. This release distinguishes a missing link on an otherwise verified unpaid invoice from an unsafe link or an ambiguous payment. It recovers only the saved invoice; it never creates a replacement invoice during status checks.

This evidence does not establish why the merchant's live InvoiceLink is absent. Production server secrets cannot be exported through the Vercel CLI, and the provider browser requires the owner's sign-in. Inspect the existing invoice and merchant online-payment settings in that session. Do not create or send another invoice to diagnose this one. Intuit documents activated online payments, a valid invoice email, and `include=invoiceLink` for the invoice read; the existing server transport already includes that parameter.

## Customer behavior

- Preparing or safely retrying a payment page reserves a browser tab during the click, then navigates only to the validated Intuit hosted invoice URL. Blocked tabs leave an explicit Open secure payment page link. Failed preparations close the temporary tab.
- Status checks show fresh feedback even if the status has not changed. A missing payment page is explicitly unpaid and can be checked again without another invoice.
- Finished production media requires the server's matching persisted live captured order before any playback, HEAD, range or download response reads private media. Customer, film, saved plan, environment and payment evidence must agree. Client payment flags do not authorize access.
- The current owner's unchanged fixed fictional operator preview remains available. Customer-uploaded archive media is a separate namespace and remains separate from generated film delivery.

Payment confirmation here means a zero invoice balance with validated QuickBooks Payment allocations covering the exact invoice total. It does not establish bank settlement or later provider refunds. This release does not enable a production renderer or change the existing generation-readiness controls.

## Receipt routing

Administration > Payments > Payment receipt emails exposes Merchant receipt email to administrators and the owner. The default is `info@brocotech.ai`. Saves validate one address, check the settings revision, conditionally persist, read back, and write an audit event. This setting does not change pricing, checkout terms, or the sender mailbox.

The customer's account email and the merchant address receive separate fixed payment receipts. No source documents, film story, card details or other recipient's address are included. Identical recipient addresses are deduplicated. A persisted receipt plan freezes recipients on the first configured queue attempt; changes affect future plans and do not redirect a queued receipt.

Only confirmed production hosted invoice payments qualify. Sandbox, unconfirmed and inconsistent records send nothing. Each recipient has a durable conditional send claim before the Graph request. A timeout, process crash or ambiguous storage result must not trigger an automatic resend. Graph HTTP 202 is recorded as accepted, never as proven delivery. Authentication failures before the send claim can recover on later runs.

## Required live configuration

No `LINEAGE_MAIL_*` variables were present in the inspected Vercel production environment. The admin field truthfully shows setup required until configured. Use the existing Microsoft Graph mail contract with a dedicated application restricted to the approved sender mailbox:

- `LINEAGE_MAIL_TENANT_ID`
- `LINEAGE_MAIL_CLIENT_ID`
- `LINEAGE_MAIL_CLIENT_SECRET` (sensitive server-only variable)
- `LINEAGE_MAIL_SENDER` (approved sender mailbox; independent of merchant recipient)
- `CRON_SECRET` (random secret, at least 32 characters; sensitive server-only variable)

Do not substitute delegated browser/connector tokens or another application's credentials. New mail access requires the appropriate tenant authorization and mailbox restriction. Do not commit credentials or include them in evidence.

The Vercel team was verified as active Pro. `vercel.json` schedules `/api/payment-reconcile` every five minutes with a 180-second function duration. The route fails closed without the cron secret and requires an exact bearer value. A persistent lease and cursor limit work to three existing orders per run. All Accounting operations are reads; it never creates, updates or sends invoices. The bounded worker checks approved customer records, reconciles saved invoices, and attempts eligible pending receipts even when the customer does not return. Larger backlogs take additional runs. Hosted status checks also attempt receipts immediately after confirmed payment is persisted; mail failure does not change the payment result.

Before marking live: deploy the approved exact commit, verify its served assets, inspect the existing invoice's hosted URL, verify the scheduler secret and run result, configure the mailbox grant, and verify an authorized real payment and actual recipient delivery. Do not make a real payment or send a test receipt without authorization. No real payment or email was sent during this implementation.

## Verification

- 487 automated tests passed at this checkpoint; TypeScript/Vite production build passed.
- The three isolated workflow checks passed, including denied unpaid/uncertain/sandbox playback. They assert zero outbound provider calls and no real charges.
- Browser verification saved and reloaded a fictional merchant recipient in memory-only storage; the missing-mail setup warning stayed visible.
- An independent review identified the retry popup path; both initial preparation and safe retry now use the same validated navigation and fallback feedback.

Sources: [Google token verification](https://developers.google.com/recaptcha/docs/verify), [Intuit Invoice API](https://developer.intuit.com/app/developer/qbo/docs/api/accounting/most-commonly-used/invoice), [Vercel cron limits](https://vercel.com/docs/cron-jobs/usage-and-pricing), [Microsoft Graph sendMail](https://learn.microsoft.com/en-us/graph/api/user-sendmail?view=graph-rest-1.0).

## Live follow-up: Intuit short invoice links

After the approved PR 23 release, the owner signed into QuickBooks. Invoice 207 showed enabled credit card and bank transfer methods and a $3.30 customer payment preview with card entry. An independent provider read then returned a share link on `https://connect.intuit.com/t/scs-v1-<96 hexadecimal characters>?locale=en_US`. The first scheduled reconciliation verified the unpaid invoice but rejected that link because both existing validators accepted only `/portal/` paths.

The follow-up supports exactly that canonical Intuit short-link shape, with an optional two-letter/two-letter locale and no other query parameters. Existing `/portal/` support and HTTPS/exact-host/credential/port/fragment/traversal checks remain. Tests prove normalization, popup navigation, and recovery of an already rejected saved order through the same invoice GET without another POST. Malformed token lengths, encoded/extra path segments, lookalike domains, redirect parameters and duplicate locales fail closed. Full suite: 490 tests passed; production build passed. No actual hosted URL/token is recorded in these notes or tests.
