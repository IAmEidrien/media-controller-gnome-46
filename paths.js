// SPDX-License-Identifier: GPL-2.0-or-later
/* paths.js: cache locations, shared with prefs.js, which runs in another
 * process and empties the art cache. */

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

export function artCacheDir() {
    return Gio.File.new_for_path(GLib.build_filenamev(
        [GLib.get_user_cache_dir(), 'media-controls', 'art']));
}

export function backdropCacheDir() {
    return Gio.File.new_for_path(GLib.build_filenamev(
        [GLib.get_user_cache_dir(), 'media-controls', 'backdrops']));
}
