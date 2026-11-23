# Fixed studio-funded Seedance production check

This operator command runs one fictional, studio-funded film through the current
Seedance adapter and normal assembly, visual-review, native-audio and private
delivery checks. It does not create a customer sale, invoice, payment, automatic
customer queue ticket, or new qualification receipt. It cannot verify customer
checkout or bank settlement. The screenplay is the existing fixed fictional
garden sample; this command does not call story generation.

The immutable run key is `seedance-production-canary-20261122-v1`. Its 15-second
edit uses three Seedance 2.5 US text-to-video requests lasting 6, 5 and 5 seconds,
with 1080p H.264 video and native audio. There are no reference-image generations
or start-frame reviews. The manifest SHA-256 is
`a0fa6c25abc352d29194e392c93f5e9d0fab73478ea165abb1aaff1e6b11922a`.

The fal allowance is at most **$19.20**, based on 16 provider seconds at $1.20 per
second. Up to three GPT-6.2 Astra visual-review requests are billed separately.
Each shot has one durable review claim. Failed, uncertain, rate-limited or lost
review responses cannot automatically issue another request; successful exact
proofs may be reused. Changing frames cannot increase the allowance. The web
handler independently checks the fixed grant, active finishing lease and exact
per-shot claim before inference.

## Prepare and inspect

Use the reviewed worker release and its protected runtime environment. Required
configuration includes the existing Blob token, `FAL_KEY`, read-only
`FAL_BILLING_KEY`, matching `FAL_BILLING_ACCOUNT`, worker secret, saved Seedance
qualification and `LINEAGE_CANARY_OWNER_EMAIL`. The account must be the current
active owner. Do not print or copy those secrets. The production worker heartbeat
and web visual-review handler must support this exact release.

The offline plan command reads no private records and makes no external requests:

```sh
node scripts/test-seedance-production.mjs plan
```

After approval for this separate allowance and release, prepare the fixed run:

```sh
node scripts/test-seedance-production.mjs prepare --execute-approved-1920-cents-seedance-20261122
node scripts/test-seedance-production.mjs status
```

Preparation creates the fixed private operator plan and a grant valid for at most
24 hours. It reserves $19.20 in the existing shared fal funding ledger using a
deterministic operator reservation identity. It never writes `payments/orders/`.
Existing commitments remain counted; the canary cannot modify an unrelated
customer order to free funds. Preparation submits no provider job. Repeating it
reads the existing fixed grant and cannot renew or reset its allowance.

## Advance and finish

Each advance submits or polls at most one production shot. Check status between
advances; poll at a reasonable interval such as 15 seconds. Stop on an uncertain,
failed or attention result. No recovery or replacement-render command is provided.

```sh
node scripts/test-seedance-production.mjs advance --execute-approved-1920-cents-seedance-20261122
node scripts/test-seedance-production.mjs status
```

Every new submission rechecks live prices and the full shared funding reservation.
This is conservative: fal must still cover the complete held allowance at each
new submission even after earlier work has spent credit. Reads, polling and
finishing do not recheck remaining credit. A failed funding check preserves the
hold and never creates another provider operation.

When `status` reports `awaiting-assembly`, finish using the ordinary media worker:

```sh
node scripts/test-seedance-production.mjs finish --execute-approved-1920-cents-seedance-20261122
node scripts/test-seedance-production.mjs status
```

Finishing downloads the three existing clips, obtains the bounded Astra reviews,
assembles the timed edit, fully verifies video and embedded native audio, stores
the private artifact and checks its bytes and visual receipts before accepting
completion. Native-audio verification proves decoding and duration; it does not
claim transcript fidelity. The evidence explicitly reports
`transcriptVerified:false`. Human listening and visual inspection remain distinct
from those technical checks.

A completed exact private artifact lets normal shared funding accounting retire
the canary reservation on its next reconciliation. Failed or uncertain work keeps
its commitment for review. The command emits fixed status codes, hashes, counts
and bounded cost metadata, without provider URLs, private media paths, credentials
or raw model responses. `customerCheckoutVerified:false` remains explicit.

## Offline checks

```sh
node --test tests/seedance-production-canary.test.mjs tests/seedance-operator-canary.test.mjs tests/film-visual-worker.test.mjs
```

The canary tests exercise the exact input/identity bounds with the real durable
fal client, refuse changed input, prices, grants and insufficient funds, preserve
uncertain claims, cap review calls across concurrent or lost responses, and run
the real operator preparation and three-shot adapter advancement against in-memory
provider replies. They also prove that operator funding cannot write customer
payment records. These are offline checks, not evidence that a live render ran.
