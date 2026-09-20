# Payment reCAPTCHA and Intuit assessment

On September 16, 2026, Intuit Developer Support case **00227847** reported that Lineage Theater's assessment was **rejected** for missing Payment ReCaptcha. Support reopened the existing questionnaire for correction and resubmission. The user selected `ecastle.wiserlaw@gmail.com` to manage Google reCAPTCHA. Continue the existing Intuit **BROCOTech / Lineage Theater** application; this Google account does not change Intuit app ownership.

## Implemented control

Google reCAPTCHA v3 runs when a user submits sign-in, registration, an MFA sign-in challenge, or payment. The fixed Google verification endpoint receives only the response token and the private server secret. The server requires success, the expected action, an exact allowed hostname, a score at least 0.5 (configurable upward), and a challenge timestamp within two minutes. Missing configuration, provider failure, invalid responses, expired tokens and replay fail closed. Tokens and private keys are never logged or persisted by this implementation.

Payment runs the security check **before** browser-direct Intuit card tokenization. Successful verification creates a random, two-minute proof bound to the authenticated account and immutable quote ID. Only a hash of that proof is stored in private Blob, alongside the account, quote, expiry and consumption flag. The payment route atomically consumes it before invoking checkout, so another account, another quote, reuse, or concurrent reuse cannot authorize another attempt. Order-status and receipt reads remain available without a new CAPTCHA. A rejected proof does not assert that an earlier payment never occurred.

The browser retains the existing one-POST payment behavior and read-only recovery after a lost response. Card information and the temporary proof are not put in project backups or browser storage. The existing merchant activation and production-readiness restrictions remain in force. reCAPTCHA does not enable charging, certify PCI compliance, or grant Intuit production approval.

## Provision before deployment

1. In Google's reCAPTCHA console, use the specified Google account, label **Lineage Theater**, **Score based (v3)**, and domain **lineagetheater.com**. The existing Google Cloud project is **Default Gemini Project**. With the user's explicit approval, the site was registered on September 16, 2026, and Google's origin verification was confirmed enabled. No billing purchase was made.
2. Set the matching `RECAPTCHA_SITE_KEY` and `RECAPTCHA_SECRET_KEY` in the existing Vercel `lineage-theater` project's Production environment. Store the secret as a sensitive server-only variable. Never commit either credential or expose the secret through a `VITE_` variable.
3. Default `RECAPTCHA_ALLOWED_HOSTNAMES` is `lineagetheater.com,www.lineagetheater.com`; `RECAPTCHA_MIN_SCORE` defaults to `0.5`. Keep Google's domain validation enabled. Development/preview hosts require a separately scoped key and explicit hostname configuration, not a production bypass.
4. Deploy the exact tested commit only after credentials are available. This version requires reCAPTCHA for sign-in; deploying without working credentials would block new sign-ins. Configuration is available publicly at `/api/auth?action=captcha`, exposing the public site key only.
5. Verify the actual custom-domain browser can load reCAPTCHA under CSP, obtain a fresh token and complete server verification. Check normal sign-in, registration and MFA where enrolled. Use designated synthetic sandbox payment data only when the existing sandbox readiness gates are satisfied; do not enable real charges to demonstrate CAPTCHA.
6. Verify missing/invalid token rejection, expired/reused proof rejection, and order-status recovery. Record exact deployment/commit and live results before answering the assessment's reCAPTCHA question affirmatively. Automated fixtures establish logic, not Google's live score behavior.
7. Correct only the supported answer in the reopened existing Intuit questionnaire and review its final certification before resubmission. No support email has been sent and no assessment has been resubmitted by this implementation.

## Evidence at implementation checkpoint

The Google site was registered in Edge under the requested account after explicit approval. The matching `RECAPTCHA_SECRET_KEY` (Secret) and `RECAPTCHA_SITE_KEY` (Config) were saved in the existing Vercel project's Production environment; successful saves and environment names were verified without logging credential values.

- `pnpm test`: **258 passed**, zero failures or skips. Tests cover configuration, Google request/response validation, single-use account/quote binding, concurrent consumption, auth rejection before account side effects, payment rejection before processor calls, and preserved GET order recovery.
- `pnpm run build`: TypeScript and Vite passed. The existing large-bundle warning remains.
- Both `node scripts/test-workflow-server.mjs --check` and `node scripts/test-workflow-server.mjs --checkout-fixtures --check` passed. The isolated loopback harness explicitly injects synthetic Google responses and memory-only storage. Its Vite transform redirects only the local reCAPTCHA loader to the harness script; no bypass exists in the deployed app. Captured, declined and uncertain payment fixtures, replay denial and GET recovery passed with zero outbound requests.
- Edge UI: sign-in, preparation, quote, reCAPTCHA notice and simulated checkout succeeded. Reload followed by **Check payment status** recovered the same confirmed order; the synthetic processor count stayed at one. Desktop and 390-by-844 viewport checks showed no horizontal overflow. The duplicate React key shared by the preparation and checkout panels was corrected; no new browser warnings/errors appeared on the rechecked route. Browser fixture data and Google/Intuit responses were synthetic, so these checks do not establish live provider behavior.

## Live rollout — September 16, 2026

- Application revision `0c937106eb0c18bcb32249a1eb9e801503a7150a` was pushed to GitHub main. GitHub's build/test workflow succeeded. Vercel deployment `dpl_8KyPFAePJGxwELe6QB615zYJZ6tV` reached READY with both `lineagetheater.com` and `www.lineagetheater.com` aliases. The HTTPS custom domain returned that exact build marker. Six existing API functions remain; no new function was added.
- `/api/auth?action=captcha` returned required/available true, provider `recaptcha-v3`, and the public site key without a secret. Google settings confirmed v3, the requested owner, `lineagetheater.com`, and enabled origin verification.
- A real Edge request on the custom domain loaded Google's script and passed the server's action/domain/score/time verification. A deliberately nonexistent `example.invalid` account then received the expected incorrect-credentials response. This demonstrates a real accepted Google check; it does not claim a successful real-account sign-in. The browser recorded no warnings or errors for this check.
- A direct same-origin login request without a CAPTCHA response returned HTTP 403 / `CAPTCHA_REQUIRED` before account lookup. No customer account, card, payment or film was created by these production checks.
- The existing deployment script incorrectly rejected the domain's already-configured `dns1.namecheaphosting.com` / `dns2.namecheaphosting.com` nameservers. Its allowlist now recognizes both Namecheap BasicDNS and these exact hosting nameservers; DNS was not changed. The exact-SHA, HTTPS, Vercel and DNS check then passed.
- The existing Lineage Theater questionnaire in BROCOTech was reopened, the **Payment Recaptcha** answer changed to **Yes. My site or app includes reCaptcha**, and Intuit displayed its successful-save confirmation. Final assessment resubmission and approval have not occurred.

## Additional existing assessment mismatches

Final resubmission needs an accurate review of existing answers beyond reCAPTCHA:

- The Payments API tab currently confirms that access tokens are stored in volatile memory only. The current OAuth service encrypts and durably saves access and refresh tokens in private Blob. The linked [Intuit payment-security rules](https://developer.intuit.com/app/developer/qbpayments/docs/learn/ensure-data-security#security-rules-for-your-application) also state the volatile-memory requirement. Encrypted-at-rest storage is not proof of a memory-only implementation. Resolve the actual requirement and implementation before attesting.
- Receipt answers currently include email delivery, fees, masked card information, and the specified Intuit processor/contact disclosure. The app currently offers an in-app JSON download with amount, refunded amount, status, date and its order reference; email delivery and those additional fields are not implemented by this checkout. These selections must be reconciled with supported behavior before resubmission.
- The existing declined/voided/refunded testing answer remains **No**. Synthetic unit and harness outcomes do not establish actual provider transaction-lifecycle verification.

Only the supported reCAPTCHA answer was changed. These observations are not a complete assessment audit, and no unverified company/legal answers were changed or submitted.

## Authorized follow-up implementation

The user authorized resolving these remaining gaps before resubmission. The OAuth implementation now writes version 2 envelopes with an explicit allowlist of refresh-token and grant metadata, never access tokens. Access tokens are AES-GCM encrypted in bounded volatile process memory, bound to current credentials and the exact saved envelope. Cold workers use the existing conditional-write refresh lock; read-only status does not rotate tokens. The owner refresh action conditionally migrates legacy records before renewal, and old storage is blocked from company/Payments use until migrated. Live migration remains a required checkpoint.

In-app receipt downloads now include explicit payment and total amounts, date, confirmed processor transaction reference when present, refund amount/status, and the exact Intuit processor/contact disclosure listed by the questionnaire. Sandbox receipts remain labeled test-only. Email delivery, card last-four and fee details are not represented. Remove those unsupported questionnaire selections after deployment and retain In-App delivery; changing source code does not itself change the saved questionnaire.

Local verification: 264 automated tests cover refresh-only persistence, expiry, credential/envelope binding, cold-worker renewal, legacy migration (including expired refresh), the existing concurrency/cancellation/ambiguous-save cases, and receipt sanitization. TypeScript/Vite build and the isolated checkout harness pass. These tests use synthetic provider responses; live migration, company verification and assessment resubmission remain pending at this code checkpoint.

## Assessment answer after live verification

### September 20 status update

The signed-in existing BROCOTech / Lineage Theater compliance page now reports **Submission status: Completed** and **Results: Approved**. The read-only Payments API answers retain reCAPTCHA Yes, volatile-memory access-token storage, and transaction-lifecycle testing No. Receipt selections are corrected: In-App delivery; payment amount, total, transaction date, transaction ID and the Intuit processor disclosure. Email delivery, fees and card last-four are not selected. This observation supersedes the pending-resubmission and receipt-correction status above. This task did not submit or change the approved questionnaire. Approval does not establish merchant activation, live token migration, processor transaction testing or MagicLight readiness.

Only after the rollout checks above succeed, the supported description is:

> Lineage Theater uses Google reCAPTCHA v3 in its payment submission flow. The server verifies each response's action, hostname, timestamp and risk score before card tokenization is allowed through the app. A short-lived, single-use verification is bound to the authenticated customer and quoted purchase and consumed before checkout. Missing, invalid, expired, reused or low-score verification prevents a new payment attempt. Sign-in and registration are protected as well. Existing-order status checks remain available without submitting another payment.

Do not paste this as a deployed-control attestation before the real Google key and custom-domain verification are complete. Intuit decides assessment approval.

## Official integration references

- [Google reCAPTCHA v3: actions, score and submit-time execution](https://developers.google.com/recaptcha/docs/v3)
- [Server-side response verification and two-minute single-use tokens](https://developers.google.com/recaptcha/docs/verify)
- [Google reCAPTCHA FAQ and CSP requirements](https://developers.google.com/recaptcha/docs/faq)
