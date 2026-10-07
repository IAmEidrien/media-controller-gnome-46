import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('update_helper', ROOT / 'tools/update_helper.py')
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)
COMPILER = os.environ.get('GLIB_COMPILE_SCHEMAS', 'glib-compile-schemas')


class UpdateHelperTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='mc helper % $ ')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name) / 'checkout'
        self.root.mkdir()
        subprocess.run(['git', 'init', '-q', str(self.root)], check=True)
        (self.root / 'schemas').mkdir()
        for name in ['metadata.json', 'stylesheet.css', 'extension.js']:
            shutil.copyfile(ROOT / name, self.root / name)
        self.xml = self.root / 'schemas/org.gnome.shell.extensions.media-controller.gschema.xml'
        shutil.copyfile(ROOT / 'schemas' / self.xml.name, self.xml)
        self.state = Path(self.temporary.name) / 'state.json'

    def update(self, **kwargs):
        return helper.update(self.root, self.state, compiler=COMPILER, **kwargs)

    def test_content_changes_compile_only_changed_schemas(self):
        self.assertEqual(self.update(notify=False), (True, True))
        binary = self.root / 'schemas/gschemas.compiled'
        original_mtime = binary.stat().st_mtime_ns
        self.assertEqual(self.update(notify=False), (False, False))
        (self.root / 'README.md').write_text('Documentation edit')
        self.assertEqual(self.update(notify=False), (False, False))
        (self.root / 'extension.js').write_text('// updated runtime')
        calls = []
        run = subprocess.run
        def dispatch(command, **kwargs):
            if command[0] == 'systemctl':
                calls.append(command)
                return subprocess.CompletedProcess(command, 0)
            return run(command, **kwargs)
        with patch.object(helper.subprocess, 'run', side_effect=dispatch), \
                patch.object(helper.shutil, 'which', return_value='/usr/bin/notify-send'):
            self.assertEqual(self.update(), (True, False))
        self.assertEqual(binary.stat().st_mtime_ns, original_mtime)
        self.assertEqual(calls, [['systemctl', '--user', '--no-block', 'restart',
                                 'media-controller-update-notification.service']])
        self.xml.write_text(self.xml.read_text().replace("<default>'left'</default>", "<default>'right'</default>"))
        self.assertEqual(self.update(notify=False), (True, True))

    def test_invalid_xml_preserves_previous_binary_and_state(self):
        self.update(notify=False)
        before = (self.root / 'schemas/gschemas.compiled').read_bytes()
        state = self.state.read_text()
        self.xml.write_text('<schemalist>invalid')
        with self.assertRaises(subprocess.CalledProcessError):
            self.update(notify=False)
        self.assertEqual((self.root / 'schemas/gschemas.compiled').read_bytes(), before)
        self.assertEqual(self.state.read_text(), state)

    def test_busy_git_checkout_is_not_compiled(self):
        (self.root / '.git/index.lock').write_text('busy')
        with patch.object(helper.time, 'sleep'), self.assertRaisesRegex(RuntimeError, 'Git is still'):
            self.update(notify=False)
        self.assertFalse((self.root / 'schemas/gschemas.compiled').exists())

    def test_unit_paths_escape_spaces_percent_and_disable_environment_expansion(self):
        rendered = helper.units(self.root)
        self.assertEqual(len(rendered), 3)
        self.assertIn('ExecStart=:', rendered['media-controller-update.service'])
        self.assertIn('%%', rendered['media-controller-update.path'])
        self.assertIn('$', rendered['media-controller-update.path'])
        self.assertIn('PathChanged=', rendered['media-controller-update.path'])
        self.assertNotIn('PathChanged="', rendered['media-controller-update.path'])
        self.assertNotIn('git pull', ''.join(rendered.values()))
        self.assertNotIn('sudo', ''.join(rendered.values()))
        with self.assertRaises(ValueError):
            helper.unit_quote('bad\npath')

    @unittest.skipUnless(shutil.which('systemd-analyze'), 'systemd validation unavailable')
    def test_native_systemd_accepts_units_with_spaces_percent_and_dollar_paths(self):
        directory = Path(self.temporary.name) / 'units'
        directory.mkdir()
        for name, contents in helper.units(self.root).items():
            (directory / name).write_text(contents)
        result = subprocess.run(['systemd-analyze', 'verify', *map(str, directory.iterdir())],
                                capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_notification_only_opens_logout_confirmation_after_explicit_action(self):
        class Notice:
            stdout = io.StringIO('42\n')
            returncode = 0
            def communicate(self, timeout):
                return ('logout\n', None)
        with patch.object(helper.subprocess, 'Popen', return_value=Notice()), \
                patch.object(helper.subprocess, 'run') as run:
            helper.notification()
        run.assert_called_once_with(['gnome-session-quit', '--logout'], check=False)
        class Dismissed(Notice):
            stdout = io.StringIO('43\n')
            def communicate(self, timeout):
                return ('', None)
        with patch.object(helper.subprocess, 'Popen', return_value=Dismissed()), \
                patch.object(helper.subprocess, 'run') as run:
            helper.notification()
        run.assert_not_called()

    def test_uninstall_only_removes_own_user_units(self):
        directory = Path(self.temporary.name) / 'units'
        directory.mkdir()
        for name in helper.units(self.root):
            (directory / name).write_text('unit')
        other = directory / 'other.service'
        other.write_text('keep')
        with patch.object(helper.subprocess, 'run'):
            helper.uninstall(directory)
        self.assertEqual(list(directory.iterdir()), [other])
        self.assertTrue(self.xml.exists())
        self.assertTrue((self.root / 'extension.js').exists())

    def test_expired_notification_drops_action_and_leaves_plain_reminder(self):
        class Expired:
            stdout = io.StringIO('42\n')
            attempts = 0
            killed = False
            def communicate(self, timeout=None):
                self.attempts += 1
                if self.attempts == 1:
                    raise subprocess.TimeoutExpired('notify-send', timeout)
                return ('', None)
            def kill(self):
                self.killed = True
        expired = Expired()
        with patch.object(helper.subprocess, 'Popen', return_value=expired), \
                patch.object(helper.shutil, 'which', return_value='/usr/bin/gdbus'), \
                patch.object(helper.subprocess, 'run') as run:
            helper.notification()
        self.assertTrue(expired.killed)
        calls = [call.args[0] for call in run.call_args_list]
        self.assertEqual(calls[0][-2:], ['org.freedesktop.Notifications.CloseNotification', '42'])
        self.assertEqual(calls[1][0], 'notify-send')
        self.assertFalse(any('--action' in argument for argument in calls[1]))
        self.assertFalse(any(call[0] == 'gnome-session-quit' for call in calls))


if __name__ == '__main__':
    unittest.main()
