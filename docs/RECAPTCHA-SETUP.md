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

The Google site was registered in Edge under the requested account after explicit approval. The matching `RECAPTCHA_SECRET_KEY` (Secret) and `RECAPTCHA_SITE_KEY` (Config) were saved in the existing Vercel project's Production environment; successful saves and environment names were verified without logging credential values. Deployment, actual Google verification, and assessment resubmission are still pending at this checkpoint.

- `pnpm test`: **258 passed**, zero failures or skips. Tests cover configuration, Google request/response validation, single-use account/quote binding, concurrent consumption, auth rejection before account side effects, payment rejection before processor calls, and preserved GET order recovery.
- `pnpm run build`: TypeScript and Vite passed. The existing large-bundle warning remains.
- Both `node scripts/test-workflow-server.mjs --check` and `node scripts/test-workflow-server.mjs --checkout-fixtures --check` passed. The isolated loopback harness explicitly injects synthetic Google responses and memory-only storage. Its Vite transform redirects only the local reCAPTCHA loader to the harness script; no bypass exists in the deployed app. Captured, declined and uncertain payment fixtures, replay denial and GET recovery passed with zero outbound requests.
- Edge UI: sign-in, preparation, quote, reCAPTCHA notice and simulated checkout succeeded. Reload followed by **Check payment status** recovered the same confirmed order; the synthetic processor count stayed at one. Desktop and 390-by-844 viewport checks showed no horizontal overflow. The duplicate React key shared by the preparation and checkout panels was corrected; no new browser warnings/errors appeared on the rechecked route. Browser fixture data and Google/Intuit responses were synthetic, so these checks do not establish live provider behavior.

## Assessment answer after live verification

Only after the rollout checks above succeed, the supported description is:

> Lineage Theater uses Google reCAPTCHA v3 in its payment submission flow. The server verifies each response's action, hostname, timestamp and risk score before card tokenization is allowed through the app. A short-lived, single-use verification is bound to the authenticated customer and quoted purchase and consumed before checkout. Missing, invalid, expired, reused or low-score verification prevents a new payment attempt. Sign-in and registration are protected as well. Existing-order status checks remain available without submitting another payment.

Do not paste this as a deployed-control attestation before the real Google key and custom-domain verification are complete. Intuit decides assessment approval.

## Official integration references

- [Google reCAPTCHA v3: actions, score and submit-time execution](https://developers.google.com/recaptcha/docs/v3)
- [Server-side response verification and two-minute single-use tokens](https://developers.google.com/recaptcha/docs/verify)
- [Google reCAPTCHA FAQ and CSP requirements](https://developers.google.com/recaptcha/docs/faq)
