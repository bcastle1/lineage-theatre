# Qualifying Seedance 2.5 US for checkout

New film quotes use two Seedance routes. Shots without approved photos use the US text-to-video route. Shots with approved photos use the US reference-to-video route. The production API and media worker read the same operator-reviewed receipt from `FILM_SEEDANCE_QUALIFICATION`. An absent or invalid receipt keeps checkout closed.

## Collect the two samples

1. Use the fal account that supplies the app's production credentials. Review its request history first. Existing completed runs on the exact routes below can qualify if they meet all the media checks. For a fresh test, budget up to **$4.80 per four-second clip, $9.60 total** at the app's $1.20 per generated second ceiling, subject to current pricing. Each separate submission can incur another charge.
2. Use a fictional scene. For example, film a blue paper boat floating on still water and ask for a narrator to say “The boat drifts home.” Choose four seconds, 16:9, 1080p, H.264 MP4, native audio enabled, no input video. Submit the text test to [US text-to-video](https://fal.ai/models/bytedance/seedance-2.5/us/text-to-video). Submit the photo test to [US reference-to-video](https://fal.ai/models/bytedance/seedance-2.5/us/reference-to-video) with an original photo of the paper boat. Use each route's production input settings. Review the published commercial-use designation for both.
3. Keep the two completed request IDs, exact endpoint names, account request records and original downloaded MP4s. For each MP4, run the checks below with its actual file path. The probe must show 1920×1080 H.264 and AAC. Record the file's duration in milliseconds and its lowercase SHA-256. The full decode must exit successfully. Play the entire file in a browser and listen for the generated audio.

```sh
ffprobe -v error -show_entries stream=codec_name,width,height:format=duration -of json clip.mp4
ffmpeg -v error -xerror -i clip.mp4 -map 0:v:0 -map 0:a:0 -f null -
```

Use `sha256sum clip.mp4` on Linux or `(Get-FileHash -Algorithm SHA256 clip.mp4).Hash.ToLowerInvariant()` in PowerShell.

## Install the reviewed receipt

Store a single JSON object in the server and worker deployment configuration. Use these fields from the review.

| Field | Value |
| --- | --- |
| `version`, `model`, `recipeVersion` | `3`, `seedance`, `lineage-realistic-seedance-2.5-us-v1` |
| `source` | `production-account` |
| `commercialUse`, `reviewedAt` | Boolean reflecting both reviews and UTC timestamp of the completed review |
| `technicalSamples` | Array with one record for each US route |

Each sample contains:

| Field | Source |
| --- | --- |
| `endpoint`, `requestId` | Exact route and distinct completed request ID from the account |
| `commercialUseSource` | `https://fal.ai/models/` followed by the exact route |
| `mediaSha256`, `durationMs` | Hash of the original MP4 and measured duration, in whole milliseconds |
| `width`, `height`, `videoCodec`, `audioCodec` | Measured stream values, using `h264` and `aac` |
| `nativeAudio`, `fullDecodePassed`, `browserPlaybackPassed` | Boolean results from the sample review |

Reload the worker and deploy the API with the same reviewed receipt. New paid quotes additionally require a ready Seedance worker, matching current provider rates and existing funding controls. Each finished film undergoes media, runtime and private-delivery checks. The native audio check measures audio duration. Exact spoken words and character likeness require a separate human review.
