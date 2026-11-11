import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

    // alarm

export function scheduleAtPrayerAlarm(prayerName, diffMs) {
        if (this._alarmTimerAtPrayer) {
            GLib.Source.remove(this._alarmTimerAtPrayer);
            this._alarmTimerAtPrayer = null;
        }

        if (!prayerName || diffMs <= 0 || diffMs === Infinity) return;

        const jsNow    = new Date();
        const todayTag = `${prayerName}-${jsNow.toDateString()}`;

        this._alarmTimerAtPrayer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, diffMs, () => {
            this._alarmTimerAtPrayer = null;
            if (this._adhanTriggeredFor === todayTag) return GLib.SOURCE_REMOVE;
            this._adhanTriggeredFor = todayTag;

            if (this._settings.get_boolean('notifications'))
                Main.notify(
                    this._t('Prayer Time', 'وقت الصلاة'),
                    this._t(`It is time for ${prayerName}.`, `حان وقت ${this._prayerName(prayerName)}.`)
                );
            this._triggerAdhan(prayerName);
            this._fetchTodayTimes();
            return GLib.SOURCE_REMOVE;
        });
    }

    // adhan

export function triggerAdhan(prayerName) {
        const key = `play-adhan-for-${prayerName.toLowerCase()}`;
        if (!this._settings.get_boolean(key)) return;

        const mode = this._settings.get_int('adhan-playback-mode');
        if (mode === 0) return;

        if (this._continuousQuran) {
            this._pauseQuran();
            this._resumeQuran = true;
        }

        const customPath = this._settings.get_string('adhan-audio-path');
        const audioPath  = customPath || `${this._ext.path}/assets/audio/Adhan.mp3`;

        this._adhanPlayer.setVolume(this._settings.get_double('adhan-volume') || 0.5);
        this._adhanPlayer.setSource(audioPath);
        this._isAdhanPlaying = true;
        this._adhanPlayer.play();

        if (mode === 2 || mode === 3) {
            if (this._adhanStopTimer) {
                GLib.Source.remove(this._adhanStopTimer);
                this._adhanStopTimer = null;
            }
            const delay = mode === 2 ? 40 : 15;
            this._adhanStopTimer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, delay, () => {
                this._adhanStopTimer = null;
                if (this._isAdhanPlaying) { this._adhanPlayer.stop(); this._onAdhanEnded(); }
                return GLib.SOURCE_REMOVE;
            });
        }
    }

export function onAdhanEnded() {
        this._isAdhanPlaying = false;
        if (this._resumeQuran) {
            this._resumeQuran = false;
            this._playQuran();
        }
    }

