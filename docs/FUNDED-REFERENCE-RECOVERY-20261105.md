# Recover the funded cast test

The v3 15-second operator test stopped when fal rejected Alice's frontal
portrait for exhausted credits. A later top-up funds new work but does not
change that request's stored HTTP 403 result. Fal's queue reports COMPLETED
for failed requests too. [Result API](https://fal.ai/docs/api-reference/inference-api/queue/result),
[Status API](https://fal.ai/docs/api-reference/inference-api/queue/status)

This recovery applies only to job `ec43a635-8c7e-8f99-dc90-d4ceb2681bb5`,
manifest `601d70f77e912b17cd1f76ee1522f6c42109f693d09b352b524284e6dd6c270f`,
and original Alice request `01a1ad68-46cc-7520-91a4-dba5bf63908c`.
It is not a general automatic retry policy.

## Preserved records and checks

The original fal receipt, job identity, screenplay, and 450-cent grant remain
unchanged. One separate immutable recovery claim authorizes one deterministic
replacement operation. A lost or uncertain submission never permits a second
POST. Only a completed, validated image can be selected through a separate
immutable reference-choice record.

The adapter, canary input guard, starting-image preflight, and final visual
review explicitly resolve the same choice. They do not impersonate the old
request or accept caller-supplied image URLs. The failed original remains
available as evidence. Existing jobs without this exact choice follow their
original behavior.

Normal cast, narration, video decode, duration, assembly, private upload and
readback checks still determine delivery. Publishing a reference choice does
not make the video Ready or create a Watch link.

## Separate recovery authority

Both modes require explicit approval for the one replacement request. The
original allowance for seven references is not silently expanded. There are
eight physical image attempts when the failed original is counted.

- `verified-zero-charge`: a matching explicit zero-quantity and zero-cost
  billing export or provider confirmation, plus `replacementApproval`, keeps
  the combined ceiling at 450 cents. An absent billing row, missing billable
  header, positive account balance, or terminal 403 alone is insufficient.
- `separate-30-cent-approval`: `additionalApproval` authorizes up to 30 more
  cents and a conservative 480-cent combined ceiling. The failed original is
  counted at its full allowance. This mode is not authorized by the original
  450-cent approval or the separate provider credit purchase.

Evidence schemas and exact scope are defined in
`api/_lib/fal-reference-choice.mjs`. Evidence must be verified by the operator
against its source before its JSON bytes are hashed and supplied. No tool
creates approval evidence automatically. Do not put credentials, card details,
provider media, or raw billing exports in the repository.

## Operator command

`scripts/recover-cast-canary-reference.mjs` takes an action, an evidence JSON
path, and its SHA-256 hash. It uses the existing protected worker environment.

```text
node scripts/recover-cast-canary-reference.mjs plan EVIDENCE_JSON SHA256
```

`plan` performs GETs and storage reads only. `recover` can submit or poll the
single approved replacement but does not advance the rest of the film. `run`
waits for that same replacement, selects it, performs one normal advancement
of the existing stopped job, then continues the committed canary with its
unchanged grant. It does not reset any production status or request receipt.

An executing action requires the corresponding fourth argument:

```text
--execute-approved-zero-charge-reference-recovery-20261105
--execute-approved-additional-30-cent-reference-recovery-20261105
```

The flag must match the independently reviewed evidence mode. Unknown,
missing, mismatched or extra arguments fail before any provider operation.
Any uncertain replacement stops for reconciliation; rerunning cannot create
another child identity. The adapter's deterministic `fal-...` shot ID may
exist while portraits are pending, so the one-time resume additionally checks
that all eight downstream request receipts are absent.

## Release and acceptance

This change is prepared for review. It does not authorize a merge, production
deploy, extra spending, or a new test identity. After approval, deploy the
reviewed worker and web source before using the recovery command. Recheck the
same job, grant expiry, account funding, current pricing, and exact original
rejection. Never extend an expired grant silently.

Completion requires the existing job to reach Ready automatically and its
15-second video to play in the signed-in library. Record actual completion
and playback evidence. Report funding and intervention delay separately from
rendering and finishing time; this operator test is not a measurement of the
customer payment or queue-admission path.

## Offline validation

The full local suite passed 1,268 tests with zero failures and two FFmpeg
runtime skips. The initial run encountered Windows' Python launcher alias;
the successful run used the installed Python runtime explicitly. Build and
diff checks passed. Independent review passed 42 focused recovery, consumer,
CLI and canary tests. These checks do not establish live recovery or playback.
