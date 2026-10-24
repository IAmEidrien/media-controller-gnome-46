// SPDX-License-Identifier: GPL-2.0-or-later
/* transport.js: playback helpers shared by the panel indicator and the card.
 *
 * Button sensitivity is deliberately not shared: the card's buttons carry
 * `message-media-control`, which the theme styles for `:insensitive`, while the
 * panel's `mc-panel-control` has no such rule and dims itself. */

import Clutter from 'gi://Clutter';

/* MPRIS positions and lengths are in microseconds. */
export const US_PER_SECOND = 1000000;

/* Signed skip offset in microseconds; direction is -1 or 1. */
export function seekOffset(settings, direction) {
    return direction * settings.get_int('seek-step-seconds') * US_PER_SECOND;
}

export function playPauseIconName(player) {
    return player.isPlaying
        ? 'media-playback-pause-symbolic'
        : 'media-playback-start-symbolic';
}

/* MPRIS LoopStatus values, in the order the loop button cycles through them. */
const LOOP_CYCLE = ['None', 'Playlist', 'Track'];

/* A non-standard status lands at index -1, so the first click turns looping
 * off, the one state that is always safe to ask for. */
export function nextLoopStatus(status) {
    return LOOP_CYCLE[(LOOP_CYCLE.indexOf(status) + 1) % LOOP_CYCLE.length];
}

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
 * @param {string|null} accentColor resolved Shell theme color, or CSS fallback
 */
export function setToggleStyle(button, on, accentColor = null) {
    if (on !== button.has_style_class_name('mc-mode-on')) {
        if (on)
            button.add_style_class_name('mc-mode-on');
        else
            button.remove_style_class_name('mc-mode-on');
    }
    const style = on && accentColor ? `color: ${accentColor};` : null;
    if (button.child && button.child.style !== style)
        button.child.set_style(style);
}

/* St's hover comes from an enter/leave count that goes stale when a widget
 * turns non-reactive under the pointer, so it is resynced from the pointer. */
export function setReactive(actor, reactive) {
    if (actor.reactive === reactive)
        return;
    actor.reactive = reactive;
    syncHover(actor);
}

export function syncHover(actor) {
    if (!actor.track_hover)
        return;

    let hovered = false;
    if (actor.reactive && actor.mapped) {
        const [x, y] = global.get_pointer();
        const target = global.stage.get_actor_at_pos(Clutter.PickMode.REACTIVE, x, y);
        hovered = !!target && actor.contains(target);
    }
    actor.hover = hovered;
}
