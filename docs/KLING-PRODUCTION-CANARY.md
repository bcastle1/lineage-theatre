# One approved Kling production canary

The owner authorized up to **$3 of existing fal credit** for this separate
fictional production check. The runner binds one fixed sample, one preparation
identity, three video request identities and two still-reference identities.
It creates no invoice or customer payment and cannot operate on a family film.

The finished target is 15 seconds. Its 5.5, 5 and 4.5 second cuts request 6, 5
and 5 seconds from Kling. The reviewed ceiling is therefore
`16 × $0.15 + 2 × $0.30 = $3.00`. The grant freezes both component rate ceilings.
The live rate is checked again before every potentially paid submission and
neither component may exceed its saved ceiling. Existing durable fal claims prevent a second POST
after a lost response. Do not change the run key, manifest hash or scope to
recover an uncertain result.

## Runtime

Use the deployed worker image with its current production modules, FFmpeg,
offline speech-recognition assets and private Blob configuration.
`FAL_KLING_KEY` and `BLOB_READ_WRITE_TOKEN` must already be supplied securely.
Set `LINEAGE_CANARY_OWNER_EMAIL` to the authenticated, persisted owner account.
The runner rereads that owner's status on every operation. The current worker
heartbeat must advertise the Kling recipe and `deliveryChecksVersion: 1`.

Only `plan` is offline. `prepare` reads live pricing and saves the isolated
operator job and immutable grant, but does not submit a generation request.

```sh
node scripts/test-kling-production.mjs plan
node scripts/test-kling-production.mjs prepare --execute-approved-300-cents
node scripts/test-kling-production.mjs step --execute-approved-300-cents
node scripts/test-kling-production.mjs status
```

Repeat `step` only for this same prepared sample while status is `processing`,
then inspect `status` again. Each invocation makes at most one film-service
advance, with the adapter independently journaling any required still or video
operation. Wait between polls. If status is `uncertain`, `failed`, or the runner
returns `attention`, inspect existing receipts; do not start another sample.
The existing grant expires after 24 hours and is never renewed automatically.

When the actual status command reports `awaiting-assembly`:

```sh
node scripts/test-kling-production.mjs finish --execute-approved-300-cents
node scripts/test-kling-production.mjs status
```

Finishing downloads the actual provider clips, runs the ordinary strict speech
review, assembles and fully decodes the output with FFmpeg, uploads it privately,
reads back and hashes the exact stored bytes, then accepts the finished artifact
through the normal production service. It does not inject a passing transcript
or use the payment-bound soundtrack fallback. A speech failure remains an
honest canary failure and cannot trigger more paid generation.

The result remains a clearly titled fictional operator sample in the owner's
film library. The existing authenticated media route serves it without
creating a payment exemption for customer films. Verify browser playback
separately; a completed decode/storage check does not claim browser playback,
historical accuracy, likeness, voice consistency or lip synchronization.
