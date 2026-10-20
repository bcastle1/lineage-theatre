"""Offline authored speech, original MIDI score, and fixed-duration scene mixes.

Construction is not speech/playback approval. No provider audio is mixed in.
Input text stays on stdin; stdout contains only bounded provenance or a reason.
"""
import hashlib
import contextlib
import gc
import importlib.metadata
import json
import math
import os
from pathlib import Path
import re
import struct
import subprocess
import sys
import time

MODEL_HASHES = {
    'kokoro-v1.0.onnx': 'beb0d1848dee9a49da392cc3df26958d46cfa35d321edf434f52949153f0df3a',
    'voices-v1.0.bin': 'bca610b8308e8d99f32e6fe4197e7ec01679264efed0cac9140fe9c29f1fbf7d',
}
REASONS = {'INPUT_INVALID', 'MODEL_UNAVAILABLE', 'VOICE_MAPPING_REQUIRED', 'PRONUNCIATION_UNSUPPORTED',
           'SPEECH_INVALID', 'SCENE_DURATION_EXCEEDED', 'SCORE_FAILED', 'TIME_LIMIT', 'OUTPUT_INVALID', 'RUNTIME_FAILED'}
DEADLINE = time.monotonic() + 18 * 60
DIAGNOSTIC = {'stage': 'input'}
KNOWN_MODULES = {'numpy', 'onnxruntime', 'soundfile', 'spacy', 'kokoro_onnx', 'misaki', 'phonemizer',
                 'espeakng_loader', 'num2words', 'regex', 'addict', 'en_core_web_sm', 'dlinfo', 'click'}


class SoundtrackError(Exception):
    pass


def stage(name, scene_index=None, turn_index=None, **measurements):
    DIAGNOSTIC.clear()
    DIAGNOSTIC['stage'] = name
    if scene_index is not None:
        DIAGNOSTIC['sceneIndex'] = scene_index + 1
    if turn_index is not None:
        DIAGNOSTIC['turnIndex'] = turn_index + 1
    DIAGNOSTIC.update(measurements)


def failure_diagnostic(failure):
    # Never serialize exception messages, tracebacks, paths, or input text.
    categories = ((SoundtrackError, 'validation'), (ModuleNotFoundError, 'dependency_missing'),
                  (ImportError, 'import_error'), (PermissionError, 'permission_denied'),
                  (FileNotFoundError, 'file_missing'), (MemoryError, 'memory_limit'),
                  (AttributeError, 'attribute_missing'), (TypeError, 'invalid_type'),
                  (ValueError, 'invalid_value'), (OSError, 'os_error'), (RuntimeError, 'runtime_error'))
    result = {**DIAGNOSTIC, 'category': next((label for kind, label in categories if isinstance(failure, kind)), 'other')}
    if isinstance(failure, ModuleNotFoundError) and failure.name in KNOWN_MODULES:
        result['module'] = failure.name
    return result


def require(condition, reason):
    if not condition:
        raise SoundtrackError(reason)


def remaining(maximum=180):
    seconds = DEADLINE - time.monotonic()
    require(seconds > 0, 'TIME_LIMIT')
    return min(maximum, seconds)


def sha(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def descriptor(path, directory):
    return {'file': str(path.relative_to(directory)), 'sha256': sha(path), 'sizeBytes': path.stat().st_size}


def boundary_silence_bounds(samples, rate):
    """Remove only contiguous PCM16 edge silence, retaining a 50 ms guard.

    One quantization step is about -90 dBFS. No interior samples, playback
    rate, phonemes or text are changed; ordinary speech review is still needed.
    """
    require(rate == 24000 and len(samples) > 0, 'SPEECH_INVALID')
    first, last, threshold = 0, len(samples), 1 / 32768
    while first < last and abs(float(samples[first])) <= threshold:
        first += 1
    while last > first and abs(float(samples[last - 1])) <= threshold:
        last -= 1
    require(first < last, 'SPEECH_INVALID')
    guard = round(rate * .05)
    return max(0, first - guard), min(len(samples), last + guard)


def offline(event, args):
    if event in ('socket.connect', 'socket.getaddrinfo'):
        raise SoundtrackError('MODEL_UNAVAILABLE')


def run(command, reason):
    remaining()
    try:
        result = subprocess.run(command, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                stderr=subprocess.DEVNULL, timeout=remaining(), shell=False)
    except subprocess.TimeoutExpired:
        raise SoundtrackError('TIME_LIMIT') from None
    require(result.returncode == 0, reason)


def variable_length(number):
    values = [number & 127]
    number >>= 7
    while number:
        values.insert(0, (number & 127) | 128)
        number >>= 7
    return bytes(values)


def original_score(path, seconds):
    """Original 72 BPM chamber cue: piano figures, moving strings, soft bass.

    No sampled composition or external music recording is used. Notes are
    specified here; timbres come from the separately licensed GM soundfont.
    """
    ppq, tempo = 480, 833333
    events = [(0, b'\xff\x51\x03' + tempo.to_bytes(3, 'big')),
              (0, b'\xff\x58\x04\x04\x02\x18\x08')]
    for channel, program, volume, pan in [(0, 0, 78, 57), (1, 48, 52, 70), (2, 32, 45, 64)]:
        events.extend([(0, bytes([0xC0 + channel, program])), (0, bytes([0xB0 + channel, 7, volume])),
                       (0, bytes([0xB0 + channel, 10, pan]))])

    def note(channel, pitch, start, duration, velocity):
        begin = max(0, round(start * ppq))
        end = max(begin + 1, round((start + duration) * ppq))
        events.extend([(begin, bytes([0x90 + channel, pitch, velocity])), (end, bytes([0x80 + channel, pitch, 0]))])

    progression = [(48, [0, 4, 7, 14]), (45, [0, 3, 7, 10]), (41, [0, 4, 7, 11]), (43, [0, 5, 7, 14]),
                   (38, [0, 3, 7, 10]), (40, [0, 3, 7, 10]), (41, [0, 4, 7, 11]), (43, [0, 4, 7, 12])]
    bars = max(1, math.ceil(seconds * 72 / 240))
    for bar in range(bars):
        root, intervals = progression[bar % len(progression)]
        if bar == bars - 1:
            root, intervals = 48, [0, 4, 7, 12]
        beat = bar * 4
        # Four-note voicings change each bar; staggered attacks avoid a static pad.
        for index, interval in enumerate(intervals):
            note(1, root + interval, beat + index * .025, 3.82 - index * .025, 26 + (bar % 3))
        note(2, root - 12, beat + .015, 3.5, 30)
        pattern = [0, 2, 1, 3, 2, 1] if bar % 2 == 0 else [0, 1, 2, 3, 1]
        positions = [0, .75, 1.5, 2.25, 3, 3.5] if bar % 2 == 0 else [0, 1, 1.75, 2.5, 3.25]
        if bar == bars - 1:
            pattern, positions = [0, 1, 2, 3], [0, .25, .5, 1]
        for index, (tone, offset) in enumerate(zip(pattern, positions)):
            note(0, root + 12 + intervals[tone], beat + offset + (.008 if index % 2 else 0),
                 1.8 if bar == bars - 1 else .8, 43 + ((bar + index) % 4) * 3)
    events.sort(key=lambda item: (item[0], item[1][0] & 0xF0 != 0x80))
    track, previous = bytearray(), 0
    for tick, data in events:
        track.extend(variable_length(tick - previous)); track.extend(data); previous = tick
    # Give the file renderer explicit release time after the target boundary.
    end_tick = max(previous, math.ceil(seconds * 72 / 60 * ppq) + 4 * ppq)
    track.extend(variable_length(end_tick - previous) + b'\xff\x2f\x00')
    path.write_bytes(b'MThd' + struct.pack('>IHHH', 6, 0, 1, ppq) + b'MTrk' + struct.pack('>I', len(track)) + track)


def construct(request):
    sys.addaudithook(offline)
    stage('import-numpy')
    import numpy as np
    stage('import-onnxruntime')
    import onnxruntime as ort
    stage('import-soundfile')
    import soundfile as sf
    stage('import-spacy')
    import spacy
    stage('import-kokoro')
    from kokoro_onnx import Kokoro
    stage('import-misaki')
    from misaki import en, espeak

    stage('validate-input')
    plan = request.get('plan', {})
    require(plan.get('version') == 1 and plan.get('recipe') == 'local-authored-soundtrack-v1'
            and re.fullmatch(r'[a-f0-9]{64}', plan.get('manifestHash', ''))
            and isinstance(plan.get('scenes'), list) and 1 <= len(plan['scenes']) <= 200
            and isinstance(plan.get('durationMs'), int) and 15000 <= plan['durationMs'] <= 600000
            and plan.get('speed') == 1, 'INPUT_INVALID')
    inspect_fit = request.get('inspectFit', False)
    require(isinstance(inspect_fit, bool), 'INPUT_INVALID')
    directory = None if inspect_fit else Path(request['directory']).resolve(strict=True)
    if not inspect_fit:
        require(directory.is_dir() and not any(directory.iterdir()), 'OUTPUT_INVALID')
    stage('verify-assets')
    model_dir = Path(request['modelDirectory']).resolve(strict=True)
    for filename, expected in MODEL_HASHES.items():
        require(sha(model_dir / filename) == expected, 'MODEL_UNAVAILABLE')
    require(spacy.util.is_package('en_core_web_sm'), 'MODEL_UNAVAILABLE')
    options = ort.SessionOptions()
    options.intra_op_num_threads, options.inter_op_num_threads = 2, 1
    options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
    stage('load-onnx')
    session = ort.InferenceSession(str(model_dir / 'kokoro-v1.0.onnx'), sess_options=options, providers=['CPUExecutionProvider'])
    stage('load-kokoro')
    engine = Kokoro.from_session(session, str(model_dir / 'voices-v1.0.bin'))
    g2p = {}
    rate = 24000
    scene_results, fit_results = [], []
    for scene_index, scene in enumerate(plan['scenes']):
        stage('prepare-scene', scene_index)
        remaining()
        duration = scene['durationMs'] / 1000
        require(isinstance(scene.get('turns'), list) and len(scene['turns']) <= 20 and 1 <= duration <= 30, 'INPUT_INVALID')
        samples_count = round(duration * rate)
        speech = np.zeros(samples_count, dtype=np.float32)
        cursor, turns, fit_turns = round(.12 * rate), [], []
        for turn_index, turn in enumerate(scene['turns']):
            stage('prepare-turn', scene_index, turn_index)
            remaining()
            voice, exact_text = turn['voice'], turn['text']
            require(voice in engine.voices and re.fullmatch(r'(?:af|am|bf|bm)_[a-z]{2,24}', voice), 'VOICE_MAPPING_REQUIRED')
            require(isinstance(exact_text, str) and 1 <= len(exact_text) <= 1200
                    and hashlib.sha256(exact_text.encode()).hexdigest() == turn['textSha256'], 'INPUT_INVALID')
            british = voice.startswith('b')
            if british not in g2p:
                stage('load-espeak', scene_index, turn_index)
                fallback = espeak.EspeakFallback(british=british)
                stage('load-pronunciation', scene_index, turn_index)
                g2p[british] = en.G2P(british=british, trf=False, fallback=fallback)
            stage('pronounce-turn', scene_index, turn_index)
            phonemes, _ = g2p[british](exact_text, preprocess=False)
            require(phonemes.strip() and all(char in engine.tokenizer.vocab or char.isspace() for char in phonemes), 'PRONUNCIATION_UNSUPPORTED')
            phonemes = ''.join(char if char in engine.tokenizer.vocab else ' ' for char in phonemes)
            stage('synthesize-turn', scene_index, turn_index)
            samples, sample_rate = engine.create(phonemes, voice=voice, speed=1, is_phonemes=True)
            stage('validate-speech', scene_index, turn_index)
            samples = np.asarray(samples, dtype=np.float32).reshape(-1)
            require(sample_rate == rate and len(samples) > 0 and np.isfinite(samples).all(), 'SPEECH_INVALID')
            peak = float(np.max(np.abs(samples)))
            active = samples[np.abs(samples) > .008]
            require(peak >= .001 and len(active) > 0, 'SPEECH_INVALID')
            gain = min(.80 / peak, .12 / float(np.sqrt(np.mean(active * active))))
            samples *= gain
            # Quantize once, then select an unchanged contiguous range. Keep
            # the original turn alongside any trimmed derivative for audit.
            source_pcm = np.clip(np.rint(samples * 32768), -32768, 32767).astype('<i2')
            source_samples = source_pcm.astype(np.float32) / 32768
            begin, stop = boundary_silence_bounds(source_samples, rate)
            selected_pcm = source_pcm[begin:stop]
            samples = source_samples[begin:stop]
            end = cursor + len(samples)
            metrics = {'turnIndex': turn_index + 1, 'generatedMs': round(len(source_samples) * 1000 / rate),
                       'retainedMs': round(len(samples) * 1000 / rate), 'trimStartMs': round(begin * 1000 / rate),
                       'trimEndMs': round((len(source_samples) - stop) * 1000 / rate),
                       'availableMs': max(0, round((samples_count - round(.20 * rate) - cursor) * 1000 / rate)),
                       'overrunMs': max(0, round((end - samples_count + round(.20 * rate)) * 1000 / rate)),
                       'fits': end <= samples_count - round(.20 * rate)}
            fit_turns.append(metrics)
            stage('fit-turn', scene_index, turn_index, **{key: metrics[key] for key in ('generatedMs', 'availableMs', 'overrunMs')})
            if inspect_fit:
                cursor = end + round(.18 * rate)
                continue
            require(end <= samples_count - round(.20 * rate), 'SCENE_DURATION_EXCEEDED')
            stage('write-turn', scene_index, turn_index)
            path = directory / f'scene-{scene_index + 1:02d}-turn-{turn_index + 1:02d}.wav'
            sf.write(path, selected_pcm, rate, subtype='PCM_16')
            original_path = path
            if begin or stop != len(source_samples):
                original_path = directory / f'scene-{scene_index + 1:02d}-turn-{turn_index + 1:02d}-original.wav'
                sf.write(original_path, source_pcm, rate, subtype='PCM_16')
            boundary = {'version': 1, 'method': 'pcm16-edge-silence-v1', 'threshold': 1 / 32768, 'guardMs': 50,
                        'sampleRate': rate, 'sourceSamples': len(source_pcm), 'retainedSamples': len(selected_pcm),
                        'trimStartSamples': begin, 'trimEndSamples': len(source_pcm) - stop,
                        'sourcePcmSha256': hashlib.sha256(source_pcm.tobytes()).hexdigest(),
                        'selectedPcmSha256': hashlib.sha256(selected_pcm.tobytes()).hexdigest()}
            # Place the same quantized samples that the reviewer receives.
            stored, _ = sf.read(path, dtype='float32')
            speech[cursor:end] = stored
            turns.append({'turnIndex': turn_index + 1, 'speakerId': turn['speakerId'], 'source': turn['source'],
                          'voice': voice, 'speed': 1, 'textSha256': turn['textSha256'], 'synthesisTextSha256': turn['textSha256'],
                          'phonemesSha256': hashlib.sha256(phonemes.encode()).hexdigest(),
                          'startSeconds': cursor / rate, 'endSeconds': end / rate, 'durationSeconds': len(samples) / rate,
                          'gain': gain, 'boundarySilence': boundary, 'originalAudio': descriptor(original_path, directory),
                          'audio': descriptor(path, directory)})
            cursor = end + round(.18 * rate)
        fit_results.append({'sceneIndex': scene_index + 1, 'durationMs': scene['durationMs'],
                            'fits': all(turn['fits'] for turn in fit_turns), 'turns': fit_turns})
        if inspect_fit:
            continue
        stage('write-speech', scene_index)
        speech_path = directory / f'scene-{scene_index + 1:02d}-speech.wav'
        sf.write(speech_path, speech, rate, subtype='PCM_16')
        scene_results.append({'shotId': scene['shotId'], 'sceneIndex': scene_index + 1, 'durationMs': scene['durationMs'],
                              'narrationSha256': scene['narrationSha256'], 'dialogueSha256': scene['dialogueSha256'],
                              'turns': turns, 'speech': descriptor(speech_path, directory)})
    # Release model memory before rendering the instrumental score and final mix.
    stage('release-model')
    engine.voices.close()
    del engine, session, g2p
    gc.collect()
    if inspect_fit:
        return {'status': 'inspected', 'version': 1, 'kind': 'soundtrack-fit-inspection-v1', 'manifestHash': plan['manifestHash'],
                'durationMs': plan['durationMs'], 'speed': 1, 'providerGenerationCalls': 0,
                'fits': all(scene['fits'] for scene in fit_results), 'scenes': fit_results}
    score_info = None
    score_path = directory / 'original-score.wav'
    if plan.get('musicRequested'):
        stage('prepare-score')
        font = Path(request['soundfont']).resolve(strict=True)
        require(font.is_file() and font.stat().st_size <= 200 * 1024 * 1024, 'SCORE_FAILED')
        midi_path, raw_score = directory / 'original-score.mid', directory / 'score-render.wav'
        original_score(midi_path, plan['durationMs'] / 1000)
        stage('render-score')
        run([request['fluidsynth'], '-ni', '-C', '0', '-R', '1', '-g', '0.4', '-r', '48000',
             '-T', 'wav', '-O', 's16', '-F', str(raw_score), str(font), str(midi_path)], 'SCORE_FAILED')
        stage('normalize-score')
        music, music_rate = sf.read(raw_score, dtype='float32', always_2d=True)
        count = plan['durationMs'] * 48
        require(music_rate == 48000 and music.shape[1] == 2 and len(music) >= count and np.isfinite(music).all(), 'SCORE_FAILED')
        music = music[:count]
        peak = float(np.max(np.abs(music)))
        require(peak > .00001, 'SCORE_FAILED')
        rms = float(np.sqrt(np.mean(music * music)))
        music *= min(.20 / peak, .04 / max(rms, .00001))
        fade = min(96000, count // 4)
        music[:fade] *= np.linspace(0, 1, fade, dtype=np.float32)[:, None]
        music[-fade:] *= np.linspace(1, 0, fade, dtype=np.float32)[:, None]
        sf.write(score_path, music, 48000, subtype='PCM_16')
        del music
        raw_score.unlink()
        score_info = {'method': 'original-midi-fluidr3-piano-strings-bass-v1', 'tempoBpm': 72,
                      'composition': 'Original deterministic chamber cue; no external recording or melody source.',
                      'midi': descriptor(midi_path, directory), 'audio': descriptor(score_path, directory),
                      'soundfontSha256': sha(font), 'soundfont': 'FluidR3 GM', 'soundfontLicense': 'MIT',
                      'licenseSource': 'https://sources.debian.org/src/fluid-soundfont/3.1-5.3/COPYING/',
                      'licenseNoticeInImage': '/usr/share/doc/fluid-soundfont-gm/copyright'}
    for scene, receipt in zip(plan['scenes'], scene_results):
        remaining()
        index = receipt['sceneIndex']
        stage('resample-speech', index - 1)
        speech_48 = directory / f'scene-{index:02d}-speech-48k.wav'
        run([request['ffmpeg'], '-hide_banner', '-loglevel', 'error', '-nostdin', '-n', '-i',
             str(directory / receipt['speech']['file']), '-ar', '48000', '-ac', '1', '-c:a', 'pcm_s16le', str(speech_48)], 'SPEECH_INVALID')
        speech, speech_rate = sf.read(speech_48, dtype='float32')
        count = scene['durationMs'] * 48
        require(speech_rate == 48000 and len(speech) == count and np.isfinite(speech).all(), 'SPEECH_INVALID')
        stage('mix-scene', index - 1)
        mixed = np.repeat(speech[:, None], 2, axis=1)
        if score_info:
            with sf.SoundFile(score_path) as score:
                score.seek(scene['startMs'] * 48)
                music = score.read(count, dtype='float32', always_2d=True)
            require(len(music) == count, 'SCORE_FAILED')
            envelope = np.ones(count, dtype=np.float32)
            for turn in receipt['turns']:
                start, end = round(turn['startSeconds'] * 48000), round(turn['endSeconds'] * 48000)
                before, after = max(0, start - 4800), min(count, end + 12000)
                envelope[before:start] = np.minimum(envelope[before:start], np.linspace(1, .30, start - before, dtype=np.float32))
                envelope[start:end] = .30
                envelope[end:after] = np.minimum(envelope[end:after], np.linspace(.30, 1, after - end, dtype=np.float32))
            mixed += music * envelope[:, None]
        peak = float(np.max(np.abs(mixed))) if len(mixed) else 0
        require(np.isfinite(mixed).all() and (peak > .00001 or not receipt['turns']), 'SPEECH_INVALID')
        final_gain = min(1, .94 / peak) if peak > 0 else 1
        mixed *= final_gain
        mix_path = directory / f'scene-{index:02d}-mix.wav'
        sf.write(mix_path, mixed, 48000, subtype='PCM_16')
        receipt.update({'speech': descriptor(speech_48, directory), 'mix': descriptor(mix_path, directory),
                        'mixGain': final_gain, 'musicDuringSpeechGain': .30 if score_info else 0,
                        'originalProviderAudioIncluded': False})
    stage('write-provenance')
    return {'status': 'constructed', 'version': 1, 'recipe': plan['recipe'], 'manifestHash': plan['manifestHash'],
            'durationMs': plan['durationMs'], 'engine': 'kokoro-82m-v1.0-cpu', 'modelHashes': MODEL_HASHES,
            'voiceAssignments': {'narrator': plan['narratorVoice'], 'characters': plan['characterVoices']},
            'speed': 1, 'sourceTextRewritten': False, 'modelLicense': 'Apache-2.0', 'wrapperLicense': 'MIT',
            'runtimeVersions': {name: importlib.metadata.version(name) for name in
                                ('kokoro-onnx', 'misaki', 'numpy', 'onnxruntime', 'soundfile', 'spacy', 'en-core-web-sm')},
            'musicRequested': plan['musicRequested'], 'originalMusicRequested': plan['originalMusicRequested'],
            'score': score_info, 'scenes': scene_results, 'independentSpeechAndPlaybackReviewRequired': True}


if __name__ == '__main__':
    try:
        raw = sys.stdin.buffer.read(300001)
        require(len(raw) <= 300000, 'INPUT_INVALID')
        with contextlib.redirect_stdout(sys.stderr):
            result = construct(json.loads(raw))
        print(json.dumps(result, separators=(',', ':')))
    except Exception as failure:
        reason = str(failure) if isinstance(failure, SoundtrackError) and str(failure) in REASONS else 'RUNTIME_FAILED'
        print(json.dumps({'status': 'failed', 'reason': reason, 'diagnostic': failure_diagnostic(failure)}))
        sys.exit(1)
