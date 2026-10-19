"""Local speech verification. No audio leaves the media worker."""
import json
import sys
from faster_whisper import WhisperModel

model = WhisperModel("small.en", device="cpu", compute_type="int8", cpu_threads=2)
segments, info = model.transcribe(sys.argv[1], beam_size=5, word_timestamps=True)
words = [{"word": word.word, "start": word.start, "end": word.end}
         for segment in segments for word in (segment.words or [])]
print(json.dumps({"duration": info.duration, "words": words}))
