"""Build-time cache of fixed public soundtrack assets; never used at runtime."""
import hashlib
from pathlib import Path
import sys
from urllib.request import urlopen


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


if __name__ == '__main__':
    if len(sys.argv) != 2:
        raise SystemExit('Supply the existing build-time asset directory.')
    cache(sys.argv[1])
