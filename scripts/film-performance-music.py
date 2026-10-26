"""Offline score only. Never load a speech model or replace spoken audio."""
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import subprocess
import sys


def require(value):
    if not value:
        raise ValueError('PERFORMANCE_MUSIC_UNAVAILABLE')


def command(args, timeout=120):
    result = subprocess.run(args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                            shell=False, timeout=timeout)
    require(result.returncode == 0 and len(result.stdout) < 16000)
    return result.stdout


def sha(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def verify_package_assets(font, root=Path('/')):
    """Check the rendered asset and license, independently of stripped docs."""
    relative_files = ('usr/share/sounds/sf2/FluidR3_GM.sf2', 'usr/share/doc/fluid-soundfont-gm/copyright')
    manifest = root / 'var/lib/dpkg/info/fluid-soundfont-gm.md5sums'
    require(manifest.is_file() and not manifest.is_symlink() and manifest.stat().st_size <= 128000)
    entries = [line.split() for line in manifest.read_text().splitlines()]
    require(font == (root / relative_files[0]).resolve(strict=True))
    for relative in relative_files:
        matches = [entry for entry in entries if len(entry) == 2 and entry[1] == relative]
        require(len(matches) == 1 and re.fullmatch(r'[a-f0-9]{32}', matches[0][0]))
        path = root / relative
        require(path.is_file() and not path.is_symlink() and 16 < path.stat().st_size <= 200 * 1024 * 1024)
        with path.open('rb') as stream:
            require(hashlib.file_digest(stream, 'md5').hexdigest() == matches[0][0])


def main(request):
    # Verify the actual installed licensed asset, not just an executable name.
    font = Path(request['soundfont']).resolve(strict=True)
    require(font == Path('/usr/share/sounds/sf2/FluidR3_GM.sf2').resolve(strict=True)
            and font.is_file() and 16 < font.stat().st_size <= 200 * 1024 * 1024)
    require(command(['dpkg-query', '-W', '-f=${Version}', 'fluid-soundfont-gm'], 15).decode().strip() == '3.1-5.3')
    # Slim images omit READMEs/changelogs. The exact installed font and copyright
    # must still match the pinned package; unrelated missing docs prove neither.
    verify_package_assets(font)
    command([request['fluidsynth'], '--version'], 15)
    assets = {'soundfontSha256': sha(font), 'soundfontPackage': 'fluid-soundfont-gm', 'soundfontPackageVersion': '3.1-5.3'}
    require(request['mode'] in ('assets', 'render'))
    if request['mode'] == 'assets':
        return {'ready': True, **assets}
    seconds = request['durationSeconds']
    require(type(seconds) is int and 3 <= seconds <= 600)
    directory = Path(request['directory']).resolve(strict=True)
    require(directory.is_dir() and not any(directory.iterdir()))
    spec = importlib.util.spec_from_file_location('lineage_original_score', Path(__file__).with_name('rebuild-film-soundtrack.py'))
    composer = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(composer)
    # Imports stay inside this score-only branch. construct()/Kokoro are unused.
    sys.addaudithook(composer.offline)
    import numpy as np
    import soundfile as sf
    midi, raw, output = directory / 'score.mid', directory / 'render.wav', directory / 'score.wav'
    composer.original_score(midi, seconds)
    command([request['fluidsynth'], '-ni', '-C', '0', '-R', '1', '-g', '0.4', '-r', '48000',
             '-T', 'wav', '-O', 's16', '-F', str(raw), str(font), str(midi)])
    samples, rate = sf.read(raw, dtype='float32', always_2d=True)
    count = seconds * 48000
    require(rate == 48000 and samples.shape[1] == 2 and len(samples) >= count and np.isfinite(samples).all())
    samples = samples[:count]
    peak = float(np.max(np.abs(samples)))
    require(peak > .00001)
    samples *= .099 / peak
    fade = min(96000, count // 4)
    samples[:fade] *= np.linspace(0, 1, fade, dtype=np.float32)[:, None]
    samples[-fade:] *= np.linspace(1, 0, fade, dtype=np.float32)[:, None]
    sf.write(output, samples, 48000, subtype='PCM_16')
    raw.unlink()
    return {'version': 1, 'requested': True, 'recipe': 'original-midi-fluidr3-performance-v1', 'durationSeconds': seconds,
            'midiSha256': sha(midi), 'midiBytes': midi.stat().st_size, 'scoreSha256': sha(output), 'scoreBytes': output.stat().st_size,
            'maximumScorePeak': .1, 'speechGain': .95, 'scoreGain': .25, 'speechOffsetSamples': 0,
            'sampleRate': 48000, 'channels': 2, **assets}


if __name__ == '__main__':
    try:
        raw = sys.stdin.buffer.read(16001)
        require(len(raw) <= 16000)
        print(json.dumps(main(json.loads(raw)), separators=(',', ':')))
    except Exception:
        print(json.dumps({'ready': False, 'reason': 'PERFORMANCE_MUSIC_UNAVAILABLE'}))
        sys.exit(1)
