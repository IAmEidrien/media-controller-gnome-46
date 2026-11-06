import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

test('preferences follow live Shell state, reject stale replies and clean up', () => {
    let signal, appeared, vanished, reply;
    let cancelled = false, unsubscribed = false, unwatched = false;
    const states = [];
    const connection = {
        signal_subscribe(bus, iface, name, path, uuid, flags, cb) {
            assert.equal(bus, 'org.gnome.Shell');
            assert.equal(iface, 'org.gnome.Shell.Extensions');
            assert.equal(path, '/org/gnome/Shell');
            assert.equal(uuid, 'smart-pause-resume@erenseymen.github.io');
            signal = cb; return 1;
        },
        call(bus, path, iface, method, params, type, flags, timeout, cancel, cb) {
            assert.equal(method, 'GetExtensionInfo'); reply = cb;
        },
        call_finish: info => ({deep_unpack: () => [info]}),
        signal_unsubscribe() { unsubscribed = true; },
    };
    const Gio = {
        DBus: {session: connection}, DBusSignalFlags: {NONE: 0},
        DBusCallFlags: {NONE: 0}, BusType: {SESSION: 0}, BusNameWatcherFlags: {NONE: 0},
        Cancellable: class {cancel() { cancelled = true; }},
        bus_watch_name(_type, _name, _flags, a, v) { appeared = a; vanished = v; return 2; },
        bus_unwatch_name() { unwatched = true; },
    };
    const GLib = {Variant: class {}, VariantType: class {}};
    const source = readFileSync(new URL('../smartPause.js', import.meta.url), 'utf8')
        .replace(/^import .*;\n/gm, '').replace(/export /g, '');
    const {SmartPauseClient} = vm.runInNewContext(`(() => {${source};return {SmartPauseClient};})()`, {Gio, GLib});
    const client = new SmartPauseClient(v => states.push(v));
    appeared();
    const stale = reply;
    signal(null, null, null, null, null, {deep_unpack: () => ['uuid', {state: {deep_unpack: () => 1}}]});
    stale(connection, {state: 2});
    assert.deepEqual(states, [true], 'late initial query cannot undo an enabled signal');
    for (const state of [2, 3, 4, 6, 1]) {
        signal(null, null, null, null, null, {deep_unpack: () => ['uuid', {state}]});
        assert.equal(states.at(-1), state === 1);
    }
    vanished(); assert.equal(states.at(-1), false);
    appeared(); reply(connection, {}); assert.equal(states.at(-1), false);
    client.destroy(); client.destroy();
    assert.ok(cancelled && unsubscribed && unwatched);
    const count = states.length;
    signal(null, null, null, null, null, {deep_unpack: () => ['uuid', {state: 1}]});
    vanished(); appeared(); reply(connection, {state: 1});
    assert.equal(states.length, count, 'closed windows receive no more updates');
});
