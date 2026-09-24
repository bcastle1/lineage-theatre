# MagicLight protocol evidence

`api/_lib/magiclight-client.mjs` implements the published task submission/status protocol in isolation. It is not a film-production adapter: `available` remains false, submission is disabled by default, and it does not supply quotes or authorize spending. The application keeps the existing unavailable film adapter.

## Source records

Inspected as public source text on September 23, 2026. No external skill was installed or executed, and no credential was submitted during this source review. Hashes below are SHA-256 of the retrieved UTF-8 script text.

| Publisher and version | Script | Origin in source | SHA-256 |
| --- | --- | --- | --- |
| zhangyuangao / magic-text2video 1.0.2 | [media_gen_client.py](https://clawhub.ai/api/v1/skills/magic-text2video/file?path=scripts%2Fmedia_gen_client.py&version=1.0.2) | `https://open-test.magiclight.ai` | `9845a495e4975c7cc072b203c13d371272ccb977f763e0c069637d556383e19a` |
| zhangyuangao / magic-image2video 1.0.1 | [media_gen_client.py](https://clawhub.ai/api/v1/skills/magic-image2video/file?path=scripts%2Fmedia_gen_client.py&version=1.0.1) | `https://open-test.magiclight.ai` | `1e48a88fa9e11a0f8f0f1e786180d5398f916bd961d160960d2175ebfa72e378` |
| leizhang-magiclight / magic-image-to-video 1.0.1 | [media_gen_client.py](https://clawhub.ai/api/v1/skills/magic-image-to-video/file?path=scripts%2Fmedia_gen_client.py&version=1.0.1) | `https://open.magiclight.ai` | `c1ac83cbbe6dc6c4a8dbf8e7b81baf24a782c08c5cd3cbc141c9649c132cd079` |

ClawHub's publisher records are not marked official; no public company affiliation was established. The first-party [MagicLight API Keys page](https://magiclight.ai/openclaw/api-keys/) establishes that MagicLight issues keys, but does not itself document these operations. Source discovery does not prove this account's entitlement or successful operation. The client defaults to the production-named origin found in the third source; this is an explicit source-backed selection, not a live readiness claim.

The text skill disables TLS verification. The image skills use certificate verification, but retry task creation without a documented idempotency key. This implementation retains native TLS verification and rejects redirects; it does not reproduce either unsafe behavior.

## Implemented operations

Authentication is the source's `Authorization: Bearer` header. Submission uses `POST /api/misc/openclaw_add_task` with JSON `text`, optional `image_url`, and `X-DashScope-Async: enable`. Status uses `GET /api/misc/openclaw_check_task?task_id=...`. The samples use business code `10000`, creation's `data.task_id`, and status's `data.task_status` and `data.video_url`. The published polling code treats status 2 as success and 3 as failure. Other numeric codes/statuses are retained without invented meanings.

The image source also describes signed image-upload URLs through `openclaw_put_url` and `openclaw_get_url`. Those operations are not implemented here: the isolated client never fetches user image URLs, signed upload destinations, or returned media URLs. Upload/download need reviewed destination hosts and media checks before use in a film adapter.

## Server interface and limits

```js
const client = createMagicLightClient({
  apiKey: serverSecret,
  environment: "production", // or the source's explicit "test" origin
  enableSubmission: false,
});
const evidence = await client.checkTask({ taskId });
```

- `checkTask` returns `{ providerCode, taskStatus?, taskId?, videoUrl? }`. `providerCode` is the exact numeric `biz_code`. Unknown business codes return only that code. No `authenticated`, `paid`, `ready`, or entitlement conclusion is inferred. A status-0 reply for a nonexistent task is not proof of authentication.
- `submitTask({ text, imageUrl? })` requires explicit server construction with `enableSubmission: true`. This is not an environment variable or a film-readiness override. It returns `{ providerCode, taskId }`; there is no automatic retry. POST failures after dispatch are marked `submissionUncertain` because acceptance may be unknown.
- Numeric JSON task identifiers are preserved from the original number token instead of rounding 64-bit IDs. String IDs remain unchanged. An unsupported runtime fails closed on unsafe integers rather than polling a rounded identifier.
- Only the two fixed origins above are accepted. There is no configurable base URL, arbitrary request path, redirect following, or credential forwarding to media URLs.
- Each response is limited to 128 KiB of decoded bytes while streaming, with cancellation on rejection. The default 15-second deadline covers fetch and body consumption; the configured ceiling is 90 seconds. Declared lengths must match unencoded bodies; native fetch decompresses encoded bodies while retaining their compressed length header, so that header is not compared to decoded size. JSON, UTF-8, task identifiers and response fields are validated. Input text is capped at 100,000 UTF-8 bytes as an application limit, not a claimed provider limit.
- Errors use fixed redacted messages/codes and optionally an HTTP status or numeric provider code. Provider messages, response bodies, trace IDs and transport error messages are not exposed. Raw responses containing credentials in returned task/media fields are rejected.

## Requirements still outside this protocol

Account API acceptance, production quality/model selection, duration limits, exact quotes or enforceable budgets, request lookup after uncertain submission, refund/failure semantics, output CDN/expiry/size guarantees, and character/audio/continuity support are not established by these examples. The command help mentions Wan 2.6 but supplies no model selector or quality contract. These sources cannot support a promise of highest-quality rendering or permit the existing paid film pipeline to spend a planning estimate.

Read-only owner diagnostics can record actual HTTP/business responses without claiming more than they establish. Paid film production still requires the verified adapter and current payment/recorded-reversal authorization already enforced by the worker.

The implemented Administration overview button calls same-origin owner-only `POST /api/admin` with only `{ "action": "checkMagicLightConnection" }`. The server uses its existing protected `MAGICLIGHT_API_KEY` and generates a fresh random task reference. No browser-supplied credentials, origin, prompt, or task ID are accepted. The action is rate limited to three checks per minute, returns only redacted diagnostic fields, and audits only a fixed code and authentication classification. A missing key sends no request; HTTP 401 is rejected authentication; generic success/status 0 and unknown business codes remain unconfirmed. Every outcome keeps `productionReady:false` and `generationSubmitted:false`. Deploying this action is required before checking the saved production key in its protected runtime.

## Verification

`node --test tests/magiclight-client.test.mjs` uses synthetic fetch/stream fixtures only. It covers fixed hosts, path validation, disabled submission, exact request shape, uncertainty without retries, bounded/stalled/truncated responses, secret redaction, and unchanged film availability. It makes no live provider requests.

## Single owner live test

Administration contains a separate owner-only live clip test using a fixed fictional shipyard prompt and the application's existing public illustrated still. The owner explicitly authorizes one generation using provider credits; exact cost and output duration remain unverified. This is separate from customer checkout and the saved paid film. It does not set production readiness or mark an order fulfilled.

The service stores one private permanent claim at `integrations/magiclight/operator-test-v1.json` before sending a generation POST. It confirms the exact record, current owner, fixture, connection fingerprint, and claim before dispatch. Every later submit attempt returns that saved claim; reloads, retries, key changes, and restarts cannot create another job. Once the provider returns a task ID, storage-only retries preserve that same ID and claim. A lost or ambiguous provider reply remains uncertain and never triggers automatic resubmission.

Owner routes use same-origin session checks: GET `magicLightLiveTest` reads the record; POST `submitMagicLightLiveTest` requires only explicit `consent:true`; POST `checkMagicLightLiveTest` polls only the privately stored task ID. Browser prompts, origins, keys, image URLs, task IDs, and replacement request IDs are rejected. Keys, provider task IDs, and full returned media URLs stay private. The UI exposes only fixed diagnostic codes and the returned media origin; playback requires separate host and media verification.

Focused service/route tests cover concurrent submissions, lost storage responses, bounded task-ID persistence retries, stale status races, owner revocation, changed credentials, output validation, redaction, and rejection of arbitrary input. A completed provider status is evidence of a provider result, not yet a verified playable film.
