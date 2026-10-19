# Automatic realistic film production

The customer flow is one saved screenplay and production plan, a current cost quote,
QuickBooks hosted checkout, and the paid-film screen. Confirmed payment schedules
the same durable queue immediately. The one-minute reconciliation sweep recovers
payments when the customer closes the browser. Browser return alone cannot confirm
payment or authorize rendering.

The production singleton uses Wan 3.0 reference-to-video through fal. Photographic
character references are shared across scenes, with up to four references and
four scenes in flight. Each new paid operation requires a fresh authorization for
the exact paid manifest and its total cost ceiling. Saved operation identities
prevent duplicate submissions after retries or lost responses. Unknown outcomes
and provider rejections stop for review; safety filtering remains enabled.

The private worker runs every 15 seconds after its previous pass on the existing
isolated Docker host. It holds only Blob, fal and a scoped worker secret; QuickBooks
credentials remain in the web runtime. A worker heartbeat no older than three
minutes is required before a new price can be quoted. Keep the image pinned by
digest in `/etc/lineage-worker/host.conf` and secrets in the mode-600 runtime file.
The image includes FFmpeg and a cached local English speech-recognition model.

Before delivery the worker transcribes generated narration, verifies the scripted
words and their timing, removes only clearly separated extra trailing speech,
assembles the scenes/captions, decodes the final video and verifies a private-storage
checksum readback. Missing/replaced/truncated speech pauses the job. This check
does not guarantee historical accuracy, likeness or flawless generated imagery.

The progress display follows saved stages, completed scenes and fresh worker
observations. Before five comparable production completions exist, it labels a
conservative scene/reference/finishing estimate as an initial estimate. A typical
short film's initial window is roughly 6–13 minutes; more scenes/cast require more
time. Deadlines do not slide on every poll. Stale or overdue work is identified,
and 100% is reserved for verified delivery. Estimates are not completion promises.

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
