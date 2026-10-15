// SPDX-License-Identifier: GPL-2.0-or-later
/* GNOME 46 uses the vertical property; keep the shared upstream helper API. */
import Clutter from 'gi://Clutter';

export function boxOrientation(orientation) {
    return {vertical: orientation === Clutter.Orientation.VERTICAL};
}
