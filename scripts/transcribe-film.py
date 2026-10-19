"""Local speech verification. No audio leaves the media worker."""
import argparse
import json
import numpy as np
from faster_whisper import WhisperModel
from faster_whisper.audio import decode_audio

parser = argparse.ArgumentParser(allow_abbrev=False)
parser.add_argument("path")
parser.add_argument("--context-silence", action="store_true")
parser.add_argument("--model", choices=("small.en", "medium.en"), default="small.en")
args = parser.parse_args()
# Production keeps small.en. Diagnostics may explicitly select a stronger
# pre-cached model; neither path downloads models or accepts remote model IDs.
model = WhisperModel(args.model, device="cpu", compute_type="int8", cpu_threads=2,
                     num_workers=1, local_files_only=True)
# The decoder can miss speech beginning at sample zero. Context silence is
# transcription-only: it neither changes the delivered audio nor hints at the
# expected script. Return timestamps in the original media's coordinate space.
audio = decode_audio(args.path, sampling_rate=16000)
duration = len(audio) / 16000
context = args.context_silence
padded = np.pad(audio, (8000, 16000)) if context else audio
segments, info = model.transcribe(padded, beam_size=5, word_timestamps=True)
offset = 0.5 if context else 0
words = [{"word": word.word, "start": max(0, word.start - offset), "end": max(0, word.end - offset)}
         for segment in segments for word in (segment.words or [])]
print(json.dumps({"duration": duration, "words": words}))
