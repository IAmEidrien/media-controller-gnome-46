// SPDX-License-Identifier: GPL-2.0-or-later
/* equalizer.js: decorative bars that bob while something is playing. MPRIS
 * exposes no audio levels, so the heights are random. */

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {boxOrientation} from './compat.js';

const BAR_COUNT = 4;

/* The container is BAR_MAX tall (stylesheet), so the bars grow from a fixed
 * baseline and the header never reflows. */
const BAR_MIN = 3;
const BAR_MAX = 12;

/* The bars jump rather than ease: an ease repaints the card on every frame it
 * runs, which kept the open card at the full frame rate for a decoration. */
const STEP_MS = 260;

export const Equalizer = GObject.registerClass(
class Equalizer extends St.BoxLayout {
    _init() {
        super._init({
            style_class: 'mc-equalizer',
            ...boxOrientation(Clutter.Orientation.HORIZONTAL),
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

    setAccentColor(color) {
        for (const bar of this._bars)
            bar.set_style(`background-color: ${color};`);
    }

    /** The card is on screen. */
    setActive(active) {
        if (active === this._active)
            return;
        this._active = active;
        this._update();
    }

    setPlaying(playing) {
        if (playing === this._playing)
            return;
        this._playing = playing;
        this._update();
    }

    /* Only animate while on screen and playing: anything else is wasted
     * compositor work. */
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

    /* Whole pixels keep the bar edges crisp. */
    _step() {
        for (const bar of this._bars)
            bar.height = Math.round(BAR_MIN + Math.random() * (BAR_MAX - BAR_MIN));
    }

    /* A flat meter: paused, or animations switched off. */
    _stop() {
        if (this._timeoutId)
            GLib.Source.remove(this._timeoutId);
        this._timeoutId = 0;

        for (const bar of this._bars)
            bar.height = BAR_MIN;
    }
});
