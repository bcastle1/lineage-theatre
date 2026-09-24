# Deploying Lineage Theatre

GitHub `bcastle1/lineage-theatre` main is the source of record. The existing Vercel project `lineage-theater` serves `lineagetheater.com`; keep its DNS and project assignment unchanged. GitHub Actions validates builds and tests. Publish the exact reviewed commit through the existing Vercel project.

The authorized release includes public customer registration, owner-delegated administration, optional private finished-film archiving, configurable future-quote markup, owner-managed QuickBooks OAuth connection controls, and connected GPT-6 Astra ideas and screenplay generation. MagicLight film generation and QuickBooks charges/refunds remain connection pending. Public and signed-in screens must distinguish verified story development from those pending capabilities. See `docs/INTERNAL-FILM-INTEGRATION.md` for the remaining provider and merchant prerequisites.

## Runtime

Framework Vite; install `pnpm install --frozen-lockfile`; build `pnpm run build`; output `dist`. Vercel API routes provide authentication, administration, private cloud archive upload/playback, studio requests, and legacy Word text extraction. Keep deployment configuration aligned with every route in `api/`.

The Vercel connector has a 3 MB source-file limit and a 4 MB total upload limit. When using that transport, omit the sample MP4 and the three PNG files listed in `scripts/ensure-public-assets.mjs` from the source upload. The build restores them from a pinned GitHub commit and verifies byte lengths and SHA-256 before Vite bundles them. The live app serves all media locally; it does not rely on playback-time redirects. Normal Git checkouts already contain the files and only run the checksum checks.

Production and preview require the private Blob connection and session secret. Server-side provider environment variables are described in README.md. Vercel sensitive variables cannot be read back into local development; validate them through an authenticated preview runtime. Do not commit `.env*`, local credential files, render fixtures, or build output. `.vercelignore` excludes them from uploads.

The private Blob store retains account/password-hash records, consent timestamps, rate limits, administrator invitations/activity, pricing settings, original media-library uploads, and opted-in cloud film metadata/videos. Any existing provider job or payment records are separate from these capabilities and do not prove current integration readiness. Full working projects remain local under the signed-in account's project key. New sources save through the private media library; earlier local sources require the Copy browser sources action. Media archive/trash and administrator retention are described in `docs/MEDIA-LIBRARY.md`. Cloud film archive consent still saves only whitelisted film details and a selected finished video.

Provision the existing owner role only through an authorized, conditional server-record update that preserves its password and account history. Never infer ownership during public registration from the supplied email address. Verify delegated administrators through their named invitation and server role. Invitation creation produces a private expiring link; it does not send an email automatically.

Private archive uploads require the authenticated token flow and signed upload-completion callback. Confirm the deployed Content Security Policy permits the required Vercel Blob upload endpoint while finished-video playback stays behind the authenticated archive route. Verify opt-in consent, upload completion, range playback, customer isolation, and administrator access. Clearing browser data does not delete the cloud archive; handle server deletion requests separately.

## Release gates

1. Build/typecheck and all tests pass; inspect the staged diff for unrelated changes or secrets.
2. Exercise public registration, normalized duplicate/owner protection, unchecked terms/privacy consent, actual new-customer session access, sign-in, forced password setup, and suspended-account rejection using synthetic QA data. Check customer/admin boundaries, owner invitation controls, private archive opt-in/upload/playback, and pricing save/readback. Unconfigured Astra requests, film generation, QuickBooks charges, and refunds must fail with clear status and no money movement. Before activating those integrations, verify real provider requests and payment/refund idempotency; mocked UI tests do not establish readiness.
3. Confirm responsive desktop/mobile layout, visible feedback, no overflow, and all text weights at 400 or below.
4. Push the exact commit to GitHub main, deploy that same tree with its SHA as `VERCEL_GIT_COMMIT_SHA`, and record the READY deployment ID and aliases.
5. Run `pnpm run check:deploy -- <sha>`. HTTPS, Vercel serving headers, and `<meta name="lineage-build">` must match the exact SHA at the custom domain.
6. Verify the authenticated custom-domain flow; provider credentials configured in production may differ from preview. Clearly report missing credits or credentials, never a simulated successful render.
7. Remove identified synthetic QA records and test archive uploads created for the release. Preserve real user credentials and records. Administrator invitations or owner-role changes require the corresponding authorized action; do not email invitations as part of routine deployment.

## Rollback

Retain the previous deployment ID and Git commit. Promote a known-good authenticated Vercel deployment if a release fails; do not delete account/archive storage, change DNS, or rotate working secrets as a routine rollback. Check that the selected version still enforces suspended-account and private-media access controls and can read existing records.

## Provider behavior

The Astra integration reads user-approved story text, source context, and selected reference photos. Exact-model access, real idea/screenplay responses, and signed-in production screenplay development with an uploaded fictional TXT file were verified on September 14, 2026. These text-only checks do not verify photo interpretation or every supported archive size. Capability checks perform a model-access lookup; a successful lookup alone does not establish generation success or available quota. The active app has no alternative video provider or external MagicLight handoff. Highest quality is a preference until the account's supported generation settings and any required clip assembly are verified. MagicLight production and QuickBooks charges/refunds fail closed. Before enabling them, reserve durable per-user jobs, reconcile uncertain submissions without automatic duplicate charges, and verify actual output before marking a film complete. Customer payments and MagicLight expenses require separate auditable records.

Markup defaults to 0% and is stored with a pricing revision in private Blob. Authorized administrators can change the percentage for future quotes; a settings change does not alter completed purchases. Resolve the actual provider credit cost and saved markup on the server, use integer currency rounding, and show the customer the confirmed total before charging. Never substitute the public API-pack reference rate for an unknown complete-film credit quote, accept a browser-supplied total, or mark a refund complete without QuickBooks confirmation.

Provider references: [OpenAI GPT-6 Astra](https://developers.openai.com/api/docs/models/gpt-6-astra), [MagicLight API keys](https://magiclight.ai/openclaw/api-keys/), and [MagicLight API-pack pricing](https://magiclight.ai/openclaw/pricing/).

## Astra activation record — September 14, 2026

- The user selected the existing Default OpenAI project and approved a dedicated key. Its local copy is ignored, and the approved production copy is the server-only Vercel Production secret `OPENAI_API_KEY`; no credential value belongs in release evidence.
- Deployment `dpl_r9pBgvu5JXv9FYteo8RK1LBRSWL8` reached READY and served source revision `5889abe31103d6ef562234cd8d55d8cda1b92696` at `lineagetheater.com`. This was a configuration activation and redeploy of that revision.
- Live model lookup returned the exact `gpt-6-astra` identifier. Separate fictional screenplay and ideas requests completed with that exact provider-reported model; the screenplay had four characters and four scenes, and the ideas response contained ten ideas with source coverage.
- Authenticated production capabilities reported Astra available and `gpt-6-astra`, while MagicLight generation, billing, and verified highest-quality readiness remained false.
- A real signed-in production UI check uploaded a 483-character fictional TXT file and developed a one-minute film draft. The app read all 1,005 narrative and source characters, linked its one uploaded source, and returned five editable scenes, four recurring characters, and nine assumptions. GPT-6 Astra attribution and a ready-draft confirmation appeared inside the app without a redirect.
- All QA people and events were fictional. No finished film was rendered and no customer payment was taken. The MagicLight generation pipeline, verified API quality and cost settings, any required clip assembly, and QuickBooks merchant processing remain pending.
