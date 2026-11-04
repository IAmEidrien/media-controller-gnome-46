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
import {CardList} from './cardList.js';
import {boxOrientation} from './compat.js';
import {Equalizer} from './equalizer.js';

/* Players emit 'changed' several times a second; most of it is not text. */
function setText(label, text) {
    if (label.text !== text)
        label.text = text;
}

export const PlayerList = GObject.registerClass({
    Signals: {
        /* Carries the picked player's MPRIS bus name. */
        'player-selected': {param_types: [GObject.TYPE_STRING]},
    },
}, class PlayerList extends CardList {
    _init(artCache) {
        super._init(_('Players'));

        this._artCache = artCache;
        this._players = [];
        this._activeBusName = null;
        /* Keyed by bus name; built on first open, kept while the same players
         * are running. */
        this._rows = new Map();

        this.connect('destroy', () => this._orphanArt());
    }

    /* Called on every card sync, so it does nothing while the list is closed. */
    setPlayers(players, activeBusName) {
        this._players = players;
        this._activeBusName = activeBusName;
        if (this._open)
            this._sync(false);
    }

    _refresh() {
        this._sync(true);
    }

    close() {
        super.close();
        for (const row of this._rows.values())
            row.equalizer.setActive(false);
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

        const title = new St.Label({style_class: 'mc-list-row-title'});
        title.clutter_text.ellipsize = Pango.EllipsizeMode.END;

        /* "Chrome · Some Channel": the app, then who. */
        const appIcon = new St.Icon({
            style_class: 'mc-player-row-app-icon',
            y_align: Clutter.ActorAlign.CENTER,
        });
        const subtitle = new St.Label({
            style_class: 'mc-list-row-subtitle',
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
            style_class: 'mc-list-row-text',
            ...boxOrientation(Clutter.Orientation.VERTICAL),
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        text.add_child(title);
        text.add_child(source);

        const equalizer = new Equalizer();
        const {button, check} = this._buildRowButton([art, text, equalizer]);

        /* The bus name, not the player: it may have quit by the time this
         * fires, and the manager is the one that knows. */
        const {busName} = player;
        button.connect('clicked', () => this.emit('player-selected', busName));

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

        this._setRowActive(row, player.busName === this._activeBusName);

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
});
