# Lineage Theatre

Lineage Theatre is a compact, local-first film-planning app for turning an ancestor's story into a provider-ready production brief. It guides a family from script and source material through film length, studio selection, a five-scene plan, and an honest handoff to an external video renderer.

## What works

- A five-step landing-page guide from family memory to video studio.
- Script, ancestor, title, and runtime editing with local autosave feedback.
- Local source-file storage in IndexedDB, including duplicate and size checks.
- Provider comparison for Runway, Google Flow + Veo, HeyGen, MagicLight, and the free Lineage planning path.
- A deterministic five-scene film plan generated in the browser from the supplied script.
- Copyable provider briefs and downloadable JSON production packages.
- Direct, disclosed handoff to the selected provider's official studio.
- Responsive desktop and mobile presentation with regular-weight typography throughout.

The app does not claim that a paid third-party render completed. Rendering, account access, pricing, usage limits, and billing remain in the provider's own studio.

## Run locally

```bash
pnpm install --frozen-lockfile
pnpm run dev
```

Vite normally serves the app at `http://127.0.0.1:5173/`.

## Build

```bash
pnpm run build
```

The production output is written to `dist/`. GitHub Actions runs this build on every push to `main`; Vercel is the intended production publisher.

## Current architecture

- Source of record: GitHub (`bcastle1/lineage-theatre`)
- Production hosting: Vercel (`lineage-theater` project)
- DNS authority today: Namecheap nameservers
- Application persistence today: the visitor's browser (`localStorage` and IndexedDB)
- Planned shared data layer: Supabase, after authentication, row-level security, retention, consent, and production data rules are approved
- Planned DNS authority: IONOS, only through a separate approved migration with rollback and domain verification

See `DEPLOYMENT.md` for the release and verification contract.

## Public safety boundary

This release is appropriate for private browser drafting. Before the app accepts production customer files in a shared backend, add authenticated accounts, least-privilege access, encrypted storage, signed uploads, consent and rights records, retention and deletion controls, abuse handling, privacy terms, and provider-specific commercial-use review. Never place video-provider or Supabase secrets in browser code.
