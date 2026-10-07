#!/usr/bin/env python3
"""Optional systemd user helper for an installed Git checkout. No polling daemon."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time

NAME = 'media-controller-update'
DEFAULT_ROOT = Path(__file__).resolve().parent.parent


def git_dir(root):
    return Path(subprocess.check_output(
        ['git', '-C', str(root), 'rev-parse', '--absolute-git-dir'], text=True).strip())


def fingerprint(files, root):
    digest = hashlib.sha256()
    for file in sorted(files):
        digest.update(str(file.relative_to(root)).encode())
        digest.update(b'\0')
        digest.update(file.read_bytes())
        digest.update(b'\0')
    return digest.hexdigest()


def runtime_files(root):
    return [*root.glob('*.js'), root / 'metadata.json', root / 'stylesheet.css',
            *root.glob('schemas/*.gschema.xml')]


def state_path():
    return Path(os.environ.get('XDG_STATE_HOME', Path.home() / '.local/state')) / NAME / 'state.json'


def write_state(path, state):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix('.tmp')
    temporary.write_text(json.dumps(state))
    os.replace(temporary, path)


def update(root, state_file, compiler='glib-compile-schemas', notify=True):
    root = root.resolve()
    directory = git_dir(root)
    busy = ['index.lock', 'MERGE_HEAD', 'rebase-merge', 'rebase-apply']
    for _ in range(10):
        if not any((directory / name).exists() for name in busy):
            break
        time.sleep(0.3)
    else:
        raise RuntimeError('Git is still updating this checkout; will retry.')

    files = runtime_files(root)
    runtime = fingerprint(files, root)
    # Gitpulsar may replace several files before it updates the index.
    time.sleep(0.2)
    if runtime != fingerprint(runtime_files(root), root):
        raise RuntimeError('Checkout is still changing; will retry.')
    schema = fingerprint(root.glob('schemas/*.gschema.xml'), root)
    try:
        old = json.loads(state_file.read_text())
    except (OSError, ValueError):
        old = {}
    if old.get('root') != str(root):
        old = {}
    changed = old.get('runtime') != runtime
    compile_needed = old.get('schema') != schema or not (root / 'schemas/gschemas.compiled').exists()
    if compile_needed:
        # Keep the previous valid binary if new XML is invalid or compilation fails.
        with tempfile.TemporaryDirectory(prefix='mc-schemas-') as temporary:
            subprocess.run([compiler, '--strict', f'--targetdir={temporary}',
                            str(root / 'schemas')], check=True)
            binary = root / 'schemas/gschemas.compiled.tmp'
            shutil.copyfile(Path(temporary) / 'gschemas.compiled', binary)
            os.replace(binary, root / 'schemas/gschemas.compiled')
        print('GSettings schemas compiled.', flush=True)
    write_state(state_file, {'root': str(root), 'runtime': runtime, 'schema': schema})
    if changed and old and notify and shutil.which('notify-send'):
        # Notification waits in its own service; future pulls can compile immediately.
        subprocess.run(['systemctl', '--user', '--no-block', 'restart',
                        f'{NAME}-notification.service'], check=False)
    return changed, compile_needed


def notification():
    command = ['notify-send', '--app-name=Media Controller', '--icon=audio-x-generic-symbolic',
               '--print-id', '--wait', '--expire-time=300000',
               '--action=logout=Log out…', 'Media Controller updated',
               'The update is ready. Log out and back in to load it.']
    # Keep the printed notification ID readable while notify-send waits for an action.
    process = subprocess.Popen(['stdbuf', '-oL', *command], stdout=subprocess.PIPE, text=True)
    identifier = process.stdout.readline().strip()
    try:
        output, _ = process.communicate(timeout=300)
    except subprocess.TimeoutExpired:
        process.kill()
        process.communicate()
        # Remove the action once its listener is gone; retain an informational notice.
        if identifier.isdigit() and shutil.which('gdbus'):
            subprocess.run(['gdbus', 'call', '--session', '--dest', 'org.freedesktop.Notifications',
                            '--object-path', '/org/freedesktop/Notifications',
                            '--method', 'org.freedesktop.Notifications.CloseNotification',
                            identifier], check=False, stdout=subprocess.DEVNULL)
        subprocess.run(['notify-send', '--app-name=Media Controller',
                        '--icon=audio-x-generic-symbolic', 'Media Controller update ready',
                        'Log out and back in when convenient to load the update.'], check=False)
        return
    if process.returncode == 0 and output.strip() == 'logout':
        # The action opens the ordinary confirmation dialog, never forces a logout.
        subprocess.run(['gnome-session-quit', '--logout'], check=False)


def unit_quote(value):
    if any(char in str(value) for char in ['\n', '\r', '\0']):
        raise ValueError('Unit paths must not contain line breaks or NUL.')
    return '"' + str(value).replace('\\', '\\\\').replace('"', '\\"').replace('%', '%%') + '"'


def unit_path(value):
    # PathChanged takes a single raw path, unlike ExecStart's shell-like words.
    # Quotes would become part of the path and make it non-absolute. Internal
    # spaces and '$' are literal; systemd specifiers still need '%' escaping.
    value = str(value)
    if any(char in value for char in ['\n', '\r', '\0']) or value != value.strip():
        raise ValueError('Watch paths must not contain line breaks or edge whitespace.')
    return value.replace('%', '%%')


def units(root):
    root = root.resolve()
    directory = git_dir(root)
    executable = unit_quote(Path(sys.executable).resolve())
    script = unit_quote(root / 'tools/update_helper.py')
    root_arg = unit_quote(root)
    # ':' disables systemd environment substitution; '%' is escaped above.
    service = f'''[Unit]
Description=Prepare Media Controller Git updates
StartLimitIntervalSec=60
StartLimitBurst=10

[Service]
Type=oneshot
ExecStart=:{executable} {script} check --root {root_arg}
Restart=on-failure
RestartSec=2
TimeoutStartSec=30
'''
    watches = '\n'.join(f'PathChanged={unit_path(directory / name)}'
                        for name in ['index', 'HEAD', 'packed-refs', 'refs/heads'])
    path = f'''[Unit]
Description=Watch Media Controller checkout changes

[Path]
{watches}
Unit={NAME}.service

[Install]
WantedBy=default.target
'''
    notice = f'''[Unit]
Description=Offer to load a Media Controller update

[Service]
Type=oneshot
ExecStart=:{executable} {script} notify
TimeoutStartSec=315
'''
    return {f'{NAME}.service': service, f'{NAME}.path': path,
            f'{NAME}-notification.service': notice}


def install(root, directory):
    for tool in ['git', 'glib-compile-schemas', 'systemctl']:
        if not shutil.which(tool):
            raise RuntimeError(f'Missing required tool: {tool}')
    rendered = units(root)
    update(root, state_path(), notify=False)
    directory.mkdir(parents=True, exist_ok=True)
    for name, contents in rendered.items():
        (directory / name).write_text(contents)
    subprocess.run(['systemctl', '--user', 'daemon-reload'], check=True)
    subprocess.run(['systemctl', '--user', 'enable', '--now', f'{NAME}.path'], check=True)
    print('Update helper enabled for this checkout. It never pulls Git or logs you out automatically.')
    if not shutil.which('notify-send'):
        print('Install libnotify-bin to receive optional update notifications.')


def uninstall(directory):
    subprocess.run(['systemctl', '--user', 'disable', '--now', f'{NAME}.path'], check=True)
    subprocess.run(['systemctl', '--user', 'stop', f'{NAME}.service',
                    f'{NAME}-notification.service'], check=False)
    for name in [f'{NAME}.path', f'{NAME}.service', f'{NAME}-notification.service']:
        (directory / name).unlink(missing_ok=True)
    subprocess.run(['systemctl', '--user', 'daemon-reload'], check=True)
    # The extension checkout and personal settings are left alone.


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['install', 'uninstall', 'check', 'notify'])
    parser.add_argument('--root', type=Path, default=DEFAULT_ROOT)
    args = parser.parse_args()
    directory = Path(os.environ.get('XDG_CONFIG_HOME', Path.home() / '.config')) / 'systemd/user'
    if args.command == 'install':
        install(args.root, directory)
    elif args.command == 'uninstall':
        uninstall(directory)
    elif args.command == 'check':
        update(args.root, state_path())
    else:
        notification()


if __name__ == '__main__':
    main()
