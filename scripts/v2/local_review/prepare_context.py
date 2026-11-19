"""Install the pinned Windows CPU translator into an explicitly selected model directory."""
import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
from urllib.request import Request, urlopen
from uuid import uuid4
from zipfile import ZipFile


def fetch(asset):
    dest, url, size, pin = asset
    def verify(file):
        digest = hashlib.sha256() if len(pin) == 64 else hashlib.sha1()
        if len(pin) == 40:
            digest.update(f'blob {size}\0'.encode())
        with file.open('rb') as stream:
            for block in iter(lambda: stream.read(2 ** 20), b''):
                digest.update(block)
        if (size is not None and file.stat().st_size != size) or digest.hexdigest() != pin:
            raise ValueError(f'Unexpected contents of {file.name}')

    if dest.is_file():
        verify(dest)
        return
    dest.parent.mkdir(parents=True, exist_ok=True)
    part = dest.with_name(dest.name + '.' + uuid4().hex + '.partial')
    try:
        with urlopen(Request(url, headers={'Accept-Encoding': 'identity'}), timeout=120) as response:
            with part.open('xb') as stream:
                for block in iter(lambda: response.read(2 ** 20), b''):
                    stream.write(block)
        verify(part)
        os.rename(part, dest)
    finally:
        part.unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('destination', type=Path)
    dest = parser.parse_args().destination
    spec = json.loads(Path(__file__).with_name('context-model.json').read_text('utf8'))
    base = f"https://huggingface.co/{spec['repository']}/resolve/{spec['revision']}/"
    assets = [(dest / name, base + name, size, pin) for name, size, pin in spec['files']]
    wheel = spec['tokenizerWheel']
    assets.append((dest / wheel['file'], wheel['url'], None, wheel['sha256']))
    with ThreadPoolExecutor(max_workers=3) as pool:
        list(pool.map(fetch, assets))
    deps = dest / 'tokenizer-deps'
    if not deps.is_dir():
        staging = dest / ('tokenizer-deps-' + uuid4().hex)
        staging.mkdir()
        with ZipFile(dest / wheel['file']) as archive:
            for name in archive.namelist():
                entry = PurePosixPath(name)
                if entry.is_absolute() or '..' in entry.parts or '\\' in name or ':' in name:
                    raise ValueError('Unexpected member of the tokenizer wheel')
            archive.extractall(staging)
        os.rename(staging, deps)
    print(f'Local translator ready at {dest}')


if __name__ == '__main__':
    main()
