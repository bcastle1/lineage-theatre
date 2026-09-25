# Delivering finished MagicLight website exports

The administration overview includes **Deliver a MagicLight film**. An administrator confirms the approved recipient account, title, runtime and finished MP4 address from the MagicLight player. Only canonical `https://videocos.magiclight.ai/videos/<project-id>/<export-uuid>.mp4` addresses are accepted. Editor URLs, redirects, arbitrary hosts, credentials and query strings are rejected.

This is an operator-assisted alternative to API generation: registering the export and recipient is manual. Transfer, private storage verification and library availability happen automatically after registration. This does not discover website projects, generate scenes, mark a paid production order complete, or charge a customer. Website credit balances and API balances remain separate.

Production Vercel Cron calls `/api/film-delivery` every five minutes with the existing `CRON_SECRET`. Each invocation processes at most one pending transfer within a 300-second function window. Administrators can also use **Transfer now**. No customer browser must stay open. The customer's library refreshes each minute while visible and idle; it does not interrupt playback or an open detail panel.

## Delivery guarantees and limits

- A permanent record binds the export to one recipient. Repeating an assignment is idempotent; assigning the same export to another recipient is rejected.
- Account and administrator approval are checked against current private records before copying and immediately before publication.
- Compare-and-swap leases prevent concurrent processing. A crashed process can be reclaimed after six minutes; a failed transfer is visible and requires **Retry delivery**.
- The worker checks the completed source's MIME type, size and MP4 header, streams it through a unique temporary file, uploads it with create-only private Blob storage, and verifies the entire stored SHA-256 and byte count before publishing library metadata.
- Maximum finished-film size is 500 MiB. Existing 100-film and 5-GiB account quotas continue to apply. A timed-out transfer never marks the film ready.
- Customer and administrator playback use the existing authenticated range-capable archive route. Neither provider URLs nor Blob addresses are exposed in customer library responses.
- Delivery provenance records the assigning administrator and MagicLight project. It does not manufacture a customer archive-consent event. Browser upload tokens cannot overwrite an administrator delivery.
- Original generation and payment records are unchanged. Customer archive/trash actions remain recoverable; administrators retain the private archived film.

`delivery/jobs/<export-derived-id>.json` is the durable receipt. `delivery/pending/` contains disposable scheduling tickets, removed only after terminal states are saved. Repeating an interrupted assignment repairs a missing ticket. Source URLs stay in private job records; logs contain only the delivery ID, status and attempt count.

Validation covers recipient isolation, authorization and CSRF, restricted export URLs, duplicate assignment, concurrent leases, failed copy/retry, approval revocation during transfer, byte/hash verification and authenticated media ranges. `scripts/test-workflow-server.mjs` provides fictional accounts and an in-memory sample-video transport for browser verification without calling MagicLight or production storage.
