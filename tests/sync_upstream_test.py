import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('sync_upstream', ROOT / 'tools/sync_upstream.py')
sync = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sync)


class UpstreamSyncTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='mc-sync-')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.git('init', '-q', '-b', 'upstream')
        self.git('config', 'user.name', 'Test')
        self.git('config', 'user.email', 'test@example.invalid')
        (self.root / 'src/schemas').mkdir(parents=True)
        (self.root / 'src/extension.js').write_text('import St from "gi://St";\nconst first = 1;\nconst second = 2;\n')
        metadata = {'uuid': 'upstream@example.invalid', 'shell-version': ['47', '48'],
                    'settings-schema': sync.SCHEMA, 'gettext-domain': 'media-controller',
                    'version-name': '2.4'}
        (self.root / 'src/metadata.json').write_text(json.dumps(metadata, indent=2))
        shutil.copyfile(ROOT / f'schemas/{sync.SCHEMA}.gschema.xml',
                        self.root / f'src/schemas/{sync.SCHEMA}.gschema.xml')
        (self.root / 'src/stylesheet.css').write_text('.original { color: blue; }\n')
        (self.root / 'README.md').write_text('Upstream documentation\n')
        (self.root / '.gitignore').write_text('build\n')
        self.commit('upstream base')
        self.base = self.git('rev-parse', 'HEAD')
        self.git('switch', '-q', '-c', 'fork')
        for name in ['extension.js', 'metadata.json', 'stylesheet.css', 'schemas']:
            self.git('mv', f'src/{name}', name)
        (self.root / 'src').rmdir()
        metadata.update({'uuid': sync.UUID, 'shell-version': ['46'], 'version-name': '2.4-gnome46.4'})
        (self.root / 'metadata.json').write_text(json.dumps(metadata, indent=2))
        (self.root / 'README.md').write_text('Fork installation instructions\n')
        (self.root / 'HUMANS.md').write_text('Untouched human prose.\n')
        (self.root / 'panelActions.js').write_text('// fork actions\n')
        (self.root / 'accentColor.js').write_text('// fork theme support\n')
        self.commit('fork layout and features')
        self.head = self.git('rev-parse', 'HEAD')

    def git(self, *args):
        return subprocess.check_output(['git', '-C', str(self.root), *args],
                                       text=True, stderr=subprocess.PIPE).strip()

    def commit(self, message):
        self.git('add', '.')
        self.git('commit', '-qm', message)

    def upstream_edit(self, editor):
        self.git('switch', '-q', 'upstream')
        editor()
        self.commit('upstream update')
        tip = self.git('rev-parse', 'HEAD')
        self.git('switch', '-q', 'fork')
        return tip

    def assert_clean_fork(self):
        self.assertEqual(self.git('rev-parse', 'HEAD'), self.head)
        self.assertEqual(self.git('status', '--porcelain'), '')
        self.assertFalse((self.root / '.git/MERGE_HEAD').exists())

    def test_no_upstream_update_creates_no_commit(self):
        self.assertFalse(sync.prepare(self.root, self.base))
        self.assert_clean_fork()

    def test_clean_bug_fix_follows_runtime_renames_and_preserves_human_note(self):
        def edit():
            file = self.root / 'src/extension.js'
            file.write_text(file.read_text().replace('first = 1', 'first = 5'))
            (self.root / 'src/newModule.js').write_text('export const newFeature = true;\n')
            (self.root / 'README.md').write_text('New upstream instructions\n')
            file = self.root / 'src/metadata.json'
            metadata = json.loads(file.read_text())
            metadata['version-name'] = '2.5'
            file.write_text(json.dumps(metadata, indent=2))
        tip = self.upstream_edit(edit)
        self.assertTrue(sync.prepare(self.root, tip))
        self.assertIn('first = 5', (self.root / 'extension.js').read_text())
        self.assertTrue((self.root / 'newModule.js').exists())
        self.assertFalse((self.root / 'src').exists())
        self.assertEqual((self.root / 'README.md').read_text(), 'Fork installation instructions\n')
        self.assertEqual((self.root / 'HUMANS.md').read_text(), 'Untouched human prose.\n')
        metadata = json.loads((self.root / 'metadata.json').read_text())
        self.assertEqual(metadata['uuid'], sync.UUID)
        self.assertEqual(metadata['shell-version'], ['46'])
        self.assertEqual(metadata['version-name'], f'2.5-gnome46.auto.{tip[:7]}')
        self.assertEqual(self.git('rev-parse', 'MERGE_HEAD'), tip)
        self.git('commit', '-qm', 'validated merge')
        self.assertEqual(len(self.git('rev-list', '--parents', '-1', 'HEAD').split()), 3)

    def test_runtime_conflict_aborts_without_modifying_fork(self):
        file = self.root / 'extension.js'
        file.write_text(file.read_text().replace('first = 1', 'first = 8'))
        self.commit('fork change')
        self.head = self.git('rev-parse', 'HEAD')
        def edit():
            file = self.root / 'src/extension.js'
            file.write_text(file.read_text().replace('first = 1', 'first = 9'))
        tip = self.upstream_edit(edit)
        with self.assertRaisesRegex(RuntimeError, 'Merge needs review'):
            sync.prepare(self.root, tip)
        self.assert_clean_fork()

    def test_platform_metadata_changes_require_review(self):
        def edit():
            file = self.root / 'src/metadata.json'
            metadata = json.loads(file.read_text())
            metadata['shell-version'] = ['50']
            file.write_text(json.dumps(metadata, indent=2))
        tip = self.upstream_edit(edit)
        with self.assertRaisesRegex(RuntimeError, 'platform/identity metadata'):
            sync.prepare(self.root, tip)
        self.assert_clean_fork()

    def test_new_runtime_imports_require_review(self):
        tip = self.upstream_edit(lambda: (self.root / 'src/new.js').write_text('import Cogl from "gi://Cogl";\n'))
        with self.assertRaisesRegex(RuntimeError, 'New GI/resource imports'):
            sync.prepare(self.root, tip)
        self.assert_clean_fork()

    def test_known_newer_api_is_rejected_even_after_clean_merge(self):
        tip = self.upstream_edit(lambda: (self.root / 'src/new.js').write_text('new St.BoxLayout({orientation: 1});\n'))
        with self.assertRaisesRegex(RuntimeError, 'post-GNOME-46 API'):
            sync.prepare(self.root, tip)
        self.assert_clean_fork()

    def test_upstream_build_changes_require_review(self):
        tip = self.upstream_edit(lambda: (self.root / 'Makefile').write_text('all: new-build\n'))
        with self.assertRaisesRegex(RuntimeError, 'files requiring review'):
            sync.prepare(self.root, tip)
        self.assert_clean_fork()


if __name__ == '__main__':
    unittest.main()
