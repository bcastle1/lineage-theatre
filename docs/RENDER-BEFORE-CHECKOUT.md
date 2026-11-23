# Render before checkout

New production film orders use `render-before-payment-v1`. The customer reviews the saved film's price, explicitly starts creation, and waits for the finished private film to pass the existing media, native-audio and Astra visual checks. A new QuickBooks invoice can be created only for that completed artifact. Confirmed payment unlocks the same artifact; no new rendering starts after payment.

QuickBooks confirmation is asynchronous. The interface may show “Confirming payment” until the linked Accounting Payment allocations have been checked. Once confirmed, the existing exact-film return opens watch/download. A zero invoice balance, a browser redirect, or a client-side paid flag never unlocks media.

## Studio funding and abandoned films

- A durable studio allowance at `production/prerenders/{ownerHash}/{preparedId}.json` binds the owner, immutable manifest, Seedance recipe, accepted retail price, provider spending ceiling, and future order identity. It never creates a financial order or reports a sale.
- The shared fal funding ledger reserves the full execution ceiling under a distinct pre-render funding identity. Existing customer commitments remain counted. New provider submissions require the same allowance and an owned queue lease. Uncertain provider operations retain their durable claims and funding holds; no automatic resubmission is introduced.
- After admission, video and visual-review authorization verify that the exact reservation remains present, unchanged, and unreleased. They do not compare the original ceiling with the wallet again after earlier clips have debited it. New films still face the full conservative balance check, including every unfinished commitment.
- One unpaid pre-render is allowed per approved account. The conditional owner record prevents concurrent requests from reserving multiple free films. The slot opens after the exact completed film has a genuinely captured, unreversed payment. Completed but abandoned films continue occupying this slot until a separately reviewed administrative resolution.
- Lineage bears production cost if a customer does not buy. Completion releases the rendering commitment through the existing ledger rules, because the provider expense has already occurred. The completed film's checkout does not reserve a second rendering budget.
- No automatic expiry, deletion, refund, or invoice cancellation is added. An old payable invoice must not outlive its artifact through a new cleanup policy. Any future retention policy must reconcile invoice/payment state before removing a private film.
- Current account approval, suspension, password setup, and `LINEAGE_PAYMENT_ACCESS` restrictions remain in force. Creating another screenplay or changing the browser's owner/reference fields cannot expand an allowance.

## Existing orders

Existing saved orders retain their original pay-then-render workflow, including unattempted invoice recovery, awaiting-payment invoices, captured orders, and production already in progress. No stored order is rewritten to the new contract. Pre-render creation rejects a plan with an existing payment order. The new-order invoice guard is enforced on the server even for an old client or a direct API caller.

Planning quotes can still be requested without starting a render. A completed pre-render purchase quote uses its frozen retail price and can be recovered from the private library without the original browser draft. The current merchant connection and checkout terms are still validated when creating the invoice.

If a worker or funding check fails after the allowance is saved but before a queue ticket exists, the editor and private library offer a consented retry of that same prepared film and frozen price. Queued, active, completed, and review-needed films cannot use this retry control. The backend reuses the same allowance and queue identity.

## Delivery and release checks

The worker heartbeat now advertises `preRenderAuthorizationVersion: 1`. New pre-render queueing requires that marker, a matching Seedance recipe, completed-delivery support, and a heartbeat no older than three minutes. Deploy the approved matching worker and web code while new orders are paused, verify the new heartbeat, then enable the approved account scope.

The library exposes “ready to purchase” separately from playback readiness. An unpaid completed film has no watch/download URL. Purchase checks verify the exact private artifact's current pathname, size, and media type before opening an invoice. Paid streaming additionally binds the order to the pre-render allowance and artifact checksum and uses the existing private range/download handler.

Validation includes concurrent unpaid requests, insufficient funding, price changes, access revocation, old-worker rejection, missing private media, direct API checkout before rendering, preserved historical orders, real queue/production service advancement with offline provider IO, and visual-review allowance/lease revocation during inference. The local workflow fixture uses an explicitly labeled existing demonstration MP4; it is not a real payment or a new provider render.

## Local browser verification

Run `node scripts/test-workflow-server.mjs --checkout-fixtures --check` for the offline route proof. Run the same command without `--check` for the browser fixture at `http://127.0.0.1:5178`. The public fictional credentials and current authenticator codes are at `/__workflow`; the harness removes inherited provider settings and blocks external network access.

1. Sign in as the fictional customer, open a seeded draft, prepare its price, and explicitly allow rendering before payment.
2. In `/__workflow/production`, simulate progress for that exact prepared ID, then attach the pinned existing demonstration MP4. Return to the app and verify the film is ready to purchase, with no playback or download available.
3. Open checkout and record the synthetic payment in the local fake QuickBooks tab. The original app tab must verify payment and open the exact saved film with Watch and Download. No second production step is used.
4. Check that the downloaded bytes match the existing sample. The fixture's sample story and duration do not match the plan; this proves the interface and private payment gate, not provider generation quality.
