// SPDX-License-Identifier: GPL-2.0-or-later
/* lyrics.js
 *
 * Finds a track's lyrics in the player's metadata, in an .lrc file beside a
 * local track, or on LRCLIB (lrclib.net). Imports only `gi://` modules, so it
 * can be exercised outside the shell.
 */

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup';

import {US_PER_SECOND} from './transport.js';

const API_URL = 'https://lrclib.net/api';

/* Seconds a recording may be off before its timestamps are not trusted. */
const DURATION_TOLERANCE = 3;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_CACHED = 64;

const TIME_TAGS = /^(?:\[\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?\])+/;
const TIME_TAG = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
const WORD_TAG = /<\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?>/g;
/* A closed list, so headings such as "[Chorus: Someone]" survive. */
const ID_TAG = /^\[(?:ar|al|ti|au|by|la|lang|length|re|tool|ve|version|id|#)\s*:[^\]]*\]$/i;
const OFFSET_TAG = /^\[offset\s*:\s*([+-]?\d+)\s*\]$/i;

const TITLE_NOISE = [
    /\s*[([][^)\]]*\b(?:feat|ft|featuring|official|video|audio|lyrics?|visuali[sz]er|remaster(?:ed)?|explicit|hd|4k)\b[^)\]]*[)\]]/gi,
    /\s+[-–—]\s+[^-–—]*\b(?:remaster(?:ed)?|radio edit|single version|mono|stereo)\b[^-–—]*$/i,
];
/* "Artist - Title", the way a video names a song. */
const VIDEO_TITLE = /^(.+?)\s[-–—]\s(.+)$/;

/**
 * @typedef {object} Lyrics
 * @property {boolean} synced whether every line has a start time
 * @property {boolean} instrumental the track is known to have no words
 * @property {{time: number|null, text: string}[]} lines `time` in microseconds
 */

/* GJS does not promisify GIO async methods, and patching their prototypes
 * would affect the whole shell. */
function asyncCall(object, method, ...args) {
    return new Promise((resolve, reject) => {
        object[`${method}_async`](...args, (source, result) => {
            try {
                resolve(source[`${method}_finish`](result));
            } catch (e) {
                reject(e);
            }
        });
    });
}

function tagTime([, minutes, seconds, fraction = '']) {
    const millis = Number(fraction.padEnd(3, '0'));
    return ((Number(minutes) * 60 + Number(seconds)) * 1000 + millis) * 1000;
}

/**
 * Parse LRC, or plain text when no line is timed.
 *
 * @param {string|null} text
 * @returns {Lyrics|null} null when there are no words
 */
export function parseLyrics(text) {
    if (!text?.trim())
        return null;

    const timed = new Map();
    const plain = [];
    let offset = 0;

    for (const raw of text.split(/\r\n|\r|\n/)) {
        const line = raw.trim();
        const offsetTag = OFFSET_TAG.exec(line);
        if (offsetTag) {
            offset = Number(offsetTag[1]) * 1000;
            continue;
        }
        if (ID_TAG.test(line))
            continue;

        const tags = TIME_TAGS.exec(line)?.[0] ?? '';
        const words = line.slice(tags.length).replace(WORD_TAG, '').trim();
        if (!tags) {
            plain.push(words);
            continue;
        }

        /* Lines that share a time are a lyric and its translation. */
        for (const tag of tags.matchAll(TIME_TAG)) {
            const time = tagTime(tag);
            const previous = timed.get(time);
            timed.set(time, previous ? [previous, words].filter(Boolean).join('\n') : words);
        }
    }

    if (timed.size > 0) {
        const lines = [...timed]
            .map(([time, words]) => ({time: Math.max(0, time - offset), text: words}))
            .sort((a, b) => a.time - b.time);
        return lines.some(line => line.text) ? {synced: true, instrumental: false, lines} : null;
    }

    /* Single blank lines between verses stay; runs and edges go. */
    const lines = [];
    for (const words of plain) {
        if (words || lines.at(-1)?.text)
            lines.push({time: null, text: words});
    }
    if (lines.at(-1)?.text === '')
        lines.pop();
    return lines.length > 0 ? {synced: false, instrumental: false, lines} : null;
}

/* Timed beats plain; between equals, the nearer source wins. */
function preferred(...candidates) {
    return candidates.find(lyrics => lyrics?.synced) ??
        candidates.find(lyrics => lyrics) ?? null;
}

function cleanTitle(title) {
    const clean = TITLE_NOISE.reduce((text, noise) => text.replace(noise, ''), title).trim();
    return clean || title.trim();
}

/* YouTube Music names its auto-generated channels "Artist - Topic". */
function cleanArtist(artist) {
    return artist.replace(/\s+-\s+Topic$/i, '').trim();
}

function normalize(text) {
    return text.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function seconds(length) {
    return Math.round(length / US_PER_SECOND);
}

function isClose(record, duration) {
    return !duration || Math.abs((record.duration ?? 0) - duration) <= DURATION_TOLERANCE;
}

/* Right length first, then right title, then timed. A record with neither the
 * length nor the title is a remix, cover or namesake, and is never taken. */
function pickRecord(records, duration, title) {
    const wanted = normalize(title);
    let best = null;
    let bestScore = 0;
    for (const record of Array.isArray(records) ? records : []) {
        if (!record?.syncedLyrics && !record?.plainLyrics && !record?.instrumental)
            continue;
        const fit = (duration && isClose(record, duration) ? 4 : 0) +
            (normalize(record.trackName ?? '') === wanted ? 2 : 0);
        const score = fit && fit + (record.syncedLyrics ? 1 : 0);
        if (score > bestScore) {
            best = record;
            bestScore = score;
        }
    }
    return best;
}

function fromRecord(record, duration) {
    if (!record)
        return null;
    if (record.instrumental)
        return {synced: false, instrumental: true, lines: []};
    /* Another cut of the song has the same words but not the same timing. */
    return (isClose(record, duration) && parseLyrics(record.syncedLyrics)) ||
        parseLyrics(record.plainLyrics);
}

export class LyricsSource {
    /** @param {string} userAgent LRCLIB asks clients to identify themselves */
    constructor(userAgent) {
        this._session = new Soup.Session({timeout: 15, user_agent: userAgent});
        this._cancellable = new Gio.Cancellable();
        this._cache = new Map();
        this._pending = new Map();
    }

    /**
     * @param {object} track `title`, `artists`, `album`, `length` (µs), `url`
     *   and the player's own `lyrics`
     * @param {boolean} online whether LRCLIB may be asked
     * @returns {Promise<Lyrics|null>} rejects only when LRCLIB failed and
     *   nothing was found locally
     */
    async lookup(track, online) {
        const fromPlayer = parseLyrics(track.lyrics);
        const fromFile = fromPlayer?.synced ? null : await this._readLrcFile(track.url);
        const local = preferred(fromPlayer, fromFile);
        if (local?.synced || !online)
            return local;

        try {
            return preferred(local, await this._remote(track));
        } catch (e) {
            if (local)
                return local;
            throw e;
        }
    }

    /* `song.lrc` beside `song.flac`. */
    async _readLrcFile(url) {
        if (!url?.startsWith('file://'))
            return null;
        const track = Gio.File.new_for_uri(url);
        const file = track.get_parent()?.get_child(
            `${track.get_basename().replace(/\.[^.]*$/, '')}.lrc`);
        if (!file)
            return null;

        try {
            const info = await asyncCall(file, 'query_info',
                Gio.FILE_ATTRIBUTE_STANDARD_SIZE, Gio.FileQueryInfoFlags.NONE,
                GLib.PRIORITY_DEFAULT, this._cancellable);
            if (info.get_size() > MAX_FILE_BYTES)
                return null;
            const [, contents] = await asyncCall(file, 'load_contents', this._cancellable);
            /* Strict UTF-8: garbled text is worse than asking LRCLIB. */
            return parseLyrics(new TextDecoder('utf-8', {fatal: true}).decode(contents));
        } catch {
            return null;
        }
    }

    /* Answers are cached, misses included; failures are not. */
    _remote(track) {
        const key = JSON.stringify(
            [track.title, track.artists, track.album, seconds(track.length)]);

        if (this._cache.has(key)) {
            const lyrics = this._cache.get(key);
            /* Re-inserted: the map's order is the eviction order. */
            this._cache.delete(key);
            this._cache.set(key, lyrics);
            return Promise.resolve(lyrics);
        }

        if (!this._pending.has(key)) {
            this._pending.set(key, this._search(track).then(lyrics => {
                this._cache.set(key, lyrics);
                if (this._cache.size > MAX_CACHED)
                    this._cache.delete(this._cache.keys().next().value);
                return lyrics;
            }).finally(() => this._pending.delete(key)));
        }
        return this._pending.get(key);
    }

    /*
     * The exact match first, which LRCLIB also chases through its upstream
     * sources; then a search of its database; then, for a video-style
     * "Artist - Title", a search by what that names. A failed request does not
     * stop the rest, and fails the lookup only if nothing was found.
     */
    async _search(track) {
        const duration = seconds(track.length);
        const title = cleanTitle(track.title);
        const artist = cleanArtist(track.artists[0] ?? '');

        let failure = null;
        const ask = async (endpoint, params) => {
            try {
                return await this._request(endpoint, params);
            } catch (e) {
                if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                    throw e;
                failure ??= e;
                return null;
            }
        };
        const search = async (name, by) => {
            const records = await ask('search', {track_name: name, artist_name: by});
            return fromRecord(pickRecord(records, duration, name), duration);
        };

        let lyrics = null;
        if (title && artist) {
            lyrics = fromRecord(await ask('get', {
                track_name: track.title,
                artist_name: artist,
                album_name: track.album,
                duration,
            }), duration) ?? await search(title, artist);
        }

        const [, named, song] = title.match(VIDEO_TITLE) ?? [];
        if (!lyrics && named && song)
            lyrics = await search(song.trim(), named.trim());

        if (!lyrics && failure)
            throw failure;
        return lyrics;
    }

    /** @returns {Promise<object|null>} the decoded answer, or null on a 404 */
    async _request(endpoint, params) {
        this._cancellable.set_error_if_cancelled();

        const query = Object.entries(params)
            .filter(([, value]) => value)
            .map(([name, value]) => `${name}=${encodeURIComponent(value)}`)
            .join('&');
        const message = Soup.Message.new('GET', `${API_URL}/${endpoint}?${query}`);
        /* Read whole: unlike artwork, the host is fixed and the answer is text. */
        const bytes = await asyncCall(this._session, 'send_and_read', message,
            GLib.PRIORITY_DEFAULT, this._cancellable);

        const status = message.get_status();
        if (status === Soup.Status.NOT_FOUND)
            return null;
        if (status !== Soup.Status.OK)
            throw new Error(`LRCLIB answered ${status}`);
        return JSON.parse(new TextDecoder().decode(bytes.toArray()));
    }

    destroy() {
        this._cancellable.cancel();
        this._session.abort();
        this._session = null;
        this._pending.clear();
        this._cache.clear();
    }
}
