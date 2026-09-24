# Hosted payment reversal evidence

The production authorizer uses `createHostedReversalVerifier` from `api/_lib/hosted-reversals.mjs` by default. Its proof scope is `quickbooks-accounting-recorded-reversals`: it checks reversals recorded in the connected QuickBooks company. It does not establish processor capture, bank settlement, or absence of refunds made outside QuickBooks or not recorded against the customer.

An invoice can remain paid after a refund. Intuit's [Payment reference](https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/Payment) documents unchanged payment totals after a linked refund and the different transaction types that can be associated through a Payment. The verifier therefore checks beyond the invoice's original payment allocation.

## Queries and matching

Each proof requires two matching, completed scans of `RefundReceipt`, `CreditMemo`, `Purchase`, `JournalEntry`, `Deposit`, and `Payment`. Payments use the documented `CustomerRef` filter. The other entities use unfiltered bounded selects; the implementation does not assume undocumented customer filters. The transport permits read-only selects for these additional entities, with no new create, update, delete, or send operations.

- Customer refunds and credits are treated as relevant or ambiguous unless reliable metadata proves they predate the sale.
- Purchase covers expenses and checks. A customer payee, customer expense line, or unidentified payee can make the record ambiguous. A clearly different identified payee can be excluded.
- Customer journal entries, negative customer or unidentified deposit lines, and separate credit/refund-settlement Payments prevent a clear proof.
- Transaction links match both entity type and ID. A Bill with the same numeric ID as the invoice is not the invoice.
- Historical exclusion requires valid server `CreateTime` and `LastUpdatedTime`, with `LastUpdatedTime` strictly before the saved order's creation time and no exact link to the sale. A user-entered transaction date, matching amount, or memo never establishes that a record is unrelated.
- The exact verified payment ID set and allocation must still cover the full saved amount. After the scans, hosted checkout rereads the invoice and each payment, then rechecks the account, company grant, order, saved price, settings, and production plan before returning a grant.

These conservative rules can stop an otherwise paid order when records cannot be reliably excluded as unrelated. They never silently classify ambiguous evidence as clear.

## Fixed operating bounds

| Bound | Value |
| --- | --- |
| Page size | 100 records |
| Records per entity per scan | 1,000 |
| Scans per proof | 2 |
| Response body | 1 MiB, enforced while streaming |
| Total response bytes per proof | 8 MiB |
| Reconciliation time | 45 seconds |
| Proof lifetime | At most 15 seconds after completion and 60 seconds after scan start |

A full page requires another page before completeness is accepted. Duplicate identities, excess volume, changed snapshots, malformed or sparse records, unsupported detail types, query errors, incomplete pagination, changed company authorization, or exceeded bounds prevent proof issuance. Error and oversized response streams are cancelled. Raw provider records are neither returned to the customer nor saved in the proof; the evidence contains a hash and the exact sale references.

The proof is bound to order, company, authorization grant, customer, invoice, currency, amount, payment IDs, and sale creation time. The production authorizer requires the expected proof scope and checks freshness after subsequent awaits.

## Operations

A missing or unsuccessful reconciliation returns `HOSTED_REVERSALS_UNVERIFIED`. Production stays pending or requires administrator attention through the existing queue behavior; the payment and saved plan remain recorded. This code introduces no customer confirmation workflow and never creates a refund or repeats a payment. Administrators should review the customer's recorded refunds/credits and the private worker result when the check cannot complete; changing an environment flag cannot override it.

Local verification uses fabricated in-memory Accounting responses. Acceptance against the connected production company's real record shapes and transaction volume remains a separate read-only verification step. Historical or unrecorded refunds cannot be resolved by inventing transaction mappings.

## Primary references

- [Intuit PHP SDK: queries, pagination, maximum result count, and filter restrictions](https://github.com/intuit/QuickBooks-V3-PHP-SDK/blob/master/docs/_sources/quickstart.rst.txt)
- [Accounting Payment totals, customer filter, and transaction linkage](https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/Payment)
- [Purchase payee reference](https://static.developer.intuit.com/sdkdocs/qbv3doc/ippdotnetdevkitv3/html/00fa13c7-5af6-952f-853a-f3ae84f21ecf.htm)
- [Journal entry customer/vendor/employee references](https://static.developer.intuit.com/sdkdocs/qbv3doc/ippdotnetdevkitv3/html/62627c63-90a3-c87a-ef9b-8b4b06daee08.htm)
- [Deposit customer and account references](https://static.developer.intuit.com/sdkdocs/qbv3doc/ippdotnetdevkitv3/html/e868d30f-5127-7bd9-7196-43791c97a424.htm)
