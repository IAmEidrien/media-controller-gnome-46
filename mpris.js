// SPDX-License-Identifier: GPL-2.0-or-later
/* mpris.js: tracks every MPRIS2 player on the session bus and picks one
 * "active" player for the UI to render. */

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';

import {PlayerKind, resolvePlayerApp, resolvePlayerIcon} from './playerIcons.js';

const GENERIC_ICON = 'audio-x-generic-symbolic';

const MPRIS_PATH = '/org/mpris/MediaPlayer2';
const MPRIS_PREFIX = 'org.mpris.MediaPlayer2.';
const PLAYER_IFACE = 'org.mpris.MediaPlayer2.Player';
const PROPS_IFACE = 'org.freedesktop.DBus.Properties';

/* playerctld mirrors the active player and would show up as a duplicate. */
const IGNORED_BUS_NAMES = ['org.mpris.MediaPlayer2.playerctld'];

/* Browsers report a live stream's length as INT64_MAX µs or close to it;
 * nothing a year or longer is a real track. */
const MAX_TRACK_LENGTH = 365 * 24 * 3600 * 1000000;

const DBusIface = `
<node>
  <interface name="org.freedesktop.DBus">
    <method name="ListNames">
      <arg type="as" direction="out" name="names"/>
    </method>
    <signal name="NameOwnerChanged">
      <arg type="s" name="name"/>
      <arg type="s" name="oldOwner"/>
      <arg type="s" name="newOwner"/>
    </signal>
  </interface>
</node>`;

const MprisIface = `
<node>
  <interface name="org.mpris.MediaPlayer2">
    <method name="Raise"/>
    <method name="Quit"/>
    <property name="Identity" type="s" access="read"/>
    <property name="DesktopEntry" type="s" access="read"/>
    <property name="CanRaise" type="b" access="read"/>
    <property name="CanQuit" type="b" access="read"/>
  </interface>
</node>`;

const PlayerIface = `
<node>
  <interface name="org.mpris.MediaPlayer2.Player">
    <method name="PlayPause"/>
    <method name="Play"/>
    <method name="Pause"/>
    <method name="Stop"/>
    <method name="Next"/>
    <method name="Previous"/>
    <method name="Seek">
      <arg type="x" direction="in" name="offset"/>
    </method>
    <method name="SetPosition">
      <arg type="o" direction="in" name="trackId"/>
      <arg type="x" direction="in" name="position"/>
    </method>
    <property name="PlaybackStatus" type="s" access="read"/>
    <property name="LoopStatus" type="s" access="readwrite"/>
    <property name="Shuffle" type="b" access="readwrite"/>
    <property name="Metadata" type="a{sv}" access="read"/>
    <property name="Position" type="x" access="read"/>
    <property name="Volume" type="d" access="readwrite"/>
    <property name="CanControl" type="b" access="read"/>
    <property name="Rate" type="d" access="read"/>
    <property name="CanPlay" type="b" access="read"/>
    <property name="CanPause" type="b" access="read"/>
    <property name="CanGoNext" type="b" access="read"/>
    <property name="CanGoPrevious" type="b" access="read"/>
    <property name="CanSeek" type="b" access="read"/>
    <signal name="Seeked">
      <arg type="x" name="position"/>
    </signal>
  </interface>
</node>`;

/* Unwrap a value from an a{sv} without assuming its type. */
function unwrap(variant) {
    if (!variant)
        return null;
    try {
        return variant.deep_unpack();
    } catch {
        return null;
    }
}

/* MPRIS metadata is famously inconsistent; coerce whatever comes to a string. */
function asString(value) {
    if (value === null || value === undefined)
        return '';
    if (Array.isArray(value))
        return value.filter(v => typeof v === 'string' && v).join(', ');
    if (typeof value === 'string')
        return value;
    return String(value);
}

function asNumber(value) {
    if (typeof value === 'bigint')
        return Number(value);
    if (typeof value === 'number')
        return value;
    return 0;
}

/* For a player with no desktop file to take a name from. Some put an app id
 * where a name belongs ("Mozilla org.mozilla.firefox"); its last part is the
 * best name on offer. Only runs of three or more letter-led parts count as an
 * id, so version numbers and short dotted names are left alone. */
function tidyIdentity(identity) {
    return identity.replace(/\b[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9_-]*){2,}\b/gi, id => {
        const last = id.slice(id.lastIndexOf('.') + 1);
        return last.charAt(0).toUpperCase() + last.slice(1);
    });
}

/* A title for a local file sent without one (VLC sends only the URL for an
 * untagged file): its name without the extension. Streams give nothing. */
function titleFromUrl(url) {
    if (!url.startsWith('file://'))
        return '';
    const name = Gio.File.new_for_uri(url).get_basename() ?? '';
    return name.replace(/\.[a-z0-9]{1,5}$/i, '');
}

/* `song.flac` but not `film.mkv`, by the name alone. */
function isAudioFile(url) {
    return url.startsWith('file://') &&
        Gio.content_type_is_a(Gio.content_type_guess(url, null)[0], 'audio/*');
}

/* Any D-Bus call can race the player leaving the bus. One helper keeps the
 * warnings consistent and sparse, as the EGO review guidelines ask. */
function logError(context, error) {
    console.warn(`media-controls: ${context}: ${error.message}`);
}

export const MprisPlayer = GObject.registerClass({
    Signals: {
        'changed': {},
        'seeked': {param_types: [GObject.TYPE_INT64]},
    },
}, class MprisPlayer extends GObject.Object {
    _init(busName) {
        super._init();

        this.busName = busName;
        this._cancellable = new Gio.Cancellable();
        this._app = null;
        this._genericIcon = null;
        this._metadata = null;

        this._playerProxy = null;
        this._appProxy = null;
        this._propsChangedId = 0;
        this._seekedId = 0;

        /* Built here, not at module scope: modules stay loaded across
         * disable/enable, so nothing GObject-related may be created at import
         * time. */
        const PlayerProxy = Gio.DBusProxy.makeProxyWrapper(PlayerIface);
        const MprisProxy = Gio.DBusProxy.makeProxyWrapper(MprisIface);

        new PlayerProxy(Gio.DBus.session, busName, MPRIS_PATH, (proxy, error) => {
            if (error) {
                /* CANCELLED: destroy() ran while the init was in flight. */
                if (!error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                    logError(`player proxy for ${busName}`, error);
                return;
            }
            this._playerProxy = proxy;
            this._propsChangedId = proxy.connect('g-properties-changed', () => {
                this._metadata = null;
                this.emit('changed');
            });
            this._seekedId = proxy.connectSignal('Seeked',
                (_p, _sender, [position]) => this.emit('seeked', asNumber(position)));
            this.emit('changed');
        }, this._cancellable, Gio.DBusProxyFlags.NONE);

        new MprisProxy(Gio.DBus.session, busName, MPRIS_PATH, (proxy, error) => {
            if (error) {
                /* Cancelled on destroy, and the interface is optional in
                 * practice anyway. */
                return;
            }
            this._appProxy = proxy;
            this.emit('changed');
        }, this._cancellable, Gio.DBusProxyFlags.NONE);
    }

    get ready() {
        return this._playerProxy !== null;
    }

    /* Running with nothing loaded: Chrome closed to the background, or VLC
     * with an empty playlist (Firefox leaves the bus instead). The spec ties
     * CanPlay to having a current track, and GNOME's own media controls hide
     * players without it. Not the title: VLC keeps a removed track's metadata.
     * The canPlay fallback keeps players that do not report it. */
    get idle() {
        return !this.isPlaying && !this.canPlay;
    }

    /* Reading proxy.Metadata deep-unpacks the whole a{sv}, and one sync asks
     * for half a dozen keys, so it is unpacked once per PropertiesChanged. */
    _metadataDict() {
        if (this._metadata)
            return this._metadata;
        /* Nothing to cache until the proxy lands; it emits 'changed' then. */
        if (!this._playerProxy)
            return {};
        this._metadata = this._playerProxy.Metadata ?? {};
        return this._metadata;
    }

    _meta(key) {
        return unwrap(this._metadataDict()[key]);
    }

    get title() {
        return asString(this._meta('xesam:title'));
    }

    /* The title, or a file's name when it has none. For display only: lyrics
     * lookups want `title` as the player sent it. */
    get displayTitle() {
        return this.title || titleFromUrl(this.url);
    }

    get artist() {
        return asString(this._meta('xesam:artist'));
    }

    get artists() {
        const value = this._meta('xesam:artist');
        return (Array.isArray(value) ? value : [value])
            .filter(artist => typeof artist === 'string' && artist);
    }

    get album() {
        return asString(this._meta('xesam:album'));
    }

    get artUrl() {
        return asString(this._meta('mpris:artUrl'));
    }

    get trackId() {
        return asString(this._meta('mpris:trackid'));
    }

    get url() {
        return asString(this._meta('xesam:url'));
    }

    get lyrics() {
        return asString(this._meta('xesam:asText'));
    }

    /* In microseconds; 0 when the player does not report it. */
    get length() {
        const length = asNumber(this._meta('mpris:length'));
        return length > 0 && length < MAX_TRACK_LENGTH ? length : 0;
    }

    get status() {
        return this._playerProxy?.PlaybackStatus ?? 'Stopped';
    }

    get isPlaying() {
        return this.status === 'Playing';
    }

    get rate() {
        const rate = this._playerProxy?.Rate;
        return typeof rate === 'number' && Number.isFinite(rate) && rate > 0 ? rate : 1;
    }

    /* Some players omit the Can* properties; assume the capability rather than
     * grey out buttons that work. */
    get canPlay() {
        return this._playerProxy?.CanPlay ?? true;
    }

    get canControl() {
        return this._playerProxy?.CanControl ?? true;
    }

    /** null means volume is not exposed by this player. */
    get volume() {
        const volume = this._playerProxy?.Volume;
        return typeof volume === 'number' && Number.isFinite(volume) && volume >= 0
            ? volume : null;
    }

    get canPause() {
        return this._playerProxy?.CanPause ?? true;
    }

    get canGoNext() {
        return this._playerProxy?.CanGoNext ?? true;
    }

    get canGoPrevious() {
        return this._playerProxy?.CanGoPrevious ?? true;
    }

    get canSeek() {
        return this._playerProxy?.CanSeek ?? false;
    }

    /* LoopStatus and Shuffle are optional. null means not implemented, which
     * the UI turns into no button: unlike the Can* fallbacks, absence is a
     * capability signal here. */
    get loopStatus() {
        const status = this._playerProxy?.LoopStatus;
        return typeof status === 'string' ? status : null;
    }

    get canLoop() {
        return this.loopStatus !== null;
    }

    get shuffle() {
        const shuffle = this._playerProxy?.Shuffle;
        return typeof shuffle === 'boolean' ? shuffle : null;
    }

    get canShuffle() {
        return this.shuffle !== null;
    }

    /**
     * Browsers are left out: Chromium and its derivatives publish a Volume
     * that always reads 1.0 and silently ignore writes to it, so a slider for
     * them would move nothing. CanControl false means the player takes no
     * commands at all.
     */
    get canSetVolume() {
        return this.volume !== null &&
            (this._playerProxy?.CanControl ?? true) &&
            this.kind !== PlayerKind.BROWSER;
    }

    get canRaise() {
        return this._appProxy?.CanRaise ?? false;
    }

    get canQuit() {
        return this._appProxy?.CanQuit ?? false;
    }

    get identity() {
        return this._appProxy?.Identity ?? this.busName.replace(MPRIS_PREFIX, '');
    }

    get desktopEntry() {
        return this._appProxy?.DesktopEntry ?? '';
    }

    /* Resolution walks the desktop file index and icon theme, and runs on every
     * sync, so it is cached against its inputs. Both arrive with the app proxy,
     * so a key, not a "resolved once" flag, lets a better icon land later. */
    _resolveApp() {
        const key = JSON.stringify([this.desktopEntry, this.identity]);
        if (this._app?.key !== key) {
            const hints = {
                busName: this.busName,
                desktopEntry: this.desktopEntry,
                identity: this.identity,
            };
            this._app = {key, icon: resolvePlayerIcon(hints), ...resolvePlayerApp(hints)};
        }
        return this._app;
    }

    get kind() {
        return this._resolveApp().kind;
    }

    /* The app's name as the desktop shows it. `identity` stays the raw MPRIS
     * value, which the app lookup matches on. */
    get displayName() {
        return this._resolveApp().name ?? tidyIdentity(this.identity);
    }

    /* Music players always, browsers never, others for local audio files. */
    get playsMusic() {
        const kind = this.kind;
        return kind === PlayerKind.MUSIC ||
            (kind === PlayerKind.OTHER && isAudioFile(this.url));
    }

    /* Whether a real app icon was found rather than a generic one. */
    get hasAppIcon() {
        return this._resolveApp().icon !== null;
    }

    /* Never null. */
    get appIcon() {
        this._genericIcon ??= Gio.ThemedIcon.new(GENERIC_ICON);
        return this._resolveApp().icon ?? this._genericIcon;
    }

    /* Every call can race the player leaving the bus, so errors are swallowed
     * rather than taking down the shell. */
    _call(method) {
        if (!this._playerProxy)
            return;
        try {
            this._playerProxy[`${method}Remote`](() => {});
        } catch (e) {
            logError(`${method} failed`, e);
        }
    }

    playPause() {
        if (!this.canControl || !(this.isPlaying ? this.canPause : this.canPlay))
            return;
        this._call('PlayPause');
    }

    play() {
        if (this.canControl && this.canPlay)
            this._call('Play');
    }

    /**
     * Pause outright rather than toggling. PlayPause would restart a player
     * that has already stopped by the time the call lands, which is exactly
     * the wrong outcome when the point is to get out of another player's way.
     */
    pause() {
        if (!this.canControl || !this.canPause)
            return;
        this._call('Pause');
    }

    next() {
        if (this.canControl && this.canGoNext)
            this._call('Next');
    }

    previous() {
        if (this.canControl && this.canGoPrevious)
            this._call('Previous');
    }

    setVolume(volume) {
        if (!this._playerProxy || !this.canSetVolume ||
            !Number.isFinite(volume))
            return;
        try {
            this._playerProxy.Volume = Math.max(0, Math.min(1, volume));
        } catch (e) {
            logError('set Volume failed', e);
        }
    }

    /* Assigning a GJS proxy property updates the cache at once and sends Set
     * asynchronously, so a sync right after already shows the new state; a
     * player that rejects it corrects it with its next PropertiesChanged. */
    setLoopStatus(status) {
        if (!this._playerProxy || !this.canLoop)
            return;
        try {
            this._playerProxy.LoopStatus = status;
        } catch (e) {
            logError('set LoopStatus failed', e);
        }
    }

    setShuffle(shuffle) {
        if (!this._playerProxy || !this.canShuffle)
            return;
        try {
            this._playerProxy.Shuffle = shuffle;
        } catch (e) {
            logError('set Shuffle failed', e);
        }
    }

    raise() {
        if (!this._appProxy || !this.canRaise)
            return;
        try {
            this._appProxy.RaiseRemote(() => {});
        } catch (e) {
            logError('Raise failed', e);
        }
    }

    quit() {
        if (!this._appProxy || !this.canQuit)
            return;
        try {
            this._appProxy.QuitRemote(() => {});
        } catch (e) {
            logError('Quit failed', e);
        }
    }

    /* The spec excludes Position from PropertiesChanged, so the cached value
     * is stale; always ask the bus. Resolves to µs, or null on failure. */
    getPosition() {
        return new Promise(resolve => {
            if (!this._playerProxy) {
                resolve(null);
                return;
            }
            Gio.DBus.session.call(
                this.busName, MPRIS_PATH, PROPS_IFACE, 'Get',
                new GLib.Variant('(ss)', [PLAYER_IFACE, 'Position']),
                new GLib.VariantType('(v)'), Gio.DBusCallFlags.NONE, -1,
                this._cancellable,
                (connection, result) => {
                    try {
                        const [value] = connection.call_finish(result).deep_unpack();
                        resolve(asNumber(value.deep_unpack()));
                    } catch {
                        resolve(null);
                    }
                });
        });
    }

    /* Relative, in µs; players clamp to the start of the track themselves. */
    seek(offset) {
        if (!this._playerProxy || !this.canSeek)
            return;
        try {
            this._playerProxy.SeekRemote(offset, () => {});
        } catch (e) {
            logError('relative seek failed', e);
        }
    }

    /* Absolute, in µs. */
    setPosition(position) {
        if (!this._playerProxy || !this.canSeek)
            return;

        const warn = e => logError('seek failed', e);

        /* SetPosition needs a valid object path; players with a bogus trackid
         * get a relative Seek instead. */
        const trackId = this.trackId;
        if (trackId && trackId.startsWith('/')) {
            try {
                this._playerProxy.SetPositionRemote(trackId, position, () => {});
            } catch (e) {
                warn(e);
            }
            return;
        }

        /* The Seek runs after a round trip, so a synchronous `try` would have
         * returned by the time it could throw. */
        this.getPosition()
            .then(current => {
                if (current !== null)
                    this._playerProxy?.SeekRemote(position - current, () => {});
            })
            .catch(warn);
    }

    destroy() {
        this._cancellable.cancel();

        if (this._playerProxy) {
            if (this._propsChangedId)
                this._playerProxy.disconnect(this._propsChangedId);
            if (this._seekedId)
                this._playerProxy.disconnectSignal(this._seekedId);
        }
        this._propsChangedId = 0;
        this._seekedId = 0;
        this._playerProxy = null;
        this._appProxy = null;
        this._metadata = null;
    }
});

export const MprisManager = GObject.registerClass({
    Signals: {
        /* The active player, or anything about it, changed. */
        'changed': {},
        /* Players came or went, or one gained the identity or icon the
         * switcher shows. */
        'players-changed': {},
    },
}, class MprisManager extends GObject.Object {
    _init() {
        super._init();

        this._players = new Map();
        this._playerSignals = new Map();
        this._active = null;
        this._pinned = null;
        this._roster = '';
        this._statuses = new Map();
        this._loaded = false;
        this._cancellable = new Gio.Cancellable();

        /* Pause other players when one starts. Set by the extension from the
         * `pause-others-on-play` setting; off until then, so nothing is
         * paused before the setting is read. */
        this.exclusivePlayback = false;

        const DBusProxy = Gio.DBusProxy.makeProxyWrapper(DBusIface);
        this._dbusProxy = new DBusProxy(Gio.DBus.session,
            'org.freedesktop.DBus', '/org/freedesktop/DBus',
            (proxy, error) => {
                /* Cancelled when destroy() beats the init to it. */
                if (error)
                    return;
                this._nameOwnerId = proxy.connectSignal('NameOwnerChanged',
                    (_p, _sender, [name, oldOwner, newOwner]) =>
                        this._onNameOwnerChanged(name, oldOwner, newOwner));
                this._loadExistingPlayers();
            }, this._cancellable, Gio.DBusProxyFlags.NONE);
    }

    get activePlayer() {
        return this._active;
    }

    get players() {
        return [...this._players.values()];
    }

    /* Controllable players, oldest first: the map is in arrival order, so a
     * switcher short of room can drop the longest-idle ones. Players running
     * at startup come in bus order, the closest thing available. An idle
     * player has nothing to control. */
    get readyPlayers() {
        return this.controllablePlayers;
    }

    get controllablePlayers() {
        return this.players.filter(player => player.ready && !player.idle);
    }

    /* Show this player, whatever else is playing. The pin holds against
     * metadata noise but not against intent: another player starting drops it
     * (see _noteStatus()), as does the pinned player leaving the bus. */
    selectPlayer(busName) {
        const player = this._players.get(busName);
        if (!player)
            return;

        this._pinned = busName;
        if (this._active === player)
            return;

        this._active = player;
        this.emit('changed');
    }

    /** Cycle the same ready-player roster as the menu, without changing playback. */
    cyclePlayer(direction) {
        const players = this.readyPlayers;
        if (players.length < 2 || !Number.isFinite(direction) || direction === 0)
            return;
        const index = players.indexOf(this._active);
        const step = direction > 0 ? 1 : -1;
        const next = index < 0 ? (step > 0 ? 0 : players.length - 1) :
            (index + step + players.length) % players.length;
        this.selectPlayer(players[next].busName);
    }


    _loadExistingPlayers() {
        /* Not destructured in the parameter list: result is null on error,
         * including cancellation on destroy. */
        this._dbusProxy.ListNamesRemote((result, error) => {
            if (error)
                return;
            const [names] = result;
            for (const name of names) {
                if (this._isPlayerName(name))
                    this._addPlayer(name);
            }
            /* From here on, a new player arrived while we were watching:
             * _noteStatus() depends on the distinction. */
            this._loaded = true;
            this._selectActive();
        }, this._cancellable);
    }

    _isPlayerName(name) {
        return name.startsWith(MPRIS_PREFIX) && !IGNORED_BUS_NAMES.includes(name);
    }

    _onNameOwnerChanged(name, oldOwner, newOwner) {
        if (!this._isPlayerName(name))
            return;

        if (newOwner && !oldOwner)
            this._addPlayer(name);
        else if (oldOwner && !newOwner)
            this._removePlayer(name);
        else
            return;

        this._selectActive();
    }

    _addPlayer(busName) {
        if (this._players.has(busName))
            return;

        const player = new MprisPlayer(busName);
        this._players.set(busName, player);

        /* A player already on the bus at startup gets no entry, so
         * _noteStatus() adopts its state without treating it as a start, and
         * enabling the extension never pauses music already running. One that
         * joins later starts from Stopped, so its first Playing counts. */
        if (this._loaded)
            this._statuses.set(busName, 'Stopped');

        this._playerSignals.set(busName, player.connect('changed', () => {
            this._noteStatus(player);

            const wasActive = this._active === player;
            /* Emits 'changed' itself when the active player flips. */
            this._selectActive();

            /* A background player's metadata is not news: only the player on
             * screen re-renders, unless _selectActive() already announced it. */
            if (wasActive && this._active === player)
                this.emit('changed');

            /* Both proxies land after the player is added, so this is where a
             * new player picks up its identity and icon. */
            this._notifyRoster();
        }));
        this._notifyRoster();
    }

    /* Watch for the moment a player starts, the only thing exclusive playback
     * acts on. Compares against the last status, since every property change
     * comes through here and "is it playing" would keep re-pausing others. */
    _noteStatus(player) {
        const previous = this._statuses.get(player.busName);
        const status = player.status;
        if (status === previous)
            return;

        this._statuses.set(player.busName, status);


        if (status !== 'Playing')
            return;

        /* Pressing play elsewhere releases an earlier pick, or the card would
         * sit on a player chosen minutes ago while the new one plays unseen. */
        if (this._pinned && this._pinned !== player.busName)
            this._pinned = null;

        /* `undefined`: seen for the first time, not watched starting; leave
         * everyone alone. */
        if (previous !== undefined)
            this._pauseOthers(player);
    }


    _pauseOthers(player) {
        if (!this.exclusivePlayback)
            return;

        for (const other of this._players.values()) {
            if (other === player || !other.isPlaying)
                continue;

            /* Not recorded as Paused until the player says so: browsers send
             * other changes before the status catches up, and each would read
             * as a fresh start and pause the player just started. Pausing twice
             * is harmless. */
            other.pause();
        }
    }

    /* The switcher renders one button per player from exactly these
     * properties. Comparing the signature keeps per-second 'changed' noise
     * from rebuilding it. JSON, so a crafted identity cannot forge a field
     * boundary. */
    _rosterSignature() {
        return JSON.stringify(this.players.map(player =>
            [player.busName, player.ready, player.idle, player.identity,
                player.desktopEntry]));
    }

    _notifyRoster() {
        const signature = this._rosterSignature();
        if (signature === this._roster)
            return;

        this._roster = signature;
        this.emit('players-changed');
    }

    _removePlayer(busName) {
        const player = this._players.get(busName);
        if (!player)
            return;

        const signalId = this._playerSignals.get(busName);
        if (signalId)
            player.disconnect(signalId);
        this._playerSignals.delete(busName);
        this._players.delete(busName);
        this._statuses.delete(busName);

        /* `_active` deliberately still points at the removed player:
         * _selectActive() compares against it to decide whether to emit
         * 'changed', and clearing it here would leave the panel showing a
         * player that has quit. */
        player.destroy();
        this._notifyRoster();
    }

    /* Scans the map in place: `players` would allocate an array per call, and
     * this runs on every property change of every player. */
    _find(predicate) {
        for (const player of this._players.values()) {
            if (predicate(player))
                return player;
        }
        return null;
    }

    /* A pinned player wins outright. Otherwise prefer one that is playing, and
     * else keep the current one so the panel does not jump around when a
     * background player updates its metadata. An idle player is never picked,
     * so with nothing else around the UI shows no player at all. */
    _selectActive() {
        const previous = this._active;
        const pinned = this._pinned ? this._players.get(this._pinned) : null;

        /* The pinned player quit. */
        if (!pinned)
            this._pinned = null;

        /* An idle pin is set aside, not cleared: it wins again once the
         * player has media back. */
        if (pinned && !pinned.idle) {
            this._active = pinned;
        } else {
            const current = this._active;
            if (!current || !this._players.has(current.busName) || current.idle)
                this._active = null;

            if (!this._active?.isPlaying)
                this._active = this._find(p => p.isPlaying) ?? this._active;

            if (!this._active || !this._players.has(this._active.busName))
                this._active = this._find(p => p.ready && !p.idle);
        }

        if (previous !== this._active)
            this.emit('changed');
    }

    destroy() {
        this._cancellable.cancel();

        if (this._dbusProxy && this._nameOwnerId)
            this._dbusProxy.disconnectSignal(this._nameOwnerId);
        this._nameOwnerId = 0;
        this._dbusProxy = null;

        for (const busName of [...this._players.keys()])
            this._removePlayer(busName);

        this._active = null;
        this._pinned = null;
        this._statuses.clear();
    }
});
