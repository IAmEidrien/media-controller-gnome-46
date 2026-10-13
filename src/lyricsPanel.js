// SPDX-License-Identifier: GPL-2.0-or-later
/* lyricsPanel.js
 *
 * The card's lyrics. Timed lyrics light up the line being sung and keep it in
 * view; plain lyrics just scroll.
 */

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';

import { boxOrientation } from './compat.js';
import { US_PER_SECOND } from './transport.js';

/* Metadata arrives in pieces; a new track's lookup waits for it to settle. */
const LOOKUP_DELAY_MS = 400;
/* LRCLIB answers 503 while busy and asks to be retried a moment later. */
const MAX_RETRIES = 2;
const RETRY_MS = 5000;

const REVEAL_MS = 200;
const HIGHLIGHT_MS = 200;
const DIM_OPACITY = 90;
const FOLLOW_MS = 450;
/* The current line sits this far down the view, so more upcoming lines show. */
const FOLLOW_FRACTION = 0.3;
const RESUME_FOLLOW_MS = 3000;
const MIN_TICK_MS = 16;
/* An intro this long gets a line of its own, so something is lit. */
const INTRO_US = 3 * US_PER_SECOND;
const BREAK_TEXT = '♪';

function wrap(label) {
    label.clutter_text.line_wrap = true;
    label.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
    label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
}

function fade(line, opacity) {
    line?.actor.ease({
        opacity,
        duration: HIGHLIGHT_MS,
        mode: Clutter.AnimationMode.EASE_OUT_QUAD,
    });
}

/* Everything a lookup depends on. */
function describeTrack(player) {
    const {busName, title, artists, album, length, url, lyrics} = player;
    return {busName, title, artists, album, length, url, lyrics};
}

export const LyricsPanel = GObject.registerClass({
    Signals: {
        'seek-requested': {param_types: [GObject.TYPE_INT64]},
        /* Timed lines appeared or went away, so `wantsPosition` may differ. */
        'timing-changed': {},
    },
}, class LyricsPanel extends St.BoxLayout {
    _init(source, settings) {
        super._init({
            style_class: 'mc-lyrics',
            ...boxOrientation(Clutter.Orientation.VERTICAL),
            x_expand: true,
            visible: false,
        });

        this._source = source;
        this._settings = settings;
        this._player = null;
        this._open = false;
        this._active = false;
        this._timers = new Map();

        this._track = null;
        this._trackKey = null;
        this._generation = 0;
        this._retries = 0;
        this._failed = false;

        this._lines = [];
        this._current = -1;

        /* The position is extrapolated from the last one reported, so lines
         * change on time between polls. Speed is 0 while paused. */
        this._anchor = 0;
        this._anchorTime = 0;
        this._speed = 0;

        this._buildStatus();
        this._buildLines();

        this._settings.connectObject('changed::lyrics-online-lookup', () => {
            this._trackKey = null;
            this._sync(0);
        }, this);
        this.connect('destroy', () => this._onDestroy());
    }

    _buildStatus() {
        this._status = new St.BoxLayout({
            style_class: 'mc-lyrics-status',
            ...boxOrientation(Clutter.Orientation.VERTICAL),
            x_expand: true,
            y_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._status.add_child(new St.Icon({
            style_class: 'mc-lyrics-status-icon',
            icon_name: 'media-view-subtitles-symbolic',
            x_align: Clutter.ActorAlign.CENTER,
        }));
        this._statusLabel = new St.Label({style_class: 'mc-lyrics-status-label'});
        wrap(this._statusLabel);
        this._status.add_child(this._statusLabel);
        this.add_child(this._status);
    }

    _buildLines() {
        this._scrollView = new St.ScrollView({
            style_class: 'mc-lyrics-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.EXTERNAL,
            x_expand: true,
            y_expand: true,
            visible: false,
        });
        this._linesBox = new St.BoxLayout({
            style_class: 'mc-lyrics-lines',
            ...boxOrientation(Clutter.Orientation.VERTICAL),
            x_expand: true,
        });
        this._scrollView.child = this._linesBox;

        this._scrollView.connect('scroll-event', () => {
            this._pauseFollowing();
            return Clutter.EVENT_PROPAGATE;
        });
        /* Line positions are only known after layout, and move on rewrap. */
        this._scrollView.vadjustment.connect('changed', () => this._follow(false));

        this.add_child(this._scrollView);
    }

    /** @param {boolean} open whether the lyrics button is on */
    setOpen(open) {
        if (open === this._open)
            return;
        this._open = open;
        this._reveal(open);

        if (open && this.visible) {
            this.opacity = 0;
            this.translation_y = -8;
            this.ease({
                opacity: 255,
                translation_y: 0,
                duration: REVEAL_MS,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        }
    }

    /** @param {boolean} active whether the card is on screen */
    setActive(active) {
        if (active === this._active)
            return;
        this._active = active;
        this._reveal(active);
    }

    /** @param {object|null} player null when nothing is playing a song */
    update(player) {
        this._player = player;
        if (player)
            this._setSpeed(player.isPlaying ? player.rate : 0);
        this._sync(LOOKUP_DELAY_MS);
    }

    /** @param {number} position in microseconds */
    setPosition(position) {
        this._anchor = position;
        this._anchorTime = GLib.get_monotonic_time();
        this._refreshCurrent();
    }

    get wantsPosition() {
        return this._shown() && this._lines.length > 0;
    }

    _shown() {
        return this._open && this._active && this._player !== null;
    }

    /* A failed lookup is retried when the lyrics are shown again. */
    _reveal(shown) {
        if (shown && this._failed)
            this._trackKey = null;
        this._sync(0);
    }

    _sync(delay) {
        this.visible = this._open && this._player !== null;

        if (!this._shown()) {
            /* A lookup that has not started yet starts over when shown again. */
            if (this._timers.has('lookup'))
                this._trackKey = null;
            this._cancel('lookup');
            this._cancel('tick');
            return;
        }

        const track = describeTrack(this._player);
        const key = JSON.stringify(track);
        if (key === this._trackKey) {
            this._refreshCurrent();
            return;
        }

        this._track = track;
        this._trackKey = key;
        this._generation++;
        this._retries = 0;
        this._failed = false;
        this._showStatus(_('Looking for lyrics…'));
        this._schedule('lookup', delay, () => this._lookup());
    }

    async _lookup() {
        const generation = this._generation;
        const online = this._settings.get_boolean('lyrics-online-lookup');

        let lyrics = null;
        let error = null;
        try {
            lyrics = await this._source.lookup(this._track, online);
        } catch (e) {
            error = e;
        }
        if (generation !== this._generation)
            return;

        if (error && this._retries < MAX_RETRIES && this._shown()) {
            this._retries++;
            this._schedule('lookup', RETRY_MS, () => this._lookup());
        } else if (lyrics?.lines.length > 0) {
            this._showLyrics(lyrics);
        } else if (lyrics?.instrumental) {
            this._showStatus(_('Instrumental'));
        } else if (error) {
            this._failed = true;
            console.warn(`media-controls: lyrics lookup failed: ${error.message}`);
            this._showStatus(_('The lyrics could not be loaded'));
        } else {
            this._showStatus(online
                ? _('No lyrics found for this track')
                : _('No lyrics found. Online lookup is turned off in the settings.'));
        }
    }

    _showStatus(text) {
        this._clearLines();
        this._statusLabel.text = text;
        this._status.visible = true;
        this._scrollView.visible = false;
    }

    _clearLines() {
        const wasTimed = this._lines.length > 0;
        this._cancel('tick');
        this._cancel('resume');
        this._linesBox.destroy_all_children();
        this._lines = [];
        this._current = -1;
        if (wasTimed)
            this.emit('timing-changed');
    }

    _showLyrics(lyrics) {
        this._clearLines();
        this._status.visible = false;
        this._scrollView.visible = true;
        this._scrollView.vadjustment.value = 0;

        if (!lyrics.synced) {
            const label = new St.Label({
                style_class: 'mc-lyrics-plain',
                text: lyrics.lines.map(line => line.text).join('\n'),
            });
            wrap(label);
            this._linesBox.add_child(label);
            return;
        }

        const seekable = this._player?.canSeek ?? false;
        const lines = lyrics.lines[0].time >= INTRO_US
            ? [{time: 0, text: ''}, ...lyrics.lines]
            : lyrics.lines;
        for (const {time, text} of lines) {
            const label = new St.Label({text: text || BREAK_TEXT});
            wrap(label);
            const button = new St.Button({
                style_class: 'mc-lyrics-line',
                child: label,
                x_expand: true,
                reactive: seekable,
                can_focus: false,
                opacity: DIM_OPACITY,
            });
            button.connect('clicked', () => this._seek(time));
            this._linesBox.add_child(button);
            this._lines.push({actor: button, time});
        }

        this._refreshCurrent();
        this.emit('timing-changed');
    }

    _seek(time) {
        this._cancel('resume');
        this.setPosition(time);
        this.emit('seek-requested', time);
    }

    /* Re-anchor before the clock changes speed, so the position does not jump. */
    _setSpeed(speed) {
        if (speed === this._speed)
            return;
        this._anchor = this._position();
        this._anchorTime = GLib.get_monotonic_time();
        this._speed = speed;
    }

    _position() {
        return this._anchor + (GLib.get_monotonic_time() - this._anchorTime) * this._speed;
    }

    /* Light the current line, and wake up when the next one starts. */
    _refreshCurrent() {
        this._cancel('tick');
        if (this._lines.length === 0)
            return;

        const position = this._position();
        const index = this._lines.findLastIndex(line => line.time <= position);
        this._setCurrent(index);

        const next = this._lines[index + 1];
        if (next && this._speed > 0 && this._shown()) {
            const delay = Math.ceil((next.time - position) / this._speed / 1000);
            this._schedule('tick', Math.max(MIN_TICK_MS, delay), () => this._refreshCurrent());
        }
    }

    _setCurrent(index) {
        if (index === this._current)
            return;

        fade(this._lines[this._current], DIM_OPACITY);
        fade(this._lines[index], 255);
        this._current = index;
        this._follow(true);
    }

    _follow(animate) {
        if (this._timers.has('resume') || this._lines.length === 0)
            return;

        const adjustment = this._scrollView.vadjustment;
        const line = this._lines[this._current];
        const top = line
            ? line.actor.get_allocation_box().y1 - adjustment.page_size * FOLLOW_FRACTION
            : 0;
        const target = Math.max(adjustment.lower,
            Math.min(top, adjustment.upper - adjustment.page_size));

        adjustment.remove_transition('value');
        if (animate) {
            adjustment.ease(target, {
                duration: FOLLOW_MS,
                mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            });
        } else {
            adjustment.value = target;
        }
    }

    /* Scrolling by hand takes over from the song for a while. */
    _pauseFollowing() {
        if (this._lines.length === 0)
            return;
        this._scrollView.vadjustment.remove_transition('value');
        this._schedule('resume', RESUME_FOLLOW_MS, () => this._follow(true));
    }

    _schedule(name, ms, callback) {
        this._cancel(name);
        this._timers.set(name, GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            this._timers.delete(name);
            callback();
            return GLib.SOURCE_REMOVE;
        }));
    }

    _cancel(name) {
        const id = this._timers.get(name);
        if (id) {
            GLib.Source.remove(id);
            this._timers.delete(name);
        }
    }

    _onDestroy() {
        /* Orphans a lookup in flight. */
        this._generation++;
        for (const id of this._timers.values())
            GLib.Source.remove(id);
        this._timers.clear();
        this._lines = [];
        this._player = null;
    }
});
