# Lineage Theatre

An invitation-only family-history film studio at https://lineagetheater.com. React/Vite guides a user through Family archive, Story direction, The cutting room, and Create & watch.

## Working features

- Sign-in and forced first-login password change; salted scrypt password hashes in private Vercel Blob storage, signed HTTP-only sessions, origin checks, and durable request limits.
- Account-specific local film projects and IndexedDB source files. Existing v2 projects remain untouched and Erik can explicitly import them.
- Text extraction from PDF, DOCX, legacy DOC, text, CSV and GEDCOM. Photos, audio, and video can be added as original sources. Legacy DOC extraction is an authenticated transient server operation; other extraction stays in the browser.
- Documentary and Cinematic treatments, historical setting, 15-second to 10-minute runtime, ten Gemini story directions, refresh excluding previous titles, up to three selected themes, and editable scene plans.
- A real browser-rendered 1920 x 1080 film from source photographs/footage, captions, gentle ambient score, and optional uploaded narration. MP4 when supported; WebM fallback. Keep the tab visible during export, which takes the selected running time.
- Runway and ImagineArt authenticated shot APIs with durable per-user job ownership and duplicate-request protection. Five-second generated takes can be combined with archive scenes. Reenactments are labeled. Runway's credential and credit balance are checked; no-credit status is disclosed. ImagineArt requires its own configured key.
- Disclosed external handoffs to MagicLight, Google Flow, and HeyGen, with downloadable production briefs.
- Progress, success, failure, and uncertain-submission feedback; responsive layouts and regular-weight typography throughout.

## Local development

Use Node 22+ and pnpm 11.7.0.

```
pnpm install --frozen-lockfile
pnpm run dev
pnpm run build
pnpm test
```

The development server serves Vite and API handlers at http://127.0.0.1:5173. A gitignored `.env.local` supplies server-only values. Never expose provider credentials through VITE variables.

## Server environment

- `BLOB_READ_WRITE_TOKEN`: private Vercel Blob store for accounts, rate limits and provider jobs.
- `LINEAGE_SESSION_SECRET`: high-entropy server signing secret.
- `GEMINI_API_KEY`: story development; default model `gemini-3.8-flash`. `LINEAGE_STORY_MODEL` can override it with a compatible model supporting low thinking level and structured output.
- `RUNWAYML_API_SECRET`: Runway API account, separate from its web-app subscription/credits.
- `IMAGINEART_API_TOKEN`: optional ImagineArt API integration.

Provider credentials are server-only. Account records are provisioned administratively with the helpers in `api/_lib/auth.mjs`; plaintext initial passwords are never committed. Password reset is currently handled by the administrator. This release does not provide cross-device project sync: source files and finished movies remain in the browser. Download films and retain original source files.

See DEPLOYMENT.md for exact-commit release verification and rollback.
