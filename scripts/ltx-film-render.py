"""Generate every shot, preserve chosen narration, and assemble a reviewable film."""
import hashlib
import json
import math
import os
import re
import subprocess
from pathlib import Path
import av
import imageio_ffmpeg

VOICE_CATALOG = Path(__file__).parent / 'ltx-voices.json'
if not VOICE_CATALOG.exists():
    VOICE_CATALOG = Path(__file__).parent.parent / 'shared/ltx-voices.json'
VOICES = {voice['id'] for voice in json.loads(VOICE_CATALOG.read_text(encoding='utf-8'))}


def narrate(text, voice, speed, audio):
    if voice not in VOICES or isinstance(speed, bool) or not isinstance(speed, (int, float)) or not 0.8 <= speed <= 1.2:
        raise ValueError('Invalid narrator or speaking pace')
    if not isinstance(text, str) or not 1 <= len(text.strip()) <= 1200:
        raise ValueError('Invalid narration text')
    raw = audio.with_name('speech-raw.wav')
    if voice in ('david', 'zira'):
        import win32com.client
        speaker = win32com.client.Dispatch('SAPI.SpVoice')
        desired = 'David' if voice == 'david' else 'Zira'
        installed = [item for item in speaker.GetVoices() if desired in item.GetDescription()]
        if len(installed) != 1:
            raise RuntimeError('The selected local narrator is unavailable')
        speaker.Voice = installed[0]
        stream = win32com.client.Dispatch('SAPI.SpFileStream')
        stream.Open(str(raw), 3)
        try:
            speaker.AudioOutputStream = stream
            speaker.Speak(text, 16)  # Plain text, never speech markup.
        finally:
            stream.Close()
            speaker = None
    else:
        root = Path(os.environ.get('LINEAGE_TTS_ROOT', Path(__file__).resolve().parent.parent))
        python = root / 'tts-venv/Scripts/python.exe'
        helper = root / 'worker/ltx-neural-voice.py'
        # The CPU voice process never receives website, storage, or model credentials.
        env = {key: value for key, value in os.environ.items() if key.upper() in
            ('SYSTEMROOT', 'WINDIR', 'PATH', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA')}
        result = subprocess.run([str(python), '-X', 'utf8', str(helper)],
            input=json.dumps({'voice': voice, 'speed': speed, 'text': text, 'output': str(raw)}).encode(),
            capture_output=True, timeout=180, env=env, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        if result.returncode or not raw.exists():
            raise RuntimeError('The selected neural narrator could not render. Check scene length and the voice installation.')
    filters = ([f'atempo={speed}'] if voice in ('david', 'zira') else []) + ['loudnorm=I=-16:TP=-1.5:LRA=11']
    ffmpeg(['-i', raw, '-af', ','.join(filters), '-ac', '1', '-ar', '48000', '-c:a', 'pcm_s16le', audio])
    raw.unlink()


def ffmpeg(args, timeout=300):
    result = subprocess.run([imageio_ffmpeg.get_ffmpeg_exe(), '-hide_banner', '-loglevel', 'error', '-y', *map(str, args)],
        capture_output=True, timeout=timeout, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    if result.returncode:
        raise RuntimeError('Film media processing failed')


def audio_duration(path):
    with av.open(str(path)) as container:
        if not container.streams.audio or container.duration is None:
            raise ValueError('The narration recording is unreadable')
        return container.duration / 1_000_000


def render(job, work, sources, progress, render_clip):
    if not re.fullmatch(r'[a-f0-9]{64}', job.get('id', '')) or not 1 <= len(job.get('scenes', [])) <= 30:
        raise ValueError('Invalid full-film job')
    if job.get('voice') not in VOICES:
        raise ValueError('Invalid narrator')
    cast = {item['id']: item for item in job['characters']}
    prepared = []
    # Measure all narration before committing GPU time. Never truncate speech.
    for index, scene in enumerate(job['scenes']):
        folder = work / ('scene-%02d' % index)
        folder.mkdir()
        audio = folder / 'narration.wav'
        mode = scene['audioMode']
        if mode == 'tts':
            narrate(scene['narration'], scene.get('voice') or job['voice'], job.get('speed') or 1, audio)
        elif mode == 'recording':
            original = sources[scene['audioId']]
            if not 0 < audio_duration(original) <= 59.5:
                raise ValueError('Use a narration recording shorter than one minute per scene')
            ffmpeg(['-i', original, '-vn', '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11', '-ac', '1', '-ar', '48000', '-c:a', 'pcm_s16le', audio])
        elif mode != 'silent':
            raise ValueError('Invalid scene audio mode')
        speech = audio_duration(audio) if mode != 'silent' else 0
        duration = math.ceil(max(scene['duration'], speech + 0.35 if speech else 0) * 24) / 24
        if not 2 <= duration <= 60:
            raise ValueError('Shorten this scene narration to less than one minute')
        if mode == 'silent':
            ffmpeg(['-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono', '-t', duration, '-c:a', 'pcm_s16le', audio])
        prepared.append((scene, folder, audio, duration))
    if sum(item[3] for item in prepared) > 600:
        raise ValueError('Narration extends the film beyond ten minutes')
    total_shots = sum(math.ceil(item[3] / 5) for item in prepared)
    completed_shots = 0
    timeline, scenes = [], []
    start = 0
    for scene, folder, audio, duration in prepared:
        character_text = '; '.join(f"{cast[id]['name']}: {cast[id]['description']}" for id in scene['characterIds'])
        reference_id = scene.get('referenceCharacterId')
        reference_text = f"Use the supplied image as the appearance reference for {cast[reference_id]['name']}. " if reference_id else ''
        prompt = f"{job.get('style', 'Cinematic')} film. {job.get('era', '')}. {reference_text}{scene['visual']}\nCast continuity: {character_text}. Natural movement, coherent faces and clothing. No titles, captions, or on-screen text."
        shot_paths = []
        reference_path = sources.get(scene.get('photoId'))
        for shot_index in range(math.ceil(duration / 5)):
            shot_folder = folder / ('shot-%02d' % shot_index)
            shot_folder.mkdir()
            identity = hashlib.sha256(f"{job['id']}:{scene['id']}:{shot_index}".encode()).hexdigest()
            seconds = 2 if shot_index == 0 and duration <= 2 else 5
            shot = {'id': identity, 'duration': seconds, 'scenes': [{'visual': prompt}],
                **({'photoId': 'reference'} if reference_path else {})}
            def report(value):
                progress(5 + int(85 * (completed_shots + value / 100) / total_shots))
            output, _ = render_clip(shot, shot_folder, {'reference': reference_path} if reference_path else {}, report)
            trimmed = shot_folder / 'shot.mp4'
            ffmpeg(['-i', output, '-map', '0:v:0', '-an', '-t', seconds, '-c:v', 'libx264', '-crf', '21', '-pix_fmt', 'yuv420p', '-r', '24', trimmed])
            shot_paths.append(trimmed)
            # Continue the previous generated shot without looping or stretching it.
            with av.open(str(trimmed)) as container:
                last = None
                for frame in container.decode(video=0):
                    last = frame
                if last is None:
                    raise RuntimeError('Generated scene has no frames')
                reference_path = folder / 'continuation.png'
                last.to_image().save(reference_path)
            completed_shots += 1
        concat = folder / 'shots.txt'
        concat.write_text(''.join("file '" + path.relative_to(folder).as_posix() + "'\n" for path in shot_paths), encoding='utf-8')
        assembled = folder / 'scene.mp4'
        ffmpeg(['-f', 'concat', '-safe', '1', '-i', concat, '-i', audio, '-map', '0:v:0', '-map', '1:a:0',
            '-t', duration, '-c:v', 'libx264', '-crf', '21', '-pix_fmt', 'yuv420p', '-r', '24',
            '-af', 'apad', '-ar', '48000', '-ac', '2', '-c:a', 'aac', '-b:a', '160k', '-map_metadata', '-1', assembled])
        timeline.append({'id': scene['id'], 'start': start, 'duration': duration, 'shots': len(shot_paths),
            'referenceApplied': bool(scene.get('photoId')), 'audioMode': scene['audioMode'],
            **({'voice': scene.get('voice') or job['voice'], 'speed': job.get('speed') or 1} if scene['audioMode'] == 'tts' else {})})
        start += duration
        scenes.append(assembled)
    progress(92)
    concat = work / 'scenes.txt'
    concat.write_text(''.join("file '" + path.relative_to(work).as_posix() + "'\n" for path in scenes), encoding='utf-8')
    output = work / 'ltx-film.mp4'
    ffmpeg(['-f', 'concat', '-safe', '1', '-i', concat, '-map', '0:v:0', '-map', '0:a:0', '-c:v', 'copy',
        '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-map_metadata', '-1', '-movflags', '+faststart', output])
    with av.open(str(output)) as container:
        video = container.streams.video[0]
        duration = container.duration / 1_000_000
        if video.width != 1024 or video.height != 576 or not container.streams.audio or abs(duration - start) > 0.15:
            raise RuntimeError('The assembled film failed format validation')
        frames = sum(1 for _ in container.decode(video=0))
        if abs(frames - round(start * 24)) > 2:
            raise RuntimeError('The assembled film is missing frames')
    with av.open(str(output)) as container:
        if sum(1 for _ in container.decode(audio=0)) == 0:
            raise RuntimeError('The assembled film has no audio track')
    size = output.stat().st_size
    if not 100 <= size <= 500 * 1024**2:
        raise RuntimeError('The assembled film exceeds its storage limit')
    digest = hashlib.sha256()
    with output.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    progress(95)
    return output, {'sha256': digest.hexdigest(), 'sizeBytes': size, 'durationSeconds': duration,
        'width': 1024, 'height': 576, 'hasAudio': True, 'engine': 'ltx-2.5-nvfp4', 'timeline': timeline}
