# Production credit before payment

New production invoices require enough existing fal credit for the saved film and every outstanding reserved production budget. Pricing remains available when funding is unavailable. The customer receives a generic, retryable production availability message; balances, billing responses and credentials are never returned.

## Required configuration

Configure these server-only values in the production web checkout runtime:

- `FAL_BILLING_KEY`: a separate fal key with only `billing:usage:read`.
- `FAL_BILLING_ACCOUNT`: the exact `username` returned by the billing endpoint for the account that owns the production generation keys.

The account must be verified during installation. A key for a different account is rejected even when it has sufficient credit. This read-only key cannot add credit or authorize generation. Keep `FAL_KLING_KEY` separate. The billing key is not needed for quoting, worker execution, payment reconciliation, existing invoice reads, or the explicitly authorized operator canary.

The guard reads `GET https://api.fal.ai/v1/account/billing?expand=credits` using `Authorization: Key …`. It requires the configured username, USD and a finite nonnegative numeric `credits.current_balance`. Available cents are rounded down. Missing configuration, redirects, failed requests, malformed responses and oversized responses fail closed. The request has a 15-second timeout and a 64 KiB response limit.

## Reservations and retry behavior

Checkout first saves an unattempted order, then reserves the full saved provider budget in the private `production/fal/funding-reservations-v1.json` ledger before any new accounting customer/invoice write. The reservation binds the order, quote cycle, owner hash, prepared film, exact manifest hash and budget. Conditional writes and exact readback prevent concurrent app checkouts from admitting more total budget than the fresh balance. Conflicts trigger at most three complete attempts.

The guard also enumerates existing production orders, including those created before this change. It reads at most 1,000 order records, in batches of eight, and fails closed if the list is incomplete, larger than that bound, or contains an unknown order schema. Explicit sandbox and declined/cancelled orders are excluded from historical imports. Existing ledger holds are not erased by those statuses. Merchant allowances increase the reserved provider cost.

An outstanding unpaid invoice, uncertain invoice attempt, partially rendered film, refunded order, or missing-job obligation retains its full budget. Issued invoices and recorded attempts never expire out of the ledger merely because their quote is old: an external payment link may still be payable. The exact completed film with its matching saved manifest and private, content-addressed MP4 record releases its production hold.

An expired hosted order that has **no invoice attempt, invoice identity, capture or linked payment** can be released only by first conditionally writing a terminal fence into that exact order and quote cycle. This invalidates a stalled invoice claimant's old ETag. The guard then writes and reads back an immutable receipt under `production/fal/funding-releases/{orderId}/{quoteId}.json`. A release receipt for an earlier quote never releases a newer quote's budget. A missing-order hold cannot use this recovery path and remains reserved for investigation.

The same reservation is checked against a fresh balance again immediately before the invoice attempt is durably claimed. If either funding check fails, no invoice POST occurs. The existing order is retained without an invoice-attempt marker, so its original request can be retried while its quote, consent, merchant binding and terms remain valid. The customer record is reused.

After a funding-blocked quote expires, an explicit `checkPayment` POST with the exact `expectedQuoteId` can create the fence and release receipt. Only then does the server return `checkoutRestartAllowed:true`. The client may clear that exact saved reference and request a new price. Quote rollover keeps the film's order ID and uses a new quote cycle; a conditional write selects one winner among concurrent refreshes. Old quote IDs and stale order ETags cannot submit an invoice. GET order remains read-only.

If the fresh quote response is lost before payment, a later pricing request recovers that exact unclaimed quote while its saved plan, price, terms and merchant binding remain valid. An expired unused rollover quote is fenced before another replacement. This avoids requiring an invoice attempt merely to recover a price after a reload.

An existing invoice or recorded invoice attempt is recovered before the new funding guard runs. It is never replaced, voided or resubmitted because credit later changes. Existing paid orders, receipt reads, and live payment reconciliation retain their previous authorization checks.

## Operational limits

This is a conservative application reservation, not a reservation in the fal wallet. It can overcount costs already spent on an unfinished film; this deliberately blocks new payment requests instead of risking underfunded fulfillment. Other applications, manual provider use, newly approved merchant allowances, or changes outside this checkout ledger can consume credit after the check. Use dedicated production credentials/account practices and keep sufficient operating credit available.

Previously issued payment links may remain payable while the wallet is low; this guard does not void them or refund existing customers. Funding must still be available to finish those obligations. QuickBooks receipts do not transfer money into fal, and the app does not automatically buy provider credit.

The 1,000-record bound is appropriate for the current small account. Before that bound is reached, implement an audited archival/indexing approach instead of raising limits without reviewing checkout latency and reservation integrity.

For a read-only deployment check, import `readFalCreditCents` with the configured runtime environment and compare the result to the needed provider cents. Print only the boolean result:

```sh
node --input-type=module -e "import {readFalCreditCents} from './api/_lib/fal-funding.mjs'; console.log(JSON.stringify({funded:(await readFalCreditCents())>=1980}));"
```

This example performs one billing read and no record writes, invoices or provider generation. `false` establishes that the full reservation must reject that 1,980-cent budget; `true` alone does not establish admission because outstanding commitments are also counted.

## Source

[fal account billing API: credits expansion, response schema and required permission](https://fal.ai/docs/platform-apis/v1/account/billing)
