// SPDX-License-Identifier: GPL-2.0-or-later
/* backdrop.js: turns album art into the card's backdrop: shrunk, blurred,
 * saturated, then darkened so the card's white text keeps its contrast in the
 * light style too.
 *
 * St cannot blur a background-image, and Clutter clips only to rectangles, so
 * a blur effect would paint square corners past the card's rounded ones. The
 * blur is baked into a small PNG instead, used as a background-image that takes
 * the rounded corners from the stylesheet.
 *
 * Imports only gi:// modules, so it runs outside the shell. */

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GdkPixbuf from 'gi://GdkPixbuf';

import {backdropCacheDir} from './paths.js';

/* Decode size. Nothing finer than a few pixels survives the blur. */
const SIZE = 64;

/* Three box-blur passes approximate a Gaussian about a tenth of the image
 * across. */
const BLUR_RADIUS = 6;
const BLUR_PASSES = 3;

/* Gives back the color the blur averages away. */
const SATURATION = 1.4;

/* Relative luminance the backdrop approaches but never passes, so white text
 * stays readable. The curve is soft: dark areas barely move, bright ones bend,
 * and the backdrop keeps its shading. */
const CEILING = 0.1;

/* Mid grey behind transparent artwork, so it leans neither way. */
const TRANSPARENT_FILL = 0.2;

/* Backdrop files kept on disk; older ones are removed. */
const MAX_FILES = 16;

/* Never removed: the backdrop on screen and the one it fades in over. */
const IN_USE = 2;

/* Fine enough that no two neighbouring 8-bit values are skipped. */
const SRGB_STEPS = 4096;

/* The sRGB transfer curve both ways, as lookup tables: this runs on the
 * shell's main loop, and a pow() per channel per pixel would dominate the
 * cost. Blurring and mixing happen in linear light. */
function buildTables() {
    const toLinear = new Float32Array(256);
    for (let i = 0; i < 256; i++) {
        const c = i / 255;
        toLinear[i] = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    }

    const toSrgb = new Uint8Array(SRGB_STEPS + 1);
    for (let i = 0; i <= SRGB_STEPS; i++) {
        const c = i / SRGB_STEPS;
        const v = c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055;
        toSrgb[i] = Math.round(v * 255);
    }

    return {toLinear, toSrgb};
}

function srgb(toSrgb, c) {
    return toSrgb[Math.round(Math.min(1, Math.max(0, c)) * SRGB_STEPS)];
}

function luminance(r, g, b) {
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/* One box-blur pass along one axis over RGB triplets, as a running sum. Edge
 * pixels repeat, so the borders do not fade toward black. */
function boxBlur(src, dst, width, height, horizontal) {
    const lines = horizontal ? height : width;
    const last = (horizontal ? width : height) - 1;
    const step = horizontal ? 3 : 3 * width;
    const lineStep = horizontal ? 3 * width : 3;
    const span = 2 * BLUR_RADIUS + 1;

    for (let line = 0; line < lines; line++) {
        const start = line * lineStep;
        let r = 0, g = 0, b = 0;
        for (let i = -BLUR_RADIUS; i <= BLUR_RADIUS; i++) {
            const at = start + Math.min(last, Math.max(0, i)) * step;
            r += src[at];
            g += src[at + 1];
            b += src[at + 2];
        }

        for (let i = 0; i <= last; i++) {
            const at = start + i * step;
            dst[at] = r / span;
            dst[at + 1] = g / span;
            dst[at + 2] = b / span;

            const enter = start + Math.min(last, i + BLUR_RADIUS + 1) * step;
            const leave = start + Math.max(0, i - BLUR_RADIUS) * step;
            r += src[enter] - src[leave];
            g += src[enter + 1] - src[leave + 1];
            b += src[enter + 2] - src[leave + 2];
        }
    }
}

/* The art blurred and saturated, as linear RGB in a Float32Array. */
function blurred(pixbuf, {toLinear}) {
    const width = pixbuf.get_width();
    const height = pixbuf.get_height();
    const channels = pixbuf.get_n_channels();
    const stride = pixbuf.get_rowstride();
    const alpha = pixbuf.get_has_alpha();
    const data = pixbuf.get_pixels();

    let pixels = new Float32Array(width * height * 3);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const from = y * stride + x * channels;
            const to = 3 * (y * width + x);
            const opacity = alpha ? data[from + 3] / 255 : 1;
            const fill = (1 - opacity) * TRANSPARENT_FILL;
            pixels[to] = opacity * toLinear[data[from]] + fill;
            pixels[to + 1] = opacity * toLinear[data[from + 1]] + fill;
            pixels[to + 2] = opacity * toLinear[data[from + 2]] + fill;
        }
    }

    let spare = new Float32Array(pixels.length);
    for (let pass = 0; pass < BLUR_PASSES; pass++) {
        boxBlur(pixels, spare, width, height, true);
        boxBlur(spare, pixels, width, height, false);
    }
    spare = null;

    for (let i = 0; i < pixels.length; i += 3) {
        const l = luminance(pixels[i], pixels[i + 1], pixels[i + 2]);
        pixels[i] = Math.min(1, Math.max(0, l + (pixels[i] - l) * SATURATION));
        pixels[i + 1] = Math.min(1, Math.max(0, l + (pixels[i + 1] - l) * SATURATION));
        pixels[i + 2] = Math.min(1, Math.max(0, l + (pixels[i + 2] - l) * SATURATION));
    }

    return {width, height, pixels};
}

/* Darken below CEILING by scaling the light rather than mixing in black, which
 * keeps hue and saturation. Returns 8-bit sRGB and the average border color as
 * CSS (the menu box shows it along the card's rounded corners). */
function render(base, {toSrgb}) {
    const {width, height, pixels} = base;
    const rgb = new Uint8Array(pixels.length);
    let edgeR = 0, edgeG = 0, edgeB = 0, edgeCount = 0;

    for (let y = 0, i = 0; y < height; y++) {
        const edgeRow = y === 0 || y === height - 1;
        for (let x = 0; x < width; x++, i += 3) {
            let r = pixels[i], g = pixels[i + 1], b = pixels[i + 2];
            const l = luminance(r, g, b);

            if (l > 0) {
                const scale = CEILING * (1 - Math.exp(-l / CEILING)) / l;
                r *= scale;
                g *= scale;
                b *= scale;
            }

            rgb[i] = srgb(toSrgb, r);
            rgb[i + 1] = srgb(toSrgb, g);
            rgb[i + 2] = srgb(toSrgb, b);

            if (edgeRow || x === 0 || x === width - 1) {
                edgeR += r;
                edgeG += g;
                edgeB += b;
                edgeCount++;
            }
        }
    }

    const edge = [edgeR, edgeG, edgeB].map(sum => srgb(toSrgb, sum / edgeCount));
    return {rgb, edge: `rgb(${edge.join(', ')})`};
}

export class BackdropMaker {
    constructor() {
        this._cancellable = new Gio.Cancellable();
        this._inUse = [];
        /* Built here, not at module scope, so they go away with the maker when
         * the extension is disabled. */
        this._tables = buildTables();

        this._dir = backdropCacheDir();
        try {
            this._dir.make_directory_with_parents(null);
        } catch (e) {
            if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.EXISTS))
                console.warn(`media-controls: backdrop dir: ${e.message}`);
        }
    }

    /* artPath is a path ArtCache.resolve() returned. Resolves to the
     * backdrop's {path, color}, or null when the art could not be read. */
    async make(artPath) {
        try {
            const base = blurred(await this._decode(artPath), this._tables);
            const {rgb, edge} = render(base, this._tables);
            const pixels = new GLib.Bytes(rgb);
            const name = `${GLib.compute_checksum_for_bytes(GLib.ChecksumType.SHA256, pixels)}.png`;
            const file = this._dir.get_child(name);
            const path = file.get_path();

            /* Named for its content, so the same art is written once. */
            if (!GLib.file_test(path, GLib.FileTest.EXISTS)) {
                const image = GdkPixbuf.Pixbuf.new_from_bytes(pixels,
                    GdkPixbuf.Colorspace.RGB, false, 8,
                    base.width, base.height, base.width * 3);
                /* The fastest compression keeps the main loop's share short;
                 * the file is a few kilobytes at any level. */
                const [, png] = image.save_to_bufferv('png', ['compression'], ['1']);
                await this._write(file, new GLib.Bytes(png));
            }

            this._inUse = [path, ...this._inUse.filter(p => p !== path)].slice(0, IN_USE);
            this._prune();
            return {path, color: edge};
        } catch (e) {
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                console.warn(`media-controls: backdrop failed: ${e.message}`);
            return null;
        }
    }

    /* Decoded at scale, in a GdkPixbuf worker thread. */
    _decode(path) {
        return new Promise((resolve, reject) => {
            Gio.File.new_for_path(path).read_async(GLib.PRIORITY_DEFAULT,
                this._cancellable, (file, result) => {
                    let stream;
                    try {
                        stream = file.read_finish(result);
                    } catch (e) {
                        reject(e);
                        return;
                    }

                    GdkPixbuf.Pixbuf.new_from_stream_at_scale_async(stream,
                        SIZE, SIZE, true, this._cancellable, (_source, decoding) => {
                            try {
                                const pixbuf = GdkPixbuf.Pixbuf.new_from_stream_finish(decoding);
                                resolve(pixbuf.apply_embedded_orientation() ?? pixbuf);
                            } catch (e) {
                                reject(e);
                            } finally {
                                stream.close(null);
                            }
                        });
                });
        });
    }

    _write(file, bytes) {
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

    /* Drop all but the newest files, never the ones in use: a file written
     * long ago and shown again is old by its date. */
    _prune() {
        const attributes = `${Gio.FILE_ATTRIBUTE_STANDARD_NAME},${Gio.FILE_ATTRIBUTE_TIME_MODIFIED}`;
        this._dir.enumerate_children_async(
            attributes, Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_LOW,
            this._cancellable,
            (dir, result) => {
                let enumerator;
                try {
                    enumerator = dir.enumerate_children_finish(result);
                } catch {
                    return;
                }
                enumerator.next_files_async(
                    MAX_FILES * 4, GLib.PRIORITY_LOW, this._cancellable,
                    (source, listing) => {
                        let infos;
                        try {
                            infos = source.next_files_finish(listing);
                        } catch {
                            return;
                        }
                        this._pruneFrom(infos);
                    });
            });
    }

    _pruneFrom(infos) {
        if (infos.length <= MAX_FILES)
            return;

        const mtime = info =>
            info.get_attribute_uint64(Gio.FILE_ATTRIBUTE_TIME_MODIFIED);
        infos.sort((a, b) => Number(mtime(b) - mtime(a)));

        for (const info of infos.slice(MAX_FILES)) {
            const file = this._dir.get_child(info.get_name());
            if (this._inUse.includes(file.get_path()))
                continue;
            file.delete_async(GLib.PRIORITY_LOW, this._cancellable,
                (target, deletion) => {
                    try {
                        target.delete_finish(deletion);
                    } catch {
                        /* Another shell instance got there first. */
                    }
                });
        }
    }

    destroy() {
        this._cancellable.cancel();
        this._inUse = [];
    }
}
