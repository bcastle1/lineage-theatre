# Magiclight media integration development

Development checkpoint: September 22, 2026. This change completes additional media-processing support. It does not claim an authenticated Magiclight generation, activate checkout, or provision a production worker.

## Native output quality

Film assembly previously converted all video to 1280 by 720 at 30 frames per second. It now derives the output profile from fully decoded source media. Equal native profiles retain their dimensions and frame rate; mixed compatible clips use the smallest native dimensions and slowest frame rate so lower-quality inputs are not enlarged. Incompatible aspect ratios require correction before assembly.

The app's encoding limits are even square-pixel dimensions, at most 4096 pixels on either edge and 4096 by 2160 pixels in total, and 1–60 frames per second. These bounds describe the assembler, not Magiclight account entitlements. The assembler checks actual output dimensions, frame rate, audio and duration, and the server stores the verified width, height and frame rate with the private completed-film record. Existing archived films remain readable.

## Separate audio

An eventual server adapter can normalize a clip result into the existing internal video descriptor and optionally include an `audio` descriptor for a reviewed composite narration/dialogue track:

```json
{
  "url": "https://approved-provider-host.example/clip.mp4",
  "contentType": "video/mp4",
  "sizeBytes": 1000000,
  "durationSeconds": 5,
  "audio": {
    "url": "https://approved-provider-host.example/voice.m4a",
    "contentType": "audio/mp4",
    "sizeBytes": 100000,
    "durationSeconds": 5
  }
}
```

This is the app's internal schema, not a claimed Magiclight API payload. Only a trusted server adapter supplies output hostnames. Both files require allowlisted HTTPS URLs without redirects, supported content types and bounded exact byte lengths. Supported separate audio types are MP4/M4A, MPEG/MP3, WAV and WebM. Their URLs remain private server data and are excluded from customer status responses.

The worker downloads the audio into its own temporary directory and passes `audioPath` to the assembler. An explicit audio track replaces embedded clip audio; it does not mix an unreviewed second voice over it. The assembler fully decodes the selected track and checks its duration against the shot timeline. A customer film with missing or short audio fails verification. Synthetic silence remains limited to explicitly labelled technical samples. These checks prove media structure and timing, not spoken-word accuracy, speaker identity or lip synchronization.

Temporary files are removed after success or failure. Only verified MP4 and caption artifacts reach the existing private publication path. The immutable manifest, ownership, spending authorization and queue-recovery rules continue to apply.

## Provider investigation

The September 22 public inspection included the [API key page](https://magiclight.ai/openclaw/api-keys/), [API pricing page](https://magiclight.ai/openclaw/pricing/) and their linked first-party scripts. API pack copy describes Hailuo image-to-video models; the inspected scripts expose key, balance, usage and pack-management behavior. No supported generation authentication format, submission/status/result schema or developer SDK was found in those resources. Account-management calls do not establish a generation contract.

Development can continue on the media pipeline while these request details are obtained. Affiliate and partner offerings indicate commercial relationships; the exact applicable API terms remain to be clarified and are not treated here as a prohibition on implementation.

## Verification

Run `pnpm test` with `FFMPEG_PATH` pointing to a trusted full FFmpeg executable. CI installs FFmpeg and explicitly configures that path, so real media tests must run there. Local development without FFmpeg may skip the real media cases; an explicitly configured but broken executable must fail.

Tests cover retained 1080p geometry, compatible mixed source profiles, separate audio, short audio rejection, malformed media/profiles, private audio downloads, provider-output normalization, queue behavior and publication checks. All generated test people, media and provider responses are fixtures. No real Magiclight render or customer transaction is represented by those tests.

Local validation on September 22 passed all **314 tests with zero failures or skips**, including actual FFmpeg decoding/encoding. The production TypeScript/Vite build passed with its existing large-bundle advisory. The native-quality sample was independently decoded as 1920 by 1080, 24 fps, with AAC audio, and its stored byte length and SHA-256 were checked.

Remaining operational work includes the documented provider adapter, reference-asset submission, actual account quality/cost verification, a durable worker host and a bounded real render with private playback acceptance. See [production worker operations](PRODUCTION-WORKER.md) for the existing budget and hosting constraints.
