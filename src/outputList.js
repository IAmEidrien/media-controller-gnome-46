// SPDX-License-Identifier: GPL-2.0-or-later
/* outputList.js: the list the card's output button opens, one row per sound
 * output, for picking the one the whole system plays through. */

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {CardList} from './cardList.js';
import {boxOrientation} from './compat.js';

/* The line under an output's name. For the computer's own outputs the card's
 * name is the chipset's, which means nothing to most people; for USB and
 * Bluetooth it is the device's own. HDMI outputs already say what they are. */
function detail(output) {
    if (output.kind === 'built-in')
        return _('Built-in');
    return output.kind === 'display' ? '' : output.origin;
}

export const OutputList = GObject.registerClass({
    Signals: {
        /* Carries the picked output's mixer id. */
        'output-selected': {param_types: [GObject.TYPE_UINT]},
    },
}, class OutputList extends CardList {
    _init() {
        super._init(_('Sound Output'));

        this._outputs = [];
        this._activeId = null;
        /* Keyed by mixer id; rebuilt only when outputs come or go. */
        this._rows = new Map();
    }

    /* outputs as from SoundOutputs; does nothing while the list is closed. */
    setOutputs(outputs, activeId) {
        this._outputs = outputs;
        this._activeId = activeId;
        if (this._open)
            this._refresh();
    }

    /* In the mixer's order, which stays put as the default changes, so a row
     * is where it was last time. */
    _refresh() {
        const current = this._outputs.length === this._rows.size &&
            this._outputs.every(output => this._rows.get(output.id)?.output === output);
        if (!current) {
            this._rowsBox.destroy_all_children();
            this._rows.clear();
            for (const output of this._outputs) {
                const row = this._buildRow(output);
                this._rows.set(output.id, row);
                this._rowsBox.add_child(row.button);
            }
        }

        for (const row of this._rows.values())
            this._setRowActive(row, row.output.id === this._activeId);
    }

    _buildRow(output) {
        const tile = new St.Bin({
            style_class: 'mc-output-row-tile',
            y_align: Clutter.ActorAlign.CENTER,
            child: new St.Icon({
                style_class: 'mc-output-row-icon',
                gicon: output.gicon,
            }),
        });

        /* "Headphones" over "Built-in": the output, then where it is. */
        const text = new St.BoxLayout({
            style_class: 'mc-list-row-text',
            ...boxOrientation(Clutter.Orientation.VERTICAL),
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        const title = new St.Label({style_class: 'mc-list-row-title', text: output.name});
        title.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        text.add_child(title);

        const where = detail(output);
        if (where) {
            const subtitle = new St.Label({style_class: 'mc-list-row-subtitle', text: where});
            subtitle.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            text.add_child(subtitle);
        }

        const {button, check} = this._buildRowButton([tile, text]);
        button.accessible_name = [output.name, where].filter(Boolean).join(', ');

        const {id} = output;
        button.connect('clicked', () => this.emit('output-selected', id));

        return {output, button, check};
    }
});
