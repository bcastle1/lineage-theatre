# Deploying Lineage Theatre

## Approved topology for this release

| Layer | Current system | Release rule |
| --- | --- | --- |
| Source | GitHub `bcastle1/lineage-theatre` | `main` is the production source of record. |
| Build and hosting | Vercel project `lineage-theater` | Production must be built from the exact GitHub commit being released. |
| Public domain | `lineagetheater.com` | The custom domain must resolve to and be served by Vercel. |
| DNS authority | Namecheap nameservers | Preserve in this release. No IONOS nameserver change is implied. |
| App data | Browser local storage and IndexedDB | No shared production customer database exists in this release. |
| Future shared data | Supabase | Add only after auth, RLS, storage, consent, retention, and deletion rules are approved. |
| Future DNS | IONOS | Migrate separately with a complete record inventory, lowered TTL, domain verification, and rollback plan. |

GitHub Pages is intentionally not a deployment target. The GitHub workflow validates the production build and does not publish the domain.

## Vercel project settings

- Framework preset: Vite
- Install command: `pnpm install --frozen-lockfile`
- Build command: `pnpm run build`
- Output directory: `dist`
- Production branch: `main`

Connect the existing Vercel `lineage-theater` project to the existing GitHub repository. Do not create a second production project or move the domain unless separately approved.

## Release verification

For every production release, record all of the following:

1. The exact pushed GitHub commit SHA.
2. The Vercel deployment ID and `READY` state.
3. The deployment's Git commit matching the pushed SHA.
4. The custom domain alias pointing to that deployment.
5. An HTTPS response from `lineagetheater.com` with `Server: Vercel`.
6. The HTML `<meta name="lineage-build">` value matching the exact commit.
7. Rendered desktop and mobile checks on the custom domain, including action feedback and regular-weight typography.

Run the read-only production check after promotion:

```bash
pnpm run check:deploy -- <expected-commit-sha>
```

The check reports DNS authority, Vercel serving evidence, the deployed build marker, and whether the public app matches the expected commit.

## Provider boundary

The browser app creates the script, scene plan, source inventory, and provider brief. It may open the official Runway, Google Flow, HeyGen, or MagicLight studio and copy that brief. It must not expose provider API credentials, fabricate rendering progress, or state that a paid render succeeded without provider evidence.

## Supabase production gate

Before replacing local browser persistence, define and verify:

- User authentication and account recovery.
- Project, source, membership, consent, and audit schemas.
- Row-level-security policies for every table and storage bucket.
- Signed upload and download paths with file-type and size enforcement.
- Data retention, deletion, export, and incident procedures.
- Secrets held only in server-side Vercel and Supabase environments.

## Future IONOS DNS gate

An IONOS cutover is a separate change. First export every current Namecheap DNS record, verify mail and domain-verification records, reproduce them in IONOS, lower TTL before the maintenance window, verify Vercel domain ownership, and retain the Namecheap configuration as rollback evidence until propagation and mail checks are complete.
