# Security Policy

Contact: `info@lineagetheater.com`

Lineage Theatre is currently a static public preview. The app stores demo/customer-entered project data in the visitor's browser through `localStorage` and IndexedDB. It does not yet provide server-side authentication, encrypted cloud storage, automated payment verification, transactional email, or real publishing credentials.

## Current Hardening

- No third-party analytics or external scripts.
- Content Security Policy in `index.html`.
- Restrictive referrer and browser permissions policy.
- GitHub Pages deployment workflow with HTTPS-ready custom-domain configuration.
- Security contact published at `/.well-known/security.txt`.
- Public launch notes warn against uploading sensitive real records until backend protections are connected.

## Required Before Real Public Customer Intake

- Replace the client-side admin code with backend authentication.
- Move customer records, source files, admin actions, payment state, receipts, and publishing state to a secured backend.
- Encrypt uploads and restrict file access with signed URLs.
- Add malware scanning/content moderation for uploaded media.
- Add privacy policy, terms, consent, child/parental handling, retention, deletion, and audit logging.
