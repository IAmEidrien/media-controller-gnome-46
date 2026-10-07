import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const root = new URL('../', import.meta.url);

// Evaluate the actual UI modules against a deliberately older GI surface. This
// checks construction and routing, not native rendering or a real MPRIS bus.
function load(file, names, api) {
    const source = readFileSync(new URL(file, root), 'utf8')
        .replace(/^import[\s\S]*?;\s*$/gm, '')
        .replace(/export default class/g, 'class')
        .replace(/export (?=(const|class|function)\b)/g, '');
    return vm.runInNewContext(`(() => { ${source}; return {${names.join(',')}}; })()`, api);
}

class Signals {
    listeners = new Map();
    nextId = 1;
    connect(name, callback) {
        const id = this.nextId++;
        this.listeners.set(id, {name, callback});
        return id;
    }
    disconnect(id) { assert.ok(this.listeners.delete(id)); }
    emit(name, ...args) {
        for (const listener of [...this.listeners.values()]) {
            if (listener.name === name) listener.callback(this, ...args);
        }
    }
    connectObject(...args) {
        const owner = args.pop();
        for (let i = 0; i < args.length; i += 2) {
            const id = this.connect(args[i], args[i + 1]);
            this.listeners.get(id).owner = owner;
        }
    }
    disconnectObject(owner) {
        for (const [id, listener] of this.listeners) {
            if (listener.owner === owner) this.listeners.delete(id);
        }
    }
}

class Actor extends Signals {
    constructor(...args) { super(); this._init(...args); }
    _init(params = {}) {
        this.children = [];
        this.classes = new Set();
        this.visible = true;
        this.clutter_text = {get_preferred_width: () => [0, (this.text?.length ?? 0) * 8]};
        Object.assign(this, params);
        if (params.child) this.add_child(params.child);
    }
    add_child(child) { child.parent = this; this.children.push(child); }
    add(child) { this.add_child(child); }
    add_suffix(child) { this.add_child(child); }
    set_child(child) { this.children = []; this.child = child; this.add_child(child); }
    get_parent() { return this.parent; }
    get_children() { return this.children; }
    set_width(width) { this.width = width; }
    set_child_at_index(child, index) {
        this.children = this.children.filter(value => value !== child);
        this.children.splice(index, 0, child);
    }
    set_style(style) { this.style = style; }
    add_style_class_name(name) { this.classes.add(name); }
    remove_style_class_name(name) { this.classes.delete(name); }
    has_style_class_name(name) { return this.classes.has(name); }
    add_css_class(name) { this.classes.add(name); }
    remove_all_transitions() {}
    get_transformed_position() { return [100, 0]; }
    get_transformed_size() { return [80, 30]; }
    destroy_all_children() { for (const child of this.children) child.destroy(); this.children = []; }
    destroy() { this.emit('destroy'); this.destroy_all_children(); }
}

function fixture() {
    const boxes = [];
    class BoxLayout extends Actor {
        _init(params) {
            assert.ok(!('orientation' in params), 'GNOME 46 St.BoxLayout rejects orientation');
            super._init(params);
            boxes.push(this);
        }
    }
    const schema = readFileSync(new URL('schemas/org.gnome.shell.extensions.media-controller.gschema.xml', root), 'utf8');
    const values = {};
    for (const match of schema.matchAll(/<key name="([^"]+)"[^>]*>[\s\S]*?<default>(.*?)<\/default>/g)) {
        const value = match[2];
        values[match[1]] = value.startsWith("'") ? value.slice(1, -1)
            : value === 'true' ? true : value === 'false' ? false : Number(value);
    }
    class Settings extends Signals {
        get_boolean(key) { assert.ok(key in values); return values[key]; }
        get_int(key) { assert.ok(key in values); return values[key]; }
        get_string(key) { assert.ok(key in values); return values[key]; }
        set_string(key, value) { values[key] = value; }
        bind(key, row, property) { row[property] = values[key]; }
    }
    const settings = new Settings();
    class Menu extends Signals {
        box = new BoxLayout({vertical: true});
        isOpen = false;
        toggle() { this.isOpen = !this.isOpen; }
        close() { this.isOpen = false; }
        addMenuItem(item) { this.box.add_child(item); }
    }
    class PanelButton extends Actor {
        _init() {
            super._init();
            this.container = new Actor();
            this.menu = new Menu();
        }
    }
    const api = {
        _: text => text,
        global: {stage: {}},
        St: {Widget: Actor, BoxLayout, Button: Actor, Icon: Actor, Label: Actor,
            Settings: {get: () => ({enable_animations: false})}},
        Clutter: {ActorAlign: {CENTER: 0, START: 1, END: 2},
            EventType: {BUTTON_PRESS: 1, TOUCH_BEGIN: 2}, EVENT_PROPAGATE: 0,
            FixedLayout: class {}, AnimationMode: {LINEAR: 0}},
        GObject: {registerClass: (...args) => args.at(-1), TYPE_STRING: 0},
        Pango: {EllipsizeMode: {END: 0, NONE: 1}, WrapMode: {WORD_CHAR: 0}},
        // No ButtonRow: it is not part of libadwaita 1.5.
        Adw: {PreferencesPage: Actor, PreferencesGroup: Actor, ActionRow: Actor,
            SwitchRow: Actor, ComboRow: Actor, SpinRow: Actor},
        Gtk: {Button: Actor, Adjustment: Actor, Align: {CENTER: 0},
            StringList: {new: labels => labels}},
        Gio: {SettingsBindFlags: {DEFAULT: 0, GET: 1}, FileQueryInfoFlags: {NONE: 0}},
        GLib: {PRIORITY_DEFAULT: 0},
        Extension: class {},
        ExtensionPreferences: class {getSettings() { return settings; }},
        Slider: Actor,
        PanelMenu: {Button: PanelButton},
        PopupMenu: {PopupBaseMenuItem: Actor},
        artCacheDir: () => ({
            enumerate_children_async: (...args) => args.at(-1)(
                {enumerate_children_finish: () => { throw Error('empty cache'); }}, null),
        }),
    };
    Object.assign(api, load('transport.js', ['US_PER_SECOND', 'loopIconName', 'nextLoopStatus',
        'playPauseIconName', 'seekOffset', 'setToggleStyle'], api));
    Object.assign(api, load('equalizer.js', ['Equalizer'], api));
    Object.assign(api, load('scrollingLabel.js', ['ScrollingLabel'], api));
    Object.assign(api, load('mediaCard.js', ['MediaCard'], api));
    const {MediaIndicator} = load('extension.js', ['MediaIndicator'], api);
    const {MediaControlsPreferences} = load('prefs.js', ['MediaControlsPreferences'], api);
    const manager = new Signals();
    manager.activePlayer = null;
    manager.readyPlayers = [];
    const indicator = new MediaIndicator({openPreferences() {}}, settings,
        {resolve: async () => null}, manager);
    return {api, values, settings, indicator, manager, boxes, MediaControlsPreferences};
}

test('panel, card, scrolling label and equalizer construct with GNOME 46 box properties', () => {
    const f = fixture();
    assert.ok(f.boxes.length >= 14, 'all nested layouts are constructed');
    assert.equal(f.indicator._card.vertical, true);
    assert.equal(f.indicator._box.vertical, false);
    assert.equal(f.indicator._card._equalizer.vertical, false);
    assert.equal(f.indicator._label._box.vertical, false);
    f.indicator._card.destroy();
    f.indicator._label.destroy();
    assert.ok([...f.settings.listeners.values()].every(listener => listener.owner === f.indicator),
        'destroying the card removes its manually connected settings signals');
});

test('all preferences pages construct without libadwaita 1.6 ButtonRow', () => {
    const f = fixture();
    const prefs = new f.MediaControlsPreferences();
    const pages = [];
    prefs.fillPreferencesWindow({set_default_size() {}, add: page => pages.push(page)});
    assert.equal(pages.length, 3);
    const maintenance = pages[2];
    const clearRow = maintenance.children[0].children[1];
    const resetRow = maintenance.children[1].children[0];
    let cleared = 0;
    let reset = 0;
    prefs._onClearCache = () => cleared++;
    prefs._onReset = () => reset++;
    assert.ok(clearRow.activatable_widget.classes.has('destructive-action'));
    clearRow.activatable_widget.emit('clicked');
    resetRow.activatable_widget.emit('clicked');
    assert.equal(cleared, 1);
    assert.equal(reset, 1);
});

test('GNOME 46 panel presses open the card while transport clicks control playback', () => {
    const f = fixture();
    const press = x => ({type: () => 1, get_coords: () => [x, 10]});
    f.indicator._controlsBox.visible = true;
    f.indicator.vfunc_event(press(120));
    assert.equal(f.indicator.menu.isOpen, false);
    let toggled = 0;
    f.manager.activePlayer = {playPause: () => toggled++};
    f.indicator._playButton.emit('clicked');
    assert.equal(toggled, 1);
    f.indicator.vfunc_event(press(50));
    assert.equal(f.indicator.menu.isOpen, true);
});

test('large fallback app icons retain fixed artwork and panel sizes', () => {
    const f = fixture();
    const card = f.indicator._card;
    const largeIcon = {nativeWidth: 4096, nativeHeight: 4096};
    card._setFallbackIcon({appIcon: largeIcon, hasAppIcon: true});
    assert.equal(card._artFallback.gicon, largeIcon);
    assert.equal(card._artFallback.icon_size, 40);
    assert.match(card._artButton.style, /width: 88px; height: 88px;/);
    assert.equal(f.indicator._playerIcon.icon_size, 16);
    f.values['card-art-size'] = 'large';
    f.settings.emit('changed::card-art-size');
    assert.equal(card._artFallback.icon_size, 56);
    assert.match(card._artButton.style, /width: 120px; height: 120px;/);
});
