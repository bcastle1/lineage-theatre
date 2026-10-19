"""Build-time cache of fixed public soundtrack assets; never used at runtime."""
import hashlib
from pathlib import Path
import sys
from urllib.request import urlopen


def cache_pronunciations(destination):
    directory = Path(destination).resolve(strict=True) / 'models/cmudict'
    directory.mkdir(parents=True, exist_ok=True)
    commit = '74790861f652b15e4ac49015a90074ad62a27690'
    expected = {
        'cmudict.dict': ('81917843c7f44ce2b094ac63873c2c7a4cf802040792c455ba3ca406891c3d22', 4_000_000),
        'LICENSE': ('bd4ce8e44170a5f9f481310ca85c51de3c4f851a65e679b40e603b143bd3542a', 10_000),
    }
    for name, (wanted, maximum) in expected.items():
        target = directory / name
        if target.exists():
            with target.open('rb') as stream:
                data = stream.read(maximum + 1)
        else:
            with urlopen(f'https://raw.githubusercontent.com/cmusphinx/cmudict/{commit}/{name}', timeout=60) as response:
                data = response.read(maximum + 1)
        if not data or len(data) > maximum or hashlib.sha256(data).hexdigest() != wanted:
            raise RuntimeError('The public pronunciation asset checksum changed')
        if not target.exists():
            with target.open('xb') as output:
                output.write(data)


def cache(destination):
    base_directory = Path(destination).resolve(strict=True)
    root = base_directory / 'models/kokoro'
    root.mkdir(parents=True)
    base = 'https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.1/'
    expected = {
        'kokoro-v1.0.onnx': ('beb0d1848dee9a49da392cc3df26958d46cfa35d321edf434f52949153f0df3a', 400_000_000),
        'voices-v1.0.bin': ('bca610b8308e8d99f32e6fe4197e7ec01679264efed0cac9140fe9c29f1fbf7d', 40_000_000),
    }
    for name, (wanted, maximum) in expected.items():
        hasher, total = hashlib.sha256(), 0
        with urlopen(base + name, timeout=180) as response, (root / name).open('xb') as output:
            while block := response.read(1024 * 1024):
                total += len(block)
                if total > maximum:
                    raise RuntimeError('The public model asset exceeds its bound')
                output.write(block)
                hasher.update(block)
        if hasher.hexdigest() != wanted:
            raise RuntimeError('The public model asset checksum changed')
    licenses = base_directory / 'licenses'
    licenses.mkdir()
    for name, url in {
        'Kokoro-82M-LICENSE': 'https://raw.githubusercontent.com/hexgrad/kokoro/main/LICENSE',
        'kokoro-onnx-LICENSE': 'https://raw.githubusercontent.com/thewh1teagle/kokoro-onnx/main/LICENSE',
    }.items():
        with urlopen(url, timeout=60) as response:
            data = response.read(100001)
        if not data or len(data) > 100000:
            raise RuntimeError('The public license asset is invalid')
        (licenses / name).write_bytes(data)
    (licenses / 'model-attribution.txt').write_text(
        'Kokoro-82M model weights: Apache-2.0. Publisher model card: '
        'https://huggingface.co/hexgrad/Kokoro-82M\n'
        'ONNX export and voice-bank release: '
        'https://github.com/thewh1teagle/kokoro-onnx/releases/tag/model-files-v1.1\n', encoding='utf-8')
    cache_pronunciations(destination)


if __name__ == '__main__':
    if len(sys.argv) == 3 and sys.argv[1] == '--cmudict-only':
        cache_pronunciations(sys.argv[2])
    elif len(sys.argv) == 2:
        cache(sys.argv[1])
    else:
        raise SystemExit('Supply the existing build-time asset directory.')
