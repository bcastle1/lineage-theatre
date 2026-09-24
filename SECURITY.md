# Security Policy

Contact: `info@lineagetheater.com`. Account and deletion requests: `admin@brocotech.ai`.

Lineage Theatre is a React/Vite application with authenticated Vercel API routes. Public registration, server-enforced roles, and an optional private finished-film archive are distinct from provider activation: GPT-6 Astra generation, MagicLight generation, and QuickBooks charges/refunds remain connection pending.

## Account and access controls

- Public registration validates and normalizes email, bounds names and 12–128-character passwords, and requires explicit terms/privacy consent. New records are always active, unverified customers; client role, status, and verification fields cannot grant access.
- Passwords use salted scrypt hashes in private Vercel Blob storage. Account creation uses a fixed account path with overwrite disabled; a duplicate or racing request cannot replace a password or role.
- Signed, secure, HTTP-only, SameSite=Strict cookies expire and are checked against the stored account on each session lookup. Password changes invalidate earlier sessions. Suspended accounts cannot sign in or continue a session. Temporary-password accounts cannot enter the studio before setting a personal password.
- Roles come from persisted server records. The reserved owner address alone does not confer ownership. The owner delegates administrator access through private, expiring invitations; customers cannot promote themselves. Administrative changes use authorization checks and private audit records.
- Same-origin checks protect app mutations. Registration, sign-in, story requests, uploads, and administrative writes have durable request limits.

## Family data and uploads

- Working projects and local source copies remain in localStorage and IndexedDB. New originals also save to the private media library with customer/administrator access. Earlier local files require an explicit Copy browser sources action. Customer trash and archive retain server originals; only administrators can purge them from their separate archive. See `docs/MEDIA-LIBRARY.md` for authorization, upload, deletion and retention controls. Local storage is not an encrypted vault, and clearing it does not erase server records or originals.
- The separate cloud archive requires explicit consent to save limited film metadata and an optional finished MP4/WebM video with administrator access. It does not upload source documents or full working screenplays. Private Blob paths are scoped to the account; media routes authorize the owner or an administrator before streaming.
- Upload tokens are limited to authorized paths, formats, and sizes. Upload completion is checked before a video is marked available. Format/header checks are not malware scanning or a certification that media content is safe.
- TXT, PDF, and DOCX extraction is local. Supported legacy DOC extraction uses the authenticated app server. Originals are retained separately by the media library. Unread scans and untranscribed recordings must not be cited as if their contents were understood.

## Providers and money

- Credentials remain server-side and must never use `VITE_` variables or appear in logs, tickets, client bundles, or source control.
- Story requests require explicit user consent and use GPT-6 Astra through OpenAI Responses with `store: false`, structured output, and no model fallback. Uploaded material and excluded titles remain untrusted input. `store: false` is not a zero-retention guarantee.
- MagicLight is the sole video provider in the active studio. Generation stays disabled until the real full-film contract and output settings are verified. A public API-pack credit rate is not a film quote.
- Customer markup defaults to 0%; authorized administrators can change the stored percentage for future quotes. Quote amounts must be calculated from verified provider costs and current server settings, never a browser-supplied total. An administrative pricing save does not authorize a charge or modify completed purchases.
- QuickBooks charges and refunds remain disabled until merchant authorization and real payment/refund handling are integrated and verified. No provider or payment success may be inferred from UI state, a saved setting, or a configured credential.

## Reporting and verification

Report a reproducible issue and its affected route to the security contact. Do not send passwords, live tokens, or private family documents. The published contact is also available at `/.well-known/security.txt`.

Run the authentication, registration, role, archive, story, and pricing checks applicable to a change. Before release, verify actual authenticated account boundaries and private media access. Synthetic tests do not prove provider readiness, payment settlement, regulatory compliance, or certification.
