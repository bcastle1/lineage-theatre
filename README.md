# Lineage Theatre

A family-history film studio with public account registration at [lineagetheater.com](https://lineagetheater.com). React/Vite guides a user through family sources, film development, script and cast review, and production.

## This development branch

MagicLight is the only video provider offered in the active studio, with no external handoff. **GPT-6 Astra generation, MagicLight generation, and QuickBooks charges/refunds remain connection pending.** MagicLight's real full-film API contract, highest-quality settings, commercial entitlement, and the QuickBooks merchant flow must be integrated and verified before paid production. An API key alone cannot activate an unavailable adapter. See [integration status](docs/INTERNAL-FILM-INTEGRATION.md).

Story ideas and full screenplays use GPT-6 Astra through OpenAI Responses, with structured output, explicit source consent, and no model fallback. An administrator must connect the selected existing OpenAI project using server-only `OPENAI_API_KEY`; real model access and quota must be verified before claiming the feature is live.

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
- `MAGICLIGHT_API_PACK_PRICE_CENTS` and `MAGICLIGHT_API_PACK_CREDITS`: optional server reference-rate override; supply both as valid positive integers. An invalid supplied configuration makes the reference rate unavailable. The default public Pro API pack reference is $88 for 80,000 credits, or $1.10 per 1,000 credits; it is not a quote for the highest-quality complete film.

The customer markup is a persisted administrator setting, initially 0%, rather than a client-supplied amount. No card, bank-account, provider credential, or private account-balance values belong in the repository or browser configuration.

Authentication, registration, administration, archive, story, and pricing fixtures are synthetic. Tests that mock private storage or OpenAI do not establish live model access, successful cloud upload, video generation, payment settlement, or refund readiness. No transactional verification/reset email or active QuickBooks checkout is claimed.

See [deployment guidance](DEPLOYMENT.md) and [activation requirements](docs/INTERNAL-FILM-INTEGRATION.md) before promotion.
