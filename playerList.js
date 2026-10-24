// SPDX-License-Identifier: GPL-2.0-or-later
/* playerList.js: the list the card's player button opens, one row per running
 * player, for picking which one the card and the panel follow.
 *
 * A row is a player, not a browser tab: MPRIS gives an app one bus entry, and
 * a browser publishes only the tab that played last. */

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {cssUrl} from './artCache.js';
import {boxOrientation} from './compat.js';
import {Equalizer} from './equalizer.js';

/* The rest of the card is covered while the list is open, so focus wraps
 * inside the list instead of leaving it. */
const NAVIGATION_KEYS = new Map([
    [Clutter.KEY_Up, St.DirectionType.UP],
    [Clutter.KEY_Down, St.DirectionType.DOWN],
    [Clutter.KEY_Tab, St.DirectionType.TAB_FORWARD],
    [Clutter.KEY_ISO_Left_Tab, St.DirectionType.TAB_BACKWARD],
]);

/* Players emit 'changed' several times a second; most of it is not text. */
function setText(label, text) {
    if (label.text !== text)
        label.text = text;
}

/* The shell's own helper moved modules between the releases in metadata.json.
 * Rows are direct children of the scrolled box, so their allocation is already
 * in the adjustment's coordinates. */
function scrollIntoView(scrollView, actor) {
    const adjustment = scrollView.vadjustment;
    const {y1, y2} = actor.get_allocation_box();
    if (y1 < adjustment.value)
        adjustment.value = y1;
    else if (y2 > adjustment.value + adjustment.page_size)
        adjustment.value = y2 - adjustment.page_size;
}

export const PlayerList = GObject.registerClass({
    Signals: {
        /* Carries the picked player's MPRIS bus name. */
        'player-selected': {param_types: [GObject.TYPE_STRING]},
        /* Escape was pressed inside the list. */
        'close-requested': {},
    },
}, class PlayerList extends St.BoxLayout {
    _init(artCache) {
        super._init({
            style_class: 'mc-player-list',
            ...boxOrientation(Clutter.Orientation.VERTICAL),
            /* A click between rows stays in the list instead of closing it. */
            reactive: true,
        });

        this._artCache = artCache;
        this._players = [];
        this._activeBusName = null;
        /* Keyed by bus name; built on first open, kept while the same players
         * are running. */
        this._rows = new Map();
        this._open = false;

        this.add_child(new St.Label({
            style_class: 'mc-player-list-title',
            text: _('Players'),
        }));

        this._scrollView = new St.ScrollView({
            style_class: 'mc-player-list-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
            x_expand: true,
            y_expand: true,
        });
        this._rowsBox = new St.BoxLayout({
            style_class: 'mc-player-list-rows',
            ...boxOrientation(Clutter.Orientation.VERTICAL),
            x_expand: true,
        });
        this._scrollView.child = this._rowsBox;
        this.add_child(this._scrollView);

        this.connect('destroy', () => this._orphanArt());
    }

    /* Called on every card sync, so it does nothing while the list is closed. */
    setPlayers(players, activeBusName) {
        this._players = players;
        this._activeBusName = activeBusName;
        if (this._open)
            this._sync(false);
    }

    open() {
        this._open = true;
        this._sync(true);
        this._scrollView.vadjustment.value = 0;
    }

    close() {
        this._open = false;
        for (const row of this._rows.values())
            row.equalizer.setActive(false);
    }

    /* The first row is the player on screen. */
    focusFirst() {
        const [first] = this._rowsBox.get_children();
        (first ?? this).grab_key_focus();
    }

    /* Rows are sorted only on opening and when players come or go, so a row
     * never jumps out from under the pointer; the rest updates in place. */
    _sync(sort) {
        const current = this._players.length === this._rows.size &&
            this._players.every(player => this._rows.get(player.busName)?.player === player);
        if (!current) {
            this._rebuild();
            sort = true;
        }

        if (sort)
            this._sort();
        for (const row of this._rows.values())
            this._updateRow(row);
    }

    _rebuild() {
        this._orphanArt();
        for (const row of this._rows.values())
            row.player.disconnectObject(this);
        this._rowsBox.destroy_all_children();
        this._rows.clear();

        for (const player of this._players) {
            const row = this._buildRow(player);
            this._rows.set(player.busName, row);
            this._rowsBox.add_child(row.button);
        }
    }

    /* The player on screen first, then newest first: the roster arrives
     * oldest first, and the player opened last is the likelier pick. */
    _sort() {
        const order = [...this._players].reverse();
        const active = order.findIndex(player => player.busName === this._activeBusName);
        if (active > 0)
            order.unshift(...order.splice(active, 1));

        order.forEach((player, index) =>
            this._rowsBox.set_child_at_index(this._rows.get(player.busName).button, index));
    }

    _buildRow(player) {
        /* Stands in for the artwork, which many players never send. */
        const fallback = new St.Icon({style_class: 'mc-player-row-fallback'});
        const art = new St.Bin({
            style_class: 'mc-player-row-art',
            y_align: Clutter.ActorAlign.CENTER,
            child: fallback,
        });

        const title = new St.Label({style_class: 'mc-player-row-title'});
        title.clutter_text.ellipsize = Pango.EllipsizeMode.END;

        /* "Chrome · Some Channel": the app, then who. */
        const appIcon = new St.Icon({
            style_class: 'mc-player-row-app-icon',
            y_align: Clutter.ActorAlign.CENTER,
        });
        const subtitle = new St.Label({
            style_class: 'mc-player-row-subtitle',
            y_align: Clutter.ActorAlign.CENTER,
        });
        subtitle.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        const source = new St.BoxLayout({
            style_class: 'mc-player-row-source',
            ...boxOrientation(Clutter.Orientation.HORIZONTAL),
        });
        source.add_child(appIcon);
        source.add_child(subtitle);

        const text = new St.BoxLayout({
            style_class: 'mc-player-row-text',
            ...boxOrientation(Clutter.Orientation.VERTICAL),
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        text.add_child(title);
        text.add_child(source);

        const equalizer = new Equalizer();
        const check = new St.Icon({
            style_class: 'mc-player-row-check',
            icon_name: 'object-select-symbolic',
            y_align: Clutter.ActorAlign.CENTER,
        });

        const box = new St.BoxLayout({
            style_class: 'mc-player-row-box',
            ...boxOrientation(Clutter.Orientation.HORIZONTAL),
            x_expand: true,
        });
        box.add_child(art);
        box.add_child(text);
        box.add_child(equalizer);
        box.add_child(check);

        const button = new St.Button({
            style_class: 'mc-player-row',
            can_focus: true,
            x_expand: true,
            child: box,
        });

        /* The bus name, not the player: it may have quit by the time this
         * fires, and the manager is the one that knows. */
        const {busName} = player;
        button.connect('clicked', () => this.emit('player-selected', busName));
        button.connect('key-focus-in', () => scrollIntoView(this._scrollView, button));

        const row = {
            player, button, art, fallback, title, appIcon, subtitle, equalizer, check,
            artUrl: null,
            artGeneration: 0,
        };

        /* Background players change track without the card hearing about it,
         * so each row listens to its own player, acting only while open. */
        player.connectObject('changed', () => {
            if (this._open)
                this._updateRow(row);
        }, this);

        return row;
    }

    setAccentColor(color) {
        this._accentColor = color;
        for (const row of this._rows.values())
            this._applyAccent(row);
    }

    _applyAccent(row) {
        if (!this._accentColor)
            return;
        row.equalizer.setAccentColor(this._accentColor);
        row.check.set_style(`color: ${this._accentColor};`);
    }

    _updateRow(row) {
        this._applyAccent(row);
        const {player} = row;
        const {displayTitle: title, displayName} = player;

        /* A player with nothing loaded still gets a row: picking it is how to
         * reach its controls. */
        setText(row.title, title || displayName);
        setText(row.subtitle, title
            ? [displayName, player.artist].filter(Boolean).join(' · ')
            : _('Nothing playing'));
        row.appIcon.gicon = player.appIcon;
        row.fallback.gicon = player.appIcon;
        row.button.accessible_name = title ? `${displayName}: ${title}` : displayName;

        row.equalizer.visible = player.isPlaying;
        row.equalizer.setPlaying(player.isPlaying);
        row.equalizer.setActive(this._open);

        /* Hidden by opacity, not `visible`, so every row keeps room for it and
         * the titles line up. */
        const active = player.busName === this._activeBusName;
        row.check.opacity = active ? 255 : 0;
        if (active !== row.button.has_style_class_name('mc-player-row-active')) {
            if (active)
                row.button.add_style_class_name('mc-player-row-active');
            else
                row.button.remove_style_class_name('mc-player-row-active');
        }

        this._updateArt(row);
    }

    _updateArt(row) {
        const url = row.player.artUrl;
        if (url === row.artUrl)
            return;

        /* A newer track must win even if its download finishes first. */
        row.artUrl = url;
        const generation = ++row.artGeneration;
        row.art.style = null;
        row.fallback.visible = true;

        this._artCache.resolve(url).then(path => {
            if (generation !== row.artGeneration || !path)
                return;
            row.art.style = `background-image: ${cssUrl(path)};`;
            row.fallback.visible = false;
        });
    }

    /* Rows about to be destroyed must not be painted on by a late download. */
    _orphanArt() {
        for (const row of this._rows.values())
            row.artGeneration++;
    }

    vfunc_key_press_event(event) {
        const key = event.get_key_symbol();
        if (key === Clutter.KEY_Escape) {
            this.emit('close-requested');
            return Clutter.EVENT_STOP;
        }

        /* Opened with the mouse, the list itself holds the focus, and St will
         * not navigate "from" the widget it is navigating within. */
        const direction = NAVIGATION_KEYS.get(key);
        if (direction !== undefined) {
            const focus = global.stage.key_focus;
            this.navigate_focus(focus === this ? null : focus, direction, true);
            return Clutter.EVENT_STOP;
        }
        return super.vfunc_key_press_event(event);
    }
});
