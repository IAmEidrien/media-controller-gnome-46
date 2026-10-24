// SPDX-License-Identifier: GPL-2.0-or-later
/* playerIcons.js: resolves the playing app's icon, name and kind. A browser
 * shows its own icon, whatever site is in the tab.
 *
 * MPRIS players are unreliable about naming themselves: Spotify's Flatpak
 * reports `DesktopEntry=spotify` while its desktop file is
 * `com.spotify.Client.desktop`, and Google Chrome reports no DesktopEntry and
 * owns the bus name `org.mpris.MediaPlayer2.chromium`. So each hint is tried
 * in turn, each looked up three ways. */

import Gio from 'gi://Gio';
import GioUnix from 'gi://GioUnix';
import St from 'gi://St';

/* Desktop ids, icon names and identities disagree on case and punctuation. */
function normalize(text) {
    return text.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/* Names too broad to fuzzy-match against the desktop file index ("Music"
 * would pick the first music app installed). They are still tried as exact
 * desktop ids and icon names. */
const GENERIC_NAMES = new Set([
    'music', 'media', 'player', 'media-player', 'audio', 'video', 'sound',
    'browser', 'web', 'stream', 'radio', 'podcast',
].map(normalize));

/* "Google Chrome" -> "google-chrome" */
function slugify(text) {
    return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function desktopApp(name) {
    const id = name.endsWith('.desktop') ? name : `${name}.desktop`;
    return GioUnix.DesktopAppInfo.new(id);
}

function desktopIcon(name) {
    return desktopApp(name)?.get_icon() ?? null;
}

function themedIcon(iconTheme, name) {
    return iconTheme.has_icon(name) ? Gio.ThemedIcon.new(name) : null;
}

/* Whether a desktop id names the app, ignoring the vendor prefix: `spotify`
 * matches `com.spotify.Client` and the snap id `spotify_spotify`. Only whole
 * runs of segments count, so `foo` does not match `...Footage`. */
function idNamesApp(id, wanted) {
    const segments = id.replace(/\.desktop$/, '').split(/[._]/).map(normalize);
    for (let start = 0; start < segments.length; start++) {
        let run = '';
        for (let end = start; end < segments.length; end++) {
            run += segments[end];
            if (run === wanted)
                return true;
        }
    }
    return false;
}

/* Reaches a Flatpak's reverse-DNS id from the short name the player reports.
 * GNOME's index also matches Name and Keywords, so the id check is what keeps
 * a bare word from pulling in half the menu. */
function* searchedApps(name) {
    const wanted = normalize(name);
    if (!wanted || GENERIC_NAMES.has(wanted))
        return;

    for (const group of GioUnix.DesktopAppInfo.search(name)) {
        for (const id of group) {
            if (!idNamesApp(id, wanted))
                continue;
            const app = desktopApp(id);
            if (app)
                yield app;
        }
    }
}

function searchedIcon(name) {
    for (const app of searchedApps(name)) {
        const icon = app.get_icon();
        if (icon)
            return icon;
    }
    return null;
}

/* The names a player might go by, best first. */
function candidateNames({busName, desktopEntry, identity}) {
    /* `org.mpris.MediaPlayer2.chromium.instance1234` -> `chromium`;
     * `org.mpris.MediaPlayer2.io.bassi.Amberol` -> `io.bassi.Amberol`. */
    const busSlug = busName
        .replace(/^org\.mpris\.MediaPlayer2\./, '')
        .replace(/\.instance.*$/i, '');

    /* Identity outranks the bus name, which can belong to another project:
     * Chrome owns `...chromium` and would otherwise wear Chromium's icon. */
    return [desktopEntry, slugify(identity ?? ''), busSlug].filter(Boolean);
}

function findApp(player) {
    for (const name of candidateNames(player)) {
        const app = desktopApp(name) ?? searchedApps(name).next().value;
        if (app)
            return app;
    }
    return null;
}

/* null when nothing better than a generic icon exists. */
export function resolvePlayerIcon(player) {
    const iconTheme = new St.IconTheme();
    for (const name of candidateNames(player)) {
        const icon = desktopIcon(name) ??
            themedIcon(iconTheme, name) ??
            searchedIcon(name);
        if (icon)
            return icon;
    }
    return null;
}

export const PlayerKind = Object.freeze({
    MUSIC: 'music',
    BROWSER: 'browser',
    OTHER: 'other',
});

/* The app's kind and its name as the desktop shows it (null without a desktop
 * file). That name beats the player's Identity, which some builds get wrong:
 * Fedora's Firefox reports "Mozilla org.mozilla.firefox". */
export function resolvePlayerApp(player) {
    const app = findApp(player);
    return {kind: kindOf(app), name: app?.get_name() || null};
}

/* A browser can be playing anything, and an app declaring Video plays films
 * too, whatever else it declares. */
function kindOf(app) {
    const categories = new Set(app?.get_categories()?.split(';'));
    if (categories.has('WebBrowser'))
        return PlayerKind.BROWSER;
    if (!categories.has('Video') && !categories.has('TV') &&
        (categories.has('Audio') || categories.has('Music')))
        return PlayerKind.MUSIC;
    return PlayerKind.OTHER;
}
