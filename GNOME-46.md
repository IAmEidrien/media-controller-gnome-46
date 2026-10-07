# GNOME 46 compatibility and workflow

The upstream version is 2.4 at `0d7caf2`. Changing `shell-version` alone would
leave these incompatibilities:

| Upstream API | GNOME 46 adaptation |
| --- | --- |
| `St.BoxLayout.orientation` | Use the supported `vertical` boolean in the panel, card, scrolling label and equalizer. |
| `Adw.ButtonRow` (libadwaita 1.6) | Use `Adw.ActionRow` with an activatable `Gtk.Button`, retaining confirmation dialogs. |
| `-st-accent-color` (newer Shell) | Use Adwaita blue `#3584e4` for the extension's custom accent elements. The seek slider still follows the Shell theme. |

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

The GSettings schema is unchanged. Compile it once after cloning, then compile
again only when its XML changes. Do not commit the compiled binary. Pulling
JavaScript/CSS updates needs no build; restart the Wayland session to reload.

## Validation

`make check` checks JavaScript syntax, schema XML, metadata, and constructs the
actual panel/card/preferences code with GNOME 46 compatibility mocks. Those
mocks deliberately omit St.BoxLayout's newer orientation property and
Adw.ButtonRow. It also checks playback-button routing and fixed artwork sizing.
`make pack` produces a ZIP with a flat, installable extension root.

This is static and mocked validation. Native GNOME 46 rendering, D-Bus playback,
input handling and monitor scaling need a live desktop check. Start with
Rhythmbox: check a track without cover art, play/pause and next, open the card,
seek, and open every preferences page. Then add a Firefox/VacuumTube player,
switch players, and disable/re-enable the extension. Avoid running the old
Media Controls indicator at the same time.
