# Lineage Theatre

A family-history film studio with public account registration at [lineagetheater.com](https://lineagetheater.com). React/Vite guides a user through family sources, film development, script and cast review, and production.

The [media library](docs/MEDIA-LIBRARY.md) stores new original uploads privately across devices. Customers can add, download, rename, reuse, archive, trash and restore source media. Administration retains all customers' media independently and provides an archive with permanent deletion. Earlier sources can be copied from their original browser; working drafts remain browser-local.

## Current capabilities

New paid films are produced with Kling O3 Pro reference-to-video through fal, with no external handoff. Customers pay a QuickBooks Online invoice on Intuit's hosted payment page, and production then starts automatically. MagicLight, LTX and local-video creation are retired for customers ([automatic realistic production](docs/AUTOMATIC-REALISTIC-PRODUCTION.md)); the remaining MagicLight code is an owner-only pilot path. **Story ideas and screenplays use GPT-6.2 Astra.** What the payment-to-film flow does today, and what has and has not been verified live, is described under [Current status](#current-status-november-18-2026).

Story ideas and full screenplays use GPT-6.2 Astra (`gpt-6.2-astra`) through OpenAI Responses, with structured output, explicit source consent, and no model fallback. The studio checks model access using the existing server-only `OPENAI_API_KEY`. On September 14, 2026, live fictional tests confirmed the exact `gpt-6-astra` response model, a screenplay, and ten story ideas. A signed-in production UI test then read the full fictional narrative and uploaded TXT file and produced five editable scenes, four recurring characters, and nine disclosed assumptions without a redirect. These checks establish story development, not finished-video rendering or payment readiness; future requests remain subject to model access and quota.

The default film treatment is a hopeful, animated story based on a true story. Script development includes a recurring ensemble, narration, dialogue, visual directions, source references and a reviewable assumptions ledger. Known facts are preserved; inferred or invented people and connective scenes are disclosed. Documentary mode restricts invention. Production requests 1080p Kling video with native audio; passing checks is not a promise of perfect likeness or historical accuracy ([film quality](docs/film-quality-reliability.md)).

## Current status (November 18, 2026)

This section summarizes the dated records as of November 18, 2026. Older documents in `docs/` keep their dated content; where they describe MagicLight as the video provider, QuickBooks charges as pending, or the worker as not provisioned, this section and the records cited here supersede them.

### How a paid film is produced

1. **Price and invoice.** The customer saves a production plan and receives a fixed price: a live fal quote for that plan plus the saved markup. Checkout needs a fresh worker heartbeat, enough fal credit for this film and every outstanding reservation ([production credit](docs/FAL-FUNDING.md)), and the customer's consent to automatic production. It creates one QuickBooks Online invoice, which the customer pays on Intuit's hosted page. Lineage Theatre never receives card or bank details ([hosted checkout](docs/HOSTED-CHECKOUT.md)).
2. **Payment detection.** QuickBooks sends no notification, so the app reads the invoice and its linked Payment records. While the payment page is open it checks every 30 seconds, for at most 48 checks or 24 minutes (`src/studio/payment-confirmation.ts`). The Vercel cron `/api/payment-reconcile` runs every minute (`vercel.json`) and examines at most three saved orders per run, so with the browser closed detection can take several minutes when many orders are saved. An order counts as paid only when the invoice balance is zero and the linked payments equal the exact amount.
3. **Automatic production outbox.** On payment, a durable start record is saved and the film is queued with no human approval ([automatic production](docs/AUTOMATIC-PAID-PRODUCTION.md)). The `/api/film-generation` cron runs every minute and retries an interrupted handoff.
4. **Generation on the self-hosted worker.** Vercel functions only queue films. A separate Docker worker on the IONOS host (`scripts/production-worker.mjs`, `deploy/worker/`) runs a pass 15 seconds after the previous pass ends. It creates still references and composed starting images with Nano Banana Pro and video clips with Kling O3 Pro, both through fal. Before each paid operation, lineagetheater.com issues a grant of at most 60 seconds after re-reading the QuickBooks invoice and payments, checking for recorded reversals and confirming a valid fal price within the paid ceiling, refreshed when the saved quote has expired (`api/_lib/hosted-checkout.mjs`).
5. **Speech and visual reviews.** Since November 5, each composed starting image is reviewed before its video request ([cast continuity](docs/VIDEO-CAST-CONTINUITY-20261105.md)). Finished clips are sampled and reviewed for appearance, wardrobe, action and image integrity, and narration is transcribed locally and checked against the script, with a bounded local soundtrack repair ([film quality](docs/film-quality-reliability.md)). A mismatch, an uncertain review or a provider failure pauses the film for attention; nothing is regenerated automatically.
6. **Delivery to the library.** The worker assembles the film with FFmpeg, uploads it privately, and verifies the stored checksum and duration. The film library shows Watch only after the stored media and the payment are validated again; a payment page that is still open then opens the film. No delivery estimate is shown until five comparable films have finished; the owner's saved terms request delivery within 24 hours of payment ([hosted checkout](docs/HOSTED-CHECKOUT.md)).

### Verified live

- **September 23, 2026:** production QuickBooks was connected, and the owner's $3.30 test payment on invoice 207 was recorded by QuickBooks. Customer and merchant receipt delivery was confirmed; the delivery mechanism is not recorded, and no Microsoft Graph mail configuration is recorded ([QuickBooks setup](docs/QUICKBOOKS-SETUP.md), [production worker](docs/PRODUCTION-WORKER.md)).
- **October 19, 2026:** an existing paid film was delivered and playable only after an operator recovered its soundtrack by hand; it was not an automatic run (PR #55–#61).
- **October 20, 2026:** a $3 fictional Kling operator test film, with no payment, passed speech review, assembly, private readback and signed-in playback (PR #66).
- **October 23, 2026:** the only recorded automatic run from a real payment to a delivered film. QuickBooks invoice 354 for $7.88 was paid at 17:31:13 UTC. Production was queued 1.2 seconds after the payment was recognized, and the 30-second 1080p film was ready at 17:49:29 UTC, about 18 minutes later. The payment page opened the film, and signed-in desktop and mobile playback were verified. The content was fictional and the payment was a test. This ran on release 0ef5815 (PR #74); the display-only 49e468f (PR #75) was deployed at 17:53:51 UTC, after the film was ready. The worker recorded with the final release was `sha256:b29ea599…`. The run used the earlier pipeline that predates character binding (PR #74 and #75 descriptions; [film quality](docs/film-quality-reliability.md#observed-results-october-23-2026)).

No payment by an outside customer is recorded. Both production payments identified in the records (invoices 207 and 354) were tests; the records do not identify which order paid for the film delivered on October 19.

### Not yet verified

- **No film has been delivered under the current pipeline.** Since November 5 every new plan uses character binding version 3 (`api/_lib/kling-character-binding.mjs`). The four live operator tests that day used fictional content and no invoice, and none delivered a film:
  - Test A on the October 23 source: three clips rendered, and the visual review blocked delivery because two characters shared one apron colour ([delivery verification](docs/VIDEO-DELIVERY-VERIFICATION-20261105.md)).
  - Test B, PR #77 (binding v1): all three video requests returned HTTP 422, and web traffic was rolled back ([element contract](docs/KLING-ELEMENT-CONTRACT-20261105.md)).
  - Test C, PR #78 (binding v2): all clips completed, and the visual review rejected scene 2 for a duplicated character. The library was left on **Finishing checks**; its status correction (`scripts/reconcile-operator-finishing.mjs`) is not recorded as applied ([cast continuity](docs/VIDEO-CAST-CONTINUITY-20261105.md)).
  - Test D, binding v3 (job `ec43a635…`): fal rejected a character portrait with HTTP 403 because credits were exhausted. After a top-up, the PR #80 recovery was deployed as a3c090a at 21:25:37 UTC, but its replacement portrait also failed with `TOP_UP` ([funded recovery](docs/FUNDED-REFERENCE-RECOVERY-20261105.md) for the original 403; the description of PR #81 for the failed replacement).
- **PR #81** (open, not merged) would reuse a verified earlier portrait to resume Test D. Its read-only plan passed on November 5. A review on November 18 found that it can no longer run: Test D's spending grant lasts at most 24 hours (`scripts/test-kling-cast-continuity.mjs`) and expired no later than November 6, 2026, and the reuse correctly refuses an expired grant before any provider request or storage write. It was therefore not merged, and Test D will not be resumed. Its film has not reached Ready or playback. Delivering a film under the current pipeline needs a new, separately approved test with its own grant and spending ceiling, or a real paid order through the ordinary checkout.
- Not recorded live: payment detection by the cron with the payment page closed, a refund of a hosted payment, and receipt email through Microsoft Graph. The release checklist in [film quality](docs/film-quality-reliability.md) has not been completed for the current (binding v3) pipeline; the October 23 observations cover parts of it for the superseded candidate.
- The November 18 redesign changed presentation only; no paid flow has been run on it live.
- Offline, the full suite passes (1,276 tests on November 18, 2026), and the offline workflow simulator (`scripts/test-workflow-server.mjs`) passes all four `--check` modes after its November 18 repair and now runs in CI. `tests/paid-production-flow.test.mjs` joins checkout, payment, outbox, queue, reviews and delivery with stand-in QuickBooks, provider, model and storage connections, so it does not show that live production works.

### What must be true at runtime

- **Worker heartbeat:** `production/worker-health.json` must be no older than 180 seconds and advertise the Kling recipe and model, `ready` and `deliveryChecksVersion` 1; plans with visual continuity also need `visualChecksVersion` 1, plans with character photos `referencePhotoVersion` 1, and new bound plans `characterBindingVersion` 3 (`api/_lib/fal-production.mjs`). Otherwise new prices and checkouts are refused with "Film production is temporarily unavailable" (or a related "being updated" message for the version checks). No record names a worker image with capability 3 or a verified capability-3 heartbeat, and whether the worker is running today is not recorded.
- **fal credit:** `FAL_KLING_KEY` for quotes and generation, and `FAL_BILLING_KEY` and `FAL_BILLING_ACCOUNT` on the web runtime for the credit check. Credit must cover the new film and every outstanding reservation, or new invoices are blocked. Credits ran out on November 5; the current balance is not recorded.
- **QuickBooks connection:** a working production OAuth grant and saved, enabled hosted-checkout settings. Payment detection and every paid production operation read QuickBooks, so a lapsed connection stops both.
- **Crons and services:** `CRON_SECRET` for the per-minute crons, `OPENAI_API_KEY` for the reviews, `LINEAGE_WORKER_SECRET` shared by the web runtime and the worker, and `BLOB_READ_WRITE_TOKEN` for private storage.
- **`LINEAGE_PAYMENT_ACCESS`:** saved as `owner` in production on September 23, 2026 ([QuickBooks setup](docs/QUICKBOOKS-SETUP.md)), and no later record shows a change. While it is `owner`, only the owner can obtain an invoice or production authorization (`api/_lib/hosted-checkout.mjs`, [payment readiness](docs/PAYMENT-READINESS-REVIEW.md)). Opening payment to approved customers is a separate decision. Do not use the merchant's own card to manufacture a sale ([hosted checkout](docs/HOSTED-CHECKOUT.md)).

## Accounts, archive, and administration

- The customer studio shows story development, film availability, and price approval in Lineage Theatre language. Provider names, connection diagnostics, supplier rates, markup settings, and quality verification live under Administration → Overview → Studio status. Customer studio API responses and project exports omit operational provider attribution; privacy and payment disclosures remain in their policy context.
- Public customer registration with normalized email, bounded legal-name/password fields, explicit terms/privacy consent, and separate versioned source-ownership/sharing acceptance. The server records the accepted text and electronic-signature evidence, rejects stale terms, and atomically creates the private Blob account. Customers begin unverified and cannot assign their own roles. Administration can edit and publish new agreement versions without rewriting earlier acceptances.
- Salted scrypt hashes, secure HTTP-only signed sessions, same-origin mutation checks, and durable request limits. Existing temporary-password accounts retain first-login password setup. Suspended accounts lose session access.
- Persisted owner/admin/customer roles. The owner delegates administrator access through private, expiring invitations and can revoke it. Administrators can review accounts, opted-in cloud films, recorded payment history, pricing settings, and activity records within their permitted scope. An email address alone never grants ownership.
- Account-specific local working projects and IndexedDB source files. Optional cloud saving requires separate consent for limited film metadata and a selected finished MP4/WebM video in private Blob storage, accessible to that customer and authorized administrators. This archive can be viewed across devices; source documents and full working projects do not automatically sync.
- Customer film prices use a verified live provider quote for the saved plan, plus the saved markup (initially 50% when no explicit setting exists). Authorized administrators can configure markup for future quotes; the planning-rate settings that remain in Administration cannot produce a customer film price (`api/_lib/film-pricing.mjs`). Stored revisions prevent silently overwriting concurrent changes. The approved checkout total is the fixed payment amount. Pricing settings never activate merchant connections or rendering.

## Story preparation

- TXT, MD, CSV, GEDCOM, DOCX, legacy DOC and PDF text extraction. Source text and PDF pages are not silently truncated. Scans, failed pages, embedded pictures, audio and video receive accurate processing feedback.
- Up to 200 sources and one million source characters per story request, with explicit rejection before transmission if the archive exceeds the budget. Bounded reference photos and read-coverage warnings explain which materials were considered.
- Editable story directions, cast, scenes, dialogue and assumptions; manual outline and project/production-brief downloads. Browser storage errors remain visible; retain original files and download backups.

## Development

Use Node 22+ and pnpm 11.7.0.

```
pnpm install --frozen-lockfile
pnpm run dev
pnpm run build
pnpm test
```

The development server serves Vite and API handlers at http://127.0.0.1:5173. Use an ignored `.env.local` for server-only settings. Never expose credentials through `VITE_` variables or commit them.

- `BLOB_READ_WRITE_TOKEN`: existing private Vercel Blob account, request-limit, administrator, pricing, and opted-in finished-film archive store.
- `LINEAGE_SESSION_SECRET`: existing server session-signing secret.
- `RECAPTCHA_SITE_KEY` and `RECAPTCHA_SECRET_KEY`: matching Google reCAPTCHA v3 credentials for this domain. Only the site key is public. Missing configuration blocks sign-in, registration, MFA sign-in, and new payment requests. Provision before deploying this change; see [reCAPTCHA setup and verification](docs/RECAPTCHA-SETUP.md).
- `RECAPTCHA_ALLOWED_HOSTNAMES`: exact comma-separated hostnames, default `lineagetheater.com,www.lineagetheater.com`. Register the same domain with Google. No wildcards.
- `RECAPTCHA_MIN_SCORE`: optional minimum v3 score, default `0.5`; only values from `0.5` through `1` are accepted.
- `OPENAI_API_KEY`: selected existing OpenAI project's credential with `gpt-6.2-astra` access.
- `QUICKBOOKS_ENVIRONMENT`: explicitly `sandbox` or `production`; no environment is inferred.
- `LINEAGE_PAYMENT_ACCESS`: optional production access restriction. `owner` limits payment operations and card entry to the current saved owner; unset or `approved` retains approved-account access. Other supplied values disable production payment authorization. This never substitutes for production credentials, merchant activation, signed readiness reviews, or payment consent. Existing authorized order/receipt reads remain available. See [payment readiness](docs/PAYMENT-READINESS-REVIEW.md).
- `QUICKBOOKS_CLIENT_ID` and `QUICKBOOKS_CLIENT_SECRET`: matching Intuit application credentials, server-only.
- `QUICKBOOKS_TOKEN_ENCRYPTION_KEY`: a dedicated, cryptographically random 32-byte key encoded as base64, stored only in the server secret vault. Do not reuse the session secret or rotate this key without handling the saved authorization.
- `MAGICLIGHT_API_PACK_PRICE_CENTS` and `MAGICLIGHT_API_PACK_CREDITS`: optional server reference-rate override; supply both as valid positive integers. An invalid supplied configuration makes the reference rate unavailable. The default public Pro API pack reference is $88 for 80,000 credits, or $1.10 per 1,000 credits; it is not a quote for the highest-quality complete film.

The customer markup is a persisted administrator setting, initially 50% when no explicit setting exists, rather than a client-supplied amount. No card, bank-account, provider credential, or private account-balance values belong in the repository or browser configuration.

Authentication, registration, administration, archive, story, and pricing fixtures are synthetic. Tests that mock private storage or OpenAI do not establish live model access, successful cloud upload, video generation, payment settlement, or refund readiness. No transactional verification/reset email is claimed. Live QuickBooks-hosted checkout evidence is listed under [Current status](#current-status-november-18-2026).

## QuickBooks connection

The owner manages Intuit authorization at `https://lineagetheater.com/#admin/payments`. Administrators can read its status. Connection changes require authenticated, same-origin POST requests; opening a connect or disconnect link does not change access. The fixed OAuth callback is `https://lineagetheater.com/api/quickbooks?action=callback`.

On September 20, 2026, the existing BROCOTech / Lineage Theater Intuit compliance page showed **Submission Completed** and **Results Approved**. Its read-only receipt answers match in-app delivery and the supported receipt fields; email, fees and card last-four are unselected. The declined/voided/refunded testing answer remains **No**. Assessment approval does not establish merchant activation, live authorization migration, verified sandbox transaction lifecycles or enabled customer charges.

This connection foundation requests Payments and Accounting access for BROCO Technologies LLC. It uses a short-lived, single-use browser-bound OAuth state, rechecks the owner's saved role and password version, and uses conditional writes to prevent concurrent connection changes. Refresh tokens and grant metadata are encrypted with AES-256-GCM in private Blob. Access tokens are encrypted in process memory only; a cold worker obtains fresh access through serialized renewal. Legacy saved access tokens require the owner's Refresh authorization action to migrate. The cross-site return uses a separate HttpOnly/Secure/SameSite=Lax state cookie; the normal session remains SameSite=Strict. Callback results never contain credentials and do not establish merchant readiness.

The owner can select **Verify company** to make one authenticated, read-only Accounting CompanyInfo request for the saved company. Administration displays only the returned company name, legal name, country, and verification time. The result confirms Accounting access for that authorization; it does not establish merchant eligibility or payment-processing capability. An expired token, changed connection, or failed check cannot enable checkout.

Authorization, merchant readiness, payment capture, refunds, and accounting synchronization are separate states. The owner can renew through a same-origin POST; status GETs never renew. A company check can renew missing memory access before its read. The legacy direct-card Payments API path requires separate signed readiness reviews; customer checkout uses QuickBooks-hosted invoices instead (see [Current status](#current-status-november-18-2026)). The original sandbox consent and code exchange were verified on September 14, 2026; the September 16 storage change requires live migration verification. See [QuickBooks setup](docs/QUICKBOOKS-SETUP.md) and [the assessment record](docs/RECAPTCHA-SETUP.md) for current evidence and activation requirements.

See [deployment guidance](DEPLOYMENT.md) and [activation requirements](docs/INTERNAL-FILM-INTEGRATION.md) before promotion.

The [production worker and private delivery](docs/PRODUCTION-WORKER.md) support durable production requests, verified assembly, and authenticated playback/download. The worker is installed on the IONOS host and renders with Kling through fal. It was last recorded active with a fresh heartbeat on October 23, 2026, and the binding v2 worker was heartbeat-verified on November 5 (PR #74, #75 and #78); whether it is running now is not recorded. See [Current status](#current-status-november-18-2026) for what has been verified and what must be true at runtime. [Payment readiness reviews](docs/PAYMENT-READINESS-REVIEW.md) govern the legacy direct-card path and the owner-only payment access setting.
