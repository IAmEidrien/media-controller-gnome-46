// SPDX-License-Identifier: GPL-2.0-or-later
/* Based on upstream shellMediaControls.js. GNOME Shell 46 has a MediaSection
 * that recomputes visibility through _shouldShow() whenever players change. */

export class ShellMediaControls {
    constructor(messageList) {
        this._section = messageList?._mediaSection ?? null;
        this._hide = () => false;
    }

    setHidden(hidden) {
        const section = this._section;
        if (typeof section?._sync !== 'function' || typeof section._shouldShow !== 'function')
            return;

        if (hidden && section._shouldShow !== this._hide) {
            this._previous = Object.getOwnPropertyDescriptor(section, '_shouldShow');
            section._shouldShow = this._hide;
        } else if (!hidden && section._shouldShow === this._hide) {
            if (this._previous)
                Object.defineProperty(section, '_shouldShow', this._previous);
            else
                delete section._shouldShow;
            this._previous = null;
        } else {
            return;
        }
        section._sync();
    }

    destroy() {
        this.setHidden(false);
        this._section = null;
        this._previous = null;
    }
}
