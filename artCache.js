// SPDX-License-Identifier: GPL-2.0-or-later
/* artCache.js
 *
 * Resolves an MPRIS `mpris:artUrl` to a local file path that St can paint as a
 * background-image. Local files pass straight through; remote art (Spotify, web
 * browsers) is downloaded once and cached on disk.
 */

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup';

import {artCacheDir} from './paths.js';

const MAX_ART_BYTES = 8 * 1024 * 1024;
const CHUNK_BYTES = 64 * 1024;

/* Cover art is small and the working set is a handful of tracks; the cap only
 * exists so a long-lived session cannot grow the directory without end. */
const MAX_CACHED_FILES = 128;

export class ArtCache {
    constructor() {
        this._session = new Soup.Session({timeout: 15});
        this._cancellable = new Gio.Cancellable();
        this._pending = new Map();

        this._cacheDir = artCacheDir();
        try {
            this._cacheDir.make_directory_with_parents(null);
        } catch (e) {
            if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.EXISTS))
                console.warn(`media-controls: art cache dir: ${e.message}`);
        }
    }

    /**
     * @param {string} url an artUrl from MPRIS metadata
     * @returns {Promise<string|null>} a local path, or null when unavailable
     */
    async resolve(url) {
        if (!url)
            return null;

        if (url.startsWith('file://')) {
            const file = Gio.File.new_for_uri(url);
            const path = file.get_path();
            return path && GLib.file_test(path, GLib.FileTest.EXISTS) ? path : null;
        }

        if (!url.startsWith('http://') && !url.startsWith('https://'))
            return null;

        const name = GLib.compute_checksum_for_string(GLib.ChecksumType.SHA256, url, -1);
        const target = this._cacheDir.get_child(name);
        const path = target.get_path();

        if (GLib.file_test(path, GLib.FileTest.EXISTS))
            return path;

        /* Two tracks can request the same art before the first fetch lands. */
        if (this._pending.has(url))
            return this._pending.get(url);

        const download = this._download(url, target)
            .finally(() => this._pending.delete(url));
        this._pending.set(url, download);
        return download;
    }

    /* GJS does not promisify GIO-style async methods on its own, and patching
     * the prototypes would affect every consumer in the shell process. */
    _send(message) {
        return new Promise((resolve, reject) => {
            this._session.send_async(
                message, GLib.PRIORITY_DEFAULT, this._cancellable,
                (session, result) => {
                    try {
                        resolve(session.send_finish(result));
                    } catch (e) {
                        reject(e);
                    }
                });
        });
    }

    _readChunk(stream) {
        return new Promise((resolve, reject) => {
            stream.read_bytes_async(
                CHUNK_BYTES, GLib.PRIORITY_DEFAULT, this._cancellable,
                (source, result) => {
                    try {
                        resolve(source.read_bytes_finish(result));
                    } catch (e) {
                        reject(e);
                    }
                });
        });
    }

    /**
     * Read the body a chunk at a time, giving up the moment it exceeds the cap.
     * `send_and_read_async` would buffer the whole response first, so a hostile
     * or misconfigured server could spike the compositor's memory before the
     * size was ever looked at — and `artUrl` comes from whatever the player says.
     *
     * @returns {Promise<GLib.Bytes|null>} null when empty or over the cap
     */
    async _readBounded(stream) {
        const chunks = [];
        let total = 0;

        for (;;) {
            const chunk = await this._readChunk(stream);
            const size = chunk.get_size();
            if (size === 0)
                break;

            total += size;
            if (total > MAX_ART_BYTES)
                return null;
            chunks.push(chunk.toArray());
        }

        if (total === 0)
            return null;

        const data = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
            data.set(chunk, offset);
            offset += chunk.length;
        }
        return new GLib.Bytes(data);
    }

    /* Drop the least recently modified files once the directory outgrows the
     * cap. Runs only after a fresh download, so it is off the UI path. */
    _prune() {
        const attributes = `${Gio.FILE_ATTRIBUTE_STANDARD_NAME},${Gio.FILE_ATTRIBUTE_TIME_MODIFIED}`;
        this._cacheDir.enumerate_children_async(
            attributes, Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_LOW,
            this._cancellable,
            (dir, result) => {
                let enumerator;
                try {
                    enumerator = dir.enumerate_children_finish(result);
                } catch {
                    return;
                }
                this._pruneFrom(enumerator);
            });
    }

    _pruneFrom(enumerator) {
        enumerator.next_files_async(
            MAX_CACHED_FILES * 4, GLib.PRIORITY_LOW, this._cancellable,
            (source, result) => {
                let infos;
                try {
                    infos = source.next_files_finish(result);
                } catch {
                    return;
                }
                if (infos.length <= MAX_CACHED_FILES)
                    return;

                const mtime = info =>
                    info.get_attribute_uint64(Gio.FILE_ATTRIBUTE_TIME_MODIFIED);
                infos.sort((a, b) => Number(mtime(b) - mtime(a)));

                for (const info of infos.slice(MAX_CACHED_FILES)) {
                    this._cacheDir.get_child(info.get_name()).delete_async(
                        GLib.PRIORITY_LOW, this._cancellable,
                        (file, deletion) => {
                            try {
                                file.delete_finish(deletion);
                            } catch {
                                /* Another shell instance got there first. */
                            }
                        });
                }
            });
    }

    _writeBytes(file, bytes) {
        return new Promise((resolve, reject) => {
            file.replace_contents_bytes_async(
                bytes, null, false, Gio.FileCreateFlags.REPLACE_DESTINATION,
                this._cancellable,
                (target, result) => {
                    try {
                        target.replace_contents_finish(result);
                        resolve();
                    } catch (e) {
                        reject(e);
                    }
                });
        });
    }

    async _download(url, target) {
        try {
            const message = Soup.Message.new('GET', url);
            const stream = await this._send(message);

            if (message.get_status() !== Soup.Status.OK) {
                stream.close(null);
                return null;
            }

            /* A declared length rejects the obvious case without transferring a
             * byte; a server that lies, or answers chunked, is still bounded by
             * the running total in _readBounded(). */
            const declared = message.get_response_headers().get_content_length();
            if (declared > MAX_ART_BYTES) {
                stream.close(null);
                return null;
            }

            const bytes = await this._readBounded(stream);
            stream.close(null);
            if (!bytes)
                return null;

            await this._writeBytes(target, bytes);
            this._prune();
            return target.get_path();
        } catch (e) {
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                console.warn(`media-controls: art download failed: ${e.message}`);
            return null;
        }
    }

    destroy() {
        this._cancellable.cancel();
        this._pending.clear();
        this._session.abort();
        this._session = null;
    }
}
