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
        set_string(key, value) {
            if (values[key] === value) return;
            values[key] = value;
            this.emit(`changed::${key}`);
        }
        bind(key, row, property) {
            row[property] = values[key];
            this.connect(`changed::${key}`, () => { row[property] = values[key]; });
        }
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
            EventType: {BUTTON_PRESS: 1, TOUCH_BEGIN: 2, BUTTON_RELEASE: 3},
            BUTTON_PRIMARY: 1, BUTTON_MIDDLE: 2, BUTTON_SECONDARY: 3,
            EVENT_PROPAGATE: 0, EVENT_STOP: 1,
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
    Object.assign(api, load('panelActions.js', ['CLICK_ACTIONS', 'activatePanelAction'], api));
    Object.assign(api, load('equalizer.js', ['Equalizer'], api));
    Object.assign(api, load('scrollingLabel.js', ['ScrollingLabel'], api));
    Object.assign(api, load('mediaCard.js', ['MediaCard'], api));
    const {MediaIndicator} = load('extension.js', ['MediaIndicator'], api);
    const {MediaControlsPreferences} = load('prefs.js', ['MediaControlsPreferences'], api);
    const manager = new Signals();
    manager.activePlayer = null;
    manager.readyPlayers = [];
    let preferencesOpened = 0;
    const indicator = new MediaIndicator({openPreferences() { preferencesOpened++; }}, settings,
        {resolve: async () => null}, manager);
    return {api, values, settings, indicator, manager, boxes, MediaControlsPreferences,
        preferencesOpened: () => preferencesOpened};
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
    const press = x => ({type: () => 1, get_button: () => 1, get_coords: () => [x, 10]});
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

test('default panel shortcuts route each button once, preserving transport and touch input', () => {
    const f = fixture();
    f.indicator._card.setPlayer = () => {};
    f.indicator._card.setPlayers = () => {};
    const calls = [];
    f.manager.activePlayer = {
        canControl: true, canPlay: true, canPause: true, canRaise: true,
        playPause: () => calls.push('play-pause'), raise: () => calls.push('raise'),
    };
    const event = (button, type = 1, x = 50) => ({
        type: () => type, get_button: () => button, get_coords: () => [x, 10],
    });
    assert.equal(f.indicator.vfunc_event(event(1)), f.api.Clutter.EVENT_STOP);
    assert.equal(f.indicator.menu.isOpen, true);
    f.indicator.vfunc_event(event(3));
    assert.equal(f.indicator.menu.isOpen, true, 'playback does not toggle the menu');
    f.indicator.vfunc_event(event(2));
    assert.equal(f.indicator.menu.isOpen, false, 'focus closes an open card');
    assert.deepEqual(calls, ['play-pause', 'raise']);

    f.indicator._controlsBox.visible = true;
    for (const button of [1, 2, 3])
        assert.equal(f.indicator.vfunc_event(event(button, 1, 120)), f.api.Clutter.EVENT_PROPAGATE);
    assert.deepEqual(calls, ['play-pause', 'raise'], 'no shortcut on a transport control');
    f.indicator._playButton.emit('clicked');
    assert.equal(calls.length, 3);
    f.indicator.vfunc_event(event(1, 3));
    f.indicator.vfunc_event(event(8));
    assert.equal(calls.length, 3, 'release and extra buttons are ignored');
    f.indicator.vfunc_event(event(undefined, 2));
    assert.equal(f.indicator.menu.isOpen, true, 'touch follows primary mapping');

    // Use real settings notifications: the new action applies without a reload.
    f.settings.set_string('left-click-action', 'preferences');
    f.indicator.vfunc_event(event(1));
    assert.equal(f.preferencesOpened(), 1);
    assert.equal(f.indicator.menu.isOpen, false);
    f.settings.set_string('left-click-action', 'none');
    assert.equal(f.indicator.vfunc_event(event(1)), f.api.Clutter.EVENT_PROPAGATE);
    assert.equal(f.preferencesOpened(), 1);
    f.manager.activePlayer = null;
    assert.doesNotThrow(() => f.indicator.vfunc_event(event(2)));
    assert.doesNotThrow(() => f.indicator.vfunc_event(event(3)));
});

test('Panel preferences order, schema choices and dependent symbolic switch stay in step', () => {
    const f = fixture();
    const prefs = new f.MediaControlsPreferences();
    const panel = prefs._panelPage(f.settings);
    assert.deepEqual(panel.children.map(group => group.title),
        ['Placement', 'Actions', 'Playback controls', 'Track information', 'Scrolling text']);
    const actions = panel.children[1];
    assert.deepEqual(actions.children.map(row => row.title), ['Left click', 'Middle click', 'Right click']);
    assert.deepEqual(actions.children.map(row => row.model[row.selected]),
        ['Open / close menu', 'Focus player', 'Play / pause']);
    const schema = readFileSync(new URL('schemas/org.gnome.shell.extensions.media-controller.gschema.xml', root), 'utf8');
    const enumXml = schema.match(/<enum id="[^\"]+\.click-action">([\s\S]*?)<\/enum>/)[1];
    const nicks = [...enumXml.matchAll(/nick="([^\"]+)"/g)].map(match => match[1]);
    assert.deepEqual(nicks, Array.from(f.api.CLICK_ACTIONS));
    assert.equal(actions.children[0].model.length, nicks.length);
    actions.children[0].selected = nicks.indexOf('previous');
    actions.children[0].emit('notify::selected');
    assert.equal(f.settings.get_string('left-click-action'), 'previous');
    f.settings.set_string('left-click-action', 'menu');
    assert.equal(actions.children[0].selected, nicks.indexOf('menu'));

    const track = panel.children[3];
    assert.equal(track.children[0].title, 'Player icon');
    const symbolic = track.children[1];
    assert.equal(symbolic.title, 'Prefer symbolic icons');
    assert.equal(symbolic.active, true);
    assert.equal(symbolic.sensitive, true);
    f.values['show-player-icon'] = false;
    f.settings.emit('changed::show-player-icon');
    assert.equal(symbolic.sensitive, false);
    assert.equal(symbolic.active, true, 'disabling the icon preserves the preference');
    f.values['show-player-icon'] = true;
    f.settings.emit('changed::show-player-icon');
    assert.equal(symbolic.sensitive, true);
});

test('symbolic preference changes only the panel icon style, retaining its real icon and size', () => {
    const f = fixture();
    const icon = f.indicator._playerIcon;
    const appIcon = {name: 'org.gnome.Rhythmbox'};
    // The card's native artwork/download behavior is tested separately.
    f.indicator._card.setPlayer = () => {};
    f.indicator._card.setPlayers = () => {};
    f.manager.activePlayer = {appIcon, canPlay: true, title: '', artist: ''};
    f.indicator.sync();
    assert.equal(icon.gicon, appIcon, 'Shell receives the original GIcon for fallback lookup');
    assert.equal(icon.icon_size, 16);
    assert.ok(icon.classes.has('mc-player-icon-symbolic'));
    assert.ok(!icon.classes.has('mc-mode-on'), 'symbolic icons do not get the accent mode color');
    const originalStyles = new Set(f.indicator._card._artFallback.classes);
    f.values['prefer-symbolic-icons'] = false;
    f.settings.emit('changed::prefer-symbolic-icons');
    assert.ok(!icon.classes.has('mc-player-icon-symbolic'));
    assert.equal(icon.gicon, appIcon);
    assert.deepEqual(f.indicator._card._artFallback.classes, originalStyles);
    f.values['prefer-symbolic-icons'] = true;
    f.settings.emit('changed::prefer-symbolic-icons');
    assert.ok(icon.classes.has('mc-player-icon-symbolic'));
    const css = readFileSync(new URL('stylesheet.css', root), 'utf8');
    assert.match(css, /\.mc-player-icon\s*\{\s*-st-icon-style: requested;/);
    assert.match(css, /\.mc-player-icon\.mc-player-icon-symbolic\s*\{\s*-st-icon-style: symbolic;/);
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
