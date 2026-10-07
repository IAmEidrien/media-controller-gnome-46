# Keeping the GNOME 46 fork current

## Automatic upstream merges

The **Sync upstream into GNOME 46 fork** Actions workflow checks upstream `main`
daily at 09:23 UTC. It can also be started with **Actions → Sync upstream into
GNOME 46 fork → Run workflow**. It uses standard Ubuntu 24.04 runners, which
are free for public repositories; no personal access token or paid plan is
needed. If Actions are disabled for the fork, enable them in GitHub's Actions
tab once. The workflow requests `contents: write` for its normal push.

An eligible update is merged with ordinary Git ancestry, preserving the
directly installable repository root and the fork's UUID, GNOME 46 declaration,
settings and added features. Upstream version-only metadata changes receive a
fork version name such as `2.5-gnome46.auto.abcdef0`. The candidate must pass
`make check`, `make pack` and the compatibility guards before it reaches `main`.
Gitpulsar Pull can then update the installed checkout as usual. There is no
force-push or replacement of local personal settings.

Conflicting runtime edits, build/layout changes, new GI/resource imports,
non-version metadata changes, known newer Shell APIs, and failed checks stop
the workflow for maintainer review. Check the failed run's logs and summary.
The fork retains its own README and `.gitignore`; `HUMANS.md`, maintenance
tools, workflows and tests are outside the automatic upstream import set.

This is guarded automatic merging, not automatic porting. Passing tests does
not prove native GNOME rendering or behavior for every player. An upstream
change can still introduce a runtime bug; the normal Git history records the
update so it can be reviewed and reverted. Do not advertise perpetual,
unattended support: GitHub disables public scheduled workflows after 60 days
without repository activity, and schedules may be delayed or dropped.

References: [Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions),
[scheduled workflows](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule),
and [workflow token permissions](https://docs.github.com/en/actions/tutorials/authenticate-with-github_token).

## Optional local update helper

The extension works without this helper. It is for Linux desktops where the
repository itself is installed in GNOME's extension directory and updated with
Gitpulsar or `git pull`. It installs three small **systemd user units**:

- A path unit watches the checkout's Git index and refs.
- A service checks content hashes and compiles changed schema XML.
- A separate notification service offers to load the update, so waiting for a
  notification response never blocks the next compilation.

There is no polling daemon, automatic Git pull, root service, or forced logout.
Only this extension's runtime and schemas are fingerprinted. Documentation-only
updates produce no restart notice. The helper skips an unfinished Git operation,
retries through systemd, and keeps the previous compiled binary if new schema
XML is invalid. Its state lives under
`${XDG_STATE_HOME:-~/.local/state}/media-controller-update/`.

Install it **from the installed checkout**:

```sh
cd ~/.local/share/gnome-shell/extensions/media-controller-gnome-46@eidrien.local
make watch-updates
```

Requirements are Python 3, Git, systemd's user manager and
`glib-compile-schemas` (the usual `libglib2.0-bin` package). For notifications,
install `libnotify-bin` if `notify-send` is absent. `stdbuf` and `gdbus` are
standard coreutils/GLib utilities on the target desktop.

The initial setup compiles and records the current version without a restart
notice. Future runtime updates produce **Media Controller updated**, with a
**Log out…** action. Clicking it opens GNOME's normal confirmation dialog; it
never uses `--force` or `--no-prompt`. The action listener lasts up to five
minutes; afterward the notification becomes informational. Notifications follow
the desktop's normal Do Not Disturb policy.

On Wayland, log out/back in to reload Shell's cached modules. On X11, an
Alt+F2 → `r` Shell restart may also work; the logout action is available on
either session type. This fork's automated checks target GNOME 46, and daily
native testing so far is on Wayland; X11 behavior needs its own desktop test.

To inspect or remove the helper:

```sh
systemctl --user status media-controller-update.path
journalctl --user -u media-controller-update.service
make unwatch-updates
```

Removal deletes only its own user units. The checkout and personal settings are
retained. Run `make watch-updates` again if the checkout is moved, or to refresh
the installed units after helper changes. With no helper, keep using
`make schemas` after schema changes and log out/back in when convenient.

## Theme accents on GNOME 46

GNOME 46's Shell themes use compile-time Sass selection colors, rather than a
shared runtime accent variable. The extension reads the themed slider's
`-barlevel-active-background-color` through `St.ThemeNode.lookup_color()` and
uses it for its equalizer, timestamps, active shuffle/repeat icons and artwork
hover/focus border. The seek bar follows the same color. Missing or invalid
colors fall back to Adwaita blue (`#3584e4`). Theme changes refresh the existing
actors; their icons, artwork geometry and animations are preserved.

For an explicit override, add this to your **Shell theme's CSS**:

```css
.mc-accent-source {
  -media-controller-accent-color: #e01b24;
}
```

This is a property defined by the fork, not a standard GNOME 46 variable. It
takes precedence over the slider color. Themes that already change their slider
accent need no extra rule. Use User Themes to load/reload the Shell theme; on
Wayland, restarting the session is a reliable way to reload edited theme CSS.
Browser `var(--accent-color)` syntax and the newer `-st-accent-color` color value
are not available here. Normal symbolic icons retain the theme's foreground;
only engaged shuffle/repeat icons receive the accent.

References: [GNOME 46 slider theme](https://github.com/GNOME/gnome-shell/blob/46.0/data/theme/gnome-shell-sass/widgets/_slider.scss)
and [GNOME 46 theme-node color lookup](https://github.com/GNOME/gnome-shell/blob/46.0/src/st/st-theme-node.c).
