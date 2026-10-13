// SPDX-License-Identifier: GPL-2.0-or-later
/* compat.js
 *
 * Differences between the GNOME Shell releases in metadata.json.
 */

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

/**
 * GNOME 48 added St.BoxLayout's `orientation` and deprecated `vertical`, the
 * only one GNOME 47 has; GJS throws on an unknown construct property.
 *
 * @param {Clutter.Orientation} orientation
 * @returns {object} to spread into St.BoxLayout's construct properties
 */
export function boxOrientation(orientation) {
    if (GObject.Object.find_property.call(St.BoxLayout, 'orientation'))
        return {orientation};
    return {vertical: orientation === Clutter.Orientation.VERTICAL};
}
