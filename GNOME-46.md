# GNOME 46 compatibility and workflow

The upstream version is 2.5 at `0c72652`. Changing `shell-version` alone would
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
it does not change the schema XML. Version `2.4-gnome46.5` adds looping player
selection actions and configurable mouse Back/Forward bindings, with defaults
of Previous/Next player. This version changes the schema XML. Compile with `make schemas` whenever the
XML changes, and do not commit the compiled binary. JavaScript/CSS-only
updates need no build, but loaded modules require a new Shell session.
The optional `make watch-updates` helper compiles schemas after Git updates;
see [MAINTENANCE.md](MAINTENANCE.md) for setup, upstream syncing and theme overrides.

## Upstream 2.5 integration

Version `2.5-gnome46.1` merges upstream 2.5 with its ancestry intact. It includes
lyrics (metadata, adjacent LRC files, and optional LRCLIB lookup), live-stream
length/seek handling, hover-state repairs, scrolling-title fixes, and the
release notification. The lyrics toggle uses the fork's theme accent lookup.
The new layout helper deliberately returns GNOME 46's `vertical` property.
The new icon is included in ZIPs, copied installs and update fingerprints.
Online lyrics lookup remains off by default. This release adds schema keys:
run `make schemas` after Pull unless the optional update helper handles it.

The automated sync stopped for manual review of upstream Makefile and icon
changes. This merge retains those guards; subsequent syncs recognize 2.5 as
already merged rather than retrying its structural changes.

## Panel conveniences

The panel shortcuts and symbolic-icon approach follow
[Media Controls](https://github.com/cliffniff/media-controls).
The Panel page puts **Actions** immediately after Placement. Left, middle and
right clicks are independently configurable, with the action choices from
Media Controls: nothing, play/pause, play, pause, next/previous, player volume
up/down (5 percentage points, clamped to 0–100%), repeat, shuffle, menu, focus
player, quit player, and preferences. Defaults are left/menu, middle/focus,
right/play-pause. Touch uses the left-click action. Transport buttons retain
their own behavior. Back (button 8) and Forward (button 9) use their configured
actions on the icon/track-information area; other extra buttons and releases
trigger no shortcuts.
Player actions use the selected player and respect its MPRIS capabilities.

Previous player and Next player use the same ready-player roster and selection
policy as the menu, wrapping in both directions. Paused players remain eligible;
cycling never changes playback or opens/closes the menu. With fewer than two
ready players, it does nothing. Switching is independent of the current player's
playback capabilities. Existing action enum values are preserved; the two new
values are appended.

Scroll up and Scroll down appear after the five click selectors, with the
same action choices and defaults of player volume up/down. Scrolling applies
anywhere on the panel indicator, including over transport buttons. Vertical
smooth input accumulates into whole steps, and horizontal input is ignored.
Partial input is cleared when the pointer leaves, direction reverses, the
selected player changes externally, or preferences change. Cycling through a
scroll action preserves the ongoing gesture's fractional remainder across its
own player selections. No additional timers are used.

This update also ports upstream's pause acknowledgement fix from
[`df2b44f`](https://github.com/naimur900/media-controller-gnome/commit/df2b44f5260d189235077eb46263a49fa5e27f6e).
When Pause is still in flight, browser metadata changes must not be interpreted
as playback starting again. The manager waits for the player's reported Paused
status instead of setting its status bookkeeping optimistically. That fix is
now included through the complete upstream 2.5 merge.

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

Check Back/Forward with at least two players, including a paused one: cycle in
both directions and across the endpoints, then play/pause and adjust the newly
selected player's volume. Try cycling from a middle-click or scroll binding;
check smooth input, live remapping, a player exiting and the zero/one-player
cases. With pause-others enabled, start music while a browser is playing and
verify that late browser updates do not pause the newly started music.

For the new theme integration, try a red slider accent or the explicit CSS
override, then reload the Shell theme. Check timestamps, equalizer, seek fill,
engaged shuffle/repeat icons, and artwork hover/focus borders. Ordinary player
icons should keep their own style. Test the optional helper on the desktop
after a Pull, including dismissing its notice and opening logout confirmation.

For 2.5, also open lyrics on a music player, test plain and timed local lyrics,
click a timed line, switch tracks while a lookup is pending, and close/reopen
the card. Enable online lookup only if wanted. A browser/live stream should
not acquire a lyrics button or bogus seek duration. Check that completed
one-pass title scrolling does not restart on hover and that hover highlights
clear after a control becomes insensitive. The release notice should appear
once, and clicking it should open preferences.
