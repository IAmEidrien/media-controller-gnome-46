# Media Controller: GNOME 46 public fork

This is a compatibility and convenience fork of `naimur900/media-controller-gnome`,
based on upstream `0d7caf289ade7d3ee109c38d5d259bc50f4ef2a3` (2.4). Preserve
upstream ancestry, copyright notices, and the GPL-2.0-or-later license.

The target is Linux Mint 22 / GNOME Shell 46 on Wayland, with GLib 2.80 and
libadwaita 1.5. Do not widen the support declaration or claim native runtime
testing from syntax checks or mocked constructors.

- Keep UUID `media-controller-gnome-46@eidrien.local`, schema ID/path
  `org.gnome.shell.extensions.media-controller`, and gettext domain
  `media-controller` stable. No personal GSettings values in the repository.
- The repository root is directly installable. Keep runtime JS, metadata,
  stylesheet, and schema XML at the root, and the Makefile's package manifest
  complete. Do not commit `schemas/gschemas.compiled` or build ZIPs.
- Shell 46 box layouts use `vertical`; `orientation` is not an St.BoxLayout
  property there. Preferences must work without Adw.ButtonRow (introduced 1.6).
  Shell 46 cannot resolve `-st-accent-color`.
- Theme accents use the standard slider fill through St.ThemeNode color lookup,
  with an optional `-media-controller-accent-color` override and blue fallback.
  Preserve theme listener cleanup, artwork styles/sizing, and neutral icons.
- Preserve fixed icon/artwork sizing, MPRIS capabilities, player selection,
  seek behavior, timer/signal cleanup, and cancellation of artwork downloads.
- Panel shortcuts apply to the selected player and must not intercept transport
  controls. Player-volume shortcuts affect MPRIS Volume, not system volume.
  Keep the Actions group after Placement in the Panel preferences.
- Prefer symbolic icons through Shell's icon-theme lookup, preserving the
  original GIcon as fallback. Keep this preference panel-only, immediately
  below Player icon, and disable its row while Player icon is off.
- Gitpulsar Pull updates the installed checkout. Use ordinary fast-forward
  commits on shared main; never force-push. Installation/uninstallation helpers
  must not remove a Git-managed extension checkout.
- The optional tools/update_helper.py installs only systemd user units. It must
  never pull Git, force a logout, overwrite a valid schema on compilation failure,
  or block new schema compilations while a notification waits for a response.
- Upstream automation must use normal merges/pushes, preserve the root layout,
  require compatibility/check/package gates, and stop for conflicts or new
  platform APIs. Do not describe mocked validation as native runtime coverage.
- HUMANS.md is exclusively Eidrien's writing. Do not draft, paraphrase, polish
  or edit its prose unless Eidrien supplies exact text and requests insertion.
  Keep public AI disclosure and technical maintenance information in README.md.

Run `make check`, `make pack`, and `git diff --check` for relevant changes.
`make check` uses Node compatibility mocks, not a running GNOME Shell. A live
Wayland check should cover Rhythmbox, a browser player, switching players,
transport controls, seeking, preferences, and disable/re-enable.
