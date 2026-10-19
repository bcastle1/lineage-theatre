# Isolated film model comparison

`scripts/evaluate-film-models.mjs` compares one exact saved-script excerpt with
Seedance 2.5 US and Kling O3 Pro. It creates one 4–15 second clip per model, reuses
the selected scene's existing character images, and requests native audio. It
does not change the completed film, its payment, production queue, current model,
or qualification records. Provider use is funded by the merchant.

Use an existing secured runtime with `BLOB_READ_WRITE_TOKEN` and `FAL_KEY` in its
environment. Keep the evaluation directory private and persistent. It contains
private script text and reference URLs. Never delete claims to retry a submission;
an uncertain result requires reconciliation with the provider's request records.

## Preparation

Create a private JSON configuration containing `shotIndex` (zero-based),
`durationSeconds`, `narration` and `dialogue`. Both speech fields must be strings;
each nonempty value must be an exact substring of the selected saved scene. An
empty field intentionally excludes that part of the speech from both samples.
The excerpt must contain speech and fit the bounded speaking-rate check.

```sh
node scripts/evaluate-film-models.mjs prepare --directory /private/evaluation --prepared-id <saved-film-id> --config /private/config.json --maximum-cost-cents 2000
```

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
1080p estimate of $1.164 per generated second and a conservative $1.20 bound;
Kling's floor is $0.15 per generated second. The script enforces at least those
bounds and, for Kling, at least the freshly returned base unit price multiplied
by one million. A higher verified rate requires a higher configured bound.
Changing the hardcoded floors requires another review of these exact endpoints.

Seedance explicitly requests 1080p, 16:9, H264, high bitrate and native audio.
Kling uses the Pro endpoint with 16:9, native audio and `shot_type: customize`;
its resolution is determined by that endpoint. No reference-image generation is
submitted. Base-price readback alone does not establish all resolution or audio
multipliers. The configured upper bound and approved total ceiling must cover
both candidate requests before submission can begin.

Preparation writes an immutable `plan.json` and returns its SHA-256, exact source
hashes and total cost bound. A new directory is required for a different plan;
keep the prior directory and its claims intact.

## Submission and observation

```sh
node scripts/evaluate-film-models.mjs submit --directory /private/evaluation --approve-plan-sha256 <prepared-plan-sha256>
node scripts/evaluate-film-models.mjs poll --directory /private/evaluation
```

The explicit approved hash must match the saved plan, which expires after one
hour. Every candidate submission freshly checks the owner, completed source,
references, exact inputs, live base prices and total bound. An exclusive,
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
