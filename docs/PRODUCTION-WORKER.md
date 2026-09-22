# Production queue and private delivery

The studio now saves an idempotent production request instead of depending on the customer keeping the page open. The request uses the saved plan and captured order. A separate worker continues provider jobs, assembles verified clips with FFmpeg, publishes an immutable private MP4, verifies its stored bytes, and marks the film complete. The studio reads status and serves authenticated range playback/download through its existing API function. No new public worker or completion endpoint exists.

## Current activation boundary

The default MagicLight adapter is still unavailable. On September 20 the user confirmed that the vendor has not replied with API documentation. Neither this worker nor a configured key supplies the missing provider contract. Real in-app rendering remains unavailable for both customers and internal tests; sample-clip assembly and simulated provider flows are available for testing. Do not represent those as MagicLight render success.

The worker is implemented and tested locally but has not been provisioned on a durable host. Do not enable paid film sales before connecting the verified provider, running a monitored worker against the intended private storage, and establishing actual delivery. Existing capability defaults continue to block customer production and checkout.

## Worker deployment

Use a dedicated durable Node 22+ host with FFmpeg on its executable path and access to the existing private Blob store. Keep provider, Blob and payment configuration in that host's secret manager. Do not export Vercel secrets into the repository. No provider key is consumed until the documented adapter is implemented and selected in the server and worker composition.

```text
node scripts/production-worker.mjs --check
node scripts/production-worker.mjs --once
```

`--check` is read-only and reports configuration presence, never credential values. `--once` processes one paginated pass, one provider operation per due ticket. Run passes under the host's supervised scheduler at a short interval after activation. A stopped customer browser does not stop a queued job. This repository does not silently provision a paid compute service or install a local unattended task.

Queue claims renew every 30 seconds during processing. Stale workers cannot commit after losing their claim. A restarted worker reconciles ambiguous submissions by the original stable request ID; it never blindly replays a generation POST. Normal progress is eligible again after five seconds. Transient failures back off; repeated ambiguous outcomes request attention. An authorized customer can resume their same saved request after its prerequisites are restored; this does not reset provider state or create another payment.

Temporary clips live only in a dedicated `lineage-production-worker` system-temp directory. Successful and failed invocations remove their own work directory. Startup cleanup removes only marked directories on the same host that are over an hour old and belong to a dead process. Unrecognized paths, active processes, and symlinks are left untouched. Prefer an encrypted ephemeral volume; configure the host to clear that volume on reboot. Do not put private temporary media in logs, shared folders, backups or a web root.

## Private output

The [September 22 media development change](MAGICLIGHT-MEDIA-INTEGRATION.md) adds native-profile assembly and optional separate reviewed audio tracks. Those checks operate on real decoded media and retain verified dimensions/frame rate; they do not establish a working Magiclight API connection.

Outputs use `production/media/<owner hash>/<job id>/<SHA-256>.mp4` with private Blob access and overwrite disabled. Actual byte length/hash, manifest binding, audio and decoded duration must pass verification before completion. Provider output URLs are allowlisted HTTPS, redirects are rejected, and downloads are bounded. The browser receives only its same-origin authenticated playback URL. Working sources and cloud archive consent remain separate.

Captions are generated and retained privately alongside the MP4 when upload succeeds. A customer caption-download UI and retention/deletion operations are not added by this change. Media streaming enforces session ownership, exact storage path, content type, byte count and requested range; no provider/storage URL is exposed.

## Still required for real operation

- Official MagicLight authentication, generation/output/reference-asset contracts, account quality/cost limits, idempotency or lookup, and applicable commercial permission.
- A provider pricing contract that covers the whole production. The current captured-order grant stops fresh shot submissions after the original quote expires (currently capped at 15 minutes). A long job must not silently extend that budget or invent a new price.
- Approved production merchant credentials and the reviewed payment activation evidence described in `PAYMENT-READINESS-REVIEW.md`. Sandbox review is separate and restricted to the genuine owner's fixed fictional operator test.
- Provisioned worker host, monitored scheduling, intended private storage, recovery operations, and real authenticated provider/output acceptance.

On September 20, the signed-in Intuit dashboard showed the existing Lineage Theater assessment as **Completed / Approved**. Its read-only questionnaire has the corrected In-App receipt delivery and supported receipt fields; email, fees and card last-four are unselected. No further assessment submission was needed or performed in this task. Actual sandbox transaction lifecycle verification is still marked No, and live grant migration/company verification and merchant activation remain separate checkpoints.

## Implementation verification — September 20, 2026

- All 299 automated tests and the TypeScript/Vite production build passed. The existing large-bundle advisory remains.
- The real-handler workflow, checkout-fixture and delivery-fixture checks passed with zero outbound provider calls. Delivery checks verify private ranges, HEAD, exact downloaded bytes and cross-account denial.
- FFmpeg assembled and decoded a 15-second technical sample with audio and 450 frames. This is assembly evidence only.
- In-browser fictional-account checks confirmed completed status, private MP4 metadata, advancing playback and a download event. Desktop and 390-pixel mobile delivery layouts fit without overflow; the recovered verification tab had no warning/error console entries. One earlier browser tab crashed during the playback/viewport-switch sequence; a fresh tab completed the mobile checks.
- The default worker's read-only check still reports the missing provider/storage configuration. No real render, charge, refund, signed merchant review or Intuit submission occurred during these checks.
