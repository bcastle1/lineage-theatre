# Kling element contract correction

The November 5 PR #77 live acceptance test exposed a provider contract error.
The three video requests returned HTTP 422 because element inputs had
`reference_image_urls` without `frontal_image_url`. No finished video was
published. Production web traffic was restored to source `49e468f`; the
binding-capable worker was retained. Inspection of all 17 saved jobs found
only the failed operator test using binding version 1, with no affected
customer job.

## Required contract

[fal's Kling O3 reference API](https://fal.ai/models/fal-ai/kling-video/o3/pro/reference-to-video/api)
documents a frontal view and one to three additional views. Its live validator
requires both fields for an image element. Nullable individual fields in the
public OpenAPI schema did not encode that cross-field requirement. A repeated
copy of the frontal image does not establish the required different view.

The corrected plan uses binding version 2. A new immutable reference operation
creates an additional angle conditioned on the original character image,
using the existing [nano-banana-pro image context input](https://fal.ai/models/fal-ai/nano-banana-pro/api).
Each video element receives the frontal image and the distinct additional
image. Both pass the same bounded reference normalization before submission.
The normal speech, visual, decode, and private-media checks remain required.

For two fictional characters, the new plan needs four reference operations
and three video operations totaling 16 provider seconds. At the app's current
reviewed ceilings, this is $3.60 in fal usage. The bound operator test requests
a separate maximum of 360 cents plus normal automated verification usage.
This calculation is a provider authorization ceiling, not a customer price,
billing receipt, or assertion of failed-request refunds.

## Compatibility and release

Historical manifests, payloads, operation identities, and completed media
remain readable. Version-1 plans are retired for new quotes and new provider
submissions; saved operations can still be reconciled. No failed version-1
operation is reset or silently retried under version 2. New plans require the
matching worker capability before spending.

Version 2 has a separate delivery-timing history because its additional image
phase depends on the original portraits. Historical timing keys remain intact.

The production visual-review route must recognize the exact new fixed
operator manifest and its 360-cent, four-reference, three-video grant. The
historical 300-cent/two-reference grant rules remain separate. This must be
tested through the actual route, not only through a local runner.

Release needs approval for the new PR. Activate the compatible worker first,
verify its heartbeat, then release the web app. After the PR #77 rollback,
a new merge alone must not be assumed to restore production alias assignment.
Verify or explicitly promote the approved production build,
then confirm its served source marker on the custom domain.

Retain a compatible worker while any bound jobs remain active, including
during a web rollback. Do not use older instructions to restore an old worker
and web image together after new bound plans exist.

The additional live test needs its own approval and immutable identities.
Offline tests cannot establish that generated alternate views preserve
identity, that all film quality checks pass, or that a newly generated film
becomes watchable. Record actual creation-to-delivery and browser playback
evidence before claiming those outcomes.

## Candidate verification

The local full suite passed 1,178 tests with zero failures and two optional
FFmpeg checks skipped. The production build passed. The actual-handler local
delivery fixture passed private playback, byte ranges, download checksum,
ownership denial, and payment-state access gates with zero outbound calls.
Its payment records and media were synthetic; this was not a payment test.

The bounded runner is reviewable in `scripts/test-kling-element-contract.mjs`,
with nine offline tests in `tests/kling-element-contract-canary.test.mjs`.
It pins seven operations, immutable authorization, a new identity, the exact
manifest, and the 360-cent ceiling. Old approval flags, repeated ambiguous
POSTs, broader grants, and earlier worker capabilities are rejected. Running
its `plan` action is offline; a live action requires separate user approval.

These checks do not establish live provider acceptance or visual quality.
