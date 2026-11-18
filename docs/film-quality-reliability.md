# Film quality and automatic production release verification

> **Status note, November 18, 2026:** The October 23 results recorded at the end of this document were observed on this candidate's release. On November 5 the generation contract was replaced by character binding v3 ([cast continuity](VIDEO-CAST-CONTINUITY-20261105.md)), and no film has yet been delivered under it, so this checklist must be completed again for the current pipeline. See the [current status](../README.md#current-status-november-18-2026).

Candidate prepared on 2026-10-22. Local verification is recorded below; live
release acceptance remains pending until the evidence checklist is completed.
A deployment marked ready, a paid invoice, or a provider clip alone does not
establish that a customer can watch the finished film.

## Behavior in this candidate

- Newly prepared Kling films save a versioned appearance and wardrobe contract
  before pricing. Character references and explicit screenplay descriptions
  guide appearance; scripted wardrobe and age changes take precedence over the
  reference image. Cuts from one scene retain its continuity identity. Existing
  paid manifests keep their saved plan, prompts and authorization.
- Finishing samples each generated clip at 15%, 50% and 85% of its target
  duration, with the previous cut's final sample when both belong to one scene.
  The server reviews the samples against the saved script and selected or
  generated references. Appearance, wardrobe, scene action and image integrity
  must all pass. Receipts bind the manifest, current provider outputs and frame
  hashes; old or mismatched receipts cannot authorize delivery.
- Review requires the current payment, saved job and active worker lease. Model
  credentials remain on the web service. A mismatch or uncertain claimed review
  pauses the film for attention. Preclaim unavailability remains retryable;
  rate limiting has a bounded retry and cooldown. Unknown model outcomes do not
  cause unbounded inference replay or automatically regenerate paid clips.
- Generated speech still runs through the existing speech checks. When the
  existing speech mismatch policy permits a replacement soundtrack, automatic
  casting uses a deterministic map of distinct stock voices and a bounded
  natural-speed fit selection. It preserves approved text and any existing
  approved or cached cast. This does not clone voices or infer demographic
  traits from names or photos. Caption, speech, duration, audio and private-file
  validation still apply before delivery.
- An already authorized, ongoing Kling film can refresh expired provider
  pricing only for the same saved manifest, provider recipe and execution
  ceiling. Current price must remain within that ceiling. The original paid
  invoice and execution authorization remain fixed; this path creates no new
  invoice and cannot enlarge the budget. Payment, reversal, account and saved
  job checks run again after external pricing returns.
- Automatic payment fulfillment remains restartable through the durable
  outbox and queue. Customer progress reaches 100% only after current stored
  media and payment validation. Crossing a completion boundary during polling
  cannot return a stale finishing state alongside ready media. Missing or
  invalid delivery evidence never becomes ready. Films using the new visual
  checks learn separate delivery timings rather than borrowing old estimates.

## Local evidence and limits

`tests/paid-production-flow.test.mjs` composes the actual hosted checkout,
payment confirmation, automatic outbox, queue, production, visual receipt,
private artifact verification and authorized download services. Its external
Accounting, render/model and storage transports, frame extraction and media
encoding are synthetic. It proves service contracts and failure behavior; it
does not prove live payment processing, generated-film quality or deployment.

The focused verification run passed 26 tests across that integration suite,
`production-progress`, `film-production-progress` and `worker-runtime-check`.
Both worker Dockerfile COPY inventories were checked against their positive
context allowlists: 96 regular-image inputs and 88 soundtrack-image inputs were
present and allowed, including the new visual-review helper. This source check
does not replace building and starting the actual container image.

Sampling can miss brief defects between frames. Passing checks is not a promise
of perfect likeness, historical accuracy, lip synchronization or identical
voices across separate films. Generated references can contain imperfections.
Human review of a real finished sample remains necessary. New timing profiles
need matching completed-film history before a measured delivery window is shown.

## Acceptance evidence still required

- [ ] Record the exact candidate commit, immutable web deployment, production
  aliases and worker image digest. Verify the deployed source matches the
  reviewed candidate and retain a matched web/worker rollback target.
- [ ] Build and start the real worker image with the existing restricted runtime.
  Check FFmpeg, cached speech recognition, offline soundtrack voices and fit
  inspection. Confirm a fresh heartbeat advertises visual checks version 1.
- [ ] Run the separately authorized, fixed quality canary within its saved
  provider spending ceiling. For staging, use an explicitly selected immutable
  preview endpoint; do not move the public alias to obtain test access. Record
  actual provider outputs and server review receipts without exposing secrets
  or private reference media.
- [ ] Inspect the finished canary for character/reference consistency, wardrobe
  within a scene and intentional changes between scenes. Listen for clear names,
  numbers, speaker distinction, timing and soundtrack levels. Record defects
  as well as passes; do not infer quality from model receipts alone.
- [ ] Verify the real output's codec, duration, audio, stored checksum and private
  readback. Confirm signed-in playback and download on desktop and mobile.
- [ ] For an authorized existing paid record, verify captured payment, automatic
  scheduling, provider work, finishing and ready delivery as separate stages.
  Preserve the original charge, ceiling and request identities. Demonstrate
  expired-price recovery without another invoice or duplicate provider charge.
- [ ] Confirm a reversal, invalid private artifact or visual-review hold cannot
  show a false 100% or expose the private film. Preserve original uploads,
  provider results, payment records and idempotency journals through rollout
  and rollback.

Append deployment identifiers and observed results when these checks are
performed. Leave any unverified item unchecked.

## Observed results: October 23, 2026

Recorded in the PR #74 and PR #75 descriptions; not re-checked from this
repository.

- Release: the paid run used 0ef5815 (PR #74; GitHub production deployment
  7265196490 at 22:24:24 UTC on October 22). The final release was 49e468f
  (PR #75; Vercel deployment `dpl_4wBDQ8HF4eFiHgiH3qgDtenNVJRV`, GitHub
  production deployment 7285104468 at 17:53:51 UTC on October 23). Worker image `sha256:b29ea599…`, timer active, fresh heartbeat.
- Paid run: QuickBooks invoice 354, $7.88, captured at 17:31:13.147 UTC. The
  automatic outbox queued production 1.210 seconds after the payment was
  recognized, and the film completed at 17:49:29.783 UTC (18 min 16.6 s). The
  content was fictional and the payment was a test.
- Output: a 30.04-second 1080p24 H.264/AAC MP4 of 29,180,138 bytes, all 721
  frames decoded, private SHA-256 `85e16a8b…` verified. The payment page opened
  the film automatically; signed-in desktop and mobile playback and download
  were verified.
- Inspection: the PR #74 description records that nine sampled frames matched
  the fictional reference appearances, wardrobe (cream shirts, green and blue
  aprons) and intended actions, and that independent offline speech
  recognition matched all scripted words. It claims no human listening and no
  perfect lip-sync.
- Not recorded: human listening, the separately authorized quality canary,
  expired-price recovery, and the reversal, invalid-artifact and review-hold
  checks.

The checklist boxes stay unchecked. These results belong to the October 22
candidate, whose generation contract was replaced on November 5, and the
checklist has not been completed for the current pipeline.
