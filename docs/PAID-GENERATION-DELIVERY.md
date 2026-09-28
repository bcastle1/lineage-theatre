# Paid generation delivery

The owner can request one generation for an exact paid screenplay. A permanent claim prevents another provider submission even when its response is uncertain. The Vercel generation cron checks saved task IDs every five minutes.

The separate delivery worker handles returned video only. It cannot submit generation, charge or refund money, approve content, or mark a film completed. It requires Node 22, FFmpeg, the existing private Blob token, and `LINEAGE_GENERATION_OUTPUT_HOSTS`, a comma-separated allowlist of reviewed exact output hosts. Missing hosts disable the worker. Redirects, oversized media, wrong duration, incomplete decoding, and missing browser-compatible video/audio fail verification.

After the full video and audio decode and private immutable upload/readback, the worker saves an `awaiting-review` record bound to the task, source, owner, paid order, plan, manifest, and artifact hash. The signed-in owner previews those exact bytes and confirms the scenes and narration before the original paid plan becomes watchable. The finished-film API continues to enforce current account and payment access.

Build the reviewed worker Docker image and run its offline runtime acceptance first. The separate `lineage-generation-delivery.service` and `.timer` templates use an immutable image from root-owned `/etc/lineage-generation-delivery/host.conf` (`LINEAGE_DELIVERY_IMAGE=sha256:...`) and a mode-0600 runtime environment file in the same directory. This worker needs only `BLOB_READ_WRITE_TOKEN` and the reviewed output-host allowlist. Provider and Accounting credentials stay in their existing runtime.

The timer waits one minute after each bounded pass and cannot overlap itself. Status counts contain no private media URLs or credentials. Inspect `systemctl status lineage-generation-delivery.timer lineage-generation-delivery.service` and the sanitized journal. Stop the timer and service before maintenance.

An enabled request path is not evidence that MagicLight can return the requested full film. Progress percentages are labeled stage estimates until actual reported percentages exist. A completed, paid, verified video alone reaches 100%. A numerical time estimate remains unavailable until real generation timing is established.
