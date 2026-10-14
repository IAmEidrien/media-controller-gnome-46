import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../mpris.js', import.meta.url), 'utf8')
    .replace(/^import[\s\S]*?;\s*$/gm, '')
    .replace(/export (?=(const|class|function)\b)/g, '');
const {MprisManager} = vm.runInNewContext(`(() => {
    ${source}; return {MprisManager};
})()`, {
    GObject: {Object: class {}, TYPE_INT64: 0, registerClass: (...args) => args.at(-1)},
    Gio: {}, GLib: {},
});

function fixture() {
    const manager = Object.create(MprisManager.prototype);
    manager._players = new Map();
    manager._statuses = new Map();
    manager._active = null;
    manager._pinned = null;
    manager.exclusivePlayback = false;
    const changes = [];
    manager.emit = signal => changes.push(signal);
    const player = (name, status = 'Paused', ready = true) => {
        const value = {
            busName: name, status, ready, pauses: 0,
            get isPlaying() { return this.status === 'Playing'; },
            pause() { this.pauses++; },
        };
        manager._players.set(name, value);
        manager._statuses.set(name, status);
        return value;
    };
    return {manager, player, changes};
}

test('cycling wraps in both directions through ready players, including paused players', () => {
    const {manager, player, changes} = fixture();
    const a = player('a', 'Playing');
    player('not-ready', 'Stopped', false);
    const b = player('b');
    const c = player('c', 'Stopped');
    manager._active = a;
    for (const expected of [b, c, a]) {
        manager.cyclePlayer(1);
        assert.equal(manager.activePlayer, expected);
        assert.equal(manager._pinned, expected.busName);
    }
    manager.cyclePlayer(-1);
    assert.equal(manager.activePlayer, c);
    manager.cyclePlayer(-1);
    assert.equal(manager.activePlayer, b);
    assert.equal(changes.length, 5);
    assert.equal(a.status, 'Playing');
    assert.equal(b.status, 'Paused');
    assert.equal(a.pauses + b.pauses + c.pauses, 0);
});

test('cycling cannot act on an empty or single-player roster', () => {
    const {manager, player, changes} = fixture();
    manager.cyclePlayer(1);
    const a = player('a');
    manager._active = a;
    manager.cyclePlayer(-1);
    assert.equal(manager.activePlayer, a);
    assert.equal(manager._pinned, null);
    assert.equal(changes.length, 0);
});

test('a missing selection chooses the first or last ready player deterministically', () => {
    const {manager, player} = fixture();
    const a = player('a');
    const b = player('b');
    manager.cyclePlayer(1);
    assert.equal(manager.activePlayer, a);
    manager._players.delete('a');
    const c = player('c');
    manager.cyclePlayer(-1);
    assert.equal(manager.activePlayer, c);
    assert.equal(b.status, 'Paused');
    for (const invalid of [0, NaN, Infinity]) {
        manager.cyclePlayer(invalid);
        assert.equal(manager.activePlayer, c);
    }
});

test('cycled selection survives metadata noise but yields when another player starts', () => {
    const {manager, player} = fixture();
    const a = player('a', 'Playing');
    const b = player('b');
    manager._active = a;
    manager.cyclePlayer(1);
    manager._selectActive();
    assert.equal(manager.activePlayer, b);
    a.status = 'Paused';
    manager._noteStatus(a);
    a.status = 'Playing';
    manager._noteStatus(a);
    manager._selectActive();
    assert.equal(manager.activePlayer, a);
    assert.equal(manager._pinned, null);
});

test('pending pause acknowledgements do not look like a browser starting again', () => {
    const {manager, player} = fixture();
    const browser = player('browser', 'Playing');
    const music = player('music');
    manager.exclusivePlayback = true;
    manager.selectPlayer('music');
    music.status = 'Playing';
    manager._noteStatus(music);
    assert.equal(browser.pauses, 1);
    assert.equal(manager._statuses.get('browser'), 'Playing', 'wait for the actual status');
    // Browser emits metadata while Pause is still in flight.
    manager._noteStatus(browser);
    manager._selectActive();
    assert.equal(music.pauses, 0);
    assert.equal(manager.activePlayer, music);
    assert.equal(manager._pinned, 'music');
    browser.status = 'Paused';
    manager._noteStatus(browser);
    assert.equal(manager._statuses.get('browser'), 'Paused');
});
