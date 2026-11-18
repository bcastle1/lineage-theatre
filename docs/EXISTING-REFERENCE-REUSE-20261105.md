# Resume the same film with its matching existing portrait

The approved replacement Alice portrait failed with fal's stored `TOP_UP`
response. By 21:51:59 UTC on November 5, the authenticated fal account reported
`is_locked:false`, `lock_reason:null`, and payment verification `VERIFIED`.
No support message, new top-up, key rotation, or account-setting change was
made to obtain that state. A current unlocked flag does not guarantee that
the next generation succeeds. Re-reading a failed request returns its original
error, rather than testing current account access. See the [fal result
contract](https://fal.ai/docs/api-reference/inference-api/queue/result).

An existing Alice portrait from the previous fictional test has exactly the
same generation input as the stopped test. Its owner, source manifest,
completed request receipt, input hash, and normalized image bytes were
verified through read-only inspection. The portrait shows one fictional woman
in a blue apron. The previous video's failed visual review remains unchanged;
none of that video's shots are reused.

## Fixed recovery scope

| Item | Binding |
| --- | --- |
| Current film | `ec43a635-8c7e-8f99-dc90-d4ceb2681bb5` |
| Current manifest | `601d70f77e912b17cd1f76ee1522f6c42109f693d09b352b524284e6dd6c270f` |
| Original failed request | `01a1ad68-46cc-7520-91a4-dba5bf63908c` |
| Failed replacement request | `01a1ad9a-db17-71f1-8426-f77b261e1852` |
| Source film | `f7d53722-1e84-bb97-9948-2deb3741c07a` |
| Source portrait request | `01a1ad45-4fcd-7483-aa6c-03596e2f039d` |
| Shared exact input hash | `13b865e66a71833f45f2ec909e134db18727f9755e0519667af6545d5a435916` |

The new recovery appends a reuse claim and an explicit reference choice. It
does not alter either failed receipt, the prior recovery claim, the source
film or portrait, the current screenplay, the current job identity, or the
original grant. The choice resolves to the actual old receipt identity.
It never represents the failed replacement as a successfully generated image.

Selection performs no generation POST. The original normal canary remains
responsible for the two additional character views, three composed starting
images, and three new video shots. Its existing cast preflight, final visual
review, narration, full decode, duration, private upload, and checksum readback
gates remain required before Ready or Watch becomes available.

The total approved fal ceiling stays at **480 cents**, conservatively counting
both failed Alice requests. No zero-charge assumption is made about either
failure. No new portrait replacement allowance, top-up, or automatic paid
retry is introduced. Historical portrait reuse has no new provider-generation
charge. Normal automated verification remains separate.

## Operator flow

Merge and production deployment require approval. After deploying matching
reviewed worker and web source, recheck the current fal account lock state,
balance, job binding, worker health, original grant expiry, and live pricing.
Never extend a grant or reset an uncertain receipt.

Prepare a separate, byte-pinned approval evidence JSON outside the repository:

```json
{
  "version": 1,
  "kind": "existing-reference-reuse-approval",
  "email": "erik@brocotech.ai",
  "productionId": "ec43a635-8c7e-8f99-dc90-d4ceb2681bb5",
  "manifestHash": "601d70f77e912b17cd1f76ee1522f6c42109f693d09b352b524284e6dd6c270f",
  "sourceRequestId": "01a1ad45-4fcd-7483-aa6c-03596e2f039d",
  "maximumAdditionalCostCents": 0,
  "maximumNewPortraitRequests": 0,
  "maximumTotalCostCents": 480,
  "evidenceSha256": "SHA256_OF_EXPLICIT_RELEASE_AND_REUSE_APPROVAL",
  "approvedAt": "ACTUAL_APPROVAL_UTC",
  "expiresAt": "NO_LATER_THAN_ORIGINAL_GRANT_EXPIRY"
}
```

```text
node scripts/reuse-cast-canary-reference.mjs plan EVIDENCE_JSON SHA256
node scripts/reuse-cast-canary-reference.mjs run EVIDENCE_JSON SHA256 --execute-approved-existing-reference-reuse-20261105
```

`plan` is read-only. `select` with the same flag only records the validated
choice. `run` selects it, reconciles the same stopped job once through normal
`film.advance`, then continues the existing guarded canary. Existing validated
choices remain readable after approval expiry; starting new downstream work
still requires the original active grant. Repeated selection must not create
another claim, rewrite history, or produce an extra portrait.

Successful delivery requires the exact saved film to become Ready in the
signed-in library and its new 15-second video to play through the ending.
Record recovery, rendering, finishing, visible availability, and playback
times separately from the earlier funding/intervention delay. This remains
an operator production test, not a test of customer payment or queue admission.
