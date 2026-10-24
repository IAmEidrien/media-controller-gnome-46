// SPDX-License-Identifier: GPL-2.0-or-later
/* updateNotice.js
 *
 * A one-off notification after an update, saying what the new version brings.
 * The release it last announced is kept in `last-announced-version`, so it is
 * shown once — not again at every login or unlock, both of which re-enable the
 * extension.
 */

import GLib from 'gi://GLib';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';

/* The release the notes below describe. Bump both together for a release worth
 * announcing; a release that leaves them alone stays quiet. */
const RELEASE = '3.2';

function releaseNotes() {
    return [
        _('Colors from album art: the card fills with a dark, frosted-glass backdrop blurred from the artwork, and fades to each new track’s colors.'),
        _('It is on by default, in the light and dark style alike, and can be switched off under Card in the preferences.'),
    ].map(line => `• ${line}`).join('\n');
}

/* A banner raised while the shell is still starting up is easily missed. */
const DELAY_SECONDS = 5;

export class UpdateNotice {
    /**
     * @param {object} extension the Extension, for its name and preferences
     * @param {object} settings the extension's Gio.Settings
     */
    constructor(extension, settings) {
        this._extension = extension;
        this._settings = settings;
        this._source = null;
        this._timeoutId = 0;

        if (settings.get_string('last-announced-version') === RELEASE)
            return;

        this._timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT,
            DELAY_SECONDS, () => {
                this._timeoutId = 0;
                this._show();
                return GLib.SOURCE_REMOVE;
            });
    }

    _show() {
        this._settings.set_string('last-announced-version', RELEASE);

        this._source = new MessageTray.Source({
            title: this._extension.metadata.name,
            iconName: 'audio-x-generic-symbolic',
        });
        /* A source destroys itself once its last notification is dismissed. */
        this._source.connect('destroy', () => {
            this._source = null;
        });
        Main.messageTray.add(this._source);

        const notification = new MessageTray.Notification({
            source: this._source,
            title: _('What’s new in %s').format(RELEASE),
            body: releaseNotes(),
        });
        notification.connect('activated', () => this._extension.openPreferences());
        this._source.addNotification(notification);
    }

    destroy() {
        if (this._timeoutId)
            GLib.Source.remove(this._timeoutId);
        this._timeoutId = 0;

        this._source?.destroy();
        this._source = null;
    }
}
