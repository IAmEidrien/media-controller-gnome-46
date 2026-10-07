#!/usr/bin/env python3
"""Prepare a normal upstream merge while preserving the GNOME 46 fork contract.

The workflow runs checks before committing/pushing. Conflicts or structural/API
changes leave main untouched and require maintainer review; this is not a porting AI.
"""
import argparse
import json
from pathlib import Path
import re
import subprocess

ROOT = Path(__file__).resolve().parent.parent
UUID = 'media-controller-gnome-46@eidrien.local'
SCHEMA = 'org.gnome.shell.extensions.media-controller'
DOCUMENTS = {'README.md', '.gitignore'}
VERSION_KEYS = {'version', 'version-name'}


def git(root, *args, check=True):
    return subprocess.run(['git', '-C', str(root), *args], text=True,
                          stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=check)


def upstream_file(root, ref, path):
    return git(root, 'show', f'{ref}:{path}').stdout


def allowed_path(path):
    return path in DOCUMENTS or path == 'src/metadata.json' or bool(re.fullmatch(
        r'src/(?:[^/]+\.js|stylesheet\.css|schemas/[^/]+\.gschema\.xml)', path))


def import_names(source):
    return set(re.findall(r"(?:from\s*|import\s*)['\"]((?:gi|resource)://[^'\"]+)['\"]", source))


def verify_fork(root):
    metadata = json.loads((root / 'metadata.json').read_text())
    if metadata.get('uuid') != UUID or metadata.get('shell-version') != ['46'] or \
            metadata.get('settings-schema') != SCHEMA or metadata.get('gettext-domain') != 'media-controller':
        raise RuntimeError('Merge changed GNOME 46 metadata; manual adaptation is required.')
    if (root / 'src').exists():
        raise RuntimeError('Runtime files remain under src/; direct Gitpulsar installation would break.')
    sources = '\n'.join(path.read_text() for path in root.glob('*.js'))
    if re.search(r'\borientation\s*:', sources) or 'Adw.ButtonRow' in sources or \
            '-st-accent-color' in (root / 'stylesheet.css').read_text():
        raise RuntimeError('Merge introduced a known post-GNOME-46 API; manual adaptation is required.')
    schema = (root / f'schemas/{SCHEMA}.gschema.xml').read_text()
    for key in ['left-click-action', 'middle-click-action', 'right-click-action',
                'scroll-up-action', 'scroll-down-action', 'prefer-symbolic-icons']:
        if f'name="{key}"' not in schema:
            raise RuntimeError(f'Merge removed fork setting {key}.')
    if not (root / 'accentColor.js').is_file() or not (root / 'panelActions.js').is_file():
        raise RuntimeError('Merge removed fork enhancements.')


def prepare(root, ref):
    root = root.resolve()
    head = git(root, 'rev-parse', 'HEAD').stdout.strip()
    tip = git(root, 'rev-parse', f'{ref}^{{commit}}').stdout.strip()
    if git(root, 'merge-base', '--is-ancestor', tip, head, check=False).returncode == 0:
        print('Upstream is already included.')
        return False
    if git(root, 'status', '--porcelain').stdout:
        raise RuntimeError('Sync requires a clean disposable checkout.')
    base = git(root, 'merge-base', head, tip).stdout.strip()
    paths = git(root, 'diff', '--name-only', base, tip).stdout.splitlines()
    blocked = [path for path in paths if not allowed_path(path)]
    if blocked:
        raise RuntimeError('Upstream changed files requiring review: ' + ', '.join(blocked))

    old_metadata = json.loads(upstream_file(root, base, 'src/metadata.json'))
    new_metadata = json.loads(upstream_file(root, tip, 'src/metadata.json'))
    strip_version = lambda data: {key: value for key, value in data.items() if key not in VERSION_KEYS}
    if strip_version(old_metadata) != strip_version(new_metadata):
        raise RuntimeError('Upstream changed platform/identity metadata; review before importing.')
    # New GI namespaces/resource APIs can imply a newer runtime even if merging is clean.
    old_imports = set()
    new_imports = set()
    for tree, target in [(base, old_imports), (tip, new_imports)]:
        for path in git(root, 'ls-tree', '-r', '--name-only', tree, 'src').stdout.splitlines():
            if path.endswith('.js'):
                target.update(import_names(upstream_file(root, tree, path)))
    if new_imports - old_imports:
        raise RuntimeError('New GI/resource imports require review: ' + ', '.join(sorted(new_imports - old_imports)))

    fork_metadata = json.loads((root / 'metadata.json').read_text())
    try:
        merged = git(root, '-c', 'merge.directoryRenames=true',
                     'merge', '--no-commit', '--no-ff', tip, check=False)
        conflicts = git(root, 'diff', '--name-only', '--diff-filter=U').stdout.splitlines()
        # The fork keeps its own documentation/layout instructions and identity.
        resolvable = DOCUMENTS | {'metadata.json', 'src/metadata.json'}
        unexpected = set(conflicts) - resolvable
        if unexpected or (merged.returncode and not conflicts):
            raise RuntimeError('Merge needs review: ' + ', '.join(sorted(unexpected)) + '\n' + merged.stderr)
        for path in DOCUMENTS:
            git(root, 'checkout', head, '--', path)
        # Git usually follows src/ -> root renames; new upstream modules need moving.
        source_dir = root / 'src'
        if source_dir.exists():
            for file in sorted(source_dir.rglob('*')):
                if not file.is_file():
                    continue
                relative = file.relative_to(source_dir)
                if str(relative) == 'metadata.json':
                    git(root, 'rm', '-f', '--', str(file.relative_to(root)))
                    continue
                destination = root / relative
                if destination.exists():
                    raise RuntimeError(f'Upstream layout collision at {relative}; review required.')
                destination.parent.mkdir(parents=True, exist_ok=True)
                git(root, 'mv', '--', str(file.relative_to(root)), str(relative))
            for directory in sorted(source_dir.rglob('*'), reverse=True):
                if directory.is_dir():
                    directory.rmdir()
            source_dir.rmdir()
        version = str(new_metadata.get('version-name', new_metadata.get('version', 'upstream')))
        fork_metadata['version-name'] = f'{version}-gnome46.auto.{tip[:7]}'
        (root / 'metadata.json').write_text(json.dumps(fork_metadata, indent=2) + '\n')
        git(root, 'add', '--', 'metadata.json')
        if git(root, 'diff', '--name-only', '--diff-filter=U').stdout:
            raise RuntimeError('Unresolved merge entries remain.')
        verify_fork(root)
        print(f'Prepared upstream {tip[:7]}; run checks before committing.')
        return True
    except Exception:
        git(root, 'merge', '--abort', check=False)
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--upstream-ref', default='refs/remotes/upstream/main')
    parser.add_argument('--root', type=Path, default=ROOT)
    args = parser.parse_args()
    prepare(args.root, args.upstream_ref)


if __name__ == '__main__':
    main()
