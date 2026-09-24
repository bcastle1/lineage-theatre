# Magiclight media integration development

Development checkpoint: September 23, 2026. This change adds media-processing support and connects hosted payment authorization to the production queue. It does not claim an authenticated Magiclight generation, change live checkout, or provision a production worker.

## Native output quality

Film assembly previously converted all video to 1280 by 720 at 30 frames per second. It now derives the output profile from fully decoded source media. Equal native profiles retain their dimensions and frame rate; mixed compatible clips use the smallest native dimensions and slowest frame rate so lower-quality inputs are not enlarged. Incompatible aspect ratios require correction before assembly.

The app's encoding limits are even square-pixel dimensions, at most 4096 pixels on either edge and 4096 by 2160 pixels in total, and 1–60 frames per second. These bounds describe the assembler, not Magiclight account entitlements. The assembler checks actual output dimensions, frame rate, audio and duration, and the server stores the verified width, height and frame rate with the private completed-film record. Existing archived films remain readable.

## Separate audio

An eventual server adapter can normalize a clip result into the existing internal video descriptor and optionally include an `audio` descriptor for a reviewed composite narration/dialogue track:

```json
{
  "url": "https://approved-provider-host.example/clip.mp4",
  "contentType": "video/mp4",
  "sizeBytes": 1000000,
  "durationSeconds": 5,
  "audio": {
    "url": "https://approved-provider-host.example/voice.m4a",
    "contentType": "audio/mp4",
    "sizeBytes": 100000,
    "durationSeconds": 5
  }
}
```

This is the app's internal schema, not a claimed Magiclight API payload. Only a trusted server adapter supplies output hostnames. Both files require allowlisted HTTPS URLs without redirects, supported content types and bounded exact byte lengths. Supported separate audio types are MP4/M4A, MPEG/MP3, WAV and WebM. Their URLs remain private server data and are excluded from customer status responses.

The worker downloads the audio into its own temporary directory and passes `audioPath` to the assembler. An explicit audio track replaces embedded clip audio; it does not mix an unreviewed second voice over it. The assembler fully decodes the selected track and checks its duration against the shot timeline. A customer film with missing or short audio fails verification. Synthetic silence remains limited to explicitly labelled technical samples. These checks prove media structure and timing, not spoken-word accuracy, speaker identity or lip synchronization.

Temporary files are removed after success or failure. Only verified MP4 and caption artifacts reach the existing private publication path. The immutable manifest, ownership, spending authorization and queue-recovery rules continue to apply.

## Provider investigation

The September 22 public inspection included the [API key page](https://magiclight.ai/openclaw/api-keys/), [API pricing page](https://magiclight.ai/openclaw/pricing/) and their linked first-party scripts. API pack copy describes Hailuo image-to-video models; the inspected scripts expose key, balance, usage and pack-management behavior. No supported generation authentication format, submission/status/result schema or developer SDK was found in those resources. Account-management calls do not establish a generation contract.

On September 23, Erik confirmed the existing affiliate/partner relationship and that no separate agreement is necessary. This task proceeds on that confirmation. The outstanding provider input is technical generation documentation, not a request for another agreement.

## September 23 production wiring

The integration branch now includes the current hosted checkout and receipt release. Confirmed hosted payments route through production authorization that rechecks the customer, original order and plan, current QuickBooks invoice/payment allocation, and a bounded provider quote. A planning price alone cannot authorize generation. The worker uses its own configured film service for both quotations and generation, preserving the same full-film quote once any shot has started.

Hosted authorization now uses a server-side verifier for recorded QuickBooks Accounting reversals. A paid invoice and its payment allocation alone cannot establish that a separate refund did not occur; the [QuickBooks Payment reference](https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/Payment) documents that linked refunds do not change `TotalAmt`. The verifier scans supported Accounting records and requires complete, unchanged results from two bounded reads, then rechecks the sale's invoice and payment allocations. Ambiguous, malformed, changing or incomplete evidence returns `HOSTED_REVERSALS_UNVERIFIED`. Automated coverage uses fixtures; this implementation has not yet been verified against the live company.

The verifier receives the exact order, current grant/company/environment, customer, invoice, currency, amount, payment IDs and order creation time. Its response must match that identity and declare its `quickbooks-accounting-recorded-reversals` scope, version 1, outcome `clear`, an evidence hash and a short-lived current observation. This establishes only the absence of identified or ambiguous reversals in the supported Accounting records read; it does not prove processor/bank settlement or detect refunds not recorded in QuickBooks. Refunds must be recorded and reconciled in the connected company. Each authorization rechecks persisted account/order/plan/settings after asynchronous provider reads; a refreshed provider quote requires another payment and reversal check. No environment flag or customer input substitutes for this evidence. [Reversal-verifier operations](HOSTED-REVERSALS.md) documents the exact matching rules and limits; exceeding 1,000 records in a scanned entity, 8 MiB of responses or the 45-second scan budget stops authorization.

Approved customers and existing owner accounts use the shared account-access rules. Suspension or account changes during payment authorization block queue creation. The customer start action supports paid hosted invoices when the configured production service reports availability; an API key or client flag cannot enable rendering.

The authenticated MagicLight API account was read on September 23: `LineageServer` is Active and the account displays 80,000 API credits. Vercel metadata confirms a protected Production `MAGICLIGHT_API_KEY`. No key value was read or copied, credits purchased, or real generation request submitted during this continuation.

The supplied references at [docs.magicai.ai](https://docs.magicai.ai/docs/) describe Magic AI's chatbot service using `api.magicai.ai`. Its [API reference](https://docs.magicai.ai/docs/category/api-reference/) lists projects, data sources and chat. These pages do not provide MagicLight video submission, status or output instructions and have not been used as a destination for the MagicLight credential.

The supplied [public fork](https://github.com/foctaveluka-eng/magiclight-api) and its raw README returned HTTP 404 on September 23. The [deployed wrapper's read-only API description](https://vercel-animate-api.vercel.app/api) was reachable and reported version 3.0.0: optional `imageUrl`, required animation `prompt`, 5- or 10-second duration, quality and output format, with status/download identified by `pack` and `eventId`. This differs from the pasted story-expansion parameters. Its current public descriptions do not establish MagicLight as the upstream provider or explain authentication with the existing OpenClaw API key. No generation/status/download route was invoked and no credential or customer material was sent to this wrapper.

The additional public search found no generation documentation in MagicLight's sitemap, public OpenClaw navigation or relevant published packages. [Magic Claw](https://magiclight.ai/claw/) is a waitlist/invitation-code product page. The authenticated Usage page showed the purchased 80,000 credits and no generation entries. The connected mailbox search returned the existing September 14 inquiry and September 17 follow-up, without a provider answer. A narrower technical follow-up is prepared in [the inquiry record](MAGICLIGHT-API-REQUEST.md); no new email has been sent.

The default MagicLight adapter remains unavailable. The remaining connection work requires the supported video-generation URL, authentication and request/response examples, status/output retrieval and retry or request-lookup behavior. The existing IONOS host is reachable and has capacity for an isolated Node/FFmpeg worker; packaging and host evidence are documented in [worker hosting](WORKER-HOST.md). After implementing the provider calls, operational verification must cover the account's actual quality/cost limits, live Accounting reconciliation, the configured supervised worker, and a bounded real render with private playback. Local fixture and media tests do not establish live generation.

## Verification

Run `pnpm test` with `FFMPEG_PATH` pointing to a trusted full FFmpeg executable. CI installs FFmpeg and explicitly configures that path, so real media tests must run there. Local development without FFmpeg may skip the real media cases; an explicitly configured but broken executable must fail.

Tests cover retained 1080p geometry, compatible mixed source profiles, separate audio, short audio rejection, malformed media/profiles, private audio downloads, provider-output normalization, queue behavior and publication checks. All generated test people, media and provider responses are fixtures. No real Magiclight render or customer transaction is represented by those tests.

Local validation on September 23 passed all **554 tests with zero failures or skips**, including actual FFmpeg decoding/encoding, hosted production authorization, recorded-reversal scans, bounded responses, worker restart, authorization expiry before submission and customer readiness cases. The production TypeScript/Vite build passed with its existing large-bundle advisory. An independent review reran the 42 focused reversal/authorization/transport tests and found no remaining actionable issue in their documented scope. The September 22 native-quality sample was independently decoded as 1920 by 1080, 24 fps, with AAC audio, and its stored byte length and SHA-256 were checked.

Remaining operational work includes the documented provider adapter, reference-asset submission, actual account quality/cost verification, live acceptance of recorded Accounting reversal reconciliation, worker activation and a bounded real render with private playback acceptance. See [production worker operations](PRODUCTION-WORKER.md) for the existing budget and hosting constraints.
