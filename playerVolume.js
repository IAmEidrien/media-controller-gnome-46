// SPDX-License-Identifier: GPL-2.0-or-later
/* Browser card volume follows the app's sound streams because browsers do
 * not expose writable volume over MPRIS. Panel actions stay MPRIS-only. */

import Gvc from 'gi://Gvc';

/* The shortest name allowed to match by prefix, as "vlc" matches VLC's stream
 * "VLC media player (LibVLC 3.0.21)". */
const MIN_PREFIX = 3;

const MPRIS_PREFIX = 'org.mpris.MediaPlayer2.';

function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
}

/* Lowercase letters and digits only, so "Google Chrome" and "google-chrome"
 * agree. */
function appKey(text) {
    return (text ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/* Every name the player goes by: its MPRIS identity, the desktop's name for
 * its app, its desktop entry in full and the last part of a reverse-DNS one
 * (org.mozilla.firefox), and the app in its bus name (firefox.instance_1_23). */
function playerKeys(player) {
    const entry = player.desktopEntry ?? '';
    const busApp = player.busName.replace(MPRIS_PREFIX, '').split('.')[0];
    const names = [player.identity, player.displayName, entry,
        entry.split('.').pop(), busApp];
    return new Set(names.map(appKey).filter(key => key.length > 0));
}

/* A stream carries the name its app gave the sound server, which can run
 * longer than the player's ("VLC media player (LibVLC 3.0.21)") or shorter
 * ("mpv" for "mpv Media Player"), so it may match by prefix. Its icon name
 * must match exactly: it can be as generic as "audio". */
function isPlayerStream(stream, keys) {
    const name = appKey(stream.get_name());
    const icon = appKey(stream.get_icon_name());
    for (const key of keys) {
        if (key === name || key === icon)
            return true;
        if (Math.min(key.length, name.length) >= MIN_PREFIX &&
            (key.startsWith(name) || name.startsWith(key)))
            return true;
    }
    return false;
}

/* As the shell's sound menu sets a stream: silence is muted, not only zero,
 * and any sound unmutes. volume is in the mixer's units. */
function setStreamVolume(stream, volume) {
    const silent = volume < 1;
    const changed = stream.set_volume(silent ? 0 : volume);
    if (silent !== stream.is_muted)
        stream.change_is_muted(silent);
    if (changed)
        stream.push_volume();
}

/* The streams the player plays through: a browser can have one per tab.
 * None until the mixer has connected. */
function findStreams(mixer, player) {
    if (mixer.get_state() !== Gvc.MixerControlState.READY)
        return [];

    const keys = playerKeys(player);
    return mixer.get_sink_inputs().filter(stream =>
        !stream.is_event_stream && !stream.is_virtual &&
        isPlayerStream(stream, keys));
}

/* 0 for silence, 1 for full, and past 1 if amplified in the sound settings. */
function streamLevel(stream, norm) {
    return stream.is_muted ? 0 : stream.volume / norm;
}

/* Each stream moves by the same step, so a browser's tabs keep their balance.
 * The loudest determines the level displayed by the card. */
function moveStreams(mixer, streams, delta, maximum) {
    const norm = mixer.get_vol_max_norm();
    for (const stream of streams) {
        const current = streamLevel(stream, norm);
        const maxLevel = Math.max(maximum, current);
        const level = clamp(current + delta, 0, maxLevel);
        setStreamVolume(stream, Math.round(level * norm));
    }
}

/* One player's sound streams as a single volume, for the card's volume bar on
 * a browser. A browser opens a stream when it starts playing and closes it a
 * while after it stops, so there is a level only while one is open. The last
 * one seen is kept for the bar to show in the meantime. */
export class StreamVolume {
    /* mixer: an open Gvc.MixerControl, which stays the caller's to close.
     * onChanged: called when the level changes, or a stream opens or closes,
     * but not for setPlayer(), whose caller updates anyway. */
    constructor(mixer, onChanged) {
        this._mixer = mixer;
        this._onChanged = onChanged;
        this._player = null;
        /* Keyed by the mixer's stream id: {stream, signals}. */
        this._streams = new Map();
        /* By app, as the sound server keeps one volume per app for its next
         * stream. */
        this._lastLevels = new Map();

        /* 'stream-changed' as well: a stream can be renamed after it opens. */
        this._mixerSignals = ['state-changed', 'stream-added', 'stream-removed',
            'stream-changed'].map(signal =>
            mixer.connect(signal, () => this._match(true)));
    }

    /* The player whose streams to follow, or null for none. Matched again even
     * for the same player, since the names it is matched by can arrive late. */
    setPlayer(player) {
        this._player = player;
        this._match(false);
    }

    /* The loudest stream's level, or null while none is open. */
    get level() {
        const norm = this._mixer.get_vol_max_norm();
        let level = null;
        for (const {stream} of this._streams.values())
            level = Math.max(level ?? 0, streamLevel(stream, norm));
        return level;
    }

    /* The level the player's app last had, or null if none was seen. */
    get lastLevel() {
        return this._player ? this._lastLevels.get(this._appKey()) ?? null : null;
    }

    /* Brings the loudest stream to level, moving the others as far. */
    setLevel(level, maximum = 1) {
        const current = this.level;
        if (current === null || !Number.isFinite(level) ||
            !Number.isFinite(maximum) || maximum < 1)
            return;
        const streams = [...this._streams.values()].map(({stream}) => stream);
        moveStreams(this._mixer, streams, clamp(level, 0, maximum) - current, maximum);
    }

    _appKey() {
        return appKey(this._player.displayName) || this._player.busName;
    }

    _match(notify) {
        const streams = this._player ? findStreams(this._mixer, this._player) : [];
        const ids = new Set(streams.map(stream => stream.id));
        let changed = false;

        for (const [id, {stream, signals}] of this._streams) {
            if (ids.has(id))
                continue;
            for (const signal of signals)
                stream.disconnect(signal);
            this._streams.delete(id);
            changed = true;
        }
        for (const stream of streams) {
            if (this._streams.has(stream.id))
                continue;
            this._streams.set(stream.id, {
                stream,
                signals: [
                    stream.connect('notify::volume', () => this._levelChanged()),
                    stream.connect('notify::is-muted', () => this._levelChanged()),
                ],
            });
            changed = true;
        }

        this._remember();
        if (changed && notify)
            this._onChanged();
    }

    _levelChanged() {
        this._remember();
        this._onChanged();
    }

    _remember() {
        const level = this.level;
        if (level !== null)
            this._lastLevels.set(this._appKey(), level);
    }

    destroy() {
        this._player = null;
        this._match(false);
        for (const signal of this._mixerSignals)
            this._mixer.disconnect(signal);
        this._mixerSignals = [];
    }
}
