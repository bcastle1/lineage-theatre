# MagicLight integration inquiry record and template

## Current status: technical follow-up sent September 24, 2026

The technical follow-up was sent, and its presence in Sent Items was verified during this continuation:

- Sent at: `2026-09-24T03:44:12Z`
- From: `Erik@puricloud.com`
- To: `support@magiclight.ai`
- Subject: `Re: API integration for complete animated films inside Lineage Theater`

The owner has confirmed commercial permission and the existing partner relationship. The account has an active API key and purchased credits. Those topics do not require a new agreement or purchase. A technical response is still needed to confirm the missing production controls; delivery verification does not establish provider acceptance or API readiness.

### Research added September 24

- The published [magic-text2video skill](https://clawhub.ai/zhangyuangao/magic-text2video) has a [version 1.0.2 Python client](https://clawhub.ai/api/v1/skills/magic-text2video/file?path=scripts%2Fmedia_gen_client.py&version=1.0.2) using the **test origin** `https://open-test.magiclight.ai`, Bearer API-key authentication, task submission and status polling. Its test origin is not evidence that the production account should send credentials there.
- The [magic-image-to-video skill published by leizhang-magiclight](https://clawhub.ai/leizhang-magiclight/magic-image-to-video) has a [version 1.0.1 Python client](https://clawhub.ai/api/v1/skills/magic-image-to-video/file?path=scripts%2Fmedia_gen_client.py&version=1.0.1) using the **production origin** `https://open.magiclight.ai`, `Authorization: Bearer <API key>`, `POST /api/misc/openclaw_add_task` with text and an image URL, the `X-DashScope-Async: enable` header, and `GET /api/misc/openclaw_check_task?task_id=...`. This is a concrete published client reference; it does not establish a bounded quote, duplicate-safe submission recovery, exact model/quality controls, or a complete film workflow with dialogue, audio and assembly. No client script was run or generation submitted during this research.
- YouTube research examined search results and public video descriptions, including the [official Kids Story tutorial](https://www.youtube.com/watch?v=QOqTc3HXjZY) and a [creator's one-click workflow chapter at 07:38](https://www.youtube.com/watch?v=Ze3TBB4lgks&t=458s). These described visual-editor workflows and supplied no technical request examples. Transcripts were not obtained; the available caption requests returned empty responses.

## Prepared technical follow-up, September 23, 2026 (historical)

The following prepared text is retained as the earlier inquiry template. The verified September 24 send is recorded above.

To: support@magiclight.ai

Subject: Re: API integration for complete animated films inside Lineage Theater

Hello MagicLight team,

We are ready to connect our existing MagicLight API account to Lineage Theater. Please send one working server-side cURL example for submitting a small image-to-video job using an OpenClaw API key, with a placeholder instead of a real key, and an example of checking that job and retrieving its video.

Please include the supported base URL, authentication header, exact model/options, credit cost, and how to look up a submission after a network timeout without charging twice. The account dashboard currently shows API Keys, Pricing and Usage but no generation documentation. A developer-documentation link covering these operations would also work.

Our existing partner/commercial arrangement is already confirmed. This request is only for the technical connection instructions.

Thank you,
Erik
Lineage Theater / BROCOTech

## Original September 14 inquiry

To: support@magiclight.ai

Subject: API integration for complete animated films inside Lineage Theater

Hello MagicLight team,

We are building Lineage Theater, a BROCOTech application that turns family narratives, historical documents and reference photos into short animated films. We want MagicLight to be our only video-generation provider, with customers uploading, reviewing their screenplay and cast, paying, tracking production and watching the finished film entirely inside lineagetheater.com.

Our application prepares a structured screenplay using OpenAI, including an ensemble cast, per-scene dialogue, visual direction and reference photos. Please help us confirm the appropriate MagicLight API or partner integration before we purchase API credits or enable customer payments.

1. Does your API support your complete script-to-video workflow, including consistent recurring characters, animation, voices, lip sync, music and final film assembly? The public Openclaw API packs mention Hailuo image-to-video; please distinguish those capabilities from the full MagicLight film workflow.
2. Please provide the official developer documentation and sandbox details for authentication, reference-image uploads, character references, scene/script submission, job status, webhooks, cancellation and finished-video retrieval. Include request/response examples, supported limits, idempotency or request lookup, rate limits and failure handling.
3. How can an API customer select the highest supported animation quality and export resolution? Which options apply to our account, and can your API return current capabilities and a binding or bounded production quote before submission?
4. Can BROCOTech sell films through its own application, collect customer payments itself, and pay MagicLight for the underlying generation usage? Please identify the applicable API/partner terms, attribution requirements, end-customer rights and any restrictions on this arrangement.
5. Are website subscription credits separate from API credits? How can an account owner check prior API purchases or associate an existing API purchase with the correct account? Please also explain charging for failed/cancelled jobs and the usage/invoice references available for reconciling provider expense.
6. What retention/deletion controls apply to uploaded family documents and photos and generated media? Can our backend retrieve the completed film for private delivery and long-term customer access?

Our initial target is a roughly two-minute film, with an appropriately sized supporting cast and the highest supported quality. We need a server-to-server integration that does not redirect customers to MagicLight or automate the consumer website. If this requires a partner program, please direct us to the correct technical contact.

Thank you,
BROCOTech / Lineage Theater

---

An email based on this template was sent to support@magiclight.ai on September 14, 2026 (UTC), after user authorization and with the user's requested signature. Its recipient, signature and presence in Sent Items were verified. This historical inquiry predates the published client references above; the remaining production controls still require technical confirmation.

This record contains no API keys, credentials, private uploads, billing details or purchase commitment.
