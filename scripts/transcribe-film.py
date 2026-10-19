"""Local speech verification. No audio leaves the media worker."""
import json
import sys
import numpy as np
from faster_whisper import WhisperModel
from faster_whisper.audio import decode_audio

model = WhisperModel("small.en", device="cpu", compute_type="int8", cpu_threads=2)
# The decoder can miss speech beginning at sample zero. Context silence is
# transcription-only: it neither changes the delivered audio nor hints at the
# expected script. Return timestamps in the original media's coordinate space.
audio = decode_audio(sys.argv[1], sampling_rate=16000)
duration = len(audio) / 16000
context = '--context-silence' in sys.argv[2:]
padded = np.pad(audio, (8000, 16000)) if context else audio
segments, info = model.transcribe(padded, beam_size=5, word_timestamps=True)
offset = 0.5 if context else 0
words = [{"word": word.word, "start": max(0, word.start - offset), "end": max(0, word.end - offset)}
         for segment in segments for word in (segment.words or [])]
print(json.dumps({"duration": duration, "words": words}))
