# Local authored soundtrack construction

`rebuildFilmSoundtrack` is an isolated construction step for an operator-approved
repair. It never reads or writes customer/payment/provider records, downloads
media, submits generation, or changes the supplied video paths. The surrounding
repair tool owns current account/payment checks, source-video hashes, review,
private preview, and publication.

Inputs are the unchanged manifest and its SHA-256, one existing video descriptor
per shot, an existing private work directory, and an explicit voice map:

```js
await rebuildFilmSoundtrack({
  manifest, manifestHash, clips, workDir,
  narratorVoice: 'am_michael',
  characterVoices: { /* saved cast ID: supported Kokoro voice ID */ },
  speakerAliases: { /* exact dialogue label: saved cast ID */ },
  music: true,
});
```

The return is `{ clips, provenance }`; each clip retains its original path and
receives a newly created `audioPath`. The voice bank is checksum pinned and
checked at runtime. Every speaking character requires an explicit distinct voice;
the narrator also has a distinct voice. Full cast names and IDs match labels
without case sensitivity. Any other label needs an explicit alias. Dialogue
turns start on separate `Speaker: text` lines. Unknown/ambiguous labels fail.

Narration is followed by the saved dialogue turns, preserving all spoken words.
The constructor makes no name/number substitutions and disables Misaki markup
preprocessing. Speed is fixed at 1.0. Speech starts after 0.12 seconds, with 0.18
seconds between turns and at least 0.20 seconds left after the last word. An
overrun fails; it never truncates speech or lengthens a scene.

The private `soundtrack/` output contains each synthesized turn, its exact UTF-8
input-text hash, phoneme hash, speaker and voice, timing, model hashes, a
speech-only stem for each scene, and each final stereo mix. It retains the
original MIDI composition and rendered instrumental stem when music is selected.
No source text is printed or written into the provenance file. Input-text hashes
prove the supplied synthesis input, not pronunciation or audible correctness.

The instrumental cue is an original deterministic 72 BPM arrangement of piano,
changing string voicings, and soft acoustic bass. FluidSynth renders the MIDI
with FluidR3 GM. It includes phrase variation, a resolving final cadence, overall
fades, and lowered music during speaking turns. It replaces the provider's whole
soundtrack; original speech is never left underneath new speech. The recipe and
MIDI are reproducible, while byte-identical synthesis across different CPUs or
runtime versions is not promised.

Kokoro weights are Apache-2.0; kokoro-onnx is MIT. The FluidR3 GM soundfont is MIT,
with its Frank Wen copyright and permission notice retained in the installed
Debian package. The image also retains the model/wrapper licenses and resolved
Python dependency versions. The generated cue uses no external music recording
or provider call. Existing infrastructure/storage costs are separate.

The Dockerfile derives from the reviewed worker image containing the cached
recognizer, installs only the CPU speech dependencies, and downloads fixed,
checksum-verified model assets at build time. Runtime synthesis is offline, uses
two ONNX threads, and receives no service credentials. Run under the existing
CPU/memory/PID/read-only filesystem bounds.

Construction always reports `constructed-needs-review`. Review every turn and
the final mix, including names, numbers, dialogue, audible clarity, and visible
speaking. This module does not approve or deliver a film.
