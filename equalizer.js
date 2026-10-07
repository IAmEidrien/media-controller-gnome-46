// SPDX-License-Identifier: GPL-2.0-or-later
/* equalizer.js
 *
 * A few bars that bob while something is playing. Purely decorative: MPRIS
 * exposes no audio levels, so the heights are invented rather than measured.
 * The point is only to signal "this is playing" at a glance.
 */

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

const BAR_COUNT = 4;

/* The container is BAR_MAX tall, so the bars grow upward from a fixed baseline
 * and the header never reflows as they move. */
const BAR_MIN = 3;
const BAR_MAX = 12;

/* One step per animation frame group; long enough to read as a bounce rather
 * than a flicker, short enough to look alive. */
const STEP_MS = 260;

export const Equalizer = GObject.registerClass(
class Equalizer extends St.BoxLayout {
    _init() {
        super._init({
            style_class: 'mc-equalizer',
            vertical: false,
            /* The widget centres against its neighbours; the bars inside it hang
             * from its bottom edge, the way a level meter reads. */
            y_align: Clutter.ActorAlign.CENTER,
            x_align: Clutter.ActorAlign.END,
        });

        this._active = false;
        this._playing = false;
        this._timeoutId = 0;

        this._bars = [];
        for (let i = 0; i < BAR_COUNT; i++) {
            const bar = new St.Widget({
                style_class: 'mc-eq-bar',
                y_align: Clutter.ActorAlign.END,
                y_expand: true,
                height: BAR_MIN,
            });
            this._bars.push(bar);
            this.add_child(bar);
        }

        this.connect('destroy', () => this._stop());
    }

    /** The card is on screen. */
    setActive(active) {
        if (active === this._active)
            return;
        this._active = active;
        this._update();
    }

    /** The player is actually playing, rather than paused or stopped. */
    setPlaying(playing) {
        if (playing === this._playing)
            return;
        this._playing = playing;
        this._update();
    }

    /* Animating a popup nobody is looking at is wasted compositor work, so the
     * bars only move while the card is open *and* audio is playing. */
    _update() {
        const wanted = this._active && this._playing &&
            St.Settings.get().enable_animations;

        if (wanted && !this._timeoutId) {
            this._step();
            this._timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, STEP_MS, () => {
                this._step();
                return GLib.SOURCE_CONTINUE;
            });
        } else if (!wanted && this._timeoutId) {
            this._stop();
        }
    }

    _step() {
        for (const bar of this._bars) {
            bar.remove_all_transitions();
            bar.ease({
                height: BAR_MIN + Math.random() * (BAR_MAX - BAR_MIN),
                duration: STEP_MS,
                mode: Clutter.AnimationMode.EASE_IN_OUT_SINE,
            });
        }
    }

    /* Settle back to the baseline: a paused player shows a flat meter, which is
     * also what someone with animations switched off sees. */
    _stop() {
        if (this._timeoutId)
            GLib.Source.remove(this._timeoutId);
        this._timeoutId = 0;

        for (const bar of this._bars) {
            bar.remove_all_transitions();
            bar.height = BAR_MIN;
        }
    }
});
