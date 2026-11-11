import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

    // alarm

export function scheduleAtPrayerAlarm(prayerName, diffMs) {
        if (!prayerName || diffMs <= 0 || diffMs === Infinity) {
            this.state._lastAlarmKey = null;
            return;
        }

        const minuteBucket = Math.floor(diffMs / 60000);
        const key = `${prayerName}-${minuteBucket}`;
        if (this.state._lastAlarmKey === key && this.state._alarmTimerAtPrayer) return;
        this.state._lastAlarmKey = key;

        if (this.state._alarmTimerAtPrayer) {
            GLib.Source.remove(this.state._alarmTimerAtPrayer);
            this.state._alarmTimerAtPrayer = null;
        }

        const jsNow    = new Date();
        const todayTag = `${prayerName}-${jsNow.toDateString()}`;

        this.state._alarmTimerAtPrayer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, diffMs, () => {
            this.state._alarmTimerAtPrayer = null;
            if (this.state._adhanTriggeredFor === todayTag) return GLib.SOURCE_REMOVE;
            this.state._adhanTriggeredFor = todayTag;

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

        if (this.state._quranStatus === 'playing') {
            this._pauseQuran();
            this.state._resumeQuran = true;
        }

        const customPath = this._settings.get_string('adhan-audio-path');
        const audioPath  = customPath || `${this._ext.path}/assets/audio/Adhan.mp3`;

        this._adhanPlayer.setVolume(this._settings.get_double('adhan-volume') || 0.5);
        this._adhanPlayer.setSource(audioPath);
        this.state._adhanState = 'playing';
        this._adhanPlayer.play();

        if (mode === 2 || mode === 3) {
            if (this.state._adhanStopTimer) {
                GLib.Source.remove(this.state._adhanStopTimer);
                this.state._adhanStopTimer = null;
            }
            const delay = mode === 2 ? 40 : 15;
            this.state._adhanStopTimer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, delay, () => {
                this.state._adhanStopTimer = null;
                if (this.state._adhanState === 'playing') { this._adhanPlayer.stop(); this._onAdhanEnded(); }
                return GLib.SOURCE_REMOVE;
            });
        }
    }

export function onAdhanEnded() {
        this.state._adhanState = 'idle';
        if (this.state._resumeQuran) {
            this.state._resumeQuran = false;
            this._playQuran();
        }
    }

