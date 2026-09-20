# Payment readiness review records

The server now consumes externally signed review records. This removes the missing verifier wiring; it does **not** establish Intuit approval or activate checkout. No live review, signing key, merchant authorization, charge or refund was created by this implementation.

An authorized human reviewer must examine actual evidence. The signature establishes who approved that evidence and the exact scope of the decision. The verifier checks the signature, schema and bindings; it does not contact Intuit to independently establish approval, validate the contents behind evidence references, or certify PCI compliance. Never sign synthetic test results as real merchant evidence.

## Integration contract

`api/_lib/payment-readiness.mjs` exports:

- `paymentReadiness.readiness({actor, subjectEmail, operation})`: returns `{authorization}` or `{}`. HTTP services pass their authenticated `actor`. The internal film worker may pass `subjectEmail` only after loading the captured order that supplies it. The current private account record is checked; caller-supplied roles are ignored.
- `paymentReadiness.authorizeTransport({binding, operation})`: returns a matching authorization or `null`. `binding` comes from the encrypted current QuickBooks grant, never an HTTP body.
- `createPaymentReadiness({read, env, now})`: dependency injection for isolated tests. No route exposes these dependencies.
- `paymentReviewPath(environment, kind)`: the fixed private review-record path.

The default `payments` singleton uses this verifier. The default QuickBooks transport checks it for both sandbox and production before a provider call, after refresh and immediately before dispatch. Every operation rereads and revalidates the signed reviews, then derives an authorization valid for at most five minutes and never beyond either applicable review's expiration. The reviewer chooses the evidence's own validity period; there is no automatic 24-hour human re-signing requirement. Deleting a review or removing its trusted public key prevents new operations. Existing order/receipt reads remain available without charging or refreshing. No customer or administrator setting can create review records.

The isolated tests still inject fabricated verifier responses and grants in memory. Those helpers are not a production configuration mechanism.

## Separate environments and reviews

Store signed envelopes using the established private Blob operator process at:

```text
integrations/payments/reviews/sandbox/operations.json
integrations/payments/reviews/sandbox/card-entry.json
integrations/payments/reviews/production/operations.json
integrations/payments/reviews/production/card-entry.json
```

Sandbox reviews designate only the existing owner `erik@brocotech.ai`, require `fictionalOnly: true`, and never allow customer or delegated administrator checkout. They still require the genuine configured sandbox OAuth grant and documented company/scope evidence. Use only provider-published fabricated card data and fictional film material. This mechanism does not create a synthetic provider, film quote or rendered output in the deployed app.

The film service separately requires `operator-test` mode for every sandbox quote or advance. It checks the current persisted active owner and compares the saved manifest/hash and shot IDs with its fixed fictional sample. A mode flag or caller-provided `fictionalOnly` value cannot send arbitrary family material through the sandbox adapter. Ordinary customer workflows are exercised with explicitly synthetic production-environment adapters in local tests; those mocks do not establish real provider evidence.

Production operations and card-entry reviews are separate. A card-entry review additionally requires an operations review for the same grant authorizing `charge`. A sandbox reviewer key cannot authorize production unless production is explicitly within its trusted environment scope.

## Trusted reviewer keys

The server-only `PAYMENT_REVIEW_TRUSTED_KEYS` variable is a JSON object mapping each reviewer key ID to exactly `{publicKey, reviewer, environments}`. `publicKey` is an Ed25519 public key in PEM form; `reviewer` identifies the authorized reviewer; `environments` contains `sandbox`, `production`, or both. Maximum ten keys. Configure public keys only after establishing the reviewer's authority. The private signing key must stay outside the app deployment, repository, browser and application logs.

`VERCEL_GIT_COMMIT_SHA` supplies the exact 40-character application revision. Missing revision or trust configuration fails closed. A public key by itself, an environment selection, or a stored boolean cannot enable a payment. Each approved deployment and replacement OAuth grant needs matching review records.

## Signed payload

The envelope contains exactly `keyId`, `payload`, and `signature`. Encode the UTF-8 JSON payload and 64-byte Ed25519 signature as unpadded base64url. Sign the **exact payload bytes** with Ed25519; do not sign a reconstructed object. No credential or card information belongs in either payload or evidence references.

The payload contains exactly these fields:

| Field | Required content |
| --- | --- |
| `version` | `1` |
| `audience` | `https://lineagetheater.com` |
| `kind` | `operations` or `card-entry` |
| `environment` | `sandbox` or `production`, matching the record path and configured grant |
| `grantId` | 64-character SHA-256 grant digest returned by the server transport's read-only `binding({allowRefresh:false})`; never raw OAuth material |
| `applicationRevision` | Exact deployed `VERCEL_GIT_COMMIT_SHA` |
| `reviewer` | Exact trusted reviewer identity |
| `reviewedAt`, `expiresAt` | Canonical UTC ISO timestamps, including milliseconds; review must not be future-dated and the reviewer must explicitly choose a later expiration appropriate to the actual evidence. No default or indefinite review validity is inferred. Derived operational authorizations last at most five minutes and cannot extend this expiration. |
| `operations` | A nonempty, unique subset of `quote`, `charge`, `refund`, `read`, `render`, `refresh`; a card-entry review contains only `card-entry` |
| `subjectEmail` | Owner address for sandbox; `null` for production |
| `fictionalOnly` | `true` for sandbox; `false` for production |
| `evidence` | Exactly one entry for each category below; no unknown categories |

Each evidence entry contains exactly `type`, `reference`, `sha256` and `observedAt`. The reference identifies the retained actual evidence reviewed by the signer; `sha256` is its digest. `observedAt` is a canonical UTC timestamp no later than review. These are provenance references, not assertions that the server independently inspected the underlying artifact.

| Review | Required evidence categories |
| --- | --- |
| Sandbox operations | `sandbox-company`, `payments-scope`, `owner-test-authorization` |
| Sandbox card entry | `card-entry-review`, `fictional-card-only` |
| Production operations | `intuit-production-approval`, `merchant-activation`, `payments-scope`, `sandbox-lifecycle`, `commercial-terms` |
| Production card entry | `card-entry-review`, `pci-responsibilities` |

Sandbox lifecycle evidence should cover the intended grant and actual processor outcomes, including charge, decline, uncertainty recovery and refund behavior. Production approval and merchant activation must concern the intended existing BROCO company/application. Browser-direct card tokenization remains part of the app's card-data handling; it is not hosted fields or an exemption from PCI responsibilities.

Use the narrow operations and expiration supported by the reviewed activity and actual provider approvals; do not choose a blanket long period merely to avoid review. The verifier does not impose a daily review cycle. Review renewal is an explicit new review, not a job that blindly extends expired evidence. Expired or revoked review records do not erase orders, permit duplicate submissions, infer declines, or initiate refunds.

## Film authorization remains bounded

A captured order permits a new render submission only while its **original provider quote** is valid, with its original provider budget, matching saved manifest/preparation, current grant and reviewed `render` authorization. Successful capture does not renew the provider quote. Current quote storage caps this window at 15 minutes, so long productions can pause before later shot submissions. Resolving that limit requires the vendor's confirmed quote/reservation and continuation contract; do not extend the price or budget merely because a customer paid. Reading an already submitted provider job or retaining a delivered file must not silently submit a new chargeable job.

No unknown-result charge/refund is retried. The durable order claims, captured-payment requirements, refund balance reservations and tenant boundaries remain enforced independently of these reviews.
