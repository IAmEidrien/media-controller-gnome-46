import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const root = new URL('../', import.meta.url);
function load(file, names, api = {}) {
    const source = readFileSync(new URL(file, root), 'utf8')
        .replace(/^import[\s\S]*?;\s*$/gm, '')
        .replace(/export (?=(const|class|function)\b)/g, '');
    return vm.runInNewContext(`(() => { ${source}; return {${names.join(',')}}; })()`, api);
}
const transport = load('transport.js', ['nextLoopStatus']);
const {CLICK_ACTIONS, activatePanelAction} = load('panelActions.js',
    ['CLICK_ACTIONS', 'activatePanelAction'], transport);

function fixture() {
    const calls = [];
    const player = {
        canControl: true, canPlay: true, canPause: true, canGoNext: true,
        canGoPrevious: true, canRaise: true, canQuit: true,
        canLoop: true, canShuffle: true, isPlaying: false,
        volume: 0.5, loopStatus: 'None', shuffle: false,
    };
    for (const method of ['playPause', 'play', 'pause', 'next', 'previous', 'raise', 'quit'])
        player[method] = () => calls.push([method]);
    for (const [method, property] of [['setVolume', 'volume'], ['setLoopStatus', 'loopStatus'], ['setShuffle', 'shuffle']])
        player[method] = value => { player[property] = value; calls.push([method, value]); };
    const ui = {};
    for (const method of ['toggleMenu', 'closeMenu', 'openPreferences', 'refresh'])
        ui[method] = () => calls.push([method]);
    return {player, calls, ui, act: action => activatePanelAction(action, player, ui)};
}

test('all Media Controls click choices reach the selected player or menu', () => {
    const expected = {
        none: [],
        'play-pause': [['playPause']],
        play: [['play']], pause: [['pause']], next: [['next']], previous: [['previous']],
        'volume-up': [['setVolume', 0.55]], 'volume-down': [['setVolume', 0.45]],
        loop: [['setLoopStatus', 'Playlist'], ['refresh']],
        shuffle: [['setShuffle', true], ['refresh']],
        menu: [['toggleMenu']], raise: [['closeMenu'], ['raise']],
        quit: [['closeMenu'], ['quit']], preferences: [['closeMenu'], ['openPreferences']],
    };
    assert.deepEqual(Array.from(CLICK_ACTIONS), Object.keys(expected));
    for (const action of CLICK_ACTIONS) {
        const f = fixture();
        f.act(action);
        assert.deepEqual(f.calls, expected[action], action);
    }
});

test('missing players and unsupported capabilities make shortcuts harmless', () => {
    const f = fixture();
    for (const action of CLICK_ACTIONS.filter(action => !['menu', 'preferences'].includes(action)))
        activatePanelAction(action, null, f.ui);
    assert.deepEqual(f.calls, []);
    activatePanelAction('menu', null, f.ui);
    activatePanelAction('preferences', null, f.ui);
    assert.deepEqual(f.calls, [['toggleMenu'], ['closeMenu'], ['openPreferences']]);
    f.calls.length = 0;
    for (const capability of Object.keys(f.player).filter(key => key.startsWith('can')))
        f.player[capability] = false;
    for (const action of CLICK_ACTIONS.filter(action => !['menu', 'preferences'].includes(action)))
        f.act(action);
    assert.deepEqual(f.calls, []);
    // Each individual capability also matters when CanControl itself is true.
    f.player.canControl = true;
    for (const action of ['play-pause', 'play', 'pause', 'next', 'previous', 'loop', 'shuffle'])
        f.act(action);
    assert.deepEqual(f.calls, []);
    f.player.volume = null;
    f.act('volume-up');
    f.act('volume-down');
    assert.deepEqual(f.calls, []);
    f.player.canControl = false;
    f.player.canRaise = true;
    f.act('raise');
    assert.deepEqual(f.calls, [['closeMenu'], ['raise']], 'application interface is independent');
});

test('play/pause respects the current state, rather than checking only CanPlay', () => {
    const f = fixture();
    f.player.isPlaying = true;
    f.player.canPlay = false;
    f.act('play-pause');
    assert.deepEqual(f.calls, [['playPause']], 'a playing stream that can pause remains pausable');
    f.calls.length = 0;
    f.player.canPause = false;
    f.player.canPlay = true;
    f.act('play-pause');
    assert.deepEqual(f.calls, [], 'unpausable live streams are not toggled');
    f.player.isPlaying = false;
    f.act('play-pause');
    assert.deepEqual(f.calls, [['playPause']], 'a paused stream only needs CanPlay');
});

test('player volume is bounded and repeat/shuffle follow their state', () => {
    const f = fixture();
    f.player.volume = 0.99;
    f.act('volume-up');
    assert.equal(f.player.volume, 1);
    f.player.volume = 0.01;
    f.act('volume-down');
    assert.equal(f.player.volume, 0);
    for (const unavailable of [null, undefined, NaN, Infinity, -1]) {
        f.player.volume = unavailable;
        const count = f.calls.length;
        f.act('volume-up');
        assert.equal(f.calls.length, count);
    }
    for (const expected of ['Playlist', 'Track', 'None']) {
        f.act('loop');
        assert.equal(f.player.loopStatus, expected);
    }
    f.act('shuffle');
    assert.equal(f.player.shuffle, true);
    f.act('shuffle');
    assert.equal(f.player.shuffle, false);
});

function mprisFixture() {
    const calls = [];
    const warnings = [];
    const xml = [];
    let signalId = 0;
    class ObjectWithSignals {
        constructor(...args) { this._init(...args); }
        _init() {}
        emit() {}
    }
    const playerProxy = {
        PlaybackStatus: 'Paused', CanControl: true, CanPlay: true, CanPause: true,
        CanGoNext: true, CanGoPrevious: true, Volume: 0.5,
        connect: () => ++signalId, connectSignal: () => ++signalId,
        disconnect() {}, disconnectSignal() {},
    };
    const appProxy = {CanRaise: true, CanQuit: true};
    for (const method of ['PlayPause', 'Play', 'Pause', 'Next', 'Previous'])
        playerProxy[`${method}Remote`] = () => calls.push(method);
    for (const method of ['Raise', 'Quit'])
        appProxy[`${method}Remote`] = () => calls.push(method);
    const proxies = [playerProxy, appProxy];
    const {MprisPlayer} = load('mpris.js', ['MprisPlayer'], {
        GObject: {Object: ObjectWithSignals, TYPE_INT64: 0,
            registerClass: (...args) => args.at(-1)},
        Gio: {
            Cancellable: class {cancel() {}},
            DBus: {session: {}}, DBusProxyFlags: {NONE: 0},
            DBusProxy: {makeProxyWrapper: iface => {
                xml.push(iface);
                return class {constructor(_connection, _name, _path, callback) {
                    callback(proxies.shift(), null);
                }};
            }},
        },
        GLib: {}, console: {warn: value => warnings.push(value)},
    });
    return {player: new MprisPlayer('org.mpris.MediaPlayer2.test'),
        playerProxy, appProxy, calls, warnings, xml};
}

test('MPRIS actions call the declared interfaces, guard capabilities and tolerate player departure', () => {
    const f = mprisFixture();
    assert.match(f.xml[0], /name="Volume" type="d" access="readwrite"/);
    assert.match(f.xml[0], /name="CanControl" type="b" access="read"/);
    assert.match(f.xml[1], /name="CanQuit" type="b" access="read"/);
    for (const method of ['playPause', 'play', 'pause', 'next', 'previous', 'raise', 'quit'])
        f.player[method]();
    assert.deepEqual(f.calls, ['PlayPause', 'Play', 'Pause', 'Next', 'Previous', 'Raise', 'Quit']);
    f.calls.length = 0;
    f.playerProxy.CanControl = false;
    f.appProxy.CanRaise = false;
    f.appProxy.CanQuit = false;
    for (const method of ['playPause', 'play', 'pause', 'next', 'previous', 'raise', 'quit'])
        f.player[method]();
    assert.deepEqual(f.calls, []);
    f.playerProxy.CanControl = true;
    f.playerProxy.PlaybackStatus = 'Playing';
    f.playerProxy.CanPlay = false;
    f.player.playPause();
    assert.deepEqual(f.calls, ['PlayPause']);
    f.playerProxy.PlayRemote = () => { throw Error('player disappeared'); };
    f.playerProxy.CanPlay = true;
    assert.doesNotThrow(() => f.player.play());
    assert.equal(f.warnings.length, 1);
    f.player.destroy();
    for (const method of ['playPause', 'play', 'pause', 'next', 'previous', 'raise', 'quit'])
        assert.doesNotThrow(() => f.player[method]());
});

test('MPRIS volume writes avoid unsupported, invalid and read-only players', () => {
    const f = mprisFixture();
    assert.equal(f.player.volume, 0.5);
    f.player.setVolume(0.55);
    assert.equal(f.playerProxy.Volume, 0.55);
    f.player.setVolume(3);
    assert.equal(f.playerProxy.Volume, 1);
    f.player.setVolume(-2);
    assert.equal(f.playerProxy.Volume, 0);
    f.player.setVolume(NaN);
    assert.equal(f.playerProxy.Volume, 0);
    f.playerProxy.CanControl = false;
    f.player.setVolume(0.5);
    assert.equal(f.playerProxy.Volume, 0);
    f.playerProxy.CanControl = true;
    delete f.playerProxy.Volume;
    assert.equal(f.player.volume, null);
    f.player.setVolume(0.5);
    assert.ok(!('Volume' in f.playerProxy));
    Object.defineProperty(f.playerProxy, 'Volume', {
        get: () => 0.5, set: () => { throw Error('read-only'); },
    });
    assert.doesNotThrow(() => f.player.setVolume(0.55));
    assert.equal(f.warnings.length, 1);
});
