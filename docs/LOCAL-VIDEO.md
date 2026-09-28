# Local video on DGX Spark

The Create & watch step offers a **Free archive film** alongside the existing paid production flow. It uses the saved scene text and selected account photos to make a 720p H.264/AAC MP4, with restrained photo motion, title cards, burned-in captions, and eSpeak NG computer narration. It does not synthesize moving characters or clone voices. No paid video or text API is called by this renderer.

## Deployment

The worker runs on BROCOSpark-01 (192.168.1.133), independently of its existing language-model container. Build `deploy/local-video/Dockerfile` from the repository root. Run as UID 1000 with `--cpus=2 --memory=2g --memory-swap=2g --restart unless-stopped`; GPU access is unnecessary. Set `LINEAGE_VIDEO_ORIGIN=https://www.lineagetheater.com` and a dedicated `LINEAGE_LOCAL_VIDEO_WORKER_KEY` of at least 40 characters, matching the Vercel production secret. Keep that environment file outside Git with mode 600. Do not supply account cookies, the Blob store credential, or other provider credentials to the worker.

The worker makes outbound HTTPS requests to `/api/studio?local=1&worker=1`. There are no internet-facing Spark ports. API function count stays unchanged. The existing private Blob store retains queue records and completed MP4s under `local-video/`. A heartbeat expires after two minutes; new requests fail clearly when the worker is offline. The worker must remain powered on and connected for new renders.

Requests are scoped to an authenticated, approved account. A persisted request UUID makes repeat submissions idempotent. Each queue claim lasts five minutes and renews every 30 seconds. Lost workers are reclaimed up to three attempts. The worker only receives the requested screenplay and authorized photos, plus a short-lived immutable upload grant for the exact output path. Publication verifies size and SHA-256 against private stored bytes. Playback checks the signed-in account and supports HTTP range requests. Existing billing and paid production authorization remain independent.

Limits: 12 requests per account per day, 1–30 scenes, 15–600 seconds requested runtime, 12,000 narration/dialogue characters, JPG/PNG/WebP photos up to 20 MB each, 100 MB output, and 900 seconds maximum finished runtime. Narration may extend the requested runtime. Render failures are explicit. Working drafts and their current render reference continue to use the existing browser project storage.

## Advanced generation installation

ComfyUI commit `8d534945ebd53cff61e8def81757c6a6c1b9cf2d` is installed separately at `/home/brocotech1/lineage-video/ComfyUI`, in image `lineage-comfy:8d534945`. It is bound to Spark loopback port 8188. An SSH forward exposes it to the operator at `http://127.0.0.1:18188` on the Windows PC. The editor currently runs in CPU mode, with a 4 GB memory cap, while the existing GPU service remains active.

The selected advanced model is official LTX-2.5, revision `5e6e71018ee1756ed329b697a7b4aedc934dfce9`, using the publisher's NVFP4 distilled transformer for Blackwell. The user approved the Hugging Face access consent and a read-only device authorization. The download credential remains in the Spark user's private Hugging Face cache, outside all worker and ComfyUI container mounts. No paid cloud video endpoint is enabled.

The six model components are the NVFP4 transformer, Gemma 4 12B int8 text encoder, both video VAEs, audio VAE, and spatial upscaler. `/home/brocotech1/lineage-video/download-models.py` downloads them with resumable, bounded HTTP transfers and verifies each size and SHA-256 against the pinned publisher metadata. The `lineage-model-http` user service has a 1 GB memory limit. Completed components are recorded in `ComfyUI/model-receipt.json`; six records confirm the complete pack. Credentials never appear in receipts.

Two saved workflows adapt the official ComfyUI LTX-2.5 template: **Lineage LTX-2.5 preview** (two seconds at 0.2 megapixels) and **Lineage LTX-2.5 quality** (five seconds at 0.9 megapixels). Prompt enhancement is disabled, avoiding an additional optional model. They are in `ComfyUI/user/default/workflows`.

Advanced generation needs separate memory capacity. The initial preflight found only 10.2 GiB available while the existing language-model service was active. `deploy/local-video/enable-ltx-gpu.sh` refuses GPU activation below a conservative 48 GiB of available system memory or before all six components are verified. It only replaces the task's `lineage-comfy` container and never stops the language-model service. The 48 GiB check is a safety threshold, not a verified peak-memory benchmark. After capacity is available, the advanced path still needs an actual GPU render and output playback before it can be offered to customers. Confirm the publisher's commercial-license applicability before activation.

## PC AI scene worker — September 28, 2026

The **AI scene video** panel creates one text-to-video scene at a time using LTX-2.5 on Windows PC `EPC`, with its RTX 5080 (16 GB VRAM) and 64 GB RAM. It offers two or five seconds at 1024 × 576, 24 fps, with model-generated sound. It does not use reference photos or promise exact spoken narration or historical likeness. This is separate from the narrated archive-film option.

Installation directory: `C:\Users\erikc\Documents\Codex\lineage-pc-video`. The isolated runtime uses Python 3.13.15, PyTorch 2.14.0+cu130, ComfyUI commit `8d534945ebd53cff61e8def81757c6a6c1b9cf2d`, and the same six checksum-verified LTX files as Spark. The worker's fixed workflow uses the NVFP4 distilled transformer, int8 Gemma encoder, convolutional video VAE, audio VAE, and the publisher's two-stage sampling/upscaling recipe. It uses disk-backed weight streaming and reserves an additional 2 GB of GPU headroom. The heavier diffusion VAE is installed but is not used in this profile.

The Windows scheduled task **Lineage AI Video Worker** starts at this user's sign-in. Its `pc-supervisor.py` supervises the private ComfyUI process and outbound worker, restarting them after failure. ComfyUI listens only at `http://127.0.0.1:8189`. Windows must remain awake and this user must remain signed in. No public rendering port or firewall exception is required. Both Spark LLM services keep their existing configurations.

`worker-settings.json` holds the production origin and dedicated `LINEAGE_AI_VIDEO_WORKER_KEY`, with file access restricted to the Windows user and SYSTEM. Only the outbound worker receives that key. A copied Node executable and `@vercel/blob` 2.8.0 handle scoped uploads. Neither the Hugging Face credential nor the site's Blob credential is copied to the PC worker. ComfyUI partner API nodes are disabled.

The same private-job implementation uses separate `ai-video/` job, pending, account-history, heartbeat, and media paths through `/api/studio?local=ltx`. The Spark archive worker cannot claim AI jobs. Starts are limited to six per account per day, one scene, and two or five seconds. Output reports must identify the configured engine and exact dimensions. Completion, account isolation, expiring leases, immutable upload grants, and SHA-256 publication follow the archive worker's checks.

The PC worker submits only a fixed graph with customer text as a string input. It allows up to 30 minutes per render, validates the returned local path, decodes the output, re-encodes browser-compatible H.264/AAC with workflow metadata removed, and publishes through the private account endpoint. Its ComfyUI history and intermediate output for the job are removed afterward; models are unloaded when idle. It waits for an idle ComfyUI queue and at least 8 GB available system RAM before claiming work.

Stop the scheduled task and the two process IDs recorded in this installation's `worker.pid` and `comfy.pid` to take the renderer offline; verify their executable paths belong to this installation first. Restart the task to resume. Jobs interrupted during a stop retain the existing lease/retry behavior.

## Release validation

Run `node --test tests/local-video.test.mjs`, `pnpm test`, and `pnpm run build`. Test a real film in the container, including an image scene and a title-card scene; use ffprobe plus a full ffmpeg decode to validate its output. Then verify an authenticated custom-domain job through queue, rendering, completion, reload, playback, and download; reject anonymous and foreign-account media access. Retain only nonsecret test receipts.
