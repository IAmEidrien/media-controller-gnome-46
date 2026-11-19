// SPDX-License-Identifier: MIT
// GNOME 46's extension-state API; no access to the other extension's internals.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

export const SMART_PAUSE_UUID = 'smart-pause-resume@erenseymen.github.io';
const ENABLED = 1;
const BUS = 'org.gnome.Shell';
const PATH = '/org/gnome/Shell';
const IFACE = 'org.gnome.Shell.Extensions';

export function smartPauseEnabled(manager) {
    return manager.lookup(SMART_PAUSE_UUID)?.state === ENABLED;
}

export class SmartPauseWatcher {
    constructor(manager, changed) {
        this._manager = manager;
        this._signal = manager.connect('extension-state-changed', (_manager, extension) => {
            if (extension.uuid === SMART_PAUSE_UUID)
                changed();
        });
    }

    destroy() {
        if (this._signal)
            this._manager.disconnect(this._signal);
        this._signal = 0;
        this._manager = null;
    }
}

// Preferences is a separate process. Subscribe before requesting initial state,
// and reject replies superseded by a newer state signal or a closed window.
export class SmartPauseClient {
    constructor(changed) {
        this._changed = changed;
        this._closed = false;
        this._serial = 0;
        this._cancel = new Gio.Cancellable();
        this._signal = Gio.DBus.session.signal_subscribe(BUS, IFACE,
            'ExtensionStateChanged', PATH, SMART_PAUSE_UUID, Gio.DBusSignalFlags.NONE,
            (_c, _s, _p, _i, _n, params) => {
                this._serial++;
                this._deliver(params.deep_unpack()[1]);
            });
        this._watch = Gio.bus_watch_name(Gio.BusType.SESSION, BUS,
            Gio.BusNameWatcherFlags.NONE, () => this._refresh(), () => {
                this._serial++;
                if (!this._closed)
                    this._changed(false);
            });
    }

    _deliver(info) {
        if (!this._closed) {
            const state = info.state?.deep_unpack?.() ?? info.state;
            this._changed(state === ENABLED);
        }
    }

    _refresh() {
        if (this._closed)
            return;
        const serial = ++this._serial;
        Gio.DBus.session.call(BUS, PATH, IFACE, 'GetExtensionInfo',
            new GLib.Variant('(s)', [SMART_PAUSE_UUID]), new GLib.VariantType('(a{sv})'),
            Gio.DBusCallFlags.NONE, 2000, this._cancel, (connection, result) => {
                try {
                    const [info] = connection.call_finish(result).deep_unpack();
                    if (serial === this._serial)
                        this._deliver(info);
                } catch {
                    if (!this._closed && serial === this._serial)
                        this._changed(false);
                }
            });
    }

    destroy() {
        if (this._closed)
            return;
        this._closed = true;
        this._cancel.cancel();
        Gio.DBus.session.signal_unsubscribe(this._signal);
        Gio.bus_unwatch_name(this._watch);
    }
}
