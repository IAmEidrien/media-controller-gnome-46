# GNOME 46 compatibility and workflow

The upstream version is 2.4 at `0d7caf2`. Changing `shell-version` alone would
leave these incompatibilities:

| Upstream API | GNOME 46 adaptation |
| --- | --- |
| `St.BoxLayout.orientation` | Use the supported `vertical` boolean in the panel, card, scrolling label and equalizer. |
| `Adw.ButtonRow` (libadwaita 1.6) | Use `Adw.ActionRow` with an activatable `Gtk.Button`, retaining confirmation dialogs. |
| `-st-accent-color` (newer Shell) | Read the Shell theme's native slider fill through `St.ThemeNode`, with an optional CSS override and Adwaita blue fallback. |

`Adw.AlertDialog`, `SwitchRow` and `SpinRow` are available in libadwaita 1.5.
The GioUnix import needs GLib 2.80, which is supplied by Mint 22 / Ubuntu 24.04.
GNOME 46's existing panel event handling and slider drag signals are retained.

API references: [GNOME 46 box layout](https://github.com/GNOME/gnome-shell/blob/46.0/src/st/st-box-layout.c),
[libadwaita ButtonRow introduction](https://github.com/GNOME/libadwaita/blob/1.6.0/src/adw-button-row.c),
[libadwaita 1.5 AlertDialog](https://github.com/GNOME/libadwaita/blob/1.5.0/src/adw-alert-dialog.c),
and [GNOME 46 color parsing](https://github.com/GNOME/gnome-shell/blob/46.0/src/st/st-theme-node.c).

The runtime files were moved from `src/` to the repository root, and install,
packaging and check targets were adjusted. Relative module imports need no
change. The root can now be cloned directly into GNOME's extension directory;
see the README. A separate UUID prevents replacement by the upstream extension.

The schema ID and path are unchanged. Version `2.4-gnome46.2` added panel click
actions and a symbolic-icon preference; `2.4-gnome46.3` added scroll actions.
Version `2.4-gnome46.4` adds theme accents and optional maintenance tools;
it does not change the schema XML. Compile with `make schemas` whenever the
XML changes, and do not commit the compiled binary. JavaScript/CSS-only
updates need no build, but loaded modules require a new Shell session.
The optional `make watch-updates` helper compiles schemas after Git updates;
see [MAINTENANCE.md](MAINTENANCE.md) for setup, upstream syncing and theme overrides.

## Panel conveniences

The panel shortcuts and symbolic-icon approach follow
[Media Controls](https://github.com/cliffniff/media-controls).
The Panel page puts **Actions** immediately after Placement. Left, middle and
right clicks are independently configurable, with the action choices from
Media Controls: nothing, play/pause, play, pause, next/previous, player volume
up/down (5 percentage points, clamped to 0–100%), repeat, shuffle, menu, focus
player, quit player, and preferences. Defaults are left/menu, middle/focus,
right/play-pause. Touch uses the left-click action. Transport buttons retain
their own behavior; extra mouse buttons and releases trigger no shortcuts.
Player actions use the selected player and respect its MPRIS capabilities.

Scroll up and Scroll down appear after the three click selectors, with the
same action choices and defaults of player volume up/down. Scrolling applies
anywhere on the panel indicator, including over transport buttons. Vertical
smooth input accumulates into whole steps, and horizontal input is ignored.
Partial input is cleared when the pointer leaves, direction reverses, the
selected player changes, or preferences change. No additional timers are used.

**Prefer symbolic icons** is directly below Player icon and is disabled when
Player icon is off. It defaults on, using the same `-st-icon-style: symbolic`
lookup as Media Controls. GNOME tries symbolic variants before the original
themed icon, handles icon-theme changes itself, and keeps direct file icons as
files. Turning the setting off restores the originally requested icon. Artwork
and player-switcher icons are unaffected; the panel icon remains fixed at 16px.
See [GNOME 46 icon lookup](https://github.com/GNOME/gnome-shell/blob/46.0/src/st/st-icon-theme.c)
and [texture cache](https://github.com/GNOME/gnome-shell/blob/46.0/src/st/st-texture-cache.c).

## Validation

`make check` checks JavaScript syntax, schema XML, metadata, and constructs the
actual panel/card/preferences code with GNOME 46 compatibility mocks. Those
mocks deliberately omit St.BoxLayout's newer orientation property and
Adw.ButtonRow. They also check click/scroll routing, smooth-scroll accumulation,
capability guards, MPRIS method/property writes, preference bindings, and fixed
artwork sizing. Accent tests cover color lookup, theme listener cleanup,
active mode colors, and artwork geometry across hover/focus changes. Python
tests use real temporary Git histories and schema compilation to exercise
upstream merges and local updates, including conflicts and invalid schema XML.
Native icon-theme lookup, rendering and notifications are not simulated.
`make pack` produces a ZIP with a flat, installable extension root.

This is static and mocked validation. Native GNOME 46 rendering, D-Bus playback,
input handling and monitor scaling need a live desktop check. Start with
Rhythmbox: check a track without cover art, play/pause and next, open the card,
seek, and open every preferences page. Then add a Firefox/VacuumTube player,
switch players, and disable/re-enable the extension. Avoid running the old
Media Controls indicator at the same time.

For the panel shortcuts, check left/menu, right/play-pause, middle/focus on
Rhythmbox and Firefox. Try a different mapping without restarting, and verify
the transport buttons still work. With Papirus, check symbolic player icons,
then turn the preference off and back on. A player without a symbolic variant
should retain its colored icon. Also switch icon themes while the extension is
enabled, and toggle Player icon off to check the dependent preference row.

For the new theme integration, try a red slider accent or the explicit CSS
override, then reload the Shell theme. Check timestamps, equalizer, seek fill,
engaged shuffle/repeat icons, and artwork hover/focus borders. Ordinary player
icons should keep their own style. Test the optional helper on the desktop
after a Pull, including dismissing its notice and opening logout confirmation.
