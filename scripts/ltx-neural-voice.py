"""CPU-only Kokoro narration. Input is one bounded JSON object on stdin."""
import hashlib
import json
import sys
from pathlib import Path

MODEL_HASHES = {
    'kokoro-v1.0.onnx': 'beb0d1848dee9a49da392cc3df26958d46cfa35d321edf434f52949153f0df3a',
    'voices-v1.0.bin': 'bca610b8308e8d99f32e6fe4197e7ec01679264efed0cac9140fe9c29f1fbf7d',
}


def synthesize(request, root):
    import numpy as np
    import onnxruntime as ort
    import soundfile as sf
    import spacy
    from kokoro_onnx import Kokoro
    from misaki import en, espeak

    catalog = json.loads((Path(__file__).parent / 'ltx-voices.json').read_text(encoding='utf-8'))
    allowed = {voice['id'] for voice in catalog if voice['engine'] == 'Kokoro'}
    voice, text, speed = request.get('voice'), request.get('text'), request.get('speed', 1)
    if voice not in allowed or not isinstance(text, str) or not 1 <= len(text.strip()) <= 1200:
        raise ValueError('Invalid neural narration')
    if isinstance(speed, bool) or not isinstance(speed, (int, float)) or not 0.8 <= speed <= 1.2:
        raise ValueError('Invalid speaking pace')
    if not spacy.util.is_package('en_core_web_sm'):
        raise RuntimeError('Install the pinned English pronunciation model before starting the worker')
    models = root / 'tts-models/kokoro'
    for name, expected in MODEL_HASHES.items():
        with (models / name).open('rb') as stream:
            if hashlib.file_digest(stream, 'sha256').hexdigest() != expected:
                raise RuntimeError('The narration model checksum does not match the installed release')
    options = ort.SessionOptions()
    options.intra_op_num_threads = 4
    options.inter_op_num_threads = 1
    session = ort.InferenceSession(str(models / 'kokoro-v1.0.onnx'), sess_options=options, providers=['CPUExecutionProvider'])
    engine = Kokoro.from_session(session, str(models / 'voices-v1.0.bin'))
    british = voice.startswith('b')
    pronounce = en.G2P(british=british, fallback=espeak.EspeakFallback(british=british))
    phonemes, _ = pronounce(text)
    if not phonemes.strip() or '❓' in phonemes:
        raise ValueError('Check the narration spelling and supported English pronunciation')
    samples, rate = engine.create(phonemes, voice=voice, speed=speed, is_phonemes=True)
    if not np.isfinite(samples).all() or not 0 < len(samples) / rate <= 59.5 or np.max(np.abs(samples)) < 0.001:
        raise ValueError('Shorten the narration to less than one minute and check that it contains spoken words')
    output = Path(request['output'])
    sf.write(str(output), samples, rate, subtype='PCM_16')
    return {'voice': voice, 'speed': speed, 'engine': 'kokoro-82m-v1.0-cpu', 'sampleRate': rate, 'duration': len(samples) / rate}


if __name__ == '__main__':
    try:
        raw = sys.stdin.buffer.read(16385)
        if len(raw) > 16384:
            raise ValueError('Narration input exceeds its limit')
        print(json.dumps(synthesize(json.loads(raw), Path(__file__).resolve().parent.parent)))
    except Exception:
        # Narration text and provider internals never enter the shared worker log.
        print('Neural narration failed; check installation, pronunciation, and scene length.', file=sys.stderr)
        sys.exit(1)
