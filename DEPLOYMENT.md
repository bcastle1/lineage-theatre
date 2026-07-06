# Deploying Lineage Theatre

The repo is prepared for GitHub Pages and the custom domain `lineagetheater.com`.

## GitHub Pages

1. Push this repository to GitHub with the default branch named `main`.
2. In GitHub, open the repository settings and enable Pages with **GitHub Actions** as the source.
3. Add the custom domain `lineagetheater.com` in the Pages settings.
4. After DNS is correct and GitHub provisions the certificate, enable **Enforce HTTPS**.

## Namecheap DNS

For `lineagetheater.com`, use Namecheap Advanced DNS and configure:

| Type | Host | Value |
| --- | --- | --- |
| A | @ | 185.199.108.153 |
| A | @ | 185.199.109.153 |
| A | @ | 185.199.110.153 |
| A | @ | 185.199.111.153 |
| CNAME | www | `<your-github-username>.github.io` |

Remove conflicting `@` or `www` URL redirect, A, CNAME, ALIAS, or parking records before saving.

## Public Safety Boundary

This release is safe as a static public preview because data stays in the visitor's browser and no production customer database exists yet.
Before accepting real public customer files, add:

- Server-side authentication and authorization for admins.
- Encrypted server storage and signed upload URLs.
- Payment verification through a payment provider or Venmo-capable reconciliation.
- Transactional email provider for receipts and links.
- Abuse moderation, content policy, privacy policy, terms, and customer consent capture.

## Verification

After DNS changes propagate:

```bash
pnpm run check:deploy
```

The check should report `ready: true`, GitHub Pages A records for the apex domain, `bcastle1.github.io` for `www`, and app content over HTTPS.
