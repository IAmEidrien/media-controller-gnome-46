// SPDX-License-Identifier: GPL-2.0-or-later
/* playerIcons.js
 *
 * Resolves the icon of the application that is playing, and what kind of app
 * it is. A browser shows the browser's own icon, whatever site is in the tab.
 *
 * MPRIS players are unreliable about naming themselves: Spotify's Flatpak
 * reports `DesktopEntry=spotify` while its desktop file is
 * `com.spotify.Client.desktop`, Google Chrome reports no DesktopEntry at all
 * and owns the bus name `org.mpris.MediaPlayer2.chromium`. So each hint the
 * player gives us is tried in turn, and each is looked up three ways before
 * moving on to the next.
 */

import Gio from 'gi://Gio';
import GioUnix from 'gi://GioUnix';
import St from 'gi://St';

/** Desktop ids, icon names and identities disagree on case and punctuation. */
function normalize(text) {
    return text.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/* Identity is a display name, so a player calling itself something this broad
 * must not be fuzzy-matched against the desktop file index — "Music" alone
 * would happily pick the first music app on the system. Such a name is still
 * tried as an exact desktop id and icon name.
 *
 * Normalized on the way in so the comparison is against the same shape the
 * lookup uses: a DesktopEntry of "Music" and an Identity of "Media Player" both
 * have to land in here, and neither matches these words verbatim. */
const GENERIC_NAMES = new Set([
    'music', 'media', 'player', 'media-player', 'audio', 'video', 'sound',
    'browser', 'web', 'stream', 'radio', 'podcast',
].map(normalize));

/** "Google Chrome" -> "google-chrome" */
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

/**
 * Whether a desktop id names the app the player calls `name`, ignoring the
 * vendor prefix: `spotify` matches `com.spotify.Client`, and `chrome` matches
 * `com.google.Chrome`. Only whole runs of dotted segments count, so `foo` does
 * not match `io.gitlab.adhami3310.Footage`.
 */
function idNamesApp(id, wanted) {
    const segments = id.replace(/\.desktop$/, '').split('.').map(normalize);
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

/**
 * Find the desktop files whose id names the app, which is how a Flatpak's
 * reverse-DNS id is reached from the short name the player reports. The id
 * check is what keeps the search from wandering: GNOME's index also matches on
 * Name and Keywords, so a bare word would pull in half the menu.
 */
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

/**
 * @param {object} player
 * @param {string} player.busName bus name the player owns
 * @param {string} player.desktopEntry MPRIS DesktopEntry, often absent
 * @param {string} player.identity MPRIS Identity, a human-readable app name
 * @returns {string[]} the names the player might go by, best first
 */
function candidateNames({busName, desktopEntry, identity}) {
    /* `org.mpris.MediaPlayer2.chromium.instance1234` -> `chromium`, but
     * `org.mpris.MediaPlayer2.io.bassi.Amberol` -> `io.bassi.Amberol`, which is
     * already a desktop id. */
    const busSlug = busName
        .replace(/^org\.mpris\.MediaPlayer2\./, '')
        .replace(/\.instance.*$/i, '');

    /* Identity outranks the bus name because the bus name can belong to another
     * project entirely: Google Chrome identifies as "Chrome" while owning
     * `org.mpris.MediaPlayer2.chromium`, and would otherwise wear Chromium's
     * icon on a machine that has both. */
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

/**
 * @param {object} player the hints candidateNames() takes
 * @returns {Gio.Icon | null} null when nothing better than a generic icon exists
 */
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

/**
 * Classify a player by its desktop file's categories. A browser can be playing
 * anything, and an app declaring Video plays films too, whatever else it
 * declares.
 *
 * @param {object} player the hints candidateNames() takes
 * @returns {string} a PlayerKind
 */
export function resolvePlayerKind(player) {
    const categories = new Set(findApp(player)?.get_categories()?.split(';'));
    if (categories.has('WebBrowser'))
        return PlayerKind.BROWSER;
    if (!categories.has('Video') && !categories.has('TV') &&
        (categories.has('Audio') || categories.has('Music')))
        return PlayerKind.MUSIC;
    return PlayerKind.OTHER;
}
