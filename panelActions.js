// SPDX-License-Identifier: GPL-2.0-or-later
/* Panel shortcuts, following Media Controls' action choices. */

import {nextLoopStatus} from './transport.js';

export const CLICK_ACTIONS = [
    'none', 'play-pause', 'play', 'pause', 'next', 'previous',
    'volume-up', 'volume-down', 'loop', 'shuffle', 'menu', 'raise',
    'quit', 'preferences',
];

/** Act on the selected player, respecting the capabilities it advertises. */
export function activatePanelAction(action, player, ui) {
    if (action === 'menu') {
        ui.toggleMenu();
        return;
    }
    if (action === 'preferences') {
        ui.closeMenu();
        ui.openPreferences();
        return;
    }
    if (!player)
        return;

    /* Raising and quitting belong to the application interface, independently
     * of whether its current track allows playback controls. */
    if (action === 'raise' || action === 'quit') {
        const allowed = action === 'raise' ? player.canRaise : player.canQuit;
        if (allowed) {
            ui.closeMenu();
            player[action]();
        }
        return;
    }
    if (!player.canControl)
        return;

    switch (action) {
    case 'play-pause':
        if (player.isPlaying ? player.canPause : player.canPlay)
            player.playPause();
        break;
    case 'play':
        if (player.canPlay)
            player.play();
        break;
    case 'pause':
        if (player.canPause)
            player.pause();
        break;
    case 'next':
        if (player.canGoNext)
            player.next();
        break;
    case 'previous':
        if (player.canGoPrevious)
            player.previous();
        break;
    case 'volume-up':
    case 'volume-down': {
        const volume = player.volume;
        if (Number.isFinite(volume) && volume >= 0) {
            const step = action === 'volume-up' ? 0.05 : -0.05;
            player.setVolume(Math.max(0, Math.min(1, volume + step)));
        }
        break;
    }
    case 'loop':
        if (player.canLoop) {
            player.setLoopStatus(nextLoopStatus(player.loopStatus));
            ui.refresh();
        }
        break;
    case 'shuffle':
        if (player.canShuffle) {
            player.setShuffle(!player.shuffle);
            ui.refresh();
        }
        break;
    }
}
