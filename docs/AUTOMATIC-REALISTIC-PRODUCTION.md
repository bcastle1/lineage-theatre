# Automatic realistic film production

The customer flow is one saved screenplay and production plan, a current cost quote,
QuickBooks hosted checkout, and the paid-film screen. Confirmed payment schedules
the same durable queue immediately. The one-minute reconciliation sweep recovers
payments when the customer closes the browser. Browser return alone cannot confirm
payment or authorize rendering.

New film orders use ByteDance Seedance 2.5 US through fal for 1080p video
with native audio. Scenes with selected character photos use
`bytedance/seedance-2.5/us/reference-to-video`; scenes without photos use
`bytedance/seedance-2.5/us/text-to-video`. The worker sends the planned action,
cast descriptions and scripted speech for each shot. Only photos selected and
bound to that shot are sent. The film plan keeps the original script and
target runtime alongside its generated cuts.

Each provider operation requires a fresh authorization for the paid manifest
and its total cost ceiling. Before checkout, the app checks current US endpoint
pricing, account credit and a fresh worker heartbeat advertising the Seedance
recipe. New orders also require verified 1080p native-audio samples from both
US endpoints on the production fal account ([Seedance qualification](SEEDANCE-QUALIFICATION.md)).
The worker needs access to both US endpoints. Real-person references
may also need approval on the fal account. A provider rejection or uncertain
submission leaves the request available for review under its saved identity.

Earlier films retain their original models, payments and generation receipts.
The studio can check an existing provider job or play a delivered film.
An earlier order cannot silently switch renderers or acquire a new charge.

The private worker runs every 15 seconds after its previous pass on the
existing Docker host. Billing authorization stays in the web runtime.
Keep the image pinned by
digest in `/etc/lineage-worker/host.conf` and secrets in the mode-600 runtime file.
The worker uses FFmpeg to decode the native Seedance audio and verify its duration
for each scene and the completed film. It preserves that soundtrack, assembles
the scenes and captions, and verifies the private storage checksum after upload.
The audio check confirms a playable track of the expected length. It does not
compare spoken words with the screenplay.

GPT-6.2 Astra reviews samples of the rendered scenes for visual continuity and
image integrity. Temporary readiness failures retry with bounded backoff.
Uncertain submissions retain their original provider request identities.

The progress display follows saved stages, completed scenes and fresh worker
observations. Seedance does not borrow an earlier model's timing history or promise
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
