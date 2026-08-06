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
import { LocationService } from '../logic/location.js';
import { AudioPlayer }     from '../logic/audio.js';

export class SalatController {
    constructor(ext) {
        this._ext      = ext;
        this._settings = ext.getSettings();
        this._api      = new AlAdhanAPI();
        this._locationService = new LocationService(this._settings);

        this._playerA      = new AudioPlayer();
        this._playerB      = new AudioPlayer();
        this._adhanPlayer  = new AudioPlayer();
        this._notifPlayer  = new AudioPlayer();
        this._quranSession = new Soup.Session();

        this._isAdhanPlaying  = false;
        this._continuousQuran = false;
        this._isPaused        = false;
        this._activePlayer    = this._playerA;

        this._quranCurrentSurah   = 1;
        this._quranCurrentAyah    = 1;
        this._quranGlobalAyah     = 1;
        this._isPlayingBismallah  = false;

        this._cachedTimes        = {};
        this._apiHijri           = null;
        this._isOffline          = false;
        this._noCoords           = false;
        this._nextPrayerName     = null;
        this._nextPrayerMs       = 0;
        this._todayDateStr       = null;
        this._alarmTimerAtPrayer = null;
        this._adhanStopTimer     = null;
        this._adhanTriggeredFor  = null;
        this._resolveTimeout     = null;
        this._refetchTimeout     = null;
        this._resumeQuran        = false;
        this._preNotifiedSet     = new Set();

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
            'changed::timezone',              this._updateUI.bind(this),
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
            'changed::topbar-placement', () => {
                if (!this._indicator) return;
                this._indicator.destroy();
                this._indicator = null;
                this._buildIndicator();
                this._fetchSurahs();
                this._updateQuranPlayerVisibility();
                this._updatePrayerIconsVisibility();
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
            if (ds !== this._todayDateStr)
                this._fetchTodayTimes();
            else
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
    }

    // quran playback

    _fetchSurahs() {
        const msg = Soup.Message.new('GET', 'https://api.alquran.cloud/v1/surah');
        this._quranSession.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null, (session, res) => {
            try {
                const bytes = session.send_and_read_finish(res);
                const data = JSON.parse(new TextDecoder().decode(bytes.get_data()));

                this._surahAyahCounts = data.data.map(s => s.numberOfAyahs);
                this._surahNames      = data.data.map(s => s.englishName);
                this._surahSubMenu.label.set_text('Select Surah');
                data.data.forEach(surah => {
                    const item = new PopupMenu.PopupMenuItem(`${surah.number}. ${surah.englishName}`);
                    item.connect('activate', () => {
                        this._quranCurrentSurah = surah.number;
                        this._quranCurrentAyah  = 1;
                        this._isPaused = false;
                        this._surahSubMenu.label.set_text(`Surah ${surah.englishName}`);
                        this._playQuran();
                    });
                    this._surahSubMenu.menu.addMenuItem(item);
                });
            } catch (e) {
                console.error('[SalatPrayerTime] Error fetching surahs:', e);
            }
        });
    }

    _playQuran() {
        this._continuousQuran = true;
        this._playPauseBtn.child.icon_name = 'media-playback-pause-symbolic';

        if (this._isPaused) {
            this._isPaused = false;
            this._activePlayer.play();
        } else {
            this._fetchAndPlayAyah(this._quranCurrentSurah, this._quranCurrentAyah, this._activePlayer);
        }
    }

    _pauseQuran() {
        this._continuousQuran = false;
        this._isPaused = true;
        this._playPauseBtn.child.icon_name = 'media-playback-start-symbolic';
        this._activePlayer.pause();
    }

    _fetchAndPlayAyah(surah, ayah, player) {
        let actualSurah = surah;
        let actualAyah  = ayah;

        if (ayah === 1 && surah !== 1 && surah !== 9 && !this._isPlayingBismallah) {
            this._isPlayingBismallah = true;
            actualSurah = 1;
            actualAyah  = 1;
        } else if (this._isPlayingBismallah) {
            this._isPlayingBismallah = false;
        }

        const reciters = [
            'Abdul_Basit_Murattal_192kbps',
            'Abdul_Basit_Mujawwad_128kbps',
            'Abdurrahmaan_As-Sudais_192kbps',
            'Saood_ash-Shuraym_128kbps',
            'Alafasy_128kbps',
            'Minshawy_Mujawwad_192kbps',
            'Minshawy_Murattal_128kbps',
            'Husary_128kbps',
            'Abu_Bakr_Ash-Shaatree_128kbps'
        ];
        const reciter     = reciters[this._settings.get_int('quran-reciter-index') || 0];
        const paddedSurah = actualSurah.toString().padStart(3, '0');
        const paddedAyah  = actualAyah.toString().padStart(3, '0');
        const url         = `https://everyayah.com/data/${reciter}/${paddedSurah}${paddedAyah}.mp3`;

        player.setVolume(this._settings.get_double('quran-volume') || 0.7);
        player.setSource(url);
        player.play();

        if (this._isPlayingBismallah) {
            let bism = 'بِسْمِ ٱللَّهِ ٱلرَّحْمَٰنِ ٱلرَّحِيمِ';
            if (this._settings.get_boolean('show-quran-translation'))
                bism += '\n\nIn the Name of Allah—the Most Compassionate, Most Merciful.';
            this._verseLabel.set_text(bism);
        } else {
            const showTrans = this._settings.get_boolean('show-quran-translation');
            const editions = showTrans ? 'quran-uthmani,en.itani' : 'quran-uthmani';
            const textMsg = Soup.Message.new(
                'GET',
                `https://api.alquran.cloud/v1/ayah/${surah}:${ayah}/editions/${editions}`
            );
            this._quranSession.send_and_read_async(textMsg, GLib.PRIORITY_DEFAULT, null, (s, res) => {
                try {
                    const bytes = s.send_and_read_finish(res);
                    const data  = JSON.parse(new TextDecoder().decode(bytes.get_data()));
                    if (data.data && data.data[0]) {
                        let text = data.data[0].text;
                        if (showTrans && data.data[1])
                            text += '\n\n' + data.data[1].text;
                        this._verseLabel.set_text(text);
                        this._quranGlobalAyah = data.data[0].number;
                    }
                } catch (_e) {}
            });
        }
    }

    _onQuranVerseEnded(nextPlayer) {
        if (!this._continuousQuran) return;

        if (this._isPlayingBismallah) {
            this._activePlayer = nextPlayer;
            this._fetchAndPlayAyah(this._quranCurrentSurah, this._quranCurrentAyah, this._activePlayer);
            return;
        }

        this._quranCurrentAyah++;
        this._quranGlobalAyah++;

        const surahLength = this._surahAyahCounts
            ? this._surahAyahCounts[this._quranCurrentSurah - 1]
            : null;

        if (surahLength !== null && this._quranCurrentAyah > surahLength) {
            this._quranCurrentSurah = this._quranCurrentSurah >= 114
                ? 1
                : this._quranCurrentSurah + 1;
            this._quranCurrentAyah = 1;

            if (this._surahNames)
                this._surahSubMenu.label.set_text(`Surah ${this._surahNames[this._quranCurrentSurah - 1]}`);
        }

        this._activePlayer = nextPlayer;
        this._fetchAndPlayAyah(this._quranCurrentSurah, this._quranCurrentAyah, this._activePlayer);
    }

    // location

    _resolveCoordinates() {
        if (this._settings.get_boolean('auto-location')) return;
        if (this._settings.get_boolean('use-coordinates')) return;

        if (this._resolveTimeout) {
            GLib.Source.remove(this._resolveTimeout);
            this._resolveTimeout = null;
        }

        this._resolveTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1500, () => {
            this._resolveTimeout = null;
            const city    = this._settings.get_string('city');
            const country = this._settings.get_string('country');
            if (city && country) {
                this._api.getCoordinatesByCity(city, country).then(coords => {
                    if (!this._settings) return;
                    this._settings.set_string('latitude', coords.lat.toString());
                    this._settings.set_string('longitude', coords.lng.toString());
                    if (coords.timezone)
                        this._settings.set_string('timezone', coords.timezone);
                    this._fetchTodayTimes();
                }).catch(e => {
                    console.error('[SalatPrayerTime] Failed to resolve coordinates:', e);
                });
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    _refetchAndUpdate() {
        if (this._refetchTimeout) {
            GLib.Source.remove(this._refetchTimeout);
            this._refetchTimeout = null;
        }
        this._refetchTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
            this._refetchTimeout = null;
            this._api.clearCache();
            this._fetchTodayTimes();
            return GLib.SOURCE_REMOVE;
        });
    }

    // prayer times

    _fetchTodayTimes() {
        const latStr = this._settings.get_string('latitude');
        const lngStr = this._settings.get_string('longitude');
        let lat      = parseFloat(latStr || '');
        let lng      = parseFloat(lngStr || '');
        const method = this._settings.get_int('method') || 3;
        const school = this._settings.get_int('school') || 0;

        const noCoords = !latStr || isNaN(lat);
        if (noCoords) { lat = 21.4225; lng = 39.8262; }
        this._noCoords = noCoords;

        const fetchOnline = () => {
            this._api.fetchAndCacheMonthly(lat, lng, method, school).then(result => {
                if (!this._settings) return;
                this._isOffline   = false;
                this._cachedTimes = result.timings;
                this._apiHijri    = result.hijri || null;
                this._updateUI();
            }).catch(err => {
                if (!this._settings) return;
                console.warn('[SalatPrayerTime] API unavailable, using offline calc:', err.message);
                this._isOffline   = true;
                this._apiHijri    = null;
                this._cachedTimes = this._calcOfflineTimes(lat, lng, method, school);
                this._updateUI();
            });
        };

        if (noCoords) {
            fetchOnline();
            return;
        }

        this._api.loadTodayFromCache(lat, lng, method, school).then(cached => {
            if (!this._settings) return;
            if (cached) {
                this._isOffline   = false;
                this._cachedTimes = cached.timings;
                this._apiHijri    = cached.hijri || null;
                this._updateUI();
            } else {
                fetchOnline();
            }
        });
    }

    _calcOfflineTimes(lat, lng, methodIndex, schoolIndex) {
        const now = GLib.DateTime.new_now_local();
        const utcOffset = now.get_utc_offset() / (3600 * 1000000);
        const times = calcOfflineTimes(new Date(), lat, lng, utcOffset, methodIndex, schoolIndex);
        return {
            Fajr:    times.Fajr,
            Dhuhr:   times.Dhuhr,
            Asr:     times.Asr,
            Maghrib: times.Maghrib,
            Isha:    times.Isha,
        };
    }

    // i18n helpers

    _t(en, ar) {
        return this._settings.get_int('language-index') === 1 ? ar : en;
    }

    _prayerName(name) {
        const AR = { Fajr: 'الفجر', Dhuhr: 'الظهر', Asr: 'العصر', Maghrib: 'المغرب', Isha: 'العشاء', Sunrise: 'الشروق' };
        return this._t(name, AR[name] || name);
    }

    _toDisplayNum(str) {
        if (!this._settings.get_boolean('use-arabic-numbers')) return str;
        return String(str).replace(/[0-9]/g, d => '٠١٢٣٤٥٦٧٨٩'[d]);
    }

    _refreshLanguage() {
        for (const [name, item] of Object.entries(this._prayerItems))
            item.nameLabel.set_text(this._prayerName(name));
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

        this._nextPrayerName = nextPrayerName;
        this._nextPrayerMs   = diffMs;

        this._updateHijriDisplay();
        this._updateOfflineBadge();
        this._refreshTopbar();
        this._scheduleAtPrayerAlarm(nextPrayerName, diffMs);
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

    // alarm

    _scheduleAtPrayerAlarm(prayerName, diffMs) {
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

    _triggerAdhan(prayerName) {
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

    _onAdhanEnded() {
        this._isAdhanPlaying = false;
        if (this._resumeQuran) {
            this._resumeQuran = false;
            this._playQuran();
        }
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
        this._quranItems = [];

        this._indicator.destroy();
        this._indicator = null;

        this._settings = null;
    }
}
