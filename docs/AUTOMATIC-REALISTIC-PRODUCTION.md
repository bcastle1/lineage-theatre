# Automatic realistic film production

The customer flow is one saved screenplay and production plan, a current cost quote,
QuickBooks hosted checkout, and the paid-film screen. Confirmed payment schedules
the same durable queue immediately. The one-minute reconciliation sweep recovers
payments when the customer closes the browser. Browser return alone cannot confirm
payment or authorize rendering.

The production singleton uses only Kling O3 Pro reference-to-video through fal
(`fal-ai/kling-video/o3/pro/reference-to-video`), with native audio and 1080p output.
New plans divide longer scenes into 3–15 second cuts before pricing; the original
screenplay and every spoken word remain saved. Film durations remain 15–600 seconds.
Uploaded character photos are verified and fitted without cropping. Nano Banana
may create missing still-image references; it is not a video alternative.
Photographic character references are shared across cuts, with up to four
references per cut and four cuts in flight. Each new paid operation requires a fresh authorization for
the exact paid manifest and its total cost ceiling. Saved operation identities
prevent duplicate submissions after retries or lost responses. Unknown outcomes
and provider rejections stop for review; safety filtering remains enabled.

The Kling credential is `FAL_KLING_KEY`, restricted to Kling O3 Pro and Nano Banana.
The earlier `FAL_KEY` remains only for reading/reconciling existing provider records.
New Wan and Seedance requests are blocked. Existing jobs retain their original
model and recipe; completed clips are polled, never relabeled as Kling. Unstarted
parts of an earlier paid plan require review, not an automatic new charge.

The private worker runs every 15 seconds after its previous pass on the existing
isolated Docker host. It holds only Blob, fal and a scoped worker secret; QuickBooks
credentials remain in the web runtime. A worker heartbeat no older than three
minutes, matching the Kling recipe and `deliveryChecksVersion: 1`, is required
before a new price can be quoted. New invoices also require a fresh server-side
check of the saved plan and its accepted budget. Reused quote keys cannot silently
change the accepted price. Keep the image pinned by
digest in `/etc/lineage-worker/host.conf` and secrets in the mode-600 runtime file.
The image includes FFmpeg and a cached local English speech-recognition model.

Before delivery the worker transcribes generated narration, verifies the scripted
words and their timing, removes only clearly separated extra trailing speech,
assembles the scenes/captions, decodes the final video and verifies a private-storage
checksum readback. Missing/replaced/truncated speech invokes the existing bounded
local soundtrack repair, then requires another script check; unresolved errors
pause the job. Temporary pre-submission readiness or grant-expiry failures retry
with bounded backoff, while uncertain submissions remain reconciled by their
original request identities. This check
does not guarantee historical accuracy, likeness or flawless generated imagery.

The progress display follows saved stages, completed scenes and fresh worker
observations. Kling does not borrow the former model's timing history or promise
an ETA from one short comparison. Until five comparable full films finish,
progress follows confirmed work. Deadlines do not slide on every poll. Stale or overdue work is identified,
and 100% is reserved for verified delivery. The paid screen automatically opens
the exact finished film only when the matching order and private media are ready.
Payment starts the production workflow; rendering and verification take time.
Estimates are not completion promises.

MagicLight, local-video and LTX creation controls and production endpoints are
retired. Historical playback, records and original payments are preserved. No
planning-price fallback can charge for an unavailable renderer. This release
does not change fal auto-top-up settings: funded service credits are an operating
prerequisite, separate from the customer's QuickBooks payment. No support email
is sent by this production path.

Operational verification: `systemctl status lineage-worker.timer`, the fixed-code
worker counts in its journal, `production/worker-health.json`, and per-order queue
states. Do not reset uncertain request journals or fabricate a new captured
payment to restart a film. Restore the prior image pin and web commit together
for rollback; never overwrite customer films or payment records.
