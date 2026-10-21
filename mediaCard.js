// SPDX-License-Identifier: GPL-2.0-or-later
/* mediaCard.js
 *
 * The iOS-style "now playing" card shown when the panel indicator is clicked.
 */

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';
import { Slider } from 'resource:///org/gnome/shell/ui/slider.js';

import { cssUrl } from './artCache.js';
import { boxOrientation } from './compat.js';
import { Equalizer } from './equalizer.js';
import { LyricsPanel, lyricsIcon } from './lyricsPanel.js';
import { PlayerList } from './playerList.js';
import {
    US_PER_SECOND, loopIconName, nextLoopStatus, playPauseIconName,
    seekOffset, setReactive, setToggleStyle, syncHover
} from './transport.js';

const POSITION_POLL_SECONDS = 1;

/* A wrapping title has no natural bound: the card is as tall as the text needs.
 * Podcast episodes and DJ sets routinely carry titles of a few hundred
 * characters, which would push the controls off the bottom of the screen. This
 * caps the title at roughly three lines at the default card width; the wrap
 * still does the real work, this only stops the pathological case. */
const MAX_TITLE_CHARS = 120;

/* The player list rises out of the player button: this much air between the
 * two, at least this much between the list and the card's edges, and this far
 * it slides in from. */
const LIST_GAP = 6;
const LIST_INSET = 10;
const LIST_SLIDE = 12;
const LIST_MS = 180;

/* Keyed by the `card-art-size` enum nick. `icon` sizes the fallback player icon
 * so it keeps roughly the same inset as the artwork it stands in for, and the
 * radius tracks the size so the corners stay proportionally round. */
const ART_SIZES = {
    'small': {size: 80, radius: 14, icon: 36},
    'medium': {size: 104, radius: 18, icon: 46},
    'large': {size: 136, radius: 22, icon: 60},
};
const DEFAULT_ART_SIZE = 'large';

/* How long the volume slider stops following the player after the user moves
 * it. Every write comes back as a PropertiesChanged a moment later, and those
 * echoes, replayed mid-drag, would pull the thumb back to where it just was. */
const VOLUME_HOLD_MS = 400;

/* The shell's own volume slider's thresholds: muted only at zero, then thirds. */
const VOLUME_ICONS = [
    'audio-volume-muted-symbolic',
    'audio-volume-low-symbolic',
    'audio-volume-medium-symbolic',
    'audio-volume-high-symbolic',
];

/** @param {number} volume 0 to 1, or past it on players that amplify */
function volumeIconName(volume) {
    if (volume <= 0)
        return VOLUME_ICONS[0];
    return VOLUME_ICONS[Math.min(3, Math.ceil(volume * 3))];
}

/**
 * Spreading the string iterates code points, so the cut never lands between the
 * halves of a surrogate pair and split an emoji into a broken glyph.
 *
 * @param {string} text @param {number} maxLength
 */
function truncate(text, maxLength) {
    const chars = [...text];
    if (chars.length <= maxLength)
        return text;
    return `${chars.slice(0, maxLength - 1).join('').trimEnd()}…`;
}

/** Hours only appear once there are some: `4:07`, but `1:23:20`. */
function formatTime(micros) {
    const total = Math.max(0, Math.floor(micros / US_PER_SECOND));
    const seconds = total % 60;
    const minutes = Math.floor(total / 60) % 60;
    const hours = Math.floor(total / 3600);

    const pad = value => value.toString().padStart(2, '0');
    if (hours > 0)
        return `${hours}:${pad(minutes)}:${pad(seconds)}`;
    return `${minutes}:${pad(seconds)}`;
}

/* Secondary text; opacity keeps it legible in both light and dark themes,
 * which a hardcoded color would not. */
const DIM_OPACITY = 160;

/* `message-media-control` is the shell's own media button style, so hover,
 * active and insensitive states follow the current theme. */
function iconButton(iconName, styleClass) {
    return new St.Button({
        style_class: `message-media-control ${styleClass}`,
        can_focus: true,
        child: new St.Icon({icon_name: iconName}),
    });
}

/* Press feedback: shrink, then spring back past full size. */
function pop(actor) {
    actor.remove_all_transitions();
    actor.set_scale(0.7, 0.7);
    actor.ease({
        scale_x: 1,
        scale_y: 1,
        duration: 300,
        mode: Clutter.AnimationMode.EASE_OUT_BACK,
    });
}

/* The layer the player list floats in. It asks for no room, so the list can
 * never hold the card open: as the list faded out over a card whose lyrics
 * were closing — switching to a browser, say — the card used to stay at its
 * old height, centring the header in it, and then snap shut. And it seats the
 * list on every allocation, so the list rides the player button wherever the
 * card's height moves it. */
const ListLayer = GObject.registerClass(
class ListLayer extends St.Widget {
    /**
     * @param {object} list the PlayerList
     * @param {Function} anchor returns the y, in the layer's coordinates, that
     *   the list's bottom edge sits on
     */
    _init(list, anchor) {
        super._init({x_expand: true, y_expand: true, visible: false});
        this._list = list;
        this._anchor = anchor;
        this.add_child(list);
    }

    vfunc_get_preferred_width(_forHeight) {
        return [0, 0];
    }

    vfunc_get_preferred_height(_forWidth) {
        return [0, 0];
    }

    vfunc_allocate(box) {
        this.set_allocation(box);

        /* No taller than the room above the button; a longer list scrolls. */
        const width = Math.max(0, box.get_width() - 2 * LIST_INSET);
        const bottom = this._anchor() - LIST_GAP;
        const [, natural] = this._list.get_preferred_height(width);
        const height = Math.min(natural, Math.max(0, bottom - LIST_INSET));
        this._list.allocate(Clutter.ActorBox.new(
            LIST_INSET, bottom - height, LIST_INSET + width, bottom));
    }
});

export const MediaCard = GObject.registerClass({
    Signals: {
        /* Raised the player's window; the menu should close. */
        'activated': {},
        /* The gear button was pressed. */
        'open-preferences': {},
        /* A player was picked from the list; carries its MPRIS bus name. */
        'player-selected': {param_types: [GObject.TYPE_STRING]},
    },
}, class MediaCard extends St.Widget {
    _init(artCache, lyricsSource, settings) {
        /* Two layers: the card's content, and above it the player list with
         * the scrim behind it, which float over the content when open. */
        super._init({
            style_class: 'mc-card',
            layout_manager: new Clutter.BinLayout(),
            x_expand: true,
        });

        /* Held to the top at its own height. Filling a card that is briefly
         * taller than it would stretch the header, whose action column
         * expands, and slide the artwork down to the middle. */
        this._content = new St.BoxLayout({
            style_class: 'mc-card-content',
            ...boxOrientation(Clutter.Orientation.VERTICAL),
            x_expand: true,
            y_align: Clutter.ActorAlign.START,
        });
        this.add_child(this._content);

        this._artCache = artCache;
        this._settings = settings;
        /* Stage pixels; known once the card is first opened. */
        this._maxHeight = Infinity;
        this._player = null;
        this._playerSignals = [];
        this._timeoutId = 0;
        this._seekRefreshId = 0;
        this._volumeHoldId = 0;
        this._dragging = false;
        this._dragPlayer = null;
        this._dragLength = 0;
        this._active = false;
        this._currentArtUrl = null;
        this._artGeneration = 0;
        this._artPath = null;
        this._artSize = ART_SIZES[DEFAULT_ART_SIZE];
        this._length = 0;
        this._position = 0;
        this._players = [];
        this._activePlayer = null;
        this._playerListOpen = false;
        this._focusBeforeList = null;

        this._buildHeader();
        this._buildLyrics(lyricsSource);
        this._buildSeekBar();
        this._buildControls();
        this._buildFooter();
        this._buildPlayerList();

        this._settingsSignals = [
            this._settings.connect('changed::card-show-art', () => this.sync()),
            this._settings.connect('changed::card-show-seek-bar', () => this.sync()),
            this._settings.connect('changed::card-show-seek-buttons', () => this.sync()),
            this._settings.connect('changed::card-show-shuffle', () => this.sync()),
            this._settings.connect('changed::card-show-loop', () => this.sync()),
            this._settings.connect('changed::card-show-volume', () => this.sync()),
            this._settings.connect('changed::card-show-lyrics-button', () => this.sync()),
            this._settings.connect('changed::card-show-player-switcher',
                () => this._updatePicker()),
            this._settings.connect('changed::card-width', () => this._applyWidth()),
            this._settings.connect('changed::lyrics-height', () => this._applyLyricsHeight()),
            this._settings.connect('changed::card-art-size', () => this._applyArtSize()),
        ];
        this._applyWidth();
        this._applyArtSize();

        this.connect('destroy', () => this._onDestroy());
    }

    /**
     * Hand the card the players it can switch between. Called on every sync, so
     * it does as little as possible when nothing has moved.
     *
     * @param {object[]} players the players to offer, in a stable order
     * @param {object|null} active the one currently on screen
     */
    setPlayers(players, active) {
        this._players = players;
        this._activePlayer = active;
        this._playerList.setPlayers(players, active?.busName ?? null);
        this._updatePicker();
    }

    /* The button names the player on screen whenever there is one. Only with a
     * second player is there a choice to make; until then it is a plain name
     * tag, with no arrow and nothing to press. */
    _updatePicker() {
        const player = this._activePlayer;
        const show = !!player && this._settings.get_boolean('card-show-player-switcher');
        const choice = show && this._players.length > 1;

        this._pickerButton.visible = show;
        if (show) {
            this._pickerIcon.gicon = player.appIcon;
            this._pickerLabel.text = player.displayName;
        }
        this._pickerArrow.visible = choice;
        this._pickerButton.can_focus = choice;
        setReactive(this._pickerButton, choice);

        if (!choice)
            this._closePlayerList();
        this._updateFooter();
    }

    _buildHeader() {
        const header = new St.BoxLayout({
            style_class: 'mc-card-header',
            ...boxOrientation(Clutter.Orientation.HORIZONTAL),
        });

        /* The artwork is the card's "go to the app" target: clicking it raises
         * the player's window. A button rather than a bin, so hover and focus
         * come from the theme — St.Button is itself a St.Bin, so it still takes
         * the fallback icon as its child and the sizing style as its own. */
        this._artButton = new St.Button({
            style_class: 'mc-art',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._artFallback = new St.Icon({
            icon_name: 'audio-x-generic-symbolic',
            opacity: DIM_OPACITY,
        });
        this._artButton.set_child(this._artFallback);
        this._artButton.connect('clicked', () => {
            this._player?.raise();
            this.emit('activated');
        });
        this._artButton.connect('notify::hover', () => this._applyArtStyle());
        this._artButton.connect('key-focus-in', () => {
            this._artFocused = true;
            this._applyArtStyle();
        });
        this._artButton.connect('key-focus-out', () => {
            this._artFocused = false;
            this._applyArtStyle();
        });
        header.add_child(this._artButton);

        const textBox = new St.BoxLayout({
            style_class: 'mc-card-text',
            ...boxOrientation(Clutter.Orientation.VERTICAL),
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
        });
        this._titleLabel = new St.Label({style_class: 'mc-card-title', text: _('Nothing playing')});
        this._artistLabel = new St.Label({style_class: 'mc-card-artist', text: ''});
        this._albumLabel = new St.Label({style_class: 'mc-card-album', text: ''});
        /* The card has a fixed width, so a long title wraps onto further lines
         * rather than being cut off. Breaking mid-word is the fallback for a
         * single word too long to fit on a line of its own. */
        this._titleLabel.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        this._titleLabel.clutter_text.line_wrap = true;
        this._titleLabel.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
        this._artistLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this._albumLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        textBox.add_child(this._titleLabel);
        textBox.add_child(this._artistLabel);
        textBox.add_child(this._albumLabel);
        header.add_child(textBox);

        /* A full-height column down the right edge: the lyrics button and the
         * gear on the top line, and the equalizer centred against the art. The
         * track text is a column of its own beside this one, so it never runs
         * underneath either of them. */
        const actions = new St.BoxLayout({
            style_class: 'mc-card-actions',
            ...boxOrientation(Clutter.Orientation.VERTICAL),
            y_expand: true,
            x_align: Clutter.ActorAlign.END,
        });

        this._prefsButton = new St.Button({
            style_class: 'mc-app-button',
            can_focus: true,
            y_align: Clutter.ActorAlign.START,
            child: new St.Icon({icon_name: 'emblem-system-symbolic', icon_size: 16}),
        });
        this._prefsButton.connect('clicked', () => this.emit('open-preferences'));

        this._lyricsButton = new St.Button({
            style_class: 'mc-app-button mc-lyrics-button',
            can_focus: true,
            toggle_mode: true,
            y_align: Clutter.ActorAlign.START,
            accessible_name: _('Lyrics'),
            child: new St.Icon({gicon: lyricsIcon(), icon_size: 16}),
        });
        this._lyricsButton.child.set_pivot_point(0.5, 0.5);
        this._lyricsButton.connect('notify::checked', () => {
            pop(this._lyricsButton.child);
            setToggleStyle(this._lyricsButton, this._lyricsButton.checked, this._accentColor);
            this._lyrics.setOpen(this._lyricsButton.checked);
            this._onLyricsTimingChanged();
        });

        /* The top of the column: the lyrics button, then the gear in the
         * corner. */
        const topRow = new St.BoxLayout({
            style_class: 'mc-card-actions-top',
            ...boxOrientation(Clutter.Orientation.HORIZONTAL),
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.START,
        });
        topRow.add_child(this._lyricsButton);
        topRow.add_child(this._prefsButton);
        actions.add_child(topRow);

        /* Expanding is what pushes this off the gear and centres it. */
        const status = new St.BoxLayout({
            style_class: 'mc-card-status',
            ...boxOrientation(Clutter.Orientation.HORIZONTAL),
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.CENTER,
            y_expand: true,
        });

        this._equalizer = new Equalizer();
        status.add_child(this._equalizer);
        actions.add_child(status);

        header.add_child(actions);

        /* The lyrics open under the header in a column with no spacing: the
         * gap above them is their own padding, so it grows with them instead
         * of appearing all at once. */
        this._headerColumn = new St.BoxLayout({
            ...boxOrientation(Clutter.Orientation.VERTICAL),
        });
        this._headerColumn.add_child(header);
        this._content.add_child(this._headerColumn);
    }

    _buildLyrics(source) {
        this._lyrics = new LyricsPanel(source, this._settings);
        this._lyrics.connect('seek-requested', (_panel, position) => {
            this._player?.setPosition(position);
            this._refreshPositionSoon();
        });
        this._lyrics.connect('timing-changed', () => this._onLyricsTimingChanged());
        this._headerColumn.add_child(this._lyrics);
    }

    /* Timed lyrics need the position polled, and want it now. */
    _onLyricsTimingChanged() {
        this._updateTimer();
        if (this._lyrics.wantsPosition)
            this._refreshPosition();
    }

    _buildSeekBar() {
        this._seekBox = new St.BoxLayout({
            style_class: 'mc-seek-box',
            ...boxOrientation(Clutter.Orientation.VERTICAL),
        });

        this._slider = new Slider(0);
        this._slider.add_style_class_name('mc-seek');
        this._slider.x_expand = true;

        /* The track can advance while the thumb is held, and sync() would move
         * `_length` out from under the drag. Pin the player and the duration the
         * user is actually scrubbing against. */
        this._slider.connect('drag-begin', () => {
            this._dragging = true;
            this._dragPlayer = this._player;
            this._dragLength = this._length;
            return Clutter.EVENT_PROPAGATE;
        });
        this._slider.connect('drag-end', () => {
            this._dragging = false;
            const player = this._dragPlayer;
            const length = this._dragLength;
            this._dragPlayer = null;

            if (player && player === this._player && length > 0)
                player.setPosition(Math.round(this._slider.value * length));
            return Clutter.EVENT_PROPAGATE;
        });
        /* Keep the timestamps under the thumb while the user scrubs. */
        this._slider.connect('notify::value', () => {
            if (this._dragging && this._dragLength > 0) {
                this._updateTimeLabels(this._slider.value * this._dragLength,
                    this._dragLength);
            }
        });

        const times = new St.BoxLayout({
            style_class: 'mc-time-box',
            ...boxOrientation(Clutter.Orientation.HORIZONTAL),
        });
        this._positionLabel = new St.Label({
            style_class: 'mc-time',
            text: '0:00',
        });
        this._remainingLabel = new St.Label({
            style_class: 'mc-time',
            text: '-0:00',
        });
        this._remainingLabel.x_align = Clutter.ActorAlign.END;
        this._remainingLabel.x_expand = true;
        times.add_child(this._positionLabel);
        times.add_child(this._remainingLabel);

        this._seekBox.add_child(this._slider);
        this._seekBox.add_child(times);
        this._content.add_child(this._seekBox);
    }

    _buildControls() {
        /* A box, not a BinLayout stack: shuffle packs against the left edge,
         * loop against the right, and the expanding transport cluster centres
         * itself in the space between them. (A BinLayout overlay does not
         * apply the edge buttons' alignment and piles them onto the middle of
         * the row, underneath the play button.) */
        const row = new St.BoxLayout({
            style_class: 'mc-controls-row',
            ...boxOrientation(Clutter.Orientation.HORIZONTAL),
        });

        this._shuffleButton = iconButton('media-playlist-shuffle-symbolic',
            'mc-control-button mc-mode-button');
        this._shuffleButton.y_align = Clutter.ActorAlign.CENTER;
        this._shuffleButton.connect('clicked', () => this._toggleShuffle());

        this._loopButton = iconButton('media-playlist-repeat-symbolic',
            'mc-control-button mc-mode-button');
        this._loopButton.y_align = Clutter.ActorAlign.CENTER;
        this._loopButton.connect('clicked', () => this._cycleLoop());

        const controls = new St.BoxLayout({
            style_class: 'mc-card-controls',
            ...boxOrientation(Clutter.Orientation.HORIZONTAL),
            x_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._prevButton = iconButton('media-skip-backward-symbolic', 'mc-control-button');
        this._backButton = iconButton('media-seek-backward-symbolic', 'mc-control-button mc-seek-button');
        this._playButton = iconButton('media-playback-start-symbolic', 'mc-control-button mc-play-button');
        this._forwardButton = iconButton('media-seek-forward-symbolic', 'mc-control-button mc-seek-button');
        this._nextButton = iconButton('media-skip-forward-symbolic', 'mc-control-button');

        this._prevButton.connect('clicked', () => this._player?.previous());
        this._playButton.connect('clicked', () => this._player?.playPause());
        this._nextButton.connect('clicked', () => this._player?.next());
        this._backButton.connect('clicked', () => this._skip(-1));
        this._forwardButton.connect('clicked', () => this._skip(1));

        controls.add_child(this._prevButton);
        controls.add_child(this._backButton);
        controls.add_child(this._playButton);
        controls.add_child(this._forwardButton);
        controls.add_child(this._nextButton);

        row.add_child(this._shuffleButton);
        row.add_child(controls);
        row.add_child(this._loopButton);
        this._content.add_child(row);
    }

    /* The bottom line of the card, under a hairline: which player this is —
     * and, with more than one running, the way to switch — beside its volume. */
    _buildFooter() {
        this._footer = new St.BoxLayout({
            style_class: 'mc-card-footer',
            ...boxOrientation(Clutter.Orientation.HORIZONTAL),
        });
        this._buildPicker();
        this._buildVolume();
        this._footer.add_child(this._pickerButton);
        this._footer.add_child(this._volumeBox);
        this._content.add_child(this._footer);
    }

    _buildPicker() {
        this._pickerIcon = new St.Icon({
            style_class: 'mc-player-picker-icon',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._pickerLabel = new St.Label({
            style_class: 'mc-player-picker-label',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._pickerLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;

        /* Points the way the list opens — up, since the card ends just below —
         * and turns over while it is open. */
        this._pickerArrow = new St.Icon({
            style_class: 'mc-player-picker-arrow',
            icon_name: 'pan-up-symbolic',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._pickerArrow.set_pivot_point(0.5, 0.5);

        const box = new St.BoxLayout({
            style_class: 'mc-player-picker-box',
            ...boxOrientation(Clutter.Orientation.HORIZONTAL),
        });
        box.add_child(this._pickerIcon);
        box.add_child(this._pickerLabel);
        box.add_child(this._pickerArrow);

        this._pickerButton = new St.Button({
            style_class: 'mc-player-picker',
            can_focus: true,
            y_align: Clutter.ActorAlign.CENTER,
            accessible_name: _('Switch player'),
            child: box,
        });
        this._pickerButton.connect('clicked', () => {
            if (this._playerListOpen) {
                this._closePlayerList();
                return;
            }
            /* Opened from the keyboard, the keyboard goes into the list; opened
             * with the pointer, no row should light up as if focused. */
            const type = Clutter.get_current_event()?.type();
            this._openPlayerList(type === Clutter.EventType.KEY_PRESS ||
                type === Clutter.EventType.KEY_RELEASE);
        });
    }

    _updateFooter() {
        this._footer.visible = this._pickerButton.visible || this._volumeBox.visible;
    }

    /* Over the card rather than in it: the list floats above the controls, so
     * opening it never makes the card taller, nor pushes it off the screen. */
    _buildPlayerList() {
        /* Dims the card behind the list and takes the click that dismisses it,
         * so that click does not also land on a control underneath. */
        this._scrim = new St.Button({
            style_class: 'mc-card-scrim',
            x_expand: true,
            y_expand: true,
            opacity: 0,
            visible: false,
        });
        this._scrim.connect('clicked', () => this._closePlayerList());

        this._playerList = new PlayerList(this._artCache);
        this._playerList.opacity = 0;
        this._playerList.connect('player-selected', (_list, busName) => {
            this._closePlayerList();
            this.emit('player-selected', busName);
        });
        this._playerList.connect('close-requested', () => this._closePlayerList());

        /* Not placed through margins, which St resets from the stylesheet on
         * every style change. The layer is not reactive, so a click beside the
         * list goes through to the scrim. */
        this._listLayer = new ListLayer(this._playerList, () => this._pickerTop());

        this.add_child(this._scrim);
        this.add_child(this._listLayer);
    }

    /* The top of the player button, in the card's coordinates. Read from the
     * allocations, which are current by the time the list's layer asks: the
     * card lays out its content first. */
    _pickerTop() {
        let y = 0;
        for (let actor = this._pickerButton; actor && actor !== this; actor = actor.get_parent())
            y += actor.get_allocation_box().y1;
        return y;
    }

    /** @param {boolean} byKeyboard whether to put the focus on the first row */
    _openPlayerList(byKeyboard) {
        if (this._playerListOpen)
            return;
        this._playerListOpen = true;
        this._focusBeforeList = global.stage.key_focus;

        const list = this._playerList;
        list.open();
        list.remove_all_transitions();
        this._listLayer.show();

        this._scrim.remove_all_transitions();
        this._scrim.show();
        this._scrim.ease({
            opacity: 255,
            duration: LIST_MS,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
        list.translation_y = LIST_SLIDE;
        list.ease({
            opacity: 255,
            translation_y: 0,
            duration: LIST_MS,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
        this._pickerArrow.ease({
            rotation_angle_z: 180,
            duration: LIST_MS,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
        this._pickerButton.checked = true;

        if (byKeyboard)
            list.focusFirst();
        else
            list.grab_key_focus();
    }

    /** @param {boolean} animate false when the card itself is going away */
    _closePlayerList(animate = true) {
        if (!this._playerListOpen)
            return;
        this._playerListOpen = false;

        /* The keyboard goes back where it was, rather than staying in a list
         * that is about to be hidden. */
        const focus = global.stage.key_focus;
        if (focus && this._playerList.contains(focus))
            (this._focusBeforeList ?? this._pickerButton).grab_key_focus();
        this._focusBeforeList = null;

        this._playerList.close();
        this._pickerButton.checked = false;

        const duration = animate ? LIST_MS : 0;
        const mode = Clutter.AnimationMode.EASE_OUT_QUAD;
        this._pickerArrow.ease({rotation_angle_z: 0, duration, mode});
        this._scrim.ease({
            opacity: 0,
            duration,
            mode,
            onComplete: () => this._scrim.hide(),
        });
        this._playerList.ease({
            opacity: 0,
            translation_y: LIST_SLIDE / 2,
            duration,
            mode,
            onComplete: () => this._listLayer.hide(),
        });
    }

    /* The player's own volume, not the system's. MPRIS announces Volume in
     * PropertiesChanged, so unlike the seek bar this needs no polling. */
    _buildVolume() {
        this._volumeBox = new St.BoxLayout({
            style_class: 'mc-volume-box',
            ...boxOrientation(Clutter.Orientation.HORIZONTAL),
            x_expand: true,
        });

        this._volumeIcon = new St.Icon({
            style_class: 'mc-volume-icon',
            icon_name: volumeIconName(1),
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._volumeSlider = new Slider(0);
        this._volumeSlider.add_style_class_name('mc-volume');
        this._volumeSlider.x_expand = true;
        this._volumeSlider.accessible_name = _('Volume');

        /* Drags, scrolls, clicks and arrow keys all land here. Blocked while
         * _syncVolume() moves the slider, so the player's own value is not
         * written straight back to it. */
        this._volumeChangedId = this._volumeSlider.connect('notify::value', () => {
            const volume = this._volumeSlider.value;
            this._player?.setVolume(volume);
            this._volumeIcon.icon_name = volumeIconName(volume);
            this._holdVolume();
        });

        this._volumeBox.add_child(this._volumeIcon);
        this._volumeBox.add_child(this._volumeSlider);
    }

    /* Leave the slider where the user put it until the writes have echoed
     * back, then take the player's word for it — which also puts the slider
     * right if the player clamped or refused the change. */
    _holdVolume() {
        if (this._volumeHoldId)
            GLib.Source.remove(this._volumeHoldId);
        this._volumeHoldId = GLib.timeout_add(GLib.PRIORITY_DEFAULT,
            VOLUME_HOLD_MS, () => {
                this._volumeHoldId = 0;
                this._syncVolume();
                return GLib.SOURCE_REMOVE;
            });
    }

    _syncVolume() {
        const volume = this._player?.volume ?? null;
        if (this._volumeHoldId || volume === null)
            return;
        this._volumeSlider.block_signal_handler(this._volumeChangedId);
        this._volumeSlider.value = volume;
        this._volumeSlider.unblock_signal_handler(this._volumeChangedId);
        this._volumeIcon.icon_name = volumeIconName(volume);
    }

    _toggleShuffle() {
        if (!this._player)
            return;
        this._player.setShuffle(!this._player.shuffle);
        this.sync();
    }

    _cycleLoop() {
        if (!this._player)
            return;
        this._player.setLoopStatus(nextLoopStatus(this._player.loopStatus));
        this.sync();
    }

    /**
     * @param {number} direction -1 to rewind, 1 to skip ahead
     */
    _skip(direction) {
        if (!this._player)
            return;
        this._player.seek(seekOffset(this._settings, direction));

        /* Players that do not emit Seeked would otherwise leave the slider
         * stale until the next poll — and there is no poll while paused. */
        this._refreshPositionSoon();
    }

    _refreshPositionSoon() {
        if (this._seekRefreshId)
            GLib.Source.remove(this._seekRefreshId);
        this._seekRefreshId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => {
            this._seekRefreshId = 0;
            this._refreshPosition();
            return GLib.SOURCE_REMOVE;
        });
    }

    _applyWidth() {
        this.style = `width: ${this._settings.get_int('card-width')}px;`;
    }

    /** @param {number} height the most the card may take up, in stage pixels */
    setMaxHeight(height) {
        this._maxHeight = height;
        this._applyLyricsHeight();
    }

    /* The lyrics are as tall as the setting asks, short of running the card
     * off the screen: they get whatever room the rest of the card leaves. */
    _applyLyricsHeight() {
        const [, card] = this.get_preferred_height(this.width);
        const [, lyrics] = this._lyrics.visible ? this._lyrics.get_preferred_height(-1) : [0, 0];
        this._lyrics.setHeight(this._settings.get_int('lyrics-height'),
            this._maxHeight - (card - lyrics));
    }

    /* The art bin's geometry and its background-image share one `style`
     * property, so both are written together rather than clobbering each other. */
    _applyArtSize() {
        const nick = this._settings.get_string('card-art-size');
        this._artSize = ART_SIZES[nick] ?? ART_SIZES[DEFAULT_ART_SIZE];
        this._artFallback.icon_size = this._artSize.icon;
        this._applyArtStyle();
    }

    _applyArtStyle() {
        const {size, radius} = this._artSize;
        const image = this._artPath
            ? ` background-image: ${cssUrl(this._artPath)};`
            : '';
        const accentBorder = this._accentColor && this._artButton.reactive &&
            (this._artButton.hover || this._artFocused)
            ? ` border-color: ${this._accentColor};` : '';
        const style =
            `width: ${size}px; height: ${size}px; border-radius: ${radius}px;${image}${accentBorder}`;
        if (this._artButton.style !== style)
            this._artButton.set_style(style);
    }

    setPlayer(player) {
        if (this._player === player) {
            this.sync();
            return;
        }

        this._disconnectPlayer();
        this._player = player;

        if (player) {
            this._playerSignals.push(player.connect('changed', () => this.sync()));
            this._playerSignals.push(player.connect('seeked', (_p, position) => {
                this._position = position;
                this._updateSlider();
                this._lyrics.setPosition(position);
            }));
        }

        this._currentArtUrl = null;
        this.sync();
        this._refreshPosition();
    }

    _disconnectPlayer() {
        if (this._player) {
            for (const id of this._playerSignals)
                this._player.disconnect(id);
        }
        this._playerSignals = [];
    }

    /** The card only polls Position while it is actually on screen. */
    setActive(active) {
        this._active = active;
        /* The card opens as it was left, apart from the list. */
        if (!active)
            this._closePlayerList(false);
        this._equalizer.setActive(active);
        this._lyrics.setActive(active);
        this._updateTimer();
        if (active)
            this._refreshPosition();
    }

    /* Polling exists to move the seek bar and timed lyrics. With neither on
     * screen, no polling — every tick is a D-Bus round trip. */
    _updateTimer() {
        const wanted = this._active && this._player?.isPlaying &&
            (this._seekBox.visible || this._lyrics.wantsPosition);

        if (wanted && !this._timeoutId) {
            this._timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT,
                POSITION_POLL_SECONDS, () => {
                    this._refreshPosition();
                    return GLib.SOURCE_CONTINUE;
                });
        } else if (!wanted && this._timeoutId) {
            GLib.Source.remove(this._timeoutId);
            this._timeoutId = 0;
        }
    }

    _refreshPosition() {
        const player = this._player;
        if (!player)
            return;
        player.getPosition().then(position => {
            /* The D-Bus round trip can outlive a drag starting, the player it
             * was issued for, or the card itself (destroy nulls `_player`) — a
             * late answer from the previous track would otherwise be painted
             * onto this one's slider. A failed read keeps the last known
             * position rather than snapping the slider and lyrics to 0. */
            if (position === null || this._dragging || this._player !== player)
                return;
            this._position = position;
            this._updateSlider();
            this._lyrics.setPosition(position);
        });
    }

    _updateSlider() {
        if (this._dragging)
            return;
        const fraction = this._length > 0
            ? Math.min(1, Math.max(0, this._position / this._length))
            : 0;
        this._slider.value = fraction;
        this._updateTimeLabels(this._position);
    }

    _updateTimeLabels(position, length = this._length) {
        this._positionLabel.text = formatTime(position);
        this._remainingLabel.text = `-${formatTime(Math.max(0, length - position))}`;
    }

    /** Drop any painted art and orphan whatever download is in flight. */
    _clearArt() {
        this._artGeneration++;
        this._currentArtUrl = null;
        this._artPath = null;
        this._applyArtStyle();
        this._artFallback.gicon = null;
        this._artFallback.icon_name = 'audio-x-generic-symbolic';
        this._artFallback.opacity = DIM_OPACITY;
        this._artFallback.visible = true;
    }

    /* A real app icon carries its own color and reads as artwork; only the
     * generic symbolic placeholder wants dimming. */
    _setFallbackIcon(player) {
        this._artFallback.gicon = player.appIcon;
        this._artFallback.opacity = player.hasAppIcon ? 255 : DIM_OPACITY;
    }

    _updateArt() {
        const player = this._player;
        const showArt = this._settings.get_boolean('card-show-art');
        this._artButton.visible = showArt;

        /* Forget the current art while hidden, so re-enabling the setting on the
         * same track resolves it again instead of short-circuiting below. */
        if (!showArt || !player) {
            this._clearArt();
            return;
        }

        const url = player.artUrl;
        if (url === this._currentArtUrl) {
            /* The app proxy resolves after the player proxy, so a track with no
             * artwork can still gain a real icon on a later sync. */
            if (this._artFallback.visible)
                this._setFallbackIcon(player);
            return;
        }

        /* Art resolution is async; a newer track must win even if its download
         * finishes first. */
        this._clearArt();
        this._currentArtUrl = url;
        const generation = this._artGeneration;
        this._setFallbackIcon(player);

        if (!url)
            return;

        this._artCache.resolve(url).then(path => {
            if (generation !== this._artGeneration || !path)
                return;
            this._artPath = path;
            this._applyArtStyle();
            this._artFallback.visible = false;
        });
    }

    sync() {
        const player = this._player;

        if (!player) {
            this._titleLabel.text = _('Nothing playing');
            this._artistLabel.text = '';
            this._artistLabel.visible = false;
            this._albumLabel.text = '';
            this._albumLabel.visible = false;
            this._seekBox.visible = false;
            this._setRaisable(false);
            this._backButton.visible = false;
            this._forwardButton.visible = false;
            this._shuffleButton.visible = false;
            this._loopButton.visible = false;
            this._volumeBox.visible = false;
            this._updateFooter();
            this._equalizer.visible = false;
            this._equalizer.setPlaying(false);
            this._lyricsButton.visible = false;
            this._lyrics.update(null);
            this._length = 0;
            this._updateArt();
            this._updateTimer();
            return;
        }

        const title = player.displayTitle || _('Unknown title');
        const artist = player.artist;
        const album = player.album;

        this._titleLabel.text = truncate(title, MAX_TITLE_CHARS);
        const showAlbum = !!album && album !== artist && album !== title;
        this._artistLabel.text = artist || '';
        this._artistLabel.visible = !!artist;
        this._albumLabel.text = showAlbum ? album : '';
        this._albumLabel.visible = showAlbum;

        this._playButton.child.icon_name = playPauseIconName(player);

        this._equalizer.visible = true;
        this._equalizer.setPlaying(player.isPlaying);

        this._setSensitive(this._prevButton, player.canGoPrevious);
        this._setSensitive(this._nextButton, player.canGoNext);
        this._setSensitive(this._playButton, player.canPlay);

        this._setRaisable(player.canRaise, player.displayName);

        this._length = player.length;
        const showSeek = this._settings.get_boolean('card-show-seek-bar') &&
            this._length > 0;
        this._seekBox.visible = showSeek;
        this._setSensitive(this._slider, player.canSeek);

        /* Skipping needs Seek(); a player without it gets no skip buttons. */
        const showSkip = this._settings.get_boolean('card-show-seek-buttons') &&
            player.canSeek;
        this._backButton.visible = showSkip;
        this._forwardButton.visible = showSkip;

        /* Shuffle and loop are optional MPRIS properties; a player that does
         * not implement them gets no button, whatever the setting says. */
        this._shuffleButton.visible =
            this._settings.get_boolean('card-show-shuffle') && player.canShuffle;
        this._loopButton.visible =
            this._settings.get_boolean('card-show-loop') && player.canLoop;
        this._loopButton.child.icon_name = loopIconName(player.loopStatus);
        setToggleStyle(this._shuffleButton, player.shuffle === true, this._accentColor);
        setToggleStyle(this._loopButton,
            player.canLoop && player.loopStatus !== 'None', this._accentColor);

        this._volumeBox.visible =
            this._settings.get_boolean('card-show-volume') && player.canSetVolume;
        this._syncVolume();
        this._updateFooter();

        /* Lyrics are for songs, not browser tabs or films. */
        const showLyrics = this._settings.get_boolean('card-show-lyrics-button') &&
            player.playsMusic;
        this._lyricsButton.visible = showLyrics;
        setToggleStyle(this._lyricsButton, this._lyricsButton.checked, this._accentColor);
        this._lyrics.update(showLyrics ? player : null);

        this._updateArt();
        this._updateSlider();
        this._updateTimer();
        /* A title that wraps onto another line leaves the lyrics less room. */
        if (this._active)
            this._applyLyricsHeight();
    }

    setAccentColor(color) {
        this._accentColor = color;
        this._equalizer.setAccentColor(color);
        this._positionLabel.set_style(`color: ${color};`);
        this._remainingLabel.set_style(`color: ${color};`);
        this._slider.set_style(`-barlevel-active-background-color: ${color};`);
        this._volumeSlider.set_style(`color: ${color}; -barlevel-active-background-color: ${color};`);
        this._playerList.setAccentColor(color);
        this._applyArtStyle();
        this.sync();
    }

    /* Setting `reactive` is enough: St maps it to the `:insensitive` pseudo
     * class, which the theme already styles. */
    _setSensitive(actor, sensitive) {
        setReactive(actor, sensitive);
    }

    /**
     * The artwork only behaves like a button for a player that can actually be
     * raised; for the rest it goes back to being a picture, with no hover cue
     * and nothing to tab to.
     *
     * @param {boolean} raisable whether the player implements Raise
     * @param {string} name names the target for screen readers
     */
    _setRaisable(raisable, name = '') {
        if (this._artButton.reactive !== raisable) {
            this._artButton.can_focus = raisable;
            this._artButton.track_hover = raisable;
            setReactive(this._artButton, raisable);
            syncHover(this._artButton);
        }
        this._artButton.accessible_name = raisable ? name : '';
        this._applyArtStyle();
    }

    _onDestroy() {
        /* Orphans any in-flight art download: its callback checks the
         * generation and finds it stale. */
        this._artGeneration++;

        if (this._timeoutId) {
            GLib.Source.remove(this._timeoutId);
            this._timeoutId = 0;
        }
        if (this._seekRefreshId) {
            GLib.Source.remove(this._seekRefreshId);
            this._seekRefreshId = 0;
        }
        if (this._volumeHoldId) {
            GLib.Source.remove(this._volumeHoldId);
            this._volumeHoldId = 0;
        }
        this._disconnectPlayer();
        for (const id of this._settingsSignals)
            this._settings.disconnect(id);
        this._settingsSignals = [];
        this._player = null;
        this._players = [];
        this._activePlayer = null;
        this._focusBeforeList = null;
    }
});
