# Film quality and automatic production release verification

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
