# Lineage Theatre

An invitation-only family-history film studio at https://lineagetheater.com. React/Vite guides a user through family sources, film development, script and cast review, and production.

## This development branch

MagicLight is the only video provider offered in the active studio. The external handoff and alternative provider integrations have been removed. **MagicLight generation and customer charging remain disabled until its real account API contract, highest-quality settings, commercial entitlement, and payment flow are integrated and verified.** An API key alone cannot activate the unavailable adapter. See [integration status](docs/INTERNAL-FILM-INTEGRATION.md).

Story ideas and full screenplays use GPT-6 Astra through OpenAI Responses, with structured output, explicit source consent, and no model fallback. An administrator must connect the selected existing OpenAI project using server-only `OPENAI_API_KEY`; real model access and quota must be verified before claiming the feature is live.

The default film treatment is a hopeful, animated story based on a true story. Script development includes a recurring ensemble, narration, dialogue, visual directions, source references and a reviewable assumptions ledger. Known facts are preserved; inferred or invented people and connective scenes are disclosed. Documentary mode restricts invention. The chosen highest-quality setting is a production preference until the MagicLight API's actual options are verified.

## Preserved capabilities

- Invitation-based authentication with forced first-login password change, salted scrypt hashes, HTTP-only signed sessions, same-origin mutation checks and durable request limits.
- Account-specific local projects and IndexedDB source files; saved finished films remain playable and downloadable. No cross-device synchronization or encrypted local vault is claimed.
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

- `BLOB_READ_WRITE_TOKEN`: existing private Vercel Blob account, session and request-limit store.
- `LINEAGE_SESSION_SECRET`: existing server session-signing secret.
- `OPENAI_API_KEY`: selected existing OpenAI project's credential with GPT-6 Astra access.

Authentication and story test fixtures are synthetic. Unit tests mock OpenAI; they do not establish live model access, video generation or billing readiness. MagicLight and customer payment credentials are not requested by unfinished code.

See [deployment guidance](DEPLOYMENT.md) and [activation requirements](docs/INTERNAL-FILM-INTEGRATION.md) before promotion.
