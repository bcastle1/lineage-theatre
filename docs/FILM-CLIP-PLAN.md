# Multi-clip scene prerequisite

`api/_lib/film-clip-plan.mjs` derives a deterministic visual clip timeline from an existing private v1 film manifest. It is a preparation helper only. Nothing imports it into customer checkout, production readiness, provider submission, the worker, or assembly. It makes no provider requests and writes no records.

The current runtime maps one scene to one shot and one provider output. A longer scene will need multiple shorter outputs when the verified provider limit cannot cover the scene. This helper supplies their identities and time mapping without changing the original paid plan.

## Input and identity

```js
const { plan, planHash } = buildFilmClipPlan({
  manifest: savedJob.manifest,
  manifestHash: savedJob.manifestHash,
  capabilityPolicy: {
    version: 1,
    evidenceHash: verifiedCapabilityRecordHash,
    maximumClipDurationMs: verifiedMaximumClipDurationMs,
  },
});
```

The caller must obtain the manifest/hash from the authenticated immutable job and the policy from a server-controlled, independently verified capability record. The evidence digest binds the record's identity; this helper cannot prove the record is authentic or that its assertions are correct. There is no browser endpoint, `verified` flag, environment bypass, default duration, or policy inferred from `planningSecondsPerClip` or a paid planning estimate. No real MagicLight capability policy is supplied by this change.

The helper validates the current v1 manifest shape, exact SHA-256 of its serialized content, mirrored scene/cast references, unique ordered shot IDs, positive integer timing, contiguous coverage, and exact film duration. The existing 1,500,000-byte screenplay limit applies; the full manifest can be larger because it repeats scenes and continuity. Unknown manifest or policy fields require an explicit versioned implementation change.

The required policy supports a positive integer maximum of up to 600,000 milliseconds. Films retain the existing 15–600-second range and 1–30 scenes. At most 600 clips may be produced; a smaller cap that would exceed that count fails before clip allocation. There is no truncation or partial plan.

## Output and remaining integration

Each clip contains a deterministic SHA-256 ID, original `shotId` and `sceneIndex`, zero-based `partIndex`, `partCount`, absolute `startMs`, `sceneOffsetMs`, and `targetDurationMs`. Clips fill each scene in order at the supplied maximum, followed by any remainder. Every target is positive and within the cap; scene and film totals remain exact. The plan contains the original manifest hash, normalized capability policy/hash, film ID, target duration, and clip list. `planHash` is the SHA-256 of `JSON.stringify(plan)`.

Identical input and policy values produce identical identities regardless of policy property order. Changing source content, the capability evidence digest, or the duration cap changes the plan identity. The function does not mutate or return aliases to the manifest, policy, payment, or prepared job.

These are editing targets, not provider request durations. A short final remainder may still require a longer supported provider clip, then an independently reviewed trim. The helper does not establish minimum/discrete durations, trim support, quality, costs, available credits, or an enforceable budget. Those need verification before adapter adoption. Narration, dialogue, reference imagery, captions, and their timing remain attached to the original scene; this helper neither repeats nor invents spoken content for every subclip.

Later work must bind a verified policy/plan to a durable job, price and authorize the exact required provider work, persist one claim and task ID per clip, handle uncertain results without duplicate submission, and assemble the clips against this map with separately verified audio. The existing payment identity and original manifest must remain intact. This prerequisite does not activate generation or claim finished-film readiness.

## Verification

`node --test tests/film-clip-plan.test.mjs` uses real `buildFilmManifest` outputs with wholly fictional scripts and synthetic capability evidence. It checks exact boundaries and totals, immutable inputs, deterministic identities, changed evidence/content, invalid hashes/timing/reference copies, bounds, and large valid saved manifests. No provider, storage, or network calls are used.
