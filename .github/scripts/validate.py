#!/usr/bin/env python3
"""Read-only-token CI: static checks, existing regressions and package smoke checks.

These checks do not constitute a native GNOME desktop test.
"""
import ast
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import zipfile

ROOT = Path(__file__).resolve().parents[2]


def run(*args, **kwargs):
    print('+', *args, flush=True)
    subprocess.run(args, cwd=ROOT, check=True, **kwargs)


def main():
    config = json.loads((ROOT / '.github/testing-validation.json').read_text())
    metadata = json.loads((ROOT / 'metadata.json').read_text())
    for key in ['uuid', 'name', 'shell-version']:
        if not metadata.get(key):
            raise RuntimeError(f'Metadata is missing {key}')
    if not (ROOT / 'extension.js').is_file():
        raise RuntimeError('Missing extension entry point')
    paths = subprocess.check_output(['git', 'ls-files', '-z'], cwd=ROOT).decode().split('\0')
    # Include new local automation files before their first commit as well.
    paths += [str(p.relative_to(ROOT)) for p in (ROOT / '.github').rglob('*') if p.is_file()]
    for name in sorted(set(paths)):
        path = ROOT / name
        if not name or not path.is_file():
            continue
        if path.suffix in {'.js', '.mjs', '.cjs'}:
            if path.suffix == '.cjs':
                run('node', '--check', str(path))
            else:
                run('node', '--input-type=module', '--check', input=path.read_bytes())
        elif path.suffix == '.py':
            ast.parse(path.read_text(), filename=name)
    compiler = os.environ.get('GLIB_COMPILE_SCHEMAS', 'glib-compile-schemas')
    if list((ROOT / 'schemas').glob('*.gschema.xml')):
        run(compiler, '--strict', '--dry-run', 'schemas')
    run('node', '--test', '.github/scripts/promote.test.cjs')
    for command in config['commands']:
        run(*command)
    if config.get('generic_package'):
        with tempfile.TemporaryDirectory(prefix='extension-ci-') as directory:
            staging = Path(directory) / 'extension'
            staging.mkdir()
            for name in sorted(set(paths)):
                if not name or name.startswith(('.', 'tests/', 'tools/')):
                    continue
                source = ROOT / name
                if source.is_file() and (source.suffix in {'.js', '.json', '.css', '.ui', '.svg', '.png', '.mo', '.py', '.xml', '.glsl'} or source.name in {'LICENSE', 'COPYING'}):
                    target = staging / name
                    target.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(source, target)
            if (staging / 'schemas').exists():
                run(compiler, '--strict', str(staging / 'schemas'))
            archive = Path(directory) / 'extension.zip'
            with zipfile.ZipFile(archive, 'w', zipfile.ZIP_DEFLATED) as packed:
                for file in staging.rglob('*'):
                    if file.is_file():
                        packed.write(file, file.relative_to(staging))
            with zipfile.ZipFile(archive) as packed:
                assert packed.testzip() is None
                assert {'metadata.json', 'extension.js'} <= set(packed.namelist())
                assert json.loads(packed.read('metadata.json'))['uuid'] == metadata['uuid']
    run('git', 'diff', '--check')


if __name__ == '__main__':
    main()
