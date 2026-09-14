# Internal film production — implementation status

The existing production app includes registration, owner/delegated administration, private finished-film archives, and configurable markup. The current change adds owner-managed Intuit authorization. Production generation, transaction processing, and accounting synchronization remain disabled until the provider contracts and real account flows are verified. Release evidence belongs in the deployment record; a deployed interface does not establish a working provider integration.

## Implemented

- MagicLight is the sole video provider in the active studio. Customers have no external provider handoff or provider picker.
- New projects request the highest available animation quality. No resolution, animation tier, account entitlement, or paid render is represented as verified.
- Story ideas and screenplay requests use OpenAI Responses with `gpt-6-astra`, structured output, explicit source consent, and `store: false`. There is no fallback model. `OPENAI_API_KEY` is server-only.
- The screenplay includes an ensemble cast, scene dialogue, source references, and an editable assumptions ledger. The default is a hopeful, respectful film based on a true story; documentary mode has stricter rules. Known events and relationships must be preserved. Invented dialogue, people and connective scenes are identified as dramatization.
- Source ingestion no longer silently truncates at 50,000 characters or PDF page 60. Each story request supports 200 sources and one million source characters; requests above those limits fail explicitly before transmission. Reference photos have bounded payloads and coverage warnings. Audio/video are not automatically transcribed.
- Working projects and original source files remain in the browser. Customers can separately opt to save limited film metadata and a selected finished MP4/WebM to a private cloud archive, available to that customer and authorized administrators. This does not automatically upload original sources or full screenplays. Storage failures show an error and provide a backup option.
- Public registration creates customer accounts. The existing owner can delegate/revoke administration; administrators can inspect accounts, payment records, opted-in films and activity, and change markup for future quotes. The default markup is 0%.
- Owner-only QuickBooks connection changes use an authenticated, same-origin API, short-lived single-use OAuth state, encrypted server tokens, and conditional writes. Opening a connection/disconnection URL never authorizes or revokes access. A saved authorization remains separate from payment/refund readiness, and token refresh is not yet enabled.
- Authenticated, same-origin generation, quote and checkout requests fail closed with `charged: false` while the provider contract and payment integration are unavailable.

## Required before production activation

1. Connect the user's selected existing OpenAI project, then test actual Astra idea and screenplay responses with entirely fictional materials. Key presence or model listing alone does not prove generation succeeds.
2. In the existing MagicLight account, verify API entitlement and obtain official developer contracts for submission, reference assets, character continuity, supported quality/tier options, job polling/cancellation and finished media. Public sources disclose an API Keys page but no complete generation contract was verified.
3. Confirm API-specific commercial terms for serving BROCOTech customers. Rights to commercial output alone do not establish service-resale terms.
4. Implement the real MagicLight adapter from that contract. Use server credentials, authenticated per-user durable jobs, idempotency, ambiguous-submission reconciliation, resumable polling, and verified playable output. Do not automate the consumer website, invent endpoints, or claim an iframe is an integration.
5. The user selected QuickBooks and a default 0% markup, with an administrator-adjustable percentage for future quotes. The public Pro API pack provides a reference rate of $1.10 per 1,000 credits; this is not a complete-film estimate. Obtain the authenticated provider credit quote before calculating a film total. Complete the existing Lineage Theater Intuit app assessment for BROCO Technologies LLC, configure its credentials securely, and verify sandbox authorization/revocation before connecting the production merchant. The existing accounting connector is not this app's merchant authorization. Add serialized token refresh, verified merchant capabilities, and a server-calculated, expiring quote before payment. Use supported in-app tokenization and verify payment server-side before authorizing exactly one production job; do not trust a browser-supplied amount or payment-success flag.
6. Track customer receipts, payment fees, MagicLight usage expense and provider invoice/reference separately. Refund or recover failed production according to the approved policy. Never describe estimated usage as an incurred expense, or a payment authorization as settled income.
7. Verify an end-to-end paid flow in provider test environments, then approve an explicitly bounded real generation/charge for live verification. Select the account's actual highest supported quality and assert the result's media metadata.
8. Run tests, build, authenticated UI checks, deployment READY check and exact served-commit check before reporting this release live.

## Official references checked

- OpenAI Astra model: https://developers.openai.com/api/docs/models/gpt-6-astra
- MagicLight API account area: https://magiclight.ai/openclaw/api-keys/
- MagicLight API packs: https://magiclight.ai/openclaw/pricing/ — the visible packs describe Hailuo image-to-video. This does not verify a complete screenplay-to-film API.
- MagicLight product workflow: https://magiclight.ai/create/
- MagicLight terms: https://magiclight.ai/terms/

The authenticated API interface exposes keys, pricing and usage. No complete developer contract for the required screenplay, cast and finished-film workflow was available in the inspected interface. The vendor inquiry in [MAGICLIGHT-API-REQUEST.md](MAGICLIGHT-API-REQUEST.md) was sent after user authorization; a response is pending. The account now has user-purchased API credits, but no API key or verified film-generation contract is connected to this app. No credentials were created during this inspection.

Do not store credentials, account documents, user uploads, or payment information in this file or in GitHub.
