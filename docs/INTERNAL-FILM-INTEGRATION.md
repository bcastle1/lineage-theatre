# Internal film production — implementation status

This branch is not a verified production release. The previous production deployment is `dpl_3LzyWrFE72Mr8Eq5HLePhNDndNMD`, serving GitHub main `9bd7591` at `lineagetheater.com` when this work began.

## Implemented

- MagicLight is the sole video provider in the active studio. Customers have no external provider handoff or provider picker.
- New projects request the highest available animation quality. No resolution, animation tier, account entitlement, or paid render is represented as verified.
- Story ideas and screenplay requests use OpenAI Responses with `gpt-6-astra`, structured output, explicit source consent, and `store: false`. There is no fallback model. `OPENAI_API_KEY` is server-only.
- The screenplay includes an ensemble cast, scene dialogue, source references, and an editable assumptions ledger. The default is a hopeful, respectful film based on a true story; documentary mode has stricter rules. Known events and relationships must be preserved. Invented dialogue, people and connective scenes are identified as dramatization.
- Source ingestion no longer silently truncates at 50,000 characters or PDF page 60. Each story request supports 200 sources and one million source characters; requests above those limits fail explicitly before transmission. Reference photos have bounded payloads and coverage warnings. Audio/video are not automatically transcribed.
- Existing local project records, original source files and saved completed films remain in the browser. These are not cloud-synced. Storage failures must show an error and provide a backup option.
- Authenticated, same-origin generation, quote and checkout requests fail closed with `charged: false` while the provider contract and payment integration are unavailable.

## Required before production activation

1. Connect the user's selected existing OpenAI project, then test actual Astra idea and screenplay responses with entirely fictional materials. Key presence or model listing alone does not prove generation succeeds.
2. In the existing MagicLight account, verify API entitlement and obtain official developer contracts for submission, reference assets, character continuity, supported quality/tier options, job polling/cancellation and finished media. Public sources disclose an API Keys page but no complete generation contract was verified.
3. Confirm API-specific commercial terms for serving BROCOTech customers. Rights to commercial output alone do not establish service-resale terms.
4. Implement the real MagicLight adapter from that contract. Use server credentials, authenticated per-user durable jobs, idempotency, ambiguous-submission reconciliation, resumable polling, and verified playable output. Do not automate the consumer website, invent endpoints, or claim an iframe is an integration.
5. Set an approved BROCOTech selling price and connect its payment account. Show a server-calculated, expiring price quote before payment. Collect payment inside this UI with a provider-hosted payment element. A signed, verified payment event must authorize exactly one production job; do not trust a browser-supplied amount or payment-success flag.
6. Track customer receipts, payment fees, MagicLight usage expense and provider invoice/reference separately. Refund or recover failed production according to the approved policy. Never describe estimated usage as an incurred expense, or a payment authorization as settled income.
7. Verify an end-to-end paid flow in provider test environments, then approve an explicitly bounded real generation/charge for live verification. Select the account's actual highest supported quality and assert the result's media metadata.
8. Run tests, build, authenticated UI checks, deployment READY check and exact served-commit check before reporting this release live.

## Official references checked

- OpenAI Astra model: https://developers.openai.com/api/docs/models/gpt-6-astra
- MagicLight API account area: https://magiclight.ai/openclaw/api-keys/
- MagicLight product workflow: https://magiclight.ai/create/
- MagicLight terms: https://magiclight.ai/terms/

Do not store credentials, account documents, user uploads, or payment information in this file or in GitHub.
