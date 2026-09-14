# Lineage Theatre

A family-history film studio with public account registration at [lineagetheater.com](https://lineagetheater.com). React/Vite guides a user through family sources, film development, script and cast review, and production.

## Current capabilities

MagicLight is the only video provider offered in the active studio, with no external handoff. **GPT-6 Astra ideas and screenplay generation are connected and verified. MagicLight film generation and QuickBooks charges/refunds remain connection pending.** The MagicLight production pipeline still needs verified API operations, quality and cost settings, any required clip assembly, and commercial entitlement; the QuickBooks merchant flow must also be integrated and verified before paid production. An API key alone cannot activate an unavailable adapter. See [integration status](docs/INTERNAL-FILM-INTEGRATION.md).

Story ideas and full screenplays use GPT-6 Astra through OpenAI Responses, with structured output, explicit source consent, and no model fallback. The selected existing OpenAI project is connected through server-only `OPENAI_API_KEY`. On September 14, 2026, live fictional tests confirmed the exact `gpt-6-astra` response model, a screenplay, and ten story ideas. A signed-in production UI test then read the full fictional narrative and uploaded TXT file and produced five editable scenes, four recurring characters, and nine disclosed assumptions without a redirect. These checks establish story development, not finished-video rendering or payment readiness; future requests remain subject to model access and quota.

The default film treatment is a hopeful, animated story based on a true story. Script development includes a recurring ensemble, narration, dialogue, visual directions, source references and a reviewable assumptions ledger. Known facts are preserved; inferred or invented people and connective scenes are disclosed. Documentary mode restricts invention. The chosen highest-quality setting is a production preference until the MagicLight API's actual options are verified.

## Accounts, archive, and administration

- Public customer registration with normalized email, bounded name/password fields, explicit terms/privacy consent, IP/email request limits, and atomic private Blob account creation. Customer accounts begin unverified and cannot assign their own roles.
- Salted scrypt hashes, secure HTTP-only signed sessions, same-origin mutation checks, and durable request limits. Existing temporary-password accounts retain first-login password setup. Suspended accounts lose session access.
- Persisted owner/admin/customer roles. The owner delegates administrator access through private, expiring invitations and can revoke it. Administrators can review accounts, opted-in cloud films, recorded payment history, pricing settings, and activity records within their permitted scope. An email address alone never grants ownership.
- Account-specific local working projects and IndexedDB source files. Optional cloud saving requires separate consent for limited film metadata and a selected finished MP4/WebM video in private Blob storage, accessible to that customer and authorized administrators. This archive can be viewed across devices; source documents and full working projects do not automatically sync.
- Pricing defaults to a 0% markup over MagicLight costs. Authorized administrators can configure a percentage for future quotes; the stored revision prevents silently overwriting a concurrent pricing change. Reference credit rates are separate from complete-film estimates, which remain unavailable pending a verified provider quote. Pricing settings never activate charges or refunds.

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
- `OPENAI_API_KEY`: selected existing OpenAI project's credential with GPT-6 Astra access.
- `QUICKBOOKS_ENVIRONMENT`: explicitly `sandbox` or `production`; no environment is inferred.
- `QUICKBOOKS_CLIENT_ID` and `QUICKBOOKS_CLIENT_SECRET`: matching Intuit application credentials, server-only.
- `QUICKBOOKS_TOKEN_ENCRYPTION_KEY`: a dedicated, cryptographically random 32-byte key encoded as base64, stored only in the server secret vault. Do not reuse the session secret or rotate this key without handling the saved authorization.
- `MAGICLIGHT_API_PACK_PRICE_CENTS` and `MAGICLIGHT_API_PACK_CREDITS`: optional server reference-rate override; supply both as valid positive integers. An invalid supplied configuration makes the reference rate unavailable. The default public Pro API pack reference is $88 for 80,000 credits, or $1.10 per 1,000 credits; it is not a quote for the highest-quality complete film.

The customer markup is a persisted administrator setting, initially 0%, rather than a client-supplied amount. No card, bank-account, provider credential, or private account-balance values belong in the repository or browser configuration.

Authentication, registration, administration, archive, story, and pricing fixtures are synthetic. Tests that mock private storage or OpenAI do not establish live model access, successful cloud upload, video generation, payment settlement, or refund readiness. No transactional verification/reset email or active QuickBooks checkout is claimed.

## QuickBooks connection

The owner manages Intuit authorization at `https://lineagetheater.com/#admin/payments`. Administrators can read its status. Connection changes require authenticated, same-origin POST requests; opening a connect or disconnect link does not change access. The fixed OAuth callback is `https://lineagetheater.com/api/quickbooks?action=callback`.

This connection foundation requests Payments and Accounting access for BROCO Technologies LLC. It uses a short-lived, single-use browser-bound OAuth state, rechecks the owner's saved role and password version, encrypts tokens with AES-256-GCM in private Blob, and uses conditional writes to prevent concurrent connection changes from silently overwriting each other. The cross-site return uses a separate HttpOnly/Secure/SameSite=Lax state cookie; the normal session remains SameSite=Strict. Callback results never contain credentials and do not establish merchant readiness.

The owner can select **Verify company** to make one authenticated, read-only Accounting CompanyInfo request for the saved company. Administration displays only the returned company name, legal name, country, and verification time. The result confirms Accounting access for that authorization; it does not establish merchant eligibility or payment-processing capability. An expired token, changed connection, or failed check cannot enable checkout.

Authorization, merchant readiness, payment capture, refunds, and accounting synchronization are separate states. A serialized refresh service exists only inside the server; status and company checks never refresh tokens automatically. No card tokenization, Payments transactions, or Accounting writes are enabled. The owner-approved sandbox authorization and encrypted token storage were verified on September 14, 2026; production authorization, real refresh/revocation, and financial processing remain pending. See [QuickBooks setup](docs/QUICKBOOKS-SETUP.md) for the current evidence and activation requirements.

See [deployment guidance](DEPLOYMENT.md) and [activation requirements](docs/INTERNAL-FILM-INTEGRATION.md) before promotion.
