# Lineage Theatre

Lineage Theatre is a local-first web app for creating ancestor movies from family photos, records, audio, dates, written stories, and customer preferences.

## What Works Locally

- Creator workspace with customer registration, ancestor profile intake, source upload vault, style/rating/runtime controls, story recommendations, characters, storyboard timeline, trailer preview, and full-movie request flow.
- Local-first persistence through `localStorage` for app state and IndexedDB for uploaded source files.
- Admin console protected by access code `patriot`.
- Admin approval queue, customer records, payment ledger, movie library, music library, fee toggles, approval toggles, and editable runtime pricing.
- Venmo payment path using `@ERik-Castle-1`, with local receipt/outbox tracking.
- Publishing preferences for email link, YouTube, family gallery, public discovery, download URL, and approval status.
- PWA manifest and service worker for offline-friendly production builds.
- Public preview safety pages: `/privacy.html`, `/terms.html`, `/security.html`, and `/.well-known/security.txt`.

## Run Locally

```bash
npm install
npm run dev
```

Open the local URL printed by Vite, usually `http://127.0.0.1:5173/`.

## Build

```bash
npm run build
npm run preview
```

The production files are emitted to `dist/` and can be hosted on Vercel, Netlify, Cloudflare Pages, or a traditional static host.

## Deployment Check

```bash
npm run check:deploy
```

This checks whether `lineagetheater.com` DNS points to GitHub Pages and whether HTTPS serves the app instead of Namecheap parking.

## Production Integration Points

The app is intentionally structured so real services can be connected behind adapters:

- `src/services/productionAdapters.ts`
  - `VideoGenerationAdapter`: connect a video generation/render pipeline for trailers and full movies.
  - `PaymentAdapter`: replace the local Venmo flow with Stripe, Venmo business/API-capable reconciliation, or another payment provider.
  - `EmailAdapter`: connect Resend, Postmark, SendGrid, AWS SES, or another transactional email provider for receipts and delivery links.
  - `PublishAdapter`: connect YouTube OAuth upload, private download storage, or a family gallery.

## Notes Before Going Live

- Automated Venmo verification and receipt email delivery require a server-side payment/email integration. The current app records the local workflow and prepares receipt state, but it does not verify Venmo payments by itself.
- Realistic 4K movie generation, voice, music, and long-form rendering require external model/render infrastructure or a backend worker fleet. The frontend already captures the inputs and decisions those services need.
- Add authentication, encrypted storage, signed upload URLs, parental/age handling, abuse moderation, privacy policy, terms, and consent workflows before accepting public users.
- Keep music direction original. The app avoids copying any specific living composer and frames generated music as original cinematic orchestration.
