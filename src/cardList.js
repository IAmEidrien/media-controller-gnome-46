// SPDX-License-Identifier: GPL-2.0-or-later
/* cardList.js: the sheet a button in the card's footer opens over the card: a
 * title above a column of rows, which scrolls once it outgrows the card. The
 * player list and the output list are built on it. */

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {boxOrientation} from './compat.js';

/* The rest of the card is covered while a list is open, so focus wraps
 * inside the list instead of leaving it. */
const NAVIGATION_KEYS = new Map([
    [Clutter.KEY_Up, St.DirectionType.UP],
    [Clutter.KEY_Down, St.DirectionType.DOWN],
    [Clutter.KEY_Tab, St.DirectionType.TAB_FORWARD],
    [Clutter.KEY_ISO_Left_Tab, St.DirectionType.TAB_BACKWARD],
]);

/* The shell's own helper moved modules between the releases in metadata.json.
 * Rows are direct children of the scrolled box, so their allocation is already
 * in the adjustment's coordinates. */
function scrollIntoView(scrollView, actor) {
    const adjustment = scrollView.vadjustment;
    const {y1, y2} = actor.get_allocation_box();
    if (y1 < adjustment.value)
        adjustment.value = y1;
    else if (y2 > adjustment.value + adjustment.page_size)
        adjustment.value = y2 - adjustment.page_size;
}

export const CardList = GObject.registerClass({
    Signals: {
        /* Escape was pressed inside the list. */
        'close-requested': {},
    },
}, class CardList extends St.BoxLayout {
    _init(title) {
        super._init({
            style_class: 'mc-list',
            ...boxOrientation(Clutter.Orientation.VERTICAL),
            /* A click between rows stays in the list instead of closing it. */
            reactive: true,
        });

        this._open = false;

        this.add_child(new St.Label({
            style_class: 'mc-list-title',
            text: title,
        }));

        this._scrollView = new St.ScrollView({
            style_class: 'mc-list-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
            x_expand: true,
            y_expand: true,
        });
        this._rowsBox = new St.BoxLayout({
            style_class: 'mc-list-rows',
            ...boxOrientation(Clutter.Orientation.VERTICAL),
            x_expand: true,
        });
        this._scrollView.child = this._rowsBox;
        this.add_child(this._scrollView);
    }

    open() {
        this._open = true;
        this._refresh();
        this._scrollView.vadjustment.value = 0;
    }

    close() {
        this._open = false;
    }

    /* Brings the rows up to date as the list opens. */
    _refresh() {
    }

    /* The row marked in use, or the first. */
    focusActive() {
        const rows = this._rowsBox.get_children();
        const row = rows.find(button => button.has_style_class_name('mc-list-row-active'));
        (row ?? rows[0] ?? this).grab_key_focus();
    }

    /* A row button around `children`, followed by the check that marks the
     * row in use. The caller adds the button to `_rowsBox`. */
    _buildRowButton(children) {
        const check = new St.Icon({
            style_class: 'mc-list-row-check',
            icon_name: 'object-select-symbolic',
            y_align: Clutter.ActorAlign.CENTER,
        });

        const box = new St.BoxLayout({
            style_class: 'mc-list-row-box',
            ...boxOrientation(Clutter.Orientation.HORIZONTAL),
            x_expand: true,
        });
        for (const child of [...children, check])
            box.add_child(child);

        const button = new St.Button({
            style_class: 'mc-list-row',
            can_focus: true,
            x_expand: true,
            child: box,
        });
        button.connect('key-focus-in', () => scrollIntoView(this._scrollView, button));

        return {button, check};
    }

    /* Hidden by opacity, not `visible`, so every row keeps room for the check
     * and the titles line up. Guarded: a style class change restyles the
     * whole row. */
    _setRowActive({button, check}, active) {
        check.opacity = active ? 255 : 0;
        if (active === button.has_style_class_name('mc-list-row-active'))
            return;
        if (active)
            button.add_style_class_name('mc-list-row-active');
        else
            button.remove_style_class_name('mc-list-row-active');
    }

    vfunc_key_press_event(event) {
        const key = event.get_key_symbol();
        if (key === Clutter.KEY_Escape) {
            this.emit('close-requested');
            return Clutter.EVENT_STOP;
        }

        /* Opened with the mouse, the list itself holds the focus, and St will
         * not navigate "from" the widget it is navigating within. */
        const direction = NAVIGATION_KEYS.get(key);
        if (direction !== undefined) {
            const focus = global.stage.key_focus;
            this.navigate_focus(focus === this ? null : focus, direction, true);
            return Clutter.EVENT_STOP;
        }
        return super.vfunc_key_press_event(event);
    }
});
