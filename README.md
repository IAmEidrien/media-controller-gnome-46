# Media Controller — GNOME 46 fork

Personal GNOME 46 compatibility fork of
[naimur900/media-controller-gnome](https://github.com/naimur900/media-controller-gnome),
based on upstream commit `0d7caf2` (2.4). The formal GitHub fork relationship and
upstream history are retained. This fork has its own UUID and only declares
GNOME 46 support. The upstream release targets GNOME 47–50.

The extension files live at the repository root for direct Gitpulsar updates.
See [GNOME-46.md](GNOME-46.md) for the compatibility changes and validation limits.

A GNOME Shell extension that puts whatever is currently playing into the top
panel, with playback controls and an iOS-style now-playing card.

Works with any player that speaks MPRIS2 — Spotify, Firefox, Chrome, VLC,
Rhythmbox, mpv, and so on.

<p align="center">
  <img src="public/img-1.png" alt="Upstream panel indicator and now-playing card" width="700">
</p>

## Features

- **Panel indicator** showing the player icon, track title and artist, in a
  fixed-width slot so it does not resize as tracks change.
- **Symbolic player icons** in the panel when the icon theme supplies them,
  falling back to the original icon. The preference sits below Player icon.
- **Configurable click actions** for left, middle and right clicks on the
  indicator. Defaults: left opens the menu, middle focuses the selected player,
  right toggles play/pause. The Panel page's Actions group follows Placement;
  playback buttons keep their own actions. Other choices include play, pause,
  next/previous, player volume up/down, repeat, shuffle, quit and preferences.
- **Scrolling text**, on by default: text too wide for that slot loops past it
  carousel-style instead of being ellipsized.
- **Playback controls** in the panel: previous, skip backward, play/pause, skip
  forward, next, plus optional shuffle and loop buttons. Each button can be
  shown or hidden independently.
- **Click the album art** to raise the player's own window. Players that do not
  support being raised leave the artwork as a plain picture.
- **Now-playing card** when you click the indicator: album art, a wrapping title,
  artist and album, a draggable seek bar with elapsed and remaining time, and
  large transport controls including skip buttons — with shuffle on the card's
  left edge and loop on its right, aligned with the controls.
- **Player switching** when more than one player is running: a strip of app icons
  appears in the card's top corner, left of the settings button, and clicking one
  puts that player in the panel. The choice sticks through the noise of a track
  changing, and is released as soon as you press play somewhere else — that player
  takes over. Three icons are shown at most: the player currently on screen, plus
  the most recently opened. With a single player the strip stays hidden and the
  card looks exactly as it always did.
- **One player at a time**: starting playback in one player pauses whichever
  other player was playing, so hitting play in VLC no longer leaves Spotify
  running underneath it. Players already playing when the extension starts are
  left alone, and the whole behavior can be switched off.
- **Shuffle and loop** control the player directly: shuffle toggles on and off,
  loop cycles between off, repeating the whole queue, and repeating one track,
  and an engaged mode lights up in Adwaita blue.
- **Configurable panel position**: far left, left, center, right, or far right.
- Uses Shell media-button and slider styles, with Adwaita blue for custom accent elements.

Skip buttons only appear for players that support seeking; shuffle and loop
only for players that expose them over MPRIS.

## Requirements

- GNOME Shell 46, libadwaita 1.5, and GLib 2.80 (Linux Mint 22 / Ubuntu 24.04)
- A player exposing the MPRIS2 D-Bus interface

## Install with Gitpulsar updates

Disable the older Media Controls extension first so it does not occupy the same
panel role. The fork's UUID is `media-controller-gnome-46@eidrien.local`.

Clone into GNOME's extension directory (the destination must not already exist):

```sh
git clone git@github.com:IAmEidrien/media-controller-gnome-46.git \
  ~/.local/share/gnome-shell/extensions/media-controller-gnome-46@eidrien.local
cd ~/.local/share/gnome-shell/extensions/media-controller-gnome-46@eidrien.local
make schemas
```

Log out and back in on Wayland, then enable the extension in Extension Manager
or run:

```sh
gnome-extensions enable media-controller-gnome-46@eidrien.local
```

Open this checkout in Gitpulsar. For future updates, **Pull**, then log out and
back in. Run `make schemas` after a schema XML change. No full build is needed
for JavaScript or stylesheet updates. Keep personal settings outside Git.

For a separate source checkout, `make install` copies the runtime files. It
refuses to overwrite a Git-managed installation. `make uninstall` also refuses
to delete a Git checkout.

## Development

```sh
make check     # compatibility smoke tests, JS syntax, schema and metadata
make schemas   # compile the GSettings schema
make pack      # build a distributable zip
make logs      # follow this extension's shell log output
make uninstall
```

Note that changes to an already-loaded extension also require a log out and back
in on Wayland, because the shell caches ES modules for the life of the process.

## Settings

<p align="center">
  <img src="public/img-2.png" alt="The preferences window, on the Panel tab, with toggles for the playback controls and track information" width="600">
</p>
<p align="center"><em>The preferences window (<code>make prefs</code>).</em></p>

| Setting                                           | Default         | Description                                             |
| ------------------------------------------------- | --------------- | ------------------------------------------------------- |
| `panel-position`                                  | `left`          | `far-left`, `left`, `center`, `right`, `far-right`      |
| `left-click-action`                               | `menu`          | Open or close the menu                                  |
| `middle-click-action`                             | `raise`         | Focus the selected player's application                 |
| `right-click-action`                              | `play-pause`    | Toggle playback                                         |
| `show-previous` / `show-play-pause` / `show-next` | on              | Panel transport buttons                                 |
| `show-seek-backward` / `show-seek-forward`        | off             | Panel skip buttons                                      |
| `show-shuffle` / `show-loop`                      | off             | Panel shuffle and loop buttons                          |
| `show-player-icon`                                | on              | Application icon in the panel                           |
| `prefer-symbolic-icons`                           | on              | Prefer a symbolic variant; disabled while Player icon is off |
| `show-title` / `show-artist`                      | on / on         | Panel text                                              |
| `panel-text-width`                                | 300             | Width of the panel text, in pixels                      |
| `scroll-text`                                     | on              | Scroll text wider than that, rather than ellipsizing it |
| `scroll-direction`                                | `left-to-right` | `left-to-right` or `right-to-left`                      |
| `scroll-speed`                                    | 30              | Scrolling speed, in pixels per second                   |
| `controls-on-left`                                | off             | Put the buttons before the text                         |
| `hide-when-inactive`                              | on              | Hide the indicator when no player is running            |
| `card-show-art`                                   | on              | Album art in the card                                   |
| `card-show-player-switcher`                       | on              | Icons for switching players, when more than one is running |
| `pause-others-on-play`                            | on              | Starting one player pauses whichever other was playing  |
| `card-show-seek-bar`                              | on              | Seek bar in the card                                    |
| `card-show-seek-buttons`                          | on              | Skip buttons in the card                                |
| `card-show-shuffle` / `card-show-loop`            | on              | Shuffle and loop buttons on the card's edges            |
| `seek-step-seconds`                               | 10              | How far the skip buttons jump, in seconds               |
| `card-width`                                      | 400             | Card width in pixels (400–560)                          |

## Layout

| File                                           | Purpose                                     |
| ---------------------------------------------- | ------------------------------------------- |
| [extension.js](extension.js)           | Panel indicator, menu, panel placement      |
| [panelActions.js](panelActions.js)     | Configurable panel shortcuts and capability checks |
| [mediaCard.js](mediaCard.js)           | The now-playing card                        |
| [scrollingLabel.js](scrollingLabel.js) | The fixed-width panel label and its marquee |
| [mpris.js](mpris.js)                   | MPRIS2 D-Bus client and player tracking     |
| [artCache.js](artCache.js)             | Resolves and caches album art               |
| [prefs.js](prefs.js)                   | Preferences window                          |

`mpris.js` and `artCache.js` deliberately import only `gi://` modules, never
`resource:///org/gnome/shell/…`, so they can be exercised outside the shell.

## License

GPL-2.0-or-later. See [LICENSE](LICENSE).

This is the license required for submission to
[extensions.gnome.org](https://extensions.gnome.org).

## Notes

Album art from streaming players and browsers arrives as an `https://` URL. It is
downloaded once and cached under `~/.cache/media-controls/art/`.

Players that do not report a track length (most web players) simply do not show a
seek bar. `playerctld` is ignored, since it mirrors another player that is
already tracked.
