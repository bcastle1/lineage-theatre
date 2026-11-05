# Video delivery verification, November 5, 2026

The production-only test on source `49e468f777442e656ec24d297e8b4a9f990ccaf0`
rendered a fictional 15-second, three-cut film, but did not deliver a finished
video. All three cuts completed about 4 minutes 23 seconds after production
began. Normal visual review blocked the first cut for appearance and wardrobe
inconsistency about five minutes after the run began. No customer invoice,
payment, credit purchase, or automatic generation retry was performed.

Inspection of the saved references and three sampled frames confirmed the
problem: the references specify one green-apron character and one blue-apron
character, while early frames contain two green-apron figures. A later frame
shows the blue-apron figure. The quality gate correctly withheld delivery;
it must not be weakened to make this sample pass.

Existing 15-second and 30-second finished fictional films both played to the
end at 1920x1080 in the authenticated production browser, without media
errors. Opening the exact completed film link displayed its private player.
These playback checks do not prove new rendering succeeds reliably.

## Candidate correction

New plans bind each character to a separate Kling element and matching
`@ElementN` prompt reference. The saved scene title and explicit film-context
label reduce ambiguity between the current action and the overall synopsis.
The original narration, dialogue, and visual directions remain intact.

The provider documents `image_urls` as style/appearance references and
`elements` as character/object inputs. Each element accepts reference images.
This is a targeted correction for the observed cast duplication, not a
guarantee of consistent generated imagery:

- [Kling O3 Pro reference-to-video documentation](https://fal.ai/models/fal-ai/kling-video/o3/pro/reference-to-video/api)
- [Provider input schema](https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=fal-ai/kling-video/o3/pro/reference-to-video)

The binding version is saved before pricing. Existing prepared manifests,
provider request identities, review receipts, payments, and historical sample
hashes retain their original behavior. New plans require the worker's matching
capability heartbeat. Speech, visual, decoding, and private-storage checks
remain required before a film is marked ready.

The library also distinguishes finishing, status reconciliation, and attention
from active rendering. Active films refresh every ten seconds while visible;
returning to the tab refreshes immediately. Background refresh must preserve
visible entries and must not overlap requests or interrupt playback.

## Release and acceptance

Candidate validation passed: 1,168 tests with zero failures and two local
FFmpeg tests skipped, TypeScript checking, and the production build. The local
Python test used the installed runtime through `LINEAGE_TEST_PYTHON` because
the system `python3` command points to a Windows Store launcher.

The synthetic authenticated private-media route check passed playback/ranges,
HEAD, download-byte verification, ownership denial, and unavailable-media
denials with zero outbound requests. In the candidate browser UI, a fictional
account opened its private player and played the existing demonstration
video at 1920x1080 without a media error. This fixture is not new provider output.

The new worker capability must be available before the web release offers
new plans. Old jobs must continue reconciling their original operations.

Keep a worker that understands character binding version 1 until every new
bound job has finished or has been explicitly resolved. Rolling the web app
back does not make those saved plans compatible with an older worker. Do not
roll the worker back to the pre-binding image while bound jobs remain active.

A separately approved bounded live test is still required after the candidate
is installed. Record first submission, clip completion, verified delivery,
automatic player availability, and actual playback. Never reset or replay
the failed sample's operation identities. Unit tests and a successful build
do not establish provider quality or successful live delivery.
