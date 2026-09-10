# Deploying Lineage Theatre

GitHub `bcastle1/lineage-theatre` main is the source of record. The existing Vercel project `lineage-theater` serves `lineagetheater.com`; keep its DNS and project assignment unchanged. GitHub Actions validates builds. Production publishing uses the authenticated Vercel CLI from the exact committed source.

## Runtime

Framework Vite; install `pnpm install --frozen-lockfile`; build `pnpm run build`; output `dist`. Three Vercel functions provide authentication, studio requests/media, and legacy Word text extraction. Their limits are declared in vercel.json.

Production and preview require the private Blob connection and session secret. Server-side provider environment variables are described in README.md. Vercel sensitive variables cannot be read back into local development; validate them through an authenticated preview runtime. Do not commit `.env*`, local credential files, render fixtures, or build output. `.vercelignore` excludes them from uploads.

The private Blob store retains account password hashes, rate limits, and provider job references. Original family sources, project metadata, and finished archive films remain local to the browser, under the signed-in account's project key. Local storage is not encrypted or a shared cloud vault. Do not represent it as cross-device storage.

## Release gates

1. Build/typecheck and auth tests pass; inspect the staged diff for unrelated changes or secrets.
2. Exercise sign-in, forced password setup, document extraction, ten AI ideas plus refresh, scene planning, actual video export/playback, and useful failures with a synthetic QA identity.
3. Confirm responsive desktop/mobile layout, visible feedback, no overflow, and all text weights at 400 or below.
4. Push the exact commit to GitHub main, deploy that same tree with its SHA as `VERCEL_GIT_COMMIT_SHA`, and record the READY deployment ID and aliases.
5. Run `pnpm run check:deploy -- <sha>`. HTTPS, Vercel serving headers, and `<meta name="lineage-build">` must match the exact SHA at the custom domain.
6. Verify the authenticated custom-domain flow; provider credentials configured in production may differ from preview. Clearly report missing credits or credentials, never a simulated successful render.
7. Remove the synthetic QA account. Verify each invited user still requires a first-login password change, then send the explicitly authorized invitations and record send receipts.

## Rollback

Retain the previous deployment ID and Git commit. Promote the known-good Vercel deployment if a release fails; do not delete account storage, change DNS, or rotate working secrets as a routine rollback. A rollback to the former unauthenticated planning app removes the login experience, so prefer a corrective deployment for authentication/UI issues.

## Provider behavior

Gemini suggestions are generated from the text the user explicitly permits sending. Runway/ImagineArt shots incur provider costs only after a confirmation inside the app. Job IDs are reserved before submission; uncertain responses never trigger an automatic retry. Final provider outputs must exist before a job is shown as completed. The browser composes complete films, transparently looping a five-second generated take within a longer scene. External studios have separate accounts and billing.

Provider API references: https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash, https://docs.dev.runwayml.com/api/, https://docs.imagine.art/.
