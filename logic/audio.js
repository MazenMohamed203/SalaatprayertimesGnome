import Gst from 'gi://Gst';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';

export const AudioPlayer = GObject.registerClass({
    Signals: {
        'eos':   {},
        'error': { param_types: [GObject.TYPE_STRING] }
    }
}, class AudioPlayer extends GObject.Object {
    constructor() {
        super();
        this._player      = null;
        this._bus         = null;
        this._currentUri  = null;
    }

    _ensurePlayer() {
        if (this._player)
            return true;

        if (!Gst.is_initialized())
            Gst.init(null);

        this._player = Gst.ElementFactory.make('playbin', 'playbin');
        if (!this._player) {
            console.error('[SalatPrayerTime] Failed to create GStreamer playbin element');
            return false;
        }

        this._bus = this._player.get_bus();
        this._bus.add_watch(GLib.PRIORITY_DEFAULT, this._onBusMessage.bind(this));
        return true;
    }

    setSource(uri) {
        if (!this._ensurePlayer()) return;
        this._player.set_state(Gst.State.NULL);
        if (uri && !uri.startsWith('http://') && !uri.startsWith('https://') && !uri.startsWith('file://'))
            uri = 'file://' + uri;
        this._currentUri = uri;
        if (uri)
            this._player.set_property('uri', uri);
    }

    play() {
        if (this._player && this._currentUri)
            this._player.set_state(Gst.State.PLAYING);
    }

    pause() {
        if (this._player)
            this._player.set_state(Gst.State.PAUSED);
    }

    stop() {
        if (this._player)
            this._player.set_state(Gst.State.NULL);
    }

    setVolume(volume) {
        if (this._player)
            this._player.set_property('volume', volume);
    }

    getPosition() {
        if (!this._player) return 0;
        const [ret, pos] = this._player.query_position(Gst.Format.TIME);
        return ret ? Math.floor(pos / 1000000) : 0;
    }

    getDuration() {
        if (!this._player) return 0;
        const [ret, dur] = this._player.query_duration(Gst.Format.TIME);
        return ret ? Math.floor(dur / 1000000) : 0;
    }

    setPosition(ms) {
        if (!this._player) return;
        this._player.seek_simple(
            Gst.Format.TIME,
            Gst.SeekFlags.FLUSH | Gst.SeekFlags.KEY_UNIT,
            ms * 1000000
        );
    }

    playBeep(volume = 0.3) {
        if (!Gst.is_initialized())
            Gst.init(null);
        const pipeline = Gst.parse_launch(
            `audiotestsrc wave=sine freq=880 num-buffers=25 ! ` +
            `volume volume=${Math.min(1.0, volume)} ! audioconvert ! autoaudiosink`
        );
        pipeline.set_state(Gst.State.PLAYING);
        const bus = pipeline.get_bus();
        bus.add_watch(GLib.PRIORITY_DEFAULT, (_bus, msg) => {
            if (msg.type === Gst.MessageType.EOS || msg.type === Gst.MessageType.ERROR) {
                pipeline.set_state(Gst.State.NULL);
                return GLib.SOURCE_REMOVE;
            }
            return GLib.SOURCE_CONTINUE;
        });
    }

    _onBusMessage(bus, message) {
        if (message.type === Gst.MessageType.EOS) {
            this.emit('eos');
        } else if (message.type === Gst.MessageType.ERROR) {
            const [err] = message.parse_error();
            console.error('[SalatPrayerTime] AudioPlayer error:', err.message);
            this.emit('error', err.message);
        }
        return GLib.SOURCE_CONTINUE;
    }

    destroy() {
        this.stop();
        if (this._bus) {
            this._bus.remove_watch();
            this._bus = null;
        }
        this._player = null;
    }
});
