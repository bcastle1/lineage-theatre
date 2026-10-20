# Isolated film model comparison

`scripts/evaluate-film-models.mjs` compares one exact saved-script excerpt with
Seedance 2.5 US and Kling O3 Pro. It creates one 4–15 second clip per model, uses
the corrected scene's explicitly selected character photo and approved existing
references for its other characters, and requests native audio. It
does not change the completed film, its payment, production queue, current model,
or qualification records. Provider use is funded by the merchant.

Use an existing secured runtime with `BLOB_READ_WRITE_TOKEN` and `FAL_KEY` in its
environment. Keep the evaluation directory private and persistent. It contains
private script text, photo metadata and reference URLs. Photo bytes are read from
private storage for submission and are not saved in the evaluation plan. Never
delete claims to retry a submission;
an uncertain result requires reconciliation with the provider's request records.

## Preparation

First save the corrected draft as a new immutable prepared plan, with an explicit
`referencePhotoId` selected for the character who needs the real photo. Preparation
must bind that photo into `character.referencePhoto`. The original completed film
remains the source of any existing generated character references. A corrected
draft may have a new film ID; the evaluation plan explicitly binds both prepared
IDs and both immutable manifest hashes. It requires the same ancestor, style,
factuality, scene order, narration, dialogue and total requested runtime. It allows
visual descriptions, photo selections and the draft title to change.

Create a private JSON configuration containing `correctedPreparedId`,
`originalManifestHash`, `correctedManifestHash`, `shotIndex` (zero-based in both
plans), `referenceCharacterMap`, `durationSeconds`, `narration` and `dialogue`.
Both speech fields must be strings; each nonempty value must be an exact substring
of the selected **corrected** saved scene. An
empty field intentionally excludes that part of the speech from both samples.
The excerpt must contain speech and fit the bounded speaking-rate check.

`referenceCharacterMap` maps each corrected scene character **without** a selected
photo to an original manifest character ID. Supply the mapping even when the IDs
are unchanged. No other keys are permitted. The mapped names must still identify
the same person and no original reference may be assigned to two characters.
Characters with a selected photo must have no mapping: their generated portraits
cannot replace the selected photo. For example, if Phillip has the selected photo
and Mary uses her original generated reference:

```json
{
  "correctedPreparedId": "<new-prepared-id>",
  "originalManifestHash": "<original-64-character-sha256>",
  "correctedManifestHash": "<corrected-64-character-sha256>",
  "shotIndex": 0,
  "referenceCharacterMap": { "<corrected-mary-id>": "<original-mary-id>" },
  "durationSeconds": 12,
  "narration": "<exact corrected scene excerpt>",
  "dialogue": ""
}
```

```sh
node scripts/evaluate-film-models.mjs prepare --directory /private/evaluation --prepared-id <original-completed-prepared-id> --config /private/config.json --maximum-cost-cents 2000
```

The selected photo must belong to the active owner, remain ready and available,
and match its immutable manifest snapshot. The shared production-photo reader
checks the private file's bytes, SHA-256, content type, size and ETag, then confirms
the deterministic normalized JPEG checksum. It preserves the entire photograph
without cropping. The same verified JPEG is supplied to both models as a Base64
data URI, supported by the file-input sections of the exact
[Seedance US API](https://fal.ai/models/bytedance/seedance-2.5/us/reference-to-video/api)
and [Kling Pro API](https://fal.ai/models/fal-ai/kling-video/o3/pro/reference-to-video/api).
No public photo upload or generated replacement portrait is created.

Without a `rates` object, preparation only returns the current API pricing and
saves a pricing snapshot; it cannot submit a render. Add the following shape to
the private configuration using the exact returned base price and unit for each
model, then rerun preparation. `unitPrice` and the bounds must be numbers.

```json
{
  "rates": {
    "seedance": {
      "unitPrice": 0.0214,
      "unit": "1000 tokens",
      "maximumMicroUsdPerSecond": 1200000,
      "sourceUrl": "https://fal.ai/models/bytedance/seedance-2.5/us/reference-to-video"
    },
    "kling": {
      "unitPrice": 0.15,
      "unit": "seconds",
      "maximumMicroUsdPerSecond": 150000,
      "sourceUrl": "https://fal.ai/models/fal-ai/kling-video/o3/pro/reference-to-video"
    }
  }
}
```

These base values illustrate the format; the live pricing response must match.
The operator must review resolution and native-audio pricing on the exact
[Seedance US endpoint](https://fal.ai/models/bytedance/seedance-2.5/us/reference-to-video)
and [Kling Pro endpoint](https://fal.ai/models/fal-ai/kling-video/o3/pro/reference-to-video)
before approving a plan. The October 19, 2026 review used Seedance's published
1080p estimate of $1.164 per generated second and a conservative $1.20 bound.
The same review found a base API rate of $0.0214 per 1,000 tokens and a published
1080p rate of $0.0234 per 1,000 tokens. Seedance accepts only the reviewed
`1000 tokens` unit. For the fixed 1920×1080, 24-fps, image-reference payload, its
minimum allowed bound is the largest of:

- $1.20 per second;
- `(1920 × 1080 × 24 / 1024 / 1000) × liveBasePrice × (0.0234 / 0.0214)`;
- `$1.20 × (liveBasePrice / 0.0214)`.

The second term applies the documented output-token formula and preserves the
reviewed 1080p premium. The third scales the conservative published-price margin
with a base-price increase; merely editing `unitPrice` in the configuration cannot
retain the old low bound. A lower base price does not lower the $1.20 floor.
There are no input videos, so the input-video duration term is zero. This pricing
profile must be reviewed again before adding video inputs or changing resolution,
aspect ratio, frame rate, token formula or the resolution premium.

Kling accepts only `second` or `seconds` and enforces the greater of $0.15 per
second and its freshly returned unit price. Unknown units fail closed for both
models. All derived values round upward to whole microdollars per second, and
per-request totals round upward to cents. A higher verified rate requires a
higher configured bound and still must fit the approved $20 total. Changing these
reviewed pricing constants requires another review of the exact endpoints.

Seedance explicitly requests 1080p, 16:9, H264, high bitrate and native audio.
Kling uses the Pro endpoint with 16:9, native audio and `shot_type: customize`;
its resolution is determined by that endpoint. No reference-image generation is
submitted. Base-price readback alone does not establish all resolution or audio
multipliers. The configured upper bound and approved total ceiling must cover
both candidate requests before submission can begin. The current approved total
ceiling is $20; the runner rejects a higher configured ceiling.

Preparation writes an immutable version-2 `plan.json` and returns its SHA-256,
exact source hashes and total cost bound. `inputProof` contains each actual
provider payload's SHA-256 and a reviewable copy with photo data replaced by
source ID and normalized checksum. The actual data URI is rebuilt from freshly
verified private bytes before each POST. Version-1 comparison plans cannot be
submitted by this runner. A new directory is required for a different plan;
keep the prior directory and its claims intact. An estimated cost bound is not a
provider-enforced spending limit; retain the current pricing review and margin.

## Submission and observation

```sh
node scripts/evaluate-film-models.mjs submit --directory /private/evaluation --approve-plan-sha256 <prepared-plan-sha256>
node scripts/evaluate-film-models.mjs poll --directory /private/evaluation
```

The explicit approved hash must match the saved plan, which expires after one
hour. Every candidate submission freshly checks the owner, original completed
source, corrected prepared plan, selected photo bytes and snapshot, retained
generated references, exact inputs, live base prices and total bound. A missing,
changed or unselected photo stops the comparison; it never falls back to a
generated portrait. An exclusive,
fsynced local claim is saved before each POST. A second submit invocation never
resubmits an existing claim, including one whose response was lost. Raw request
identity is retained before convenience URL validation to assist reconciliation.

Polling validates status URLs and media hosts, and checks returned MP4 metadata.
The first terminal observation is saved immutably; subsequent polls reuse it,
including its elapsed time. Elapsed time is submission-to-observation wall time,
including queueing and any delay between polls, not isolated model compute time.

Completed samples still need full decoding, saved-script speech verification,
visual continuity and lip-sync review, and private playback. Polling deliberately
returns those quality flags as false. It does not deliver either sample to the
customer or qualify a replacement production model.

## One reviewed Kling access-rejection recovery

The explicit `retry-rejected-kling` action is limited to the already reviewed
original request `01a15695-178d-7d90-838c-6be342ac18c3`. It is not a general retry
mechanism. Use the newly authorized temporary Kling credential in the same secured
runtime and keep the existing evaluation directory and approved plan intact:

```sh
node scripts/evaluate-film-models.mjs retry-rejected-kling --directory /evaluation --approve-plan-sha256 <same-approved-plan-sha256>
node scripts/evaluate-film-models.mjs poll --directory /evaluation
```

Before its single recovery POST, the action requires the original claim and
receipt, a completed Seedance receipt and terminal record, unchanged source and
photo bytes, identical payload hashes, fresh matching prices, and the unexpired
approved plan. The combined cost bound still covers one Seedance generation and
one Kling generation and must remain at most $20. This recovery applies only to
the confirmed access rejection, which produced no Kling video; it cannot authorize
another Seedance request or another attempt after an uncertain Kling submission.

It rereads the original Kling status and requires `COMPLETED` with the same
request ID. The original result GET must return HTTP 403 with exactly
`type: "resource_restricted"` and
`detail: "API key does not have access to model: fal-ai/kling-video/o3/pro/reference-to-video"`.
A successful result, different error, nonterminal state or ambiguous response
stops recovery. The exact rejection is saved in `kling-confirmed-rejection.json`
before an exclusive `kling-recovery-claim.json` is created.

Original claims, receipts and observations remain unchanged. Recovery response,
receipt, uncertainty and terminal records use the separate `kling-recovery-`
prefix. Once a recovery claim exists, this action never submits again. Polling
uses its recovery receipt when available; a recovery claim without a receipt
reports uncertainty and requires reconciliation. Never remove those records to
make another attempt.
