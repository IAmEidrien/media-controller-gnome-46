// SPDX-License-Identifier: GPL-2.0-or-later
/* paths.js
 *
 * Shared on-disk locations. The extension writes the art cache and the
 * preferences window empties it, from a different process — so the path has to
 * be derived in one place rather than spelled out in both.
 */

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

/** @returns {Gio.File} the directory downloaded album art is cached in */
export function artCacheDir() {
    return Gio.File.new_for_path(GLib.build_filenamev(
        [GLib.get_user_cache_dir(), 'media-controls', 'art']));
}
