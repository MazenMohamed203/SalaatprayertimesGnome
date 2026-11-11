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

    _buildIndicator() {
        this.state._indicator = new PanelMenu.Button(0.5, this._ext.metadata.name, false);
        this.state._nextPrayerLabel = new St.Label({
            text: '...',
            y_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
            style: 'padding: 0px 8px;'
        });
        this.state._indicator.add_child(this.state._nextPrayerLabel);
        this._buildMenu();

        const placementInt = this._settings.get_int('topbar-placement') || 0;
        const box = placementInt === 1 ? 'center' : placementInt === 2 ? 'left' : 'right';
        const position = box === 'left' ? 1 : 0;
        Main.panel.addToStatusArea(this._ext.uuid, this.state._indicator, position, box);
    }

    // menu

    _buildMenu() {
        this.state._prayerItems = {};
        this.state._nightItems = {};

        const hijriItem = new PopupMenu.PopupBaseMenuItem({ reactive: false, hover: false });
        this.state._hijriLabel = new St.Label({
            text: '...',
            x_expand: true,
            style: 'text-align: center; font-style: italic; padding: 4px 8px;'
        });
        hijriItem.add_child(this.state._hijriLabel);
        this.state._hijriItem = hijriItem;
        this.state._indicator.menu.addMenuItem(hijriItem);

        const specialItem = new PopupMenu.PopupBaseMenuItem({ reactive: false, hover: false });
        this.state._specialLabel = new St.Label({
            text: '',
            x_expand: true,
            style: 'text-align: center; font-weight: bold; padding: 0 8px 4px;'
        });
        specialItem.add_child(this.state._specialLabel);
        this.state._specialItem = specialItem;
        this.state._indicator.menu.addMenuItem(specialItem);

        this.state._indicator.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

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

            this.state._prayerItems[prayer.name] = { item, icon, nameLabel, timeLabel };
            this.state._indicator.menu.addMenuItem(item);
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

            this.state._nightItems[entry.name] = { item, icon, nameLabel, timeLabel, setting: entry.setting };
            this.state._indicator.menu.addMenuItem(item);
        });

        this.state._indicator.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const offlineItem = new PopupMenu.PopupBaseMenuItem({ reactive: false, hover: false });
        this.state._offlineLabel = new St.Label({
            text: '',
            x_expand: true,
            style: 'text-align: center; color: #f9a825; font-weight: bold; padding: 2px 8px;'
        });
        offlineItem.add_child(this.state._offlineLabel);
        this.state._offlineItem = offlineItem;
        this.state._offlineItem.visible = false;
        this.state._indicator.menu.addMenuItem(offlineItem);

        const settingsItem = new PopupMenu.PopupBaseMenuItem();
        const settingsBox = new St.BoxLayout({ x_expand: true, x_align: Clutter.ActorAlign.CENTER, style: 'spacing: 8px;' });
        const settingsIcon = new St.Icon({ icon_name: 'preferences-system-symbolic', icon_size: 16 });
        this.state._settingsLabel = new St.Label({
            text: this._t('Settings', 'الإعدادات'),
            y_expand: true,
            y_align: Clutter.ActorAlign.CENTER
        });
        settingsBox.add_child(settingsIcon);
        settingsBox.add_child(this.state._settingsLabel);
        settingsItem.add_child(settingsBox);
        settingsItem.connect('activate', () => {
            this.state._indicator.menu.close();
            this._ext.openPreferences();
        });
        this.state._indicator.menu.addMenuItem(settingsItem);
        this.state._settingsItem = settingsItem;
        this.state._settingsItem.visible = this._settings.get_boolean('show-settings-button');

        this.state._indicator.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this.state._quranSeparator = new PopupMenu.PopupSeparatorMenuItem('Quran Player');
        this.state._indicator.menu.addMenuItem(this.state._quranSeparator);

        this.state._surahSubMenu = new PopupMenu.PopupSubMenuMenuItem('Select Surah (Loading...)');
        this.state._indicator.menu.addMenuItem(this.state._surahSubMenu);

        this.state._verseTextItem = new PopupMenu.PopupBaseMenuItem({ reactive: false });
        this.state._verseLabel = new St.Label({
            text: 'Press Play to start recitation',
            style: 'text-align: center; max-width: 300px; padding: 10px; font-size: 1.1em;'
        });
        this.state._verseLabel.clutter_text.line_wrap = true;
        this.state._verseTextItem.add_child(this.state._verseLabel);
        this.state._indicator.menu.addMenuItem(this.state._verseTextItem);

        const controlsItem = new PopupMenu.PopupBaseMenuItem({ reactive: false });
        const controlsBox = new St.BoxLayout({
            x_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
            style: 'spacing: 10px;'
        });

        this.state._playPauseBtn = new St.Button({
            child: new St.Icon({ icon_name: 'media-playback-start-symbolic', icon_size: 24 })
        });
        this.state._playPauseBtn.connect('clicked', () => {
            if (this.state._continuousQuran)
                this._pauseQuran();
            else
                this._playQuran();
        });

        controlsBox.add_child(this.state._playPauseBtn);
        controlsItem.add_child(controlsBox);
        this.state._indicator.menu.addMenuItem(controlsItem);

        this.state._quranItems = [
            this.state._quranSeparator,
            this.state._surahSubMenu,
            this.state._verseTextItem,
            controlsItem
        ];

        this._updateQuranPlayerVisibility();
    }

    _updateQuranPlayerVisibility() {
        const show = this._settings.get_boolean('show-quran-player');
        this.state._quranItems.forEach(item => (item.visible = show));
    }

    _updatePrayerIconsVisibility() {
        const show = this._settings.get_boolean('show-prayer-icons');
        for (const key in this.state._prayerItems) {
            const row = this.state._prayerItems[key];
            row.icon.visible = show;
            row.nameLabel.style = show ? 'padding-left: 10px;' : '';
        }
        for (const key in this.state._nightItems) {
            const row = this.state._nightItems[key];
            row.icon.visible = show;
            row.nameLabel.style = show ? 'padding-left: 10px;' : '';
        }
    }

    _updateNightTimesVisibility() {
        if (!this.state._nightItems) return;
        for (const key in this.state._nightItems) {
            const row = this.state._nightItems[key];
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
        for (const [name, item] of Object.entries(this.state._prayerItems))
            item.nameLabel.set_text(this._prayerName(name));
        if (this.state._nightItems) {
            for (const [name, item] of Object.entries(this.state._nightItems))
                item.nameLabel.set_text(this._prayerName(name));
        }
        if (this.state._settingsLabel)
            this.state._settingsLabel.set_text(this._t('Settings', 'الإعدادات'));
        this._updateHijriDisplay();
        this._refreshTopbar();
    }

    // hijri

    _updateHijriDisplay() {
        const show = this._settings.get_boolean('show-hijri-date');
        if (this.state._hijriItem)   this.state._hijriItem.visible  = show;
        if (this.state._specialItem) this.state._specialItem.visible = show;
        if (!show) return;

        const offset = this._settings.get_int('hijri-offset') || 0;
        const isAr   = this._settings.get_int('language-index') === 1;
        let hDay, hMonth, hYear, mName;

        if (this.state._apiHijri) {
            hDay   = parseInt(this.state._apiHijri.day, 10) + offset;
            hMonth = parseInt(this.state._apiHijri.month.number, 10);
            hYear  = parseInt(this.state._apiHijri.year, 10);
            if (hDay > 30) { hDay -= 30; hMonth++; if (hMonth > 12) { hMonth = 1; hYear++; } }
            if (hDay < 1)  { hDay += 30; hMonth--; if (hMonth < 1)  { hMonth = 12; hYear--; } }
            mName = isAr
                ? (this.state._apiHijri.month.ar || HIJRI_MONTHS_AR[hMonth - 1])
                : (this.state._apiHijri.month.en || HIJRI_MONTHS_EN[hMonth - 1]);
        } else {
            const h = getHijriDate(new Date(), offset);
            hDay = h.day; hMonth = h.month; hYear = h.year;
            mName = isAr ? HIJRI_MONTHS_AR[hMonth - 1] : HIJRI_MONTHS_EN[hMonth - 1];
        }

        const suffix = isAr ? 'هـ' : 'AH';
        const displayDay  = this._toDisplayNum(String(hDay));
        const displayYear = this._toDisplayNum(String(hYear));
        this.state._hijriLabel.set_text(`${displayDay} ${mName} ${displayYear} ${suffix}`);

        const msg = this._getSpecialIslamicMessage(hDay, hMonth);
        this.state._specialLabel.set_text(msg);
        if (this.state._specialItem) this.state._specialItem.visible = show && msg !== '';
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
        const rawTimes = this.state._cachedTimes;
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

        this.state._adjustedTimes = times;

        const now = GLib.DateTime.new_now_local();
        this.state._todayDateStr = `${now.get_day_of_month()}-${now.get_month()}-${now.get_year()}`;
        const todayKey = `${now.get_year()}-${String(now.get_month()).padStart(2, '0')}-${String(now.get_day_of_month()).padStart(2, '0')}`;

        const use12h = this._settings.get_boolean('hour-format');
        const jsNow  = new Date();
        let nextPrayerName = null;
        let diffMs         = Infinity;

        for (const [prayer, timeStr] of Object.entries(times)) {
            if (!this.state._prayerItems[prayer]) continue;

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
        if (!this.state._offlineItem) return;
        if (this.state._isOffline && this.state._noCoords) {
            this.state._offlineLabel.set_text(this._t(
                'No location set — open Settings and enter your coordinates.',
                'لا يوجد موقع — افتح الإعدادات وأدخل الإحداثيات.'
            ));
            this.state._offlineItem.visible = true;
        } else {
            this.state._offlineItem.visible = false;
        }
    }

    _refreshTopbar() {
        const name   = this.state._nextPrayerName;
        const diffMs = this.state._nextPrayerMs;

        if (!name) {
            this.state._nextPrayerLabel.set_text(
                this.state._isOffline ? this._t('Offline', 'غير متصل') : '...'
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
        const timeStr = (this.state._adjustedTimes && this.state._adjustedTimes[name]) || this.state._cachedTimes[name] || '';
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

        this.state._nextPrayerLabel.set_text(text);
    }

    // no-coords fallback

    _showNoCoordinatesPrompt() {
        this.state._nextPrayerLabel.set_text(this._t('Set location', 'حدد موقعك'));

        if (this.state._hijriLabel)
            this.state._hijriLabel.set_text(this._t(
                'No location set — open Settings to configure.',
                'لا يوجد موقع — افتح الإعدادات للضبط.'
            ));
        if (this.state._hijriItem)   this.state._hijriItem.visible   = true;
        if (this.state._specialItem) this.state._specialItem.visible = false;

        for (const item of Object.values(this.state._prayerItems))
            item.timeLabel.set_text('--:--');
        if (this.state._nightItems) {
            for (const item of Object.values(this.state._nightItems))
                item.timeLabel.set_text('--:--');
        }
    }

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
