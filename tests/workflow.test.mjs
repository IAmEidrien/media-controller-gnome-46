import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));
const compiler = process.env.GLIB_COMPILE_SCHEMAS || 'glib-compile-schemas';

function fixture(t) {
    const temp = mkdtempSync(join(tmpdir(), 'media-controller-test-'));
    t.after(() => rmSync(temp, {recursive: true, force: true}));
    const source = join(temp, 'source');
    const installed = join(temp, 'installed');
    mkdirSync(source);
    for (const name of readdirSync(root)) {
        if (name.endsWith('.js') || ['Makefile', 'metadata.json', 'stylesheet.css', 'LICENSE', 'schemas'].includes(name))
            cpSync(join(root, name), join(source, name), {recursive: true});
    }
    return {
        source, installed,
        make(target) {
            return spawnSync('make', [target, `GLIB_COMPILE_SCHEMAS=${compiler}`, `INSTALL_DIR=${installed}`],
                {cwd: source, encoding: 'utf8', env: {...process.env, MAKEFLAGS: ''}});
        },
    };
}

test('package and copy installation contain a complete flat runtime', t => {
    const f = fixture(t);
    const packed = f.make('pack');
    assert.equal(packed.status, 0, packed.stdout + packed.stderr);
    const uuid = JSON.parse(readFileSync(join(f.source, 'metadata.json'))).uuid;
    const entries = spawnSync('python3', ['-c',
        'import json,sys,zipfile; print(json.dumps(zipfile.ZipFile(sys.argv[1]).namelist()))',
        join(f.source, `${uuid}.shell-extension.zip`)], {encoding: 'utf8'});
    assert.equal(entries.status, 0, entries.stderr);
    const names = JSON.parse(entries.stdout);
    const required = readdirSync(root).filter(name => name.endsWith('.js'));
    required.push('metadata.json', 'stylesheet.css', 'LICENSE',
        'schemas/gschemas.compiled', 'schemas/org.gnome.shell.extensions.media-controller.gschema.xml');
    assert.deepEqual([...names].sort(), required.sort());
    const installed = f.make('install');
    assert.equal(installed.status, 0, installed.stdout + installed.stderr);
    for (const name of required)
        assert.ok(readFileSync(join(f.installed, name)).length > 0, name);
});

test('install and uninstall leave an installed Git checkout intact', t => {
    const f = fixture(t);
    mkdirSync(f.installed);
    writeFileSync(join(f.installed, '.git'), 'checkout sentinel');
    writeFileSync(join(f.installed, 'extension.js'), 'installed sentinel');
    for (const target of ['install', 'uninstall']) {
        const result = f.make(target);
        assert.notEqual(result.status, 0);
        assert.match(result.stdout, /Git checkout/);
        assert.equal(readFileSync(join(f.installed, '.git'), 'utf8'), 'checkout sentinel');
        assert.equal(readFileSync(join(f.installed, 'extension.js'), 'utf8'), 'installed sentinel');
    }
});
