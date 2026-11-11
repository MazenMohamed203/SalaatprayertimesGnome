import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup';

import { AlAdhanAPI }                                        from '../logic/api.js';
import { calcOfflineTimes, getHijriDate, applyOffset,
         HIJRI_MONTHS_EN, HIJRI_MONTHS_AR }                  from '../logic/offlineCalc.js';
import { SalatState } from './state.js';
import { LocationService } from '../logic/location.js';
import { AudioPlayer }     from '../logic/audio.js';
import * as quranPlayer from '../lib/quranPlayer.js';
import * as prayerTimes from '../lib/prayerTimes.js';
import * as adhan from '../lib/adhan.js';

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
                if (this._settingsItem)
                    this._settingsItem.visible = this._settings.get_boolean('show-settings-button');
            },
            'changed::show-quran-player', () => this._updateQuranPlayerVisibility(),
            'changed::show-prayer-icons', () => this._updatePrayerIconsVisibility(),
            'changed::show-midnight',     () => this._updateNightTimesVisibility(),
            'changed::show-last-third',   () => this._updateNightTimesVisibility(),
            'changed::topbar-placement', () => {
                if (!this._indicator) return;
                this._indicator.destroy();
                this._indicator = null;
                this._buildIndicator();
                this._fetchSurahs();
                this._updateQuranPlayerVisibility();
                this._updatePrayerIconsVisibility();
                this._updateNightTimesVisibility();
                if (this._noCoords)
                    this._showNoCoordinatesPrompt();
                else
                    this._updateUI();
            },
            this
        );

        this._buildIndicator();

        this._updateTimer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 60, () => {
            const now = GLib.DateTime.new_now_local();
            const ds  = `${now.get_day_of_month()}-${now.get_month()}-${now.get_year()}`;
            if (ds !== this._todayDateStr) {
                this._preNotifiedSet.clear();
                this._fetchTodayTimes();
            } else
                this._updateUI();
            return GLib.SOURCE_CONTINUE;
        });
        this._fetchTodayTimes();
        this._fetchSurahs();
    }

    _buildIndicator() {
        this._indicator = new PanelMenu.Button(0.5, this._ext.metadata.name, false);
        this._nextPrayerLabel = new St.Label({
            text: '...',
            y_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
            style: 'padding: 0px 8px;'
        });
        this._indicator.add_child(this._nextPrayerLabel);
        this._buildMenu();

        const placementInt = this._settings.get_int('topbar-placement') || 0;
        const box = placementInt === 1 ? 'center' : placementInt === 2 ? 'left' : 'right';
        const position = box === 'left' ? 1 : 0;
        Main.panel.addToStatusArea(this._ext.uuid, this._indicator, position, box);
    }

    // menu

    _buildMenu() {
        this._prayerItems = {};
        this._nightItems = {};

        const hijriItem = new PopupMenu.PopupBaseMenuItem({ reactive: false, hover: false });
        this._hijriLabel = new St.Label({
            text: '...',
            x_expand: true,
            style: 'text-align: center; font-style: italic; padding: 4px 8px;'
        });
        hijriItem.add_child(this._hijriLabel);
        this._hijriItem = hijriItem;
        this._indicator.menu.addMenuItem(hijriItem);

        const specialItem = new PopupMenu.PopupBaseMenuItem({ reactive: false, hover: false });
        this._specialLabel = new St.Label({
            text: '',
            x_expand: true,
            style: 'text-align: center; font-weight: bold; padding: 0 8px 4px;'
        });
        specialItem.add_child(this._specialLabel);
        this._specialItem = specialItem;
        this._indicator.menu.addMenuItem(specialItem);

        this._indicator.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const prayers = [
            { id: 'fajr',    name: 'Fajr'    },
            { id: 'thuhr',   name: 'Dhuhr'   },
            { id: 'asr',     name: 'Asr'     },
            { id: 'maghrib', name: 'Maghrib' },
            { id: 'isha',    name: 'Isha'    }
        ];

        const showIcons = this._settings.get_boolean('show-prayer-icons');

        prayers.forEach(prayer => {
            const item = new PopupMenu.PopupBaseMenuItem({ reactive: false, hover: false });
            const iconPath = `${this._ext.path}/assets/icons/${prayer.id}.svg`;
            const icon = new St.Icon({
                gicon: Gio.icon_new_for_string(iconPath),
                icon_size: 16,
                style_class: 'system-status-icon',
                visible: showIcons,
            });
            const nameLabel = new St.Label({ text: this._prayerName(prayer.name), x_expand: true, style: showIcons ? 'padding-left: 10px;' : '' });
            const timeLabel = new St.Label({ text: '--:--' });

            item.add_child(icon);
            item.add_child(nameLabel);
            item.add_child(timeLabel);

            this._prayerItems[prayer.name] = { item, icon, nameLabel, timeLabel };
            this._indicator.menu.addMenuItem(item);
        });

        const nightTimes = [
            { id: 'midnight',  name: 'Midnight',  setting: 'show-midnight' },
            { id: 'lastthird', name: 'LastThird', setting: 'show-last-third' },
        ];

        nightTimes.forEach(entry => {
            const item = new PopupMenu.PopupBaseMenuItem({ reactive: false, hover: false });
            const iconPath = `${this._ext.path}/assets/icons/${entry.id}.svg`;
            const icon = new St.Icon({
                gicon: Gio.icon_new_for_string(iconPath),
                icon_size: 16,
                style_class: 'system-status-icon',
                visible: showIcons,
            });
            const nameLabel = new St.Label({ text: this._prayerName(entry.name), x_expand: true, style: showIcons ? 'padding-left: 10px;' : '' });
            const timeLabel = new St.Label({ text: '--:--' });

            item.add_child(icon);
            item.add_child(nameLabel);
            item.add_child(timeLabel);

            item.visible = this._settings.get_boolean(entry.setting);

            this._nightItems[entry.name] = { item, icon, nameLabel, timeLabel, setting: entry.setting };
            this._indicator.menu.addMenuItem(item);
        });

        this._indicator.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const offlineItem = new PopupMenu.PopupBaseMenuItem({ reactive: false, hover: false });
        this._offlineLabel = new St.Label({
            text: '',
            x_expand: true,
            style: 'text-align: center; color: #f9a825; font-weight: bold; padding: 2px 8px;'
        });
        offlineItem.add_child(this._offlineLabel);
        this._offlineItem = offlineItem;
        this._offlineItem.visible = false;
        this._indicator.menu.addMenuItem(offlineItem);

        const settingsItem = new PopupMenu.PopupBaseMenuItem();
        const settingsBox = new St.BoxLayout({ x_expand: true, x_align: Clutter.ActorAlign.CENTER, style: 'spacing: 8px;' });
        const settingsIcon = new St.Icon({ icon_name: 'preferences-system-symbolic', icon_size: 16 });
        this._settingsLabel = new St.Label({
            text: this._t('Settings', 'الإعدادات'),
            y_expand: true,
            y_align: Clutter.ActorAlign.CENTER
        });
        settingsBox.add_child(settingsIcon);
        settingsBox.add_child(this._settingsLabel);
        settingsItem.add_child(settingsBox);
        settingsItem.connect('activate', () => {
            this._indicator.menu.close();
            this._ext.openPreferences();
        });
        this._indicator.menu.addMenuItem(settingsItem);
        this._settingsItem = settingsItem;
        this._settingsItem.visible = this._settings.get_boolean('show-settings-button');

        this._indicator.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._quranSeparator = new PopupMenu.PopupSeparatorMenuItem('Quran Player');
        this._indicator.menu.addMenuItem(this._quranSeparator);

        this._surahSubMenu = new PopupMenu.PopupSubMenuMenuItem('Select Surah (Loading...)');
        this._indicator.menu.addMenuItem(this._surahSubMenu);

        this._verseTextItem = new PopupMenu.PopupBaseMenuItem({ reactive: false });
        this._verseLabel = new St.Label({
            text: 'Press Play to start recitation',
            style: 'text-align: center; max-width: 300px; padding: 10px; font-size: 1.1em;'
        });
        this._verseLabel.clutter_text.line_wrap = true;
        this._verseTextItem.add_child(this._verseLabel);
        this._indicator.menu.addMenuItem(this._verseTextItem);

        const controlsItem = new PopupMenu.PopupBaseMenuItem({ reactive: false });
        const controlsBox = new St.BoxLayout({
            x_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
            style: 'spacing: 10px;'
        });

        this._playPauseBtn = new St.Button({
            child: new St.Icon({ icon_name: 'media-playback-start-symbolic', icon_size: 24 })
        });
        this._playPauseBtn.connect('clicked', () => {
            if (this._continuousQuran)
                this._pauseQuran();
            else
                this._playQuran();
        });

        controlsBox.add_child(this._playPauseBtn);
        controlsItem.add_child(controlsBox);
        this._indicator.menu.addMenuItem(controlsItem);

        this._quranItems = [
            this._quranSeparator,
            this._surahSubMenu,
            this._verseTextItem,
            controlsItem
        ];

        this._updateQuranPlayerVisibility();
    }

    _updateQuranPlayerVisibility() {
        const show = this._settings.get_boolean('show-quran-player');
        this._quranItems.forEach(item => (item.visible = show));
    }

    _updatePrayerIconsVisibility() {
        const show = this._settings.get_boolean('show-prayer-icons');
        for (const key in this._prayerItems) {
            const row = this._prayerItems[key];
            row.icon.visible = show;
            row.nameLabel.style = show ? 'padding-left: 10px;' : '';
        }
        for (const key in this._nightItems) {
            const row = this._nightItems[key];
            row.icon.visible = show;
            row.nameLabel.style = show ? 'padding-left: 10px;' : '';
        }
    }

    _updateNightTimesVisibility() {
        if (!this._nightItems) return;
        for (const key in this._nightItems) {
            const row = this._nightItems[key];
            row.item.visible = this._settings.get_boolean(row.setting);
        }
    }

    // quran playback

    // i18n helpers

    _t(en, ar) {
        return this._settings.get_int('language-index') === 1 ? ar : en;
    }

    _prayerName(name) {
        const AR = {
            Fajr: 'الفجر',
            Dhuhr: 'الظهر',
            Asr: 'العصر',
            Maghrib: 'المغرب',
            Isha: 'العشاء',
            Sunrise: 'الشروق',
            Midnight: 'منتصف الليل',
            LastThird: 'ثلث الليل الأخير'
        };
        const enName = name === 'LastThird' ? 'Last Third' : name;
        return this._t(enName, AR[name] || name);
    }

    _toDisplayNum(str) {
        if (!this._settings.get_boolean('use-arabic-numbers')) return str;
        return String(str).replace(/[0-9]/g, d => '٠١٢٣٤٥٦٧٨٩'[d]);
    }

    _refreshLanguage() {
        for (const [name, item] of Object.entries(this._prayerItems))
            item.nameLabel.set_text(this._prayerName(name));
        if (this._nightItems) {
            for (const [name, item] of Object.entries(this._nightItems))
                item.nameLabel.set_text(this._prayerName(name));
        }
        if (this._settingsLabel)
            this._settingsLabel.set_text(this._t('Settings', 'الإعدادات'));
        this._updateHijriDisplay();
        this._refreshTopbar();
    }

    // hijri

    _updateHijriDisplay() {
        const show = this._settings.get_boolean('show-hijri-date');
        if (this._hijriItem)   this._hijriItem.visible  = show;
        if (this._specialItem) this._specialItem.visible = show;
        if (!show) return;

        const offset = this._settings.get_int('hijri-offset') || 0;
        const isAr   = this._settings.get_int('language-index') === 1;
        let hDay, hMonth, hYear, mName;

        if (this._apiHijri) {
            hDay   = parseInt(this._apiHijri.day, 10) + offset;
            hMonth = parseInt(this._apiHijri.month.number, 10);
            hYear  = parseInt(this._apiHijri.year, 10);
            if (hDay > 30) { hDay -= 30; hMonth++; if (hMonth > 12) { hMonth = 1; hYear++; } }
            if (hDay < 1)  { hDay += 30; hMonth--; if (hMonth < 1)  { hMonth = 12; hYear--; } }
            mName = isAr
                ? (this._apiHijri.month.ar || HIJRI_MONTHS_AR[hMonth - 1])
                : (this._apiHijri.month.en || HIJRI_MONTHS_EN[hMonth - 1]);
        } else {
            const h = getHijriDate(new Date(), offset);
            hDay = h.day; hMonth = h.month; hYear = h.year;
            mName = isAr ? HIJRI_MONTHS_AR[hMonth - 1] : HIJRI_MONTHS_EN[hMonth - 1];
        }

        const suffix = isAr ? 'هـ' : 'AH';
        const displayDay  = this._toDisplayNum(String(hDay));
        const displayYear = this._toDisplayNum(String(hYear));
        this._hijriLabel.set_text(`${displayDay} ${mName} ${displayYear} ${suffix}`);

        const msg = this._getSpecialIslamicMessage(hDay, hMonth);
        this._specialLabel.set_text(msg);
        if (this._specialItem) this._specialItem.visible = show && msg !== '';
    }

    _getSpecialIslamicMessage(day, month) {
        const ar = this._settings.get_int('language-index') === 1;
        if (month === 9)  return ar ? 'شهر رمضان المبارك' : 'Month of Ramadan';
        if (month === 10 && day === 1)  return ar ? 'عيد الفطر المبارك' : 'Eid Al-Fitr';
        if (month === 12) {
            if (day === 9)  return ar ? 'يوم عرفة'          : 'Day of Arafah';
            if (day === 10) return ar ? 'عيد الأضحى المبارك' : 'Eid Al-Adha';
            if (day >= 1 && day <= 10) return ar ? 'العشر الأوائل من ذي الحجة' : 'First 10 Days of Dhu Al-Hijjah';
            if (day >= 11 && day <= 13) return ar ? 'أيام التشريق' : 'Ayyam Al-Tashreeq';
        }
        if (month === 1 && day === 1)  return ar ? 'رأس السنة الهجرية' : 'Islamic New Year';
        if (month === 1 && day === 10) return ar ? 'يوم عاشوراء'       : 'Day of Ashura';
        if (month === 3 && day === 12) return ar ? 'المولد النبوي الشريف ﷺ' : 'Mawlid Al-Nabi';
        if (day === 13 || day === 14 || day === 15)
            return ar ? 'الأيام البيض' : 'Ayyam Al-Bid (White Days)';
        if (day === 11)
            return ar ? 'الأيام البيض بعد يومين' : 'Ayyam Al-Bid in 2 days';
        if (day === 12)
            return ar ? 'الأيام البيض غدا' : 'Ayyam Al-Bid tomorrow';
        return '';
    }

    // ui update

    _updateUI() {
        const rawTimes = this._cachedTimes;
        if (!rawTimes || Object.keys(rawTimes).length === 0) return;

        const offsets = {
            Fajr:    this._settings.get_int('offset-fajr'),
            Dhuhr:   this._settings.get_int('offset-dhuhr'),
            Asr:     this._settings.get_int('offset-asr'),
            Maghrib: this._settings.get_int('offset-maghrib'),
            Isha:    this._settings.get_int('offset-isha'),
        };
        const times = {};
        for (const [p, t] of Object.entries(rawTimes))
            times[p] = applyOffset(t, offsets[p] || 0);

        this._adjustedTimes = times;

        const now = GLib.DateTime.new_now_local();
        this._todayDateStr = `${now.get_day_of_month()}-${now.get_month()}-${now.get_year()}`;
        const todayKey = `${now.get_year()}-${String(now.get_month()).padStart(2, '0')}-${String(now.get_day_of_month()).padStart(2, '0')}`;

        const use12h = this._settings.get_boolean('hour-format');
        const jsNow  = new Date();
        let nextPrayerName = null;
        let diffMs         = Infinity;

        for (const [prayer, timeStr] of Object.entries(times)) {
            if (!this._prayerItems[prayer]) continue;

            const [hStr, mStr] = timeStr.split(':');
            const h = parseInt(hStr, 10);
            const m = parseInt(mStr, 10);

            const pTime = new Date();
            pTime.setHours(h, m, 0, 0);
            if (pTime.getTime() <= jsNow.getTime()) pTime.setDate(pTime.getDate() + 1);

            const timeDiff = pTime.getTime() - jsNow.getTime();
            if (timeDiff > 0 && timeDiff < diffMs) { diffMs = timeDiff; nextPrayerName = prayer; }

            let displayStr;
            if (use12h) {
                const dh = h % 12 || 12;
                const ap = h >= 12 ? 'PM' : 'AM';
                displayStr = this._toDisplayNum(`${dh}:${m.toString().padStart(2, '0')}`) + ` ${ap}`;
            } else {
                displayStr = this._toDisplayNum(timeStr);
            }
            this._prayerItems[prayer].timeLabel.set_text(displayStr);

            const preMin = this._settings.get_int('pre-notification-minutes');
            if (preMin > 0) {
                const minutesUntil = Math.round(timeDiff / 60000);
                const preKey = `${prayer}-${todayKey}`;
                if (minutesUntil === preMin && !this._preNotifiedSet.has(preKey)) {
                    this._preNotifiedSet.add(preKey);
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

        if (this._nightItems && times.Maghrib && times.Fajr) {
            const nightTimes = this._calcJafariNightTimes(times.Maghrib, times.Fajr);
            if (nightTimes) {
                if (this._nightItems.Midnight)
                    this._nightItems.Midnight.timeLabel.set_text(this._formatTimeDisplay(nightTimes.Midnight, use12h));
                if (this._nightItems.LastThird)
                    this._nightItems.LastThird.timeLabel.set_text(this._formatTimeDisplay(nightTimes.LastThird, use12h));
            } else {
                if (this._nightItems.Midnight)
                    this._nightItems.Midnight.timeLabel.set_text('--:--');
                if (this._nightItems.LastThird)
                    this._nightItems.LastThird.timeLabel.set_text('--:--');
            }
        }

        this._nextPrayerName = nextPrayerName;
        this._nextPrayerMs   = diffMs;

        this._updateHijriDisplay();
        this._updateOfflineBadge();
        this._refreshTopbar();
        this._scheduleAtPrayerAlarm(nextPrayerName, diffMs);
    }

    _formatTimeDisplay(timeStr, use12h) {
        if (!timeStr || timeStr === '--:--') return '--:--';
        const [hStr, mStr] = timeStr.split(':');
        const h = parseInt(hStr, 10);
        const m = parseInt(mStr, 10);
        if (isNaN(h) || isNaN(m)) return '--:--';

        if (use12h) {
            const dh = h % 12 || 12;
            const ap = h >= 12 ? 'PM' : 'AM';
            return this._toDisplayNum(`${dh}:${m.toString().padStart(2, '0')}`) + ` ${ap}`;
        }
        return this._toDisplayNum(timeStr);
    }

    // topbar + offline badge

    _updateOfflineBadge() {
        if (!this._offlineItem) return;
        if (this._isOffline && this._noCoords) {
            this._offlineLabel.set_text(this._t(
                'No location set — open Settings and enter your coordinates.',
                'لا يوجد موقع — افتح الإعدادات وأدخل الإحداثيات.'
            ));
            this._offlineItem.visible = true;
        } else {
            this._offlineItem.visible = false;
        }
    }

    _refreshTopbar() {
        const name   = this._nextPrayerName;
        const diffMs = this._nextPrayerMs;

        if (!name) {
            this._nextPrayerLabel.set_text(
                this._isOffline ? this._t('Offline', 'غير متصل') : '...'
            );
            return;
        }

        const fmt          = this._settings.get_int('topbar-display-format') || 0;
        const totalMinutes = Math.floor(diffMs / 60000);
        const rh           = Math.floor(totalMinutes / 60);
        const rm           = totalMinutes % 60;
        const countdown    = this._toDisplayNum(`${rh.toString().padStart(2, '0')}:${rm.toString().padStart(2, '0')}`);
        const pName        = this._prayerName(name);

        const _formatAbsTime = (timeStr) => {
            const [hStr, mStr] = timeStr.split(':');
            const h = parseInt(hStr, 10);
            const m = parseInt(mStr, 10);
            if (this._settings.get_boolean('hour-format')) {
                const dh = h % 12 || 12;
                const ap = h >= 12 ? this._t('PM', 'م') : this._t('AM', 'ص');
                return this._toDisplayNum(`${dh}:${m.toString().padStart(2, '0')}`) + ` ${ap}`;
            }
            return this._toDisplayNum(timeStr);
        };

        let text;
        const timeStr = (this._adjustedTimes && this._adjustedTimes[name]) || this._cachedTimes[name] || '';
        if (fmt === 0) {
            text = `${pName}  ${_formatAbsTime(timeStr)}`;
        } else if (fmt === 1) {
            text = `${pName}  ${countdown}`;
        } else if (fmt === 2) {
            text = countdown;
        } else {
            const inWord = this._t('In', 'بعد');
            text = `${pName}: ${_formatAbsTime(timeStr)} / ${inWord}: ${countdown}`;
        }

        this._nextPrayerLabel.set_text(text);
    }

    // no-coords fallback

    _showNoCoordinatesPrompt() {
        this._nextPrayerLabel.set_text(this._t('Set location', 'حدد موقعك'));

        if (this._hijriLabel)
            this._hijriLabel.set_text(this._t(
                'No location set — open Settings to configure.',
                'لا يوجد موقع — افتح الإعدادات للضبط.'
            ));
        if (this._hijriItem)   this._hijriItem.visible   = true;
        if (this._specialItem) this._specialItem.visible = false;

        for (const item of Object.values(this._prayerItems))
            item.timeLabel.set_text('--:--');
        if (this._nightItems) {
            for (const item of Object.values(this._nightItems))
                item.timeLabel.set_text('--:--');
        }
    }

    disable() {
        this._settings.disconnectObject(this);

        if (this._updateTimer) {
            GLib.Source.remove(this._updateTimer);
            this._updateTimer = null;
        }
        if (this._resolveTimeout) {
            GLib.Source.remove(this._resolveTimeout);
            this._resolveTimeout = null;
        }
        if (this._refetchTimeout) {
            GLib.Source.remove(this._refetchTimeout);
            this._refetchTimeout = null;
        }
        if (this._alarmTimerAtPrayer) {
            GLib.Source.remove(this._alarmTimerAtPrayer);
            this._alarmTimerAtPrayer = null;
        }
        if (this._adhanStopTimer) {
            GLib.Source.remove(this._adhanStopTimer);
            this._adhanStopTimer = null;
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

        this._nextPrayerLabel.destroy(); this._nextPrayerLabel = null;
        this._hijriLabel.destroy();      this._hijriLabel = null;
        this._hijriItem.destroy();       this._hijriItem = null;
        this._specialLabel.destroy();    this._specialLabel = null;
        this._specialItem.destroy();     this._specialItem = null;
        this._offlineLabel.destroy();    this._offlineLabel = null;
        this._offlineItem.destroy();     this._offlineItem = null;
        this._settingsLabel.destroy();   this._settingsLabel = null;
        this._settingsItem.destroy();    this._settingsItem = null;
        this._verseLabel.destroy();      this._verseLabel = null;
        this._verseTextItem.destroy();   this._verseTextItem = null;
        this._playPauseBtn.destroy();    this._playPauseBtn = null;
        this._surahSubMenu.destroy();    this._surahSubMenu = null;
        this._quranSeparator.destroy();  this._quranSeparator = null;
        this._prayerItems = {};
        this._nightItems = {};
        this._quranItems = [];

        this._indicator.destroy();
        this._indicator = null;

        this._settings = null;
    }
}
