// SPDX-License-Identifier: GPL-2.0-or-later
/* GNOME 46 theme colors, without newer Shell color-variable syntax. */

import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

export const DEFAULT_ACCENT = '#3584e4';

export function resolveAccentColor(node) {
    // An explicit theme override wins; otherwise follow GNOME's slider fill.
    for (const [property, inherit] of [
        ['-media-controller-accent-color', true],
        ['-barlevel-active-background-color', false],
    ]) {
        try {
            const [found, color] = node.lookup_color(property, inherit);
            if (!found || !color)
                continue;
            const channels = [color.red, color.green, color.blue, color.alpha];
            if (!channels.every(value => Number.isFinite(value) && value >= 0 && value <= 255))
                continue;
            return `rgba(${color.red}, ${color.green}, ${color.blue}, ${color.alpha / 255})`;
        } catch {
            // An absent or invalid theme property must not break the indicator.
        }
    }
    return DEFAULT_ACCENT;
}

export class ThemeAccent {
    constructor(onChanged) {
        this._onChanged = onChanged;
        this._context = St.ThemeContext.get_for_stage(global.stage);
        // A hidden, noninteractive theme node: no screen geometry or input grab.
        this._probe = new St.Widget({
            style_class: 'slider mc-accent-source',
            visible: false, reactive: false, can_focus: false,
        });
        Main.uiGroup.add_child(this._probe);
        this._probe.connect('style-changed', () => this._refresh());
        this._contextId = this._context.connect('changed', () => this._refresh());
        this._refresh();
    }

    _refresh() {
        if (this._refreshing || !this._probe)
            return;
        this._refreshing = true;
        try {
            let color = DEFAULT_ACCENT;
            try {
                color = resolveAccentColor(this._probe.get_theme_node());
            } catch {
                // A theme transition may temporarily leave the node unavailable.
            }
            if (color !== this._color) {
                this._color = color;
                this._onChanged(color);
            }
        } finally {
            this._refreshing = false;
        }
    }

    destroy() {
        if (this._contextId)
            this._context.disconnect(this._contextId);
        this._contextId = 0;
        this._probe?.destroy();
        this._probe = null;
        this._onChanged = null;
    }
}
