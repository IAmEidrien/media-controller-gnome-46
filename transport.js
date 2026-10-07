// SPDX-License-Identifier: GPL-2.0-or-later
/* transport.js
 *
 * The bits of playback control the panel indicator and the card both need.
 * They render the same transport buttons against the same player, so the step
 * math, the loop cycle and the icon naming live here rather than in two places.
 *
 * Note that button *sensitivity* is deliberately not shared: the card's buttons
 * carry `message-media-control`, which the shell theme styles for the
 * `:insensitive` state, while the panel's `mc-panel-control` has no such rule
 * and has to dim itself.
 */

/** MPRIS speaks microseconds throughout. */
export const US_PER_SECOND = 1000000;

/**
 * How far a skip button moves, signed.
 *
 * @param {object} settings the extension's Gio.Settings
 * @param {number} direction -1 to rewind, 1 to skip ahead
 * @returns {number} offset in microseconds
 */
export function seekOffset(settings, direction) {
    return direction * settings.get_int('seek-step-seconds') * US_PER_SECOND;
}

/**
 * @param {object} player an MprisPlayer
 * @returns {string} the icon the play/pause button should currently wear
 */
export function playPauseIconName(player) {
    return player.isPlaying
        ? 'media-playback-pause-symbolic'
        : 'media-playback-start-symbolic';
}

/* The MPRIS LoopStatus values, in the order the loop button walks through
 * them: off, repeat the whole queue, repeat the current track. */
const LOOP_CYCLE = ['None', 'Playlist', 'Track'];

/**
 * A non-standard status lands at -1, so the first click turns looping off —
 * the one state that is always safe to ask for.
 *
 * @param {string|null} status the player's current LoopStatus
 * @returns {string} the status the loop button should switch to next
 */
export function nextLoopStatus(status) {
    return LOOP_CYCLE[(LOOP_CYCLE.indexOf(status) + 1) % LOOP_CYCLE.length];
}

/**
 * @param {string|null} status the player's current LoopStatus
 * @returns {string} the icon the loop button should currently wear
 */
export function loopIconName(status) {
    return status === 'Track'
        ? 'media-playlist-repeat-song-symbolic'
        : 'media-playlist-repeat-symbolic';
}

/**
 * Paint a mode button as engaged or not: `.mc-mode-on` colors the icon with
 * the desktop accent color. Guarded because this runs on every sync and a
 * style class change invalidates the whole style cascade under the actor.
 *
 * @param {object} button an St.Button
 * @param {boolean} on whether the button's mode is currently engaged
 */
export function setToggleStyle(button, on) {
    if (on === button.has_style_class_name('mc-mode-on'))
        return;
    if (on)
        button.add_style_class_name('mc-mode-on');
    else
        button.remove_style_class_name('mc-mode-on');
}
