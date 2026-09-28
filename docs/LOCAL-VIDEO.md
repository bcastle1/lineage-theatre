# Local video on DGX Spark

The Create & watch step offers a **Free archive film** alongside the existing paid production flow. It uses the saved scene text and selected account photos to make a 720p H.264/AAC MP4, with restrained photo motion, title cards, burned-in captions, and eSpeak NG computer narration. It does not synthesize moving characters or clone voices. No paid video or text API is called by this renderer.

## Deployment

The worker runs on BROCOSpark-01 (192.168.1.133), independently of its existing language-model container. Build `deploy/local-video/Dockerfile` from the repository root. Run as UID 1000 with `--cpus=2 --memory=2g --memory-swap=2g --restart unless-stopped`; GPU access is unnecessary. Set `LINEAGE_VIDEO_ORIGIN=https://www.lineagetheater.com` and a dedicated `LINEAGE_LOCAL_VIDEO_WORKER_KEY` of at least 40 characters, matching the Vercel production secret. Keep that environment file outside Git with mode 600. Do not supply account cookies, the Blob store credential, or other provider credentials to the worker.

The worker makes outbound HTTPS requests to `/api/studio?local=1&worker=1`. There are no internet-facing Spark ports. API function count stays unchanged. The existing private Blob store retains queue records and completed MP4s under `local-video/`. A heartbeat expires after two minutes; new requests fail clearly when the worker is offline. The worker must remain powered on and connected for new renders.

Requests are scoped to an authenticated, approved account. A persisted request UUID makes repeat submissions idempotent. Each queue claim lasts five minutes and renews every 30 seconds. Lost workers are reclaimed up to three attempts. The worker only receives the requested screenplay and authorized photos, plus a short-lived immutable upload grant for the exact output path. Publication verifies size and SHA-256 against private stored bytes. Playback checks the signed-in account and supports HTTP range requests. Existing billing and paid production authorization remain independent.

Limits: 12 requests per account per day, 1–30 scenes, 15–600 seconds requested runtime, 12,000 narration/dialogue characters, JPG/PNG/WebP photos up to 20 MB each, 100 MB output, and 900 seconds maximum finished runtime. Narration may extend the requested runtime. Render failures are explicit. Working drafts and their current render reference continue to use the existing browser project storage.

## Advanced generation installation

ComfyUI commit `8d534945ebd53cff61e8def81757c6a6c1b9cf2d` is installed separately at `/home/brocotech1/lineage-video/ComfyUI`, in image `lineage-comfy:8d534945`. It is bound to Spark loopback port 8188. An SSH forward exposes it to the operator at `http://127.0.0.1:18188` on the Windows PC. The editor currently runs in CPU mode, with a 4 GB memory cap, while the existing GPU service remains active.

The selected advanced model is official LTX-2.5, revision `5e6e71018ee1756ed329b697a7b4aedc934dfce9`. Its weights are gated by Hugging Face authentication, contact-sharing consent, and the publisher's license. Access was not available during initial setup. Do not label advanced generation available until authorized model downloads, checksum verification, an actual GPU render, and output playback all succeed. Confirm licensing applicability before commercial activation. Do not stop or reconfigure the existing language-model service without the user's authorization.

## Validation

Run `node --test tests/local-video.test.mjs`, `pnpm test`, and `pnpm run build`. Test a real film in the container, including an image scene and a title-card scene; use ffprobe plus a full ffmpeg decode to validate its output. Then verify an authenticated custom-domain job through queue, rendering, completion, reload, playback, and download; reject anonymous and foreign-account media access. Retain only nonsecret test receipts.
