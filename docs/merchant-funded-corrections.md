# Merchant-funded film corrections

The owner can approve one corrected Kling film against an existing captured
QuickBooks hosted-invoice order. This action creates no invoice, customer
charge, replacement payment record, or edited financial receipt.

The owner-only `createProductionCorrection` admin action accepts
`originalOrderId`, `preparedId`, `manifestHash`, `maximumCostCents`, a plain-text
`reason`, and `confirmed: true`. The current supported ceiling is 1,980 cents.
The owner must own both the original order and the corrected saved plan.
The original and target preparations and manifest hashes must differ.

Approval checks the original immutable paid quote, current account and company,
live invoice and Payment allocations, and a fresh recorded-reversal scan.
It obtains an actual Kling price and reserves the approved provider budget
through the same fal funding ledger used by checkout. Existing production
billing credentials and account binding are required.

Private records are separate from accounting:

- `production/correction-claims/<correctionId>.json` fixes one original order
  to one corrected plan, exact manifest, screenplay, source list, Kling recipe,
  provider budget, and owner approval.
- `production/correction-targets/<ownerHash>/<preparedId>.json` fixes one target
  to that grant.
- `production/corrections/<correctionId>.json` is published only after funding
  is reserved and payment, owner, and target are rechecked.

All three records are immutable and verified by exact readback. An uncertain
write is reconciled; it is never overwritten. A retry with the same inputs
recovers the same approval. Conflicting targets, budgets, or approval reasons
are rejected. A funding or publication interruption may leave a private claim
or budget hold for that exact correction; retrying the same approval resumes it.

The queue uses `correctionId` as its internal authorization reference. Each new
paid operation still obtains a short-lived server grant after fresh original
payment and reversal checks. A fresh read-only Kling price must fit both the
original execution ceiling and the approved budget. An expired pricing snapshot
can therefore be refreshed without changing the immutable approval, provider
request identities, original order, or already-submitted shots.

The worker saves the correction and original-order references on the target
job. Private playback and authored soundtrack recovery validate that explicit
grant, the exact saved target, and the intact original paid record. Normal
media verification and speech checks remain required.

Library list and detail responses expose validated coverage separately from
`payments`: `kind: "original-payment"`, correction ID, original order/preparation,
original amount/currency, receipt availability, and zero additional customer
charge. Receipt downloads continue to use the original financial order.

Stored delivery access is based on the original recorded payment; live
Accounting and recorded-reversal validation runs before new production expense.
Accounting confirmation does not assert bank settlement or absence of refunds
made outside QuickBooks.
