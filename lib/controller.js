import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup';

import { AlAdhanAPI }                                        from '../logic/api.js';
import { applyOffsets, findNextPrayer } from '../logic/prayerCompute.js';
import { SalatState } from './state.js';
import { LocationService } from '../logic/location.js';
import { AudioPlayer }     from '../logic/audio.js';
import * as quranPlayer from '../lib/quranPlayer.js';
import * as prayerTimes from '../lib/prayerTimes.js';
import * as adhan from '../lib/adhan.js';
import * as ui from '../lib/ui.js';

export class SalatController {
    constructor(ext) {
        this._ext      = ext;
        this._settings = ext.getSettings();
        this._api      = new AlAdhanAPI();
        this.state     = new SalatState();

        const ctrl = new Proxy(this, {
            get(target, prop) {
                if (typeof prop === 'symbol') return target[prop];
                if (Object.prototype.hasOwnProperty.call(target.state, prop))
                    return target.state[prop];
                return target[prop];
            },
            set(target, prop, value) {
                if (typeof prop === 'symbol') { target[prop] = value; return true; }
                if (Object.prototype.hasOwnProperty.call(target.state, prop)) {
                    target.state[prop] = value;
                    return true;
                }
                target[prop] = value;
                return true;
            }
        });

        this._locationService = new LocationService(this._settings, () => {
            if (ctrl._noCoords && ctrl._showNoCoordinatesPrompt)
                ctrl._showNoCoordinatesPrompt();
        });

        this._playerA      = new AudioPlayer();
        this._playerB      = new AudioPlayer();
        this._adhanPlayer  = new AudioPlayer();
        this._notifPlayer  = new AudioPlayer();
        this._quranSession = new Soup.Session();

        this.state._activePlayer = this._playerA;

        this._fetchSurahs      = quranPlayer.fetchSurahs.bind(ctrl);
        this._playQuran         = quranPlayer.playQuran.bind(ctrl);
        this._pauseQuran       = quranPlayer.pauseQuran.bind(ctrl);
        this._fetchAndPlayAyah = quranPlayer.fetchAndPlayAyah.bind(ctrl);
        this._onQuranVerseEnded = quranPlayer.onQuranVerseEnded.bind(ctrl);

        this._resolveCoordinates     = prayerTimes.resolveCoordinates.bind(ctrl);
        this._refetchAndUpdate       = prayerTimes.refetchAndUpdate.bind(ctrl);
        this._fetchTodayTimes        = prayerTimes.fetchTodayTimes.bind(ctrl);
        this._calcOfflineTimes      = prayerTimes.calcOfflineTimes.bind(ctrl);
        this._calcJafariNightTimes  = prayerTimes.calcJafariNightTimes.bind(ctrl);

        this._scheduleAtPrayerAlarm = adhan.scheduleAtPrayerAlarm.bind(ctrl);
        this._triggerAdhan         = adhan.triggerAdhan.bind(ctrl);
        this._onAdhanEnded         = adhan.onAdhanEnded.bind(ctrl);

        this._buildIndicator               = ui.buildIndicator.bind(ctrl);
        this._buildMenu                   = ui.buildMenu.bind(ctrl);
        this._updateQuranPlayerVisibility = ui.updateQuranPlayerVisibility.bind(ctrl);
        this._updatePrayerIconsVisibility = ui.updatePrayerIconsVisibility.bind(ctrl);
        this._updateNightTimesVisibility  = ui.updateNightTimesVisibility.bind(ctrl);
        this._t                           = ui.t.bind(ctrl);
        this._prayerName                  = ui.prayerName.bind(ctrl);
        this._toDisplayNum                = ui.toDisplayNum.bind(ctrl);
        this._refreshLanguage             = ui.refreshLanguage.bind(ctrl);
        this._updateHijriDisplay          = ui.updateHijriDisplay.bind(ctrl);
        this._getSpecialIslamicMessage    = ui.getSpecialIslamicMessage.bind(ctrl);
        this._formatTimeDisplay           = ui.formatTimeDisplay.bind(ctrl);
        this._updateOfflineBadge          = ui.updateOfflineBadge.bind(ctrl);
        this._refreshTopbar               = ui.refreshTopbar.bind(ctrl);
        this._showNoCoordinatesPrompt     = ui.showNoCoordinatesPrompt.bind(ctrl);

        return ctrl;
    }

    enable() {
        this._playerA.connectObject('eos', () => this._onQuranVerseEnded(this._playerB), this);
        this._playerB.connectObject('eos', () => this._onQuranVerseEnded(this._playerA), this);
        this._adhanPlayer.connectObject('eos', () => this._onAdhanEnded(), this);

        if (this._settings.get_boolean('auto-location'))
            this._locationService.start();
        else
            this._resolveCoordinates();

        this._settings.connectObject(
            'changed::auto-location', () => {
                if (this._settings.get_boolean('auto-location')) {
                    this._locationService.start();
                } else {
                    this._locationService.stop();
                    this._resolveCoordinates();
                }
            },
            'changed::city',    this._resolveCoordinates.bind(this),
            'changed::country', this._resolveCoordinates.bind(this),
            'changed::use-coordinates', () => {
                if (!this._settings.get_boolean('use-coordinates'))
                    this._resolveCoordinates();
                else
                    this._updateUI();
            },
            'changed::latitude',              this._refetchAndUpdate.bind(this),
            'changed::longitude',             this._refetchAndUpdate.bind(this),
            'changed::timezone',              this._refetchAndUpdate.bind(this),
            'changed::method',                this._refetchAndUpdate.bind(this),
            'changed::school',                this._refetchAndUpdate.bind(this),
            'changed::topbar-display-format', this._refreshTopbar.bind(this),
            'changed::hour-format',           this._updateUI.bind(this),
            'changed::offset-fajr',           this._updateUI.bind(this),
            'changed::offset-dhuhr',          this._updateUI.bind(this),
            'changed::offset-asr',            this._updateUI.bind(this),
            'changed::offset-maghrib',        this._updateUI.bind(this),
            'changed::offset-isha',           this._updateUI.bind(this),
            'changed::hijri-offset',          this._updateHijriDisplay.bind(this),
            'changed::show-hijri-date',       this._updateHijriDisplay.bind(this),
            'changed::language-index',        this._refreshLanguage.bind(this),
            'changed::use-arabic-numbers',    this._updateUI.bind(this),
            'changed::show-settings-button', () => {
                if (this.state._settingsItem)
                    this.state._settingsItem.visible = this._settings.get_boolean('show-settings-button');
            },
            'changed::show-quran-player', () => this._updateQuranPlayerVisibility(),
            'changed::show-prayer-icons', () => this._updatePrayerIconsVisibility(),
            'changed::show-midnight',     () => this._updateNightTimesVisibility(),
            'changed::show-last-third',   () => this._updateNightTimesVisibility(),
            'changed::topbar-placement', () => {
                if (!this.state._indicator) return;
                this.state._indicator.destroy();
                this.state._indicator = null;
                this._buildIndicator();
                this._fetchSurahs();
                this._updateQuranPlayerVisibility();
                this._updatePrayerIconsVisibility();
                this._updateNightTimesVisibility();
                if (this.state._noCoords)
                    this._showNoCoordinatesPrompt();
                else
                    this._updateUI();
            },
            this
        );

        this._buildIndicator();

        this.state._updateTimer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 60, () => {
            const now = GLib.DateTime.new_now_local();
            const ds  = `${now.get_day_of_month()}-${now.get_month()}-${now.get_year()}`;
            if (ds !== this.state._todayDateStr) {
                this.state._preNotifiedSet.clear();
                this._fetchTodayTimes();
            } else
                this._updateUI();
            return GLib.SOURCE_CONTINUE;
        });
        this._fetchTodayTimes();
        this._fetchSurahs();
    }


    // menu





    // quran playback

    // i18n helpers





    // hijri



    // ui update

    _updateUI() {
        const rawTimes = this.state._cachedTimes;
        if (!rawTimes || Object.keys(rawTimes).length === 0) return;

        const offsets = {
            Fajr:    this._settings.get_int('offset-fajr'),
            Dhuhr:   this._settings.get_int('offset-dhuhr'),
            Asr:     this._settings.get_int('offset-asr'),
            Maghrib: this._settings.get_int('offset-maghrib'),
            Isha:    this._settings.get_int('offset-isha'),
        };
        const times = applyOffsets(rawTimes, offsets);

        this.state._adjustedTimes = times;

        const now = GLib.DateTime.new_now_local();
        this.state._todayDateStr = `${now.get_day_of_month()}-${now.get_month()}-${now.get_year()}`;
        const todayKey = `${now.get_year()}-${String(now.get_month()).padStart(2, '0')}-${String(now.get_day_of_month()).padStart(2, '0')}`;

        const use12h = this._settings.get_boolean('hour-format');
        const jsNow  = new Date();

        const { name: nextPrayerName, ms: diffMs } = findNextPrayer(times, jsNow);

        for (const [prayer, timeStr] of Object.entries(times)) {
            if (!this.state._prayerItems[prayer]) continue;

            const [hStr, mStr] = timeStr.split(':');
            const h = parseInt(hStr, 10);
            const m = parseInt(mStr, 10);

            const pTime = new Date();
            pTime.setHours(h, m, 0, 0);
            if (pTime.getTime() <= jsNow.getTime()) pTime.setDate(pTime.getDate() + 1);

            const timeDiff = pTime.getTime() - jsNow.getTime();

            let displayStr;
            if (use12h) {
                const dh = h % 12 || 12;
                const ap = h >= 12 ? 'PM' : 'AM';
                displayStr = this._toDisplayNum(`${dh}:${m.toString().padStart(2, '0')}`) + ` ${ap}`;
            } else {
                displayStr = this._toDisplayNum(timeStr);
            }
            this.state._prayerItems[prayer].timeLabel.set_text(displayStr);

            const preMin = this._settings.get_int('pre-notification-minutes');
            if (preMin > 0) {
                const minutesUntil = Math.round(timeDiff / 60000);
                const preKey = `${prayer}-${todayKey}`;
                if (minutesUntil === preMin && !this.state._preNotifiedSet.has(preKey)) {
                    this.state._preNotifiedSet.add(preKey);
                    Main.notify(
                        this._t('Prayer Time', 'وقت الصلاة'),
                        this._t(
                            `${prayer} is in ${preMin} minutes.`,
                            `${this._prayerName(prayer)} بعد ${preMin} دقيقة.`
                        )
                    );
                    if (this._settings.get_boolean('pre-notification-sound'))
                        this._notifPlayer.playBeep(this._settings.get_double('adhan-volume') || 0.5);
                }
            }
        }

        if (this.state._nightItems && times.Maghrib && times.Fajr) {
            const nightTimes = this._calcJafariNightTimes(times.Maghrib, times.Fajr);
            if (nightTimes) {
                if (this.state._nightItems.Midnight)
                    this.state._nightItems.Midnight.timeLabel.set_text(this._formatTimeDisplay(nightTimes.Midnight, use12h));
                if (this.state._nightItems.LastThird)
                    this.state._nightItems.LastThird.timeLabel.set_text(this._formatTimeDisplay(nightTimes.LastThird, use12h));
            } else {
                if (this.state._nightItems.Midnight)
                    this.state._nightItems.Midnight.timeLabel.set_text('--:--');
                if (this.state._nightItems.LastThird)
                    this.state._nightItems.LastThird.timeLabel.set_text('--:--');
            }
        }

        this.state._nextPrayerName = nextPrayerName;
        this.state._nextPrayerMs   = diffMs;

        this._updateHijriDisplay();
        this._updateOfflineBadge();
        this._refreshTopbar();
        this._scheduleAtPrayerAlarm(nextPrayerName, diffMs);
    }


    // topbar + offline badge



    // no-coords fallback


    disable() {
        this._settings.disconnectObject(this);

        if (this.state._updateTimer) {
            GLib.Source.remove(this.state._updateTimer);
            this.state._updateTimer = null;
        }
        if (this.state._resolveTimeout) {
            GLib.Source.remove(this.state._resolveTimeout);
            this.state._resolveTimeout = null;
        }
        if (this.state._refetchTimeout) {
            GLib.Source.remove(this.state._refetchTimeout);
            this.state._refetchTimeout = null;
        }
        if (this.state._alarmTimerAtPrayer) {
            GLib.Source.remove(this.state._alarmTimerAtPrayer);
            this.state._alarmTimerAtPrayer = null;
        }
        if (this.state._adhanStopTimer) {
            GLib.Source.remove(this.state._adhanStopTimer);
            this.state._adhanStopTimer = null;
        }
        this._locationService.stop();
        this._locationService = null;

        this._playerA.disconnectObject(this);
        this._playerA.destroy();
        this._playerA = null;

        this._playerB.disconnectObject(this);
        this._playerB.destroy();
        this._playerB = null;

        this._adhanPlayer.disconnectObject(this);
        this._adhanPlayer.destroy();
        this._adhanPlayer = null;

        this._notifPlayer.destroy();
        this._notifPlayer = null;

        this._quranSession.abort();
        this._quranSession = null;

        this._api.destroy();
        this._api = null;

        this.state._nextPrayerLabel.destroy(); this.state._nextPrayerLabel = null;
        this.state._hijriLabel.destroy();      this.state._hijriLabel = null;
        this.state._hijriItem.destroy();       this.state._hijriItem = null;
        this.state._specialLabel.destroy();    this.state._specialLabel = null;
        this.state._specialItem.destroy();     this.state._specialItem = null;
        this.state._offlineLabel.destroy();    this.state._offlineLabel = null;
        this.state._offlineItem.destroy();     this.state._offlineItem = null;
        this.state._settingsLabel.destroy();   this.state._settingsLabel = null;
        this.state._settingsItem.destroy();    this.state._settingsItem = null;
        this.state._verseLabel.destroy();      this.state._verseLabel = null;
        this.state._verseTextItem.destroy();   this.state._verseTextItem = null;
        this.state._playPauseBtn.destroy();    this.state._playPauseBtn = null;
        this.state._surahSubMenu.destroy();    this.state._surahSubMenu = null;
        this.state._quranSeparator.destroy();  this.state._quranSeparator = null;
        this.state._prayerItems = {};
        this.state._nightItems = {};
        this.state._quranItems = [];

        this.state._indicator.destroy();
        this.state._indicator = null;

        this._settings = null;
    }
}
