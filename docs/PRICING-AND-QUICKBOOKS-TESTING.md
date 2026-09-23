# Film pricing and QuickBooks verification

Prepared September 22, 2026. Source changes require approval before merging or deploying to production.

## Customer behavior

After reviewing the screenplay and allowing private plan storage, **Prepare my pricing** saves the production plan and calculates a fixed film price. A working merchant connection is not required to calculate or display the price. The saved plan remains available if a price request fails, and its download remains available after payment.

An actual verified production quote is preferred. When the generation adapter is unavailable, the server calculates a production cost basis from the saved shot durations and administrator planning rates, then applies the saved markup. The customer approves a single fixed total; later provider expenses or administrator pricing changes do not reprice a captured order. The checkout amount, processor request, saved order and receipt use the same server-owned quote. A changed total must be reviewed again before payment.

The initial markup is **50%** when no prior settings exist. Previously saved explicit markup settings remain intact; Administration provides a 50% preset and a revision-checked Save action.

## Administrator settings

Administration → Pricing and the Overview pricing card explain the fixed-price policy. Pricing supports:

- Markup percentage (default 50%).
- Credits per planned clip (default 286).
- Seconds per planned clip (default 6).
- Render attempts per planned clip (default 1).

The published [Magiclight API pricing page](https://magiclight.ai/openclaw/pricing/) was read in the browser on September 22, 2026: Pro pack $88, 80,000 credits, advertised up to 280 Hailuo-series image-to-video clips. The 286-credit default rounds 80,000 / 280 up. Six seconds is an editable planning assumption, not verified API capability. Each shot is rounded up independently to a whole planned clip; repeat attempts multiply that count. Credit conversion and markup use integer arithmetic rounded to cents.

Final quality, voice, music, assembly and retry costs may differ from this planning calculation. BROCO retains the customer's agreed price and absorbs those differences. The stored cost basis is labeled as planning-based internally; it never asserts provider API, quality or commercial verification.

## Payment and production boundaries

The existing QuickBooks OAuth, merchant-binding, card-entry and payment-activation checks still apply before checkout. Pricing alone does not enable live charges. A captured payment is not proof of bank settlement or a completed film.

The owner-only QuickBooks sandbox panel can independently submit a fixed $1 fictional-card charge, read it back, refund it and read back the refund. It uses one durable test per saved grant, rejects production connections and arbitrary card/amount/URL input, and never repeats an uncertain processor mutation. A tokenization failure before a charge attempt can be retried safely. Nonsecret charge and refund request references support investigation.

The sandbox test does not create a customer order or authorize rendering. Magiclight generation remains unavailable until a documented and verified adapter is connected. Paid planning-based orders need a fresh verified provider budget before rendering; their retail price stays fixed. Provider spending cannot exceed the stored cost budget automatically. One persisted provider quote governs all scenes; if it expires after production starts, further spending stops until the production budget is resolved.

## Validation

All 346 automated tests pass, and the TypeScript/Vite production build passes. Tests cover pricing arithmetic and settings, ownership and saved-plan integrity, invalid/expired provider replies, displayed-price-to-charge consistency, immutable orders, bounded deferred fulfillment, owner-only sandbox operations, duplicate requests, ambiguous outcomes and secret exclusion.

The synthetic workflow server forbids all outbound fetches and uses only fictional accounts, films and card tokens. Its route checks verify pricing while billing is unavailable and captured/declined/uncertain checkout outcomes. Browser verification completed preparation → $1.41 fixed price → $1.41 test payment confirmation, with the prepared-plan download retained. The administrator's 50% markup and planning values were edited, saved and read back in that local fixture.

Intuit's real public sandbox token endpoint accepted its published fictional card fixture in a separate token-only check. That token was discarded; no real Intuit charge or refund was submitted. Live merchant activation, a real provider lifecycle and Magiclight rendering have not been verified by these tests.

Commands:

```text
node --test tests/*.test.mjs
pnpm build
node scripts/test-workflow-server.mjs --check
node scripts/test-workflow-server.mjs --checkout-fixtures --check
node scripts/test-intuit-sandbox-token.mjs --tokenize
```

After an approved production release, sign in as owner, verify Administration → Pricing and save 50% if an earlier explicit rate is present. Verify the current QuickBooks environment and merchant state independently before claiming live payment readiness. Production release evidence must include the approved commit, deployment status, served release and signed-in behavior.
