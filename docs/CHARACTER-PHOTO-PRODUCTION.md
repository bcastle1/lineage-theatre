# Character photos in production

In **Review script & cast**, the customer can choose an appearance photo for
each character from the film's JPEG, PNG and WebP sources. This explicit choice
sets `character.referencePhotoId` and links the source in `character.sourceIds`.
The written character description remains editable for supplied identity, age
and period details. The application does not infer ethnicity or biography from
a photo. A selected reference guides appearance; it is not a guarantee of likeness.

Preparation reads the selected original from the current account's private media
library. It requires a ready, non-trash record, matching private object path,
content type, byte count and ETag. It fully reads and hashes the original, decodes
it with a 40-megapixel limit, and normalizes the entire image to a JPEG fitting
within 1600 pixels, without cropping. Inputs are limited to 20 MB, at least
64 pixels in each dimension, and a single frame. Normalized output is limited to
2 MB. The stored original is unchanged.

Only new manifests with an explicit photo choice include `referencePhotoId` and
a server-created `referencePhoto` binding. The binding records source ID, owner
hash, original SHA-256, content type, size, ETag, normalization version and
normalized-image SHA-256. It contains no image bytes, download URL or credentials.
Client-supplied bindings are ignored. The existing immutable manifest hash covers
the binding, so changing a photo or its description requires a new preparation.

Before a new render submission, the worker verifies the selected source against
that saved binding and sends the normalized image as a data URI. The current Wan
endpoint supports this transport; the exact Seedance US endpoint also documents
base64 data URIs for file inputs. The source remains private in Lineage Theatre,
and only selected production inputs are sent to the generation service.

A selected photo replaces that character's generated reference portrait. It does
not trigger a new portrait charge. Missing, deleted, unreadable or changed photos
stop preparation or new submission; there is no fallback to an invented portrait.
Unselected characters retain the existing description-based reference workflow.
Already submitted provider requests keep their existing identities and can still
be reconciled without uploading the photo again.

Deploy the web application and worker together. The worker advertises
`referencePhotoVersion: 1`; quoting a plan with photo selections requires a fresh
heartbeat with that capability. The provider model and recipe remain unchanged.
Existing manifests without selected photos preserve their content hashes,
generated references, request identities and completed media. A correction to an
existing film is a separate saved plan; old paid plans are never edited in place.

API references:

- [Wan 3.0 reference-to-video](https://fal.ai/models/alibaba/wan-3.0/reference-to-video/api)
- [Seedance 2.5 US reference-to-video](https://fal.ai/models/bytedance/seedance-2.5/us/reference-to-video/api)

Production still needs the existing speech, media and private-delivery checks.
Neither this reference binding nor a successful provider response proves facial
consistency or historical accuracy across every generated scene.
