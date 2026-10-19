"""Offline exact pronunciation evidence for an explicitly scoped film repair.

The caller must bind pairs to saved cast names and reviewed replacement audio.
This helper does not authorize delivery or change the normal production gate.
Private spelling pairs enter through stdin; stdout contains only bounded hashes.
"""
import contextlib
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import re
import sys

CMU_COMMIT = '74790861f652b15e4ac49015a90074ad62a27690'
CMU_HASH = '81917843c7f44ce2b094ac63873c2c7a4cf802040792c455ba3ca406891c3d22'
CMU_LICENSE_HASH = 'bd4ce8e44170a5f9f481310ca85c51de3c4f851a65e679b40e603b143bd3542a'
VERSIONS = {'misaki': '0.9.4', 'spacy': '3.8.7', 'en-core-web-sm': '3.8.0',
            'phonemizer': '3.4.0', 'espeakng-loader': '0.2.4', 'kokoro-onnx': '0.6.1'}
NAME = re.compile(r"[A-Za-z]+(?:['-][A-Za-z]+)*(?: [A-Za-z]+(?:['-][A-Za-z]+)*){0,3}")
REASONS = {'INPUT_INVALID', 'ASSET_UNAVAILABLE', 'RUNTIME_UNAVAILABLE', 'PRONUNCIATION_UNSUPPORTED'}


class ComparisonError(Exception):
    pass


def require(condition, reason):
    if not condition:
        raise ComparisonError(reason)


def digest(value):
    return hashlib.sha256(value.encode('utf-8') if isinstance(value, str) else value).hexdigest()


def offline(event, args):
    if event in ('socket.connect', 'socket.getaddrinfo'):
        raise ComparisonError('RUNTIME_UNAVAILABLE')


def asset(directory, name, expected, maximum):
    with (directory / name).open('rb') as stream:
        data = stream.read(maximum + 1)
    require(0 < len(data) <= maximum and digest(data) == expected, 'ASSET_UNAVAILABLE')
    return data


def compare(request):
    require(isinstance(request, dict) and set(request) == {'pairs'} and isinstance(request['pairs'], list)
            and 1 <= len(request['pairs']) <= 64, 'INPUT_INVALID')
    for pair in request['pairs']:
        require(isinstance(pair, dict) and set(pair) == {'expected', 'recognized'}, 'INPUT_INVALID')
        for value in pair.values():
            require(isinstance(value, str) and len(value) <= 120 and NAME.fullmatch(value), 'INPUT_INVALID')
        require(len(pair['expected'].split(' ')) == len(pair['recognized'].split(' ')), 'INPUT_INVALID')
    require(all(importlib.metadata.version(name) == version for name, version in VERSIONS.items()), 'RUNTIME_UNAVAILABLE')
    directory = Path(os.environ.get('LINEAGE_PRONUNCIATION_DIR', '/opt/soundtrack/models/cmudict'))
    raw = asset(directory, 'cmudict.dict', CMU_HASH, 4_000_000)
    asset(directory, 'LICENSE', CMU_LICENSE_HASH, 10_000)
    wanted = {word.lower() for pair in request['pairs'] for text in pair.values() for word in text.split(' ')}
    lexicon = {word: set() for word in wanted}
    for line in raw.decode('utf-8').splitlines():
        fields = line.split('#', 1)[0].split()
        if len(fields) < 2:
            continue
        word = re.sub(r'\([0-9]+\)$', '', fields[0])
        if word in wanted:
            require(all(re.fullmatch(r'[A-Z]+[012]?', phoneme) for phoneme in fields[1:]), 'ASSET_UNAVAILABLE')
            lexicon[word].add(tuple(fields[1:]))
            require(len(lexicon[word]) <= 64, 'ASSET_UNAVAILABLE')
    del raw

    import spacy
    from kokoro_onnx.config import DEFAULT_VOCAB
    from misaki import en, espeak
    require(spacy.util.is_package('en_core_web_sm'), 'RUNTIME_UNAVAILABLE')
    g2p = en.G2P(british=False, trf=False, fallback=espeak.EspeakFallback(british=False))
    pronunciation_cache = {}

    def pronunciation(text):
        if text not in pronunciation_cache:
            value, _ = g2p(text, preprocess=False)
            # Unknown placeholders or characters must never create an equality proof.
            require(isinstance(value, str) and value.strip() and len(value) <= 2000
                    and all(character in DEFAULT_VOCAB for character in value), 'PRONUNCIATION_UNSUPPORTED')
            pronunciation_cache[text] = value
        return pronunciation_cache[text]

    proofs = []
    for pair in request['pairs']:
        expected, recognized = pair['expected'], pair['recognized']
        first, second = pronunciation(expected), pronunciation(recognized)
        method, phoneme_hash = 'none', None
        if first == second:
            method, phoneme_hash = 'misaki-exact', digest(first)
        else:
            # Preserve word order and boundaries. Each corresponding word must have
            # an identical full dictionary pronunciation, including every stress digit.
            shared_words = []
            for left, right in zip(expected.lower().split(' '), recognized.lower().split(' ')):
                common = lexicon[left].intersection(lexicon[right])
                if not common:
                    break
                shared_words.append(' '.join(sorted(common)[0]))
            if len(shared_words) == len(expected.split(' ')):
                method = 'cmudict-exact'
                phoneme_hash = digest(json.dumps(shared_words, separators=(',', ':')))
        proof = {'expectedSha256': digest(expected), 'recognizedSha256': digest(recognized),
                 'equal': method != 'none', 'method': method, 'phonemeHash': phoneme_hash,
                 'expectedPhonemeHash': digest(first), 'recognizedPhonemeHash': digest(second),
                 'engineVersion': 'misaki-0.9.4', 'dictionarySha256': CMU_HASH,
                 'dictionaryCommit': CMU_COMMIT, 'runtimeVersions': VERSIONS}
        proof['evidenceHash'] = digest(json.dumps(proof, sort_keys=True, separators=(',', ':')))
        proofs.append(proof)
    return {'version': 1, 'status': 'compared', 'pairs': proofs,
            'dictionarySha256': CMU_HASH, 'dictionaryCommit': CMU_COMMIT,
            'dictionaryLicenseSha256': CMU_LICENSE_HASH, 'runtimeVersions': VERSIONS}


if __name__ == '__main__':
    try:
        sys.addaudithook(offline)
        raw = sys.stdin.buffer.read(25001)
        require(len(raw) <= 25000, 'INPUT_INVALID')
        with open(os.devnull, 'w') as quiet, contextlib.redirect_stdout(quiet), contextlib.redirect_stderr(quiet):
            result = compare(json.loads(raw))
        print(json.dumps(result, separators=(',', ':')))
    except Exception as failure:
        reason = str(failure) if isinstance(failure, ComparisonError) and str(failure) in REASONS else 'RUNTIME_UNAVAILABLE'
        print(json.dumps({'version': 1, 'status': 'failed', 'reason': reason}))
        sys.exit(1)
