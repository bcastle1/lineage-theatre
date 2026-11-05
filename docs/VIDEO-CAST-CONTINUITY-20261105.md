# Cast continuity and finishing failure correction

The PR #78 live test produced three clips, but the second clip showed a
duplicate character and a changed outfit. Its normal visual review correctly
blocked delivery. The operator runner released its finishing lease without
saving the terminal failure on the production job, so the library continued
to show **Finishing checks** with no playable video.

## New generation contract

New Kling plans use character binding version 3. Each cut gets a composed
starting image conditioned on its original cast references and saved scene.
The composition requests one instance of each intended visible character,
consistent clothing, distinct positions, and a stable camera. Starting images
and additional character views can progress concurrently after the frontal
references are complete.

Before a video request, the ordinary worker endpoint reviews the starting
image against the saved originals and full scene context. The endpoint reads
the image identities from private records and verifies the current job lease
and production authorization. It accepts no caller-supplied approval or image.
The adapter checks the persisted review again against the exact normalized
starting-image bytes it is about to submit. A missing, uncertain, or failing
review cannot authorize a video request. Failed checks never trigger another
paid generation automatically.

If the worker lease expires after a valid model response, the result is saved
as awaiting authorization. That state cannot authorize rendering. A renewed
authorized worker can confirm the same unchanged result without another
model call; an ambiguous response still requires reconciliation.

Kling receives the reviewed starting image and complete frontal/additional
view elements. The final visual review explicitly checks cast duplication
and missing required characters as well as appearance, wardrobe, action,
setting, and image integrity. Speech, decode, exact duration, private storage,
and readback checks remain required before Ready and Watch become available.

The request shapes follow the provider's
[Kling reference API](https://fal.ai/models/fal-ai/kling-video/o3/pro/reference-to-video/api)
and [image context API](https://fal.ai/models/fal-ai/nano-banana-pro/api).
Valid request shapes and offline tests do not prove generative quality. A
fresh live acceptance test remains necessary.

## Accurate failure status

Terminal finishing failures persist a sanitized reason on the exact unfinished
job. The library and progress projections show **Needs attention**, including
operator runs without a queue ticket. Transient failures retain bounded retry
behavior. Conditional job writes and current claim checks prevent stale
workers from overwriting completion or a newer claim. Successful verified
completion clears any older retry diagnostic.

The historical v2 test needs a separate guarded reconciliation; code deployment
alone does not change its saved status. `scripts/reconcile-operator-finishing.mjs`
defaults to a read-only plan. Its explicit apply action validates the exact
failed visual receipt and obtains a short finishing lease before saving
Needs attention. It cannot render, invoice, or publish a film.

## Compatibility and release

Saved absent/v1/v2 manifests, payloads, quote identities, and operation IDs
retain their prior contracts. Retired v1 plans still cannot start new work.
The new worker supports v2 and v3, while a v2 worker cannot start v3 work.
The v3 delivery timing history is separate because the new checks add work.

After release approval, activate and verify worker capability 3 before
releasing the web app. Verify the exact approved source on the production
domain; a Git merge alone is not evidence of an active production alias.
Keep a compatible worker while any v3 jobs remain active, including a web
rollback. Apply the old test's status correction only with approval and a
validated exact receipt.

## Bounded next live test

`scripts/test-kling-cast-continuity.mjs plan` is offline. The fresh fictional
15-second test uses run key `kling-cast-continuity-canary-20261105-v3` and manifest
`601d70f77e912b17cd1f76ee1522f6c42109f693d09b352b524284e6dd6c270f`.
It allows exactly two frontal images, two additional views, three starting
images, and three video clips totaling 16 provider seconds. Its proposed
ceiling is **$4.50 in existing fal credits plus normal automated verification**,
subject to live price checks before every new operation. This is a spending
ceiling, not a billing receipt. Earlier $3.00/$3.60 approvals do not apply.

Live mutation commands require the separate flag
`--execute-approved-new-450-cents-cast-v3-20261105` after user approval.
The runner uses the normal preflight and finishing services. It neither
creates a customer invoice nor exercises a payment transaction.

Acceptance requires all saved visual and speech checks to pass; a private
verified 15-second MP4; automatic library transition to Ready and Watch;
and signed-in browser playback with advancing time, decoded frames, and no
media error. Record submission, provider completion, delivery, and first
playback times. Inspect the previously failing cast scene during playback.
If a check fails, require Needs attention and stop without automatic paid retry.

Offline coverage includes cast and exact-image binding, changed or revoked
authorization, duplicate requests and lost acknowledgements, historical plans,
status/completion races, exact canary limits, and guarded reconciliation.
The actual-handler local delivery fixture verifies private playback ranges,
download bytes, and ownership with synthetic data and zero outbound calls.
These tests do not establish that a newly generated production video plays.
