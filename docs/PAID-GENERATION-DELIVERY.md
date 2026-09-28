# Paid generation delivery

The owner can request one generation for an exact paid screenplay. A permanent claim prevents automatic resubmission even when its response is uncertain. The Vercel generation cron checks saved task IDs every five minutes.

The separate delivery worker handles returned video only. It cannot submit generation, charge or refund money, approve content, or mark a film completed. It requires Node 22, FFmpeg, the existing private Blob token, and `LINEAGE_GENERATION_OUTPUT_HOSTS`, a comma-separated allowlist of reviewed exact output hosts. Missing hosts disable the worker. Redirects, oversized media, wrong duration, incomplete decoding, and missing browser-compatible video/audio fail verification.

After the full video and audio decode and private immutable upload/readback, the worker saves an `awaiting-review` record bound to the task, source, owner, paid order, plan, manifest, and artifact hash. The signed-in owner previews those exact bytes and confirms the scenes and narration before the original paid plan becomes watchable. The finished-film API continues to enforce current account and payment access.

Build the reviewed worker Docker image and run its offline runtime acceptance first. The separate `lineage-generation-delivery.service` and `.timer` templates use an immutable image from root-owned `/etc/lineage-generation-delivery/host.conf` (`LINEAGE_DELIVERY_IMAGE=sha256:...`) and a mode-0600 runtime environment file in the same directory. This worker needs only `BLOB_READ_WRITE_TOKEN` and the reviewed output-host allowlist. Provider and Accounting credentials stay in their existing runtime.

The timer waits one minute after each bounded pass and cannot overlap itself. Status counts contain no private media URLs or credentials. Inspect `systemctl status lineage-generation-delivery.timer lineage-generation-delivery.service` and the sanitized journal. Stop the timer and service before maintenance.

An enabled request path is not evidence that MagicLight can return the requested full film. Progress percentages are labeled stage estimates until actual reported percentages exist. A completed, paid, verified video alone reaches 100%. A numerical time estimate remains unavailable until real generation timing is established.

## Server acceptance: September 28, 2026 UTC

Source revision `12672785e6532f182925745302cc5cad47f60980` was packaged using an explicit Git archive allowlist. The transferred archive SHA-256 was `88ca7a882ac0581f3df02e0ff79c315781ef1f7189aa7a27d5ab2a961714282c`; the host verified it before extraction. The image is `sha256:754ee96dd6c236b1202624a7a4e02c7aef1363dfb79ca05eb253fa9eb294e74c` at staging directory `/opt/lineage-worker/staging/paid-delivery-1267278`.

All 25 delivery and review tests passed inside that image with networking disabled, no runtime credentials, an unprivileged user, a read-only filesystem, two CPUs, and 3 GiB memory. The actual FFmpeg test verified a complete H.264/AAC sample and rejected absent/short audio, wrong duration, and truncated media. The service and timer templates passed `systemd-analyze verify`.

At this checkpoint the worker is staged, with no installed runtime credentials or activated service/timer. This acceptance proves the delivery code and media runtime, not a successful external generation. The first Nathan Wood generation request remains unconfirmed and must not be automatically resubmitted.

## Activation: September 28, 2026 UTC

The owner explicitly approved granting the existing worker private film storage access. The existing Blob credential was transferred through SSH standard input into the root-owned mode-0600 runtime file, with `videocos.magiclight.ai` as the sole allowed output host. No provider, Accounting, or Vercel account credential was installed on the worker.

The immutable image above passed its configuration check and a real storage-backed delivery pass. The initial systemd acceptance exposed a cleanup error: after a successful pass Docker had already removed the container, so `ExecStop` reported failure. Cleanup now uses an optional `ExecStopPost`, which also handles interrupted starts and tolerates an already-removed container without masking the worker's exit status.

At 00:32 UTC the corrected service exited successfully with `ExecMainStatus=0`, and the timer was enabled and active. Both the manual service pass and the first timer-triggered pass returned zero pending deliveries, zero delivery errors, and one skipped request. Existing unrelated application containers remained healthy.

This activates delivery for the existing owner pilot. Nathan Wood's saved request is still unconfirmed, with no recoverable task ID or returned video; it is safely skipped. No replacement generation, customer charge, content approval, or completed-film claim resulted from activation. General customer rendering and a reliable generation-time estimate remain unverified.

## Explicit recovery of a missing acknowledgement

The owner can confirm at most one replacement of a request that has no task ID or output and has been unresolved for at least five minutes. This is a new provider request, not recovery of the original job. The confirmation explicitly acknowledges that the earlier request might still finish or consume provider credits. Ordinary starts, status checks, reloads and scheduled workers never use this option.

The server rechecks current owner access, the exact immutable paid plan and the existing confirmed payment. It archives the original request into create-only private history and verifies that copy before conditionally replacing the current claim using the expected revision. Concurrent confirmations can dispatch at most one replacement. The replacement uses the same screenplay and payment, records the risk acknowledgment and history hash, and cannot itself be replaced. A known provider task is never eligible. No new customer invoice or charge is created.

New submissions allow up to 90 seconds for the provider acknowledgement within the 180-second route limit. The client retains exact accepted task IDs from valid 2xx envelopes and records only fixed diagnostic codes, stages, and numeric HTTP/business codes. These diagnostics are shown to the owner; provider response bodies and credentials remain undisclosed. Stale no-ID claims display unconfirmed status instead of indefinite active submission.

The original Nathan request had no saved error detail, changed to unconfirmed roughly 0.34 seconds after its claim, and ran on Node 24. The absence of a corresponding provider usage entry does not establish that it was rejected. Preventive acknowledgement fixes and a recovery option do not establish full-film support or a successful video result.
