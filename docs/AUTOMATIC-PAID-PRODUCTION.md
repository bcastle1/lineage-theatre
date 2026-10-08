# Automatic production after confirmed payment

This change connects a customer's explicit checkout consent to a durable production-start outbox. QuickBooks Accounting must confirm the saved invoice payment. Closing the browser does not lose the intent: the payment reconciliation schedule recovers an interrupted write, and the film-generation schedule attempts the queued start.

The outbox accepts only live, captured, unreversed hosted-invoice orders with dated production consent, an approved current customer, and an unchanged private production manifest. Starting the existing production queue independently rechecks provider readiness, live payment and reversals, the exact paid budget, and the owning account. Its existing film identity prevents duplicate provider work during overlapping or repeated outbox processing. Receipt delivery and provider task polling can fail independently of scheduling.

Existing payments have no new consent inferred. Sandbox, refunded, unpaid and uncertain orders cannot enter this automatic flow. The customer sees automatic-start terms only when production is available; the UI resets acceptance if availability changes.

## Activation remains incomplete

As checked on October 8, 2026, the application's full-film MagicLight adapter is still unavailable. The signed-in MagicLight API portal exposes Hailuo image-to-video credits. The saved text-only full-film attempt has no provider task ID or output. The existing general production worker also requires a working adapter. The payment outbox does not supply or validate one.

Do not interpret passing synthetic payment/queue tests, the existing completed-export delivery path, or a successful website deployment as evidence of new full-film generation. Completing activation requires a supported MagicLight generation path with verified output and a running compatible worker, or an explicitly chosen alternative renderer with truthful pricing and customer terms. The installed LTX renderer is a separate integration and is not silently substituted by this change.

## Verification

Focused tests cover explicit checkout consent, confirmed-payment scheduling, recovery without a browser, current-account and manifest checks, refund/sandbox exclusion, concurrent queue identity, and independent polling/receipt failures. These tests use synthetic in-memory records and do not charge cards, create real invoices, send receipt mail, or spend generation credits.

Before enabling customer production, verify the real provider submission, completed media, signed-in customer playback, and paid access on lineagetheater.com. That live fulfillment check has not passed for this change.
