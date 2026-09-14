# Internal film production — implementation status

The production app includes registration, owner/delegated administration, private finished-film archives, configurable markup, owner-managed Intuit authorization, and verified GPT-6 Astra story development. MagicLight film generation, transaction processing, and accounting synchronization remain disabled until the provider contracts and real account flows are verified. Release evidence belongs in the deployment record; a deployed interface alone does not establish a working provider integration.

## Implemented

- MagicLight is the sole video provider in the active studio. Customers have no external provider handoff or provider picker.
- New projects request the highest available animation quality. No resolution, animation tier, account entitlement, or paid render is represented as verified.
- Story ideas and screenplay requests use OpenAI Responses with `gpt-6-astra`, structured output, explicit source consent, and `store: false`. There is no fallback model. The selected existing OpenAI project is connected through server-only `OPENAI_API_KEY`; exact-model live responses and signed-in production screenplay development were verified with fictional materials on September 14, 2026.
- The screenplay includes an ensemble cast, scene dialogue, source references, and an editable assumptions ledger. The default is a hopeful, respectful film based on a true story; documentary mode has stricter rules. Known events and relationships must be preserved. Invented dialogue, people and connective scenes are identified as dramatization.
- Source ingestion no longer silently truncates at 50,000 characters or PDF page 60. Each story request supports 200 sources and one million source characters; requests above those limits fail explicitly before transmission. Reference photos have bounded payloads and coverage warnings. Audio/video are not automatically transcribed.
- Working projects and original source files remain in the browser. Customers can separately opt to save limited film metadata and a selected finished MP4/WebM to a private cloud archive, available to that customer and authorized administrators. This does not automatically upload original sources or full screenplays. Storage failures show an error and provide a backup option.
- Public registration creates customer accounts. The existing owner can delegate/revoke administration; administrators can inspect accounts, payment records, opted-in films and activity, and change markup for future quotes. The default markup is 0%.
- Owner-only QuickBooks connection changes use an authenticated, same-origin API, short-lived single-use OAuth state, encrypted server tokens, and conditional writes. Opening a connection/disconnection URL never authorizes or revokes access. A saved authorization remains separate from payment/refund readiness. Serialized token refresh exists only inside the server; status and company checks never refresh tokens automatically.
- Authenticated, same-origin generation, quote and checkout requests fail closed with `charged: false` while the provider contract and payment integration are unavailable.

## Verified Astra activation

On September 14, 2026, the user approved a dedicated key in the existing Default OpenAI project and its storage as the Vercel server-only Production secret `OPENAI_API_KEY`. The redeployed app passed authenticated production capability checks for Astra while the MagicLight and billing gates remained false.

Live OpenAI tests used only fictional people and events. The model lookup returned `gpt-6-astra`; actual Responses output reported that same model and completed successfully. One 45-second screenplay contained four characters and four scenes, and a separate ideas request returned ten ideas with the supplied source coverage. These were real provider responses, separate from mocked automated tests.

The signed-in production UI then developed a one-minute fictional workshop story from a narrative and a 483-character uploaded TXT file. It read all 1,005 combined characters, reported one of one uploaded sources read and linked, and returned five editable scenes, four recurring characters, and nine disclosed assumptions. The app displayed GPT-6 Astra attribution and a ready-draft confirmation without leaving Lineage Theatre. No film was rendered and no customer charge was made. These checks do not establish untested photo interpretation, long-archive behavior, or future quota availability. See [the deployment record](../DEPLOYMENT.md#astra-activation-record--september-14-2026).

## Required before paid film production

1. In the existing MagicLight account, verify API entitlement and obtain official developer contracts for clip requests, status and output, first-frame/reference assets, character continuity, audio, quality/tier options, credit costs, and cancellation where supported. Determine which operations MagicLight supports and what clip assembly the app must perform. A dedicated screenplay-to-film endpoint is not assumed; the documented clip workflow and complete production pipeline remain unverified.
2. Confirm API-specific commercial terms for serving BROCOTech customers. Rights to commercial output alone do not establish service-resale terms.
3. Implement the MagicLight production pipeline from those supported APIs, including any required clip composition inside the app's backend. Use server credentials, authenticated per-user durable jobs, idempotency, ambiguous-submission reconciliation, resumable polling, and verified playable output. Do not automate the consumer website, invent endpoints, or claim an iframe is an integration.
4. The user selected QuickBooks and a default 0% markup, with an administrator-adjustable percentage for future quotes. The public Pro API pack provides a reference rate of $1.10 per 1,000 credits; this is not a complete-film estimate. Obtain the authenticated provider credit quote before calculating a film total. Complete the existing Lineage Theater Intuit app assessment for BROCO Technologies LLC, configure production credentials securely, and verify real refresh/revocation before connecting the production merchant. Sandbox authorization and encrypted token storage are verified; the existing accounting connector is not this app's merchant authorization. Verify merchant capabilities and implement a server-calculated, expiring quote before payment. Use supported in-app tokenization and verify payment server-side before authorizing exactly one production job; do not trust a browser-supplied amount or payment-success flag.
5. Track customer receipts, payment fees, MagicLight usage expense and provider invoice/reference separately. Refund or recover failed production according to the approved policy. Never describe estimated usage as an incurred expense, or a payment authorization as settled income.
6. Verify the end-to-end flow in provider test environments where supported, then approve an explicitly bounded real generation/charge for live verification. Do not assume MagicLight offers a sandbox. Select the account's actual highest supported quality and assert the result's media metadata.
7. Run tests, build, authenticated UI checks, deployment READY check and exact served-commit check before reporting this release live.

## Official references checked

- OpenAI Astra model: https://developers.openai.com/api/docs/models/gpt-6-astra
- MagicLight API account area: https://magiclight.ai/openclaw/api-keys/
- MagicLight API packs: https://magiclight.ai/openclaw/pricing/ — the visible packs describe Hailuo image-to-video. This does not verify the clip request, status, output, quality, audio, or credit contracts needed for the complete film workflow.
- MagicLight product workflow: https://magiclight.ai/create/
- MagicLight terms: https://magiclight.ai/terms/

The authenticated API interface exposes keys, pricing and usage. The inspected interface did not establish the complete API workflow for generating and assembling the screenplay, cast and finished film. The vendor inquiry in [MAGICLIGHT-API-REQUEST.md](MAGICLIGHT-API-REQUEST.md) was sent after user authorization; a response is pending. The account now has user-purchased API credits, but no MagicLight API key or verified film-generation pipeline is connected to this app. No MagicLight credentials were created during that inspection.

Do not store credentials, account documents, user uploads, or payment information in this file or in GitHub.
