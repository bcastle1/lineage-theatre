# Deploying Lineage Theatre

GitHub `bcastle1/lineage-theatre` main is the source of record. The existing Vercel project `lineage-theater` serves `lineagetheater.com`; keep its DNS and project assignment unchanged. GitHub Actions validates builds and tests. Publish the exact reviewed commit through the existing Vercel project.

The user authorized publishing the prepared MagicLight-only studio while its provider and payment connections are pending. This is a studio-preview release, not activation of paid film production. Public and signed-in screens must disclose that status. See `docs/INTERNAL-FILM-INTEGRATION.md` for the remaining account/API/payment prerequisites.

## Runtime

Framework Vite; install `pnpm install --frozen-lockfile`; build `pnpm run build`; output `dist`. Three Vercel functions provide authentication, studio requests/media, and legacy Word text extraction. Their limits are declared in vercel.json.

Production and preview require the private Blob connection and session secret. Server-side provider environment variables are described in README.md. Vercel sensitive variables cannot be read back into local development; validate them through an authenticated preview runtime. Do not commit `.env*`, local credential files, render fixtures, or build output. `.vercelignore` excludes them from uploads.

The private Blob store retains account password hashes, rate limits, and provider job references. Original family sources, project metadata, and finished archive films remain local to the browser, under the signed-in account's project key. Local storage is not encrypted or a shared cloud vault. Do not represent it as cross-device storage.

## Release gates

1. Build/typecheck and all tests pass; inspect the staged diff for unrelated changes or secrets.
2. Exercise sign-in, forced password setup, document extraction and cast/assumption review using synthetic QA data. For this studio-preview release, verify that unconfigured Astra requests, film generation and payment fail with clear status and no charge. Before activating production, additionally verify actual Astra development, provider jobs, payment idempotency and finished-film playback. Mocked UI tests do not establish real provider readiness.
3. Confirm responsive desktop/mobile layout, visible feedback, no overflow, and all text weights at 400 or below.
4. Push the exact commit to GitHub main, deploy that same tree with its SHA as `VERCEL_GIT_COMMIT_SHA`, and record the READY deployment ID and aliases.
5. Run `pnpm run check:deploy -- <sha>`. HTTPS, Vercel serving headers, and `<meta name="lineage-build">` must match the exact SHA at the custom domain.
6. Verify the authenticated custom-domain flow; provider credentials configured in production may differ from preview. Clearly report missing credits or credentials, never a simulated successful render.
7. Remove synthetic QA records created for the release. Do not change real user credentials or send invitations as part of a routine update.

## Rollback

Retain the previous deployment ID and Git commit. Promote the known-good Vercel deployment if a release fails; do not delete account storage, change DNS, or rotate working secrets as a routine rollback. A rollback to the former unauthenticated planning app removes the login experience, so prefer a corrective deployment for authentication/UI issues.

## Provider behavior

GPT-6 Astra reads user-approved story text, source context, and selected reference photos. The active app has no alternative video provider or external MagicLight handoff. Highest quality is a preference until verified with the account's API capabilities. MagicLight production and customer payment currently fail closed, with no charge. Before enabling them, reserve durable per-user jobs, reconcile uncertain submissions without automatic duplicate charges, and verify actual output before marking a film complete. Customer payments and MagicLight expenses require separate auditable records.

Provider references: https://developers.openai.com/api/docs/models/gpt-6-astra and https://magiclight.ai/openclaw/api-keys/.
