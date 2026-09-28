# LTX narration

The full-film workflow offers 15 Kokoro neural English voices and the existing
David and Zira voices. Heart is the default for new drafts. Explicit saved voices,
old render requests, and uploaded recordings retain their selection.

## Voice and script choices

- American female: Heart, Bella, Nicole, Aoede, Kore, Sarah, Alloy, Nova.
- American male: Fenrir, Michael, Puck.
- British female: Emma, Isabella.
- British male: Fable, George.
- Classic Windows voices: Zira and David.
- Each scene can inherit the film narrator or select another voice. Each scene
  uses one voice for its narration and dialogue. There is no automatic speaker
  detection or voice cloning.
- Film speaking pace ranges from 0.8 to 1.2. Uploaded recordings retain their
  timing. Voice auditions are a fixed, fictional sample at normal pace.
- Speech is normalized toward -16 LUFS with a -1.5 dB true-peak limit, then
  delivered as 48 kHz AAC with the film. Kokoro generates native 24 kHz speech;
  resampling does not add detail. Narration is measured before generating footage
  and is never trimmed to fit. A scene remains limited to 60 seconds.
- All screenplay requests use OpenAI `gpt-6-astra` through the Responses API.
  Successful responses must confirm that model or its dated snapshot. There is
  no substitute model when access fails. Customer-facing attribution remains
  Lineage Theatre. Script consent and source-evidence validation still apply.

## Research and selection

Kokoro was selected for this installation because it offers a broad set of
English presets and an 82-million-parameter model that can run on the PC CPU,
leaving GPU memory for LTX. This is a practical selection for the existing
hardware, not a claim that it outperforms every commercial voice service.

The publisher's voice grades informed the selection; those grades reflect
training quality and duration, not a guarantee for every script. Audition voices
and review uncommon names in the finished film. Qwen3-TTS offers instruction
control and cloning, but its larger models and narrower native English preset
selection were a poorer fit for this request. Cloud services such as ElevenLabs
and Azure Speech remain alternatives when paid voices or additional languages
are needed; they are not part of this local integration.

Primary sources checked September 28, 2026:

- https://huggingface.co/hexgrad/Kokoro-82M/blob/main/VOICES.md
- https://github.com/hexgrad/kokoro
- https://github.com/thewh1teagle/kokoro-onnx
- https://github.com/QwenLM/Qwen3-TTS
- https://developers.openai.com/api/docs/models/gpt-6-astra

## PC installation

Keep the ComfyUI environment and both Spark language-model services running.
Install the voice environment separately under the existing PC worker root:

1. Create `tts-venv` with Python 3.12. Install
   `scripts/ltx-voice-requirements.txt` with uv or pip. This includes the English
   pronunciation model so runtime rendering does not download packages.
2. Put the two model assets from the `model-files-v1.1` release of
   `thewh1teagle/kokoro-onnx` into `tts-models/kokoro`:
   - `kokoro-v1.0.onnx` SHA-256
     `beb0d1848dee9a49da392cc3df26958d46cfa35d321edf434f52949153f0df3a`
   - `voices-v1.0.bin` SHA-256
     `bca610b8308e8d99f32e6fe4197e7ec01679264efed0cac9140fe9c29f1fbf7d`
3. When the worker is idle, copy `scripts/ltx-neural-voice.py` and
   `scripts/ltx-film-render.py` into `worker`, and copy
   `shared/ltx-voices.json` to `worker/ltx-voices.json`.
4. The film renderer launches the isolated voice helper before GPU generation.
   It fixes ONNX Runtime to CPU and four inference threads, checks both model
   hashes, bounds input and execution time, and strips service credentials from
   the child environment. A failed voice render fails the job without silently
   switching narrators.

The Kokoro model is Apache-2.0 licensed. The ONNX wrapper is MIT licensed.
The repository contains generated sample audio, not model weights. There is no
per-minute local voice fee; PC operation, website storage, and OpenAI script
generation retain their existing costs. Samples use the same voice helper and
loudness processing as the film renderer.
