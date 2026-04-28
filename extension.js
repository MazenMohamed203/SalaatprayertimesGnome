import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

import { AlAdhanAPI }                                         from './logic/api.js';
import { calcOfflineTimes, getHijriDate, applyOffset,
         HIJRI_MONTHS_EN, HIJRI_MONTHS_AR }                   from './logic/offlineCalc.js';
import { LocationService }  from './logic/location.js';
import { AudioPlayer }      from './logic/audio.js';

export default class SalatPrayerTimeExtension extends Extension {
    enable() {
        this._settings = this.getSettings('org.gnome.shell.extensions.salatprayertime');
        this._api = new AlAdhanAPI();
        this._locationService = new LocationService(this._settings);

        // Audio players for A/B gapless Quran playback, Adhan, and notifications
        this._playerA       = new AudioPlayer();
        this._playerB       = new AudioPlayer();
        this._adhanPlayer   = new AudioPlayer();
        this._notifPlayer   = new AudioPlayer(); // for pre-prayer notification beep

        this._isAdhanPlaying = false;
        this._continuousQuran = false;
        this._isPaused = false;            // FIX: track paused state for correct resume
        this._activePlayer = this._playerA;
        this._quranCurrentSurah = 1;
        this._quranCurrentAyah = 1;
        this._quranGlobalAyah = 1;
        this._isPlayingBismallah = false;

        // Cached prayer times and hijri date
        this._cachedTimes = {};
        this._apiHijri    = null;
        this._isOffline   = false; // true when last fetch fell back to offline calc
        this._noCoords    = false; // true when no coords were set at time of fetch
        this._nextPrayerName = null;
        this._nextPrayerMs = 0;
        this._todayDateStr = null;

        // Precise alarm timers
        this._alarmTimerAtPrayer  = null;
        this._adhanTriggeredFor   = null;
        this._preNotifiedSet      = new Set();

        this._playerA.connect('eos', () => this._onQuranVerseEnded(this._playerB));
        this._playerB.connect('eos', () => this._onQuranVerseEnded(this._playerA));
        this._adhanPlayer.connect('eos', () => this._onAdhanEnded());

        // Start location resolution
        if (this._settings.get_boolean('auto-location')) {
            this._locationService.start();
        } else {
            this._resolveCoordinates();
        }

        // Wire settings change signals — store IDs so we can disconnect in disable()
        this._settingsHandlers = [];
        const S = (key, cb) => this._settingsHandlers.push(this._settings.connect(key, cb));

        S('changed::auto-location', () => {
            if (this._settings.get_boolean('auto-location')) {
                this._locationService.start();
            } else {
                this._locationService.stop();
                this._resolveCoordinates();
            }
        });
        S('changed::city',             this._resolveCoordinates.bind(this));
        S('changed::country',          this._resolveCoordinates.bind(this));
        S('changed::use-coordinates',  () => {
            if (!this._settings.get_boolean('use-coordinates')) {
                this._resolveCoordinates();
            } else {
                this._updateUI();
            }
        });
        S('changed::latitude',               this._refetchAndUpdate.bind(this));
        S('changed::longitude',              this._refetchAndUpdate.bind(this));
        S('changed::timezone',               this._updateUI.bind(this));
        S('changed::method',                 this._refetchAndUpdate.bind(this));
        S('changed::school',                 this._refetchAndUpdate.bind(this));
        S('changed::topbar-display-format',  this._refreshTopbar.bind(this));
        S('changed::hour-format',            this._updateUI.bind(this));
        S('changed::offset-fajr',            this._updateUI.bind(this));
        S('changed::offset-dhuhr',           this._updateUI.bind(this));
        S('changed::offset-asr',             this._updateUI.bind(this));
        S('changed::offset-maghrib',         this._updateUI.bind(this));
        S('changed::offset-isha',            this._updateUI.bind(this));
        S('changed::hijri-offset',           this._updateHijriDisplay.bind(this));
        S('changed::show-hijri-date',        this._updateHijriDisplay.bind(this));
        S('changed::language-index',         this._refreshLanguage.bind(this));
        S('changed::use-arabic-numbers',     this._updateUI.bind(this));
        S('changed::show-settings-button',   () => {
            if (this._settingsItem)
                this._settingsItem.visible = this._settings.get_boolean('show-settings-button');
        });
        S('changed::show-quran-player',      () => this._updateQuranPlayerVisibility());
        S('changed::topbar-placement', () => {
            if (!this._indicator) return;

            // Fully destroy the old indicator to avoid GNOME Shell tracking bugs
            this._indicator.destroy();
            this._indicator = null;

            // Rebuild indicator and label, with 0.5 for centered popup menu
            this._indicator = new PanelMenu.Button(0.5, this.metadata.name, false);
            this._nextPrayerLabel = new St.Label({
                text: '...',
                y_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
                style: 'padding: 0px 8px;'
            });
            this._indicator.add_child(this._nextPrayerLabel);
            
            // Rebuild the menu
            this._buildMenu();
            
            const placementInt = this._settings.get_int('topbar-placement') || 0;
            const box = placementInt === 1 ? 'center' : placementInt === 2 ? 'left' : 'right';
            // Put it at position 1 in the left box so it's to the right of the Activities button
            const position = box === 'left' ? 1 : 0;
            Main.panel.addToStatusArea(this.uuid, this._indicator, position, box);

            // Re-fetch Surahs for the newly built Quran menu
            this._fetchSurahs();

            // Refresh UI state to populate the new label and menu
            this._updateQuranPlayerVisibility();
            if (this._noCoords) {
                this._showNoCoordinatesPrompt();
            } else {
                this._updateUI();
            }
        });


        // Build panel indicator — text only, no icon. 0.5 menuAlignment to center the popup.
        this._indicator = new PanelMenu.Button(0.5, this.metadata.name, false);
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
        const position = box === 'left' ? 1 : 0; // Position 1 in 'left' box skips Activities button
        Main.panel.addToStatusArea(this.uuid, this._indicator, position, box);

        // Update every minute; re-fetch prayer times if the date has changed (midnight)
        this._updateTimer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 60, () => {
            const now = GLib.DateTime.new_now_local();
            const ds  = `${now.get_day_of_month()}-${now.get_month()}-${now.get_year()}`;
            if (ds !== this._todayDateStr) {
                this._fetchTodayTimes(); // new day — refetch from API
            } else {
                this._updateUI();
            }
            return GLib.SOURCE_CONTINUE;
        });
        this._fetchTodayTimes(); // initial load (online → cache → offline)

        // Fetch Surah list
        this._fetchSurahs();
    }

    // ─── Menu Construction ────────────────────────────────────────────────────

    _buildMenu() {
        this._prayerItems = {};

        // ── Hijri date row ────────────────────────────────────────────────────
        const hijriItem = new PopupMenu.PopupBaseMenuItem({ reactive: false, hover: false });
        this._hijriLabel = new St.Label({
            text: '...',
            x_expand: true,
            style: 'text-align: center; font-style: italic; padding: 4px 8px;'
        });
        hijriItem.add_child(this._hijriLabel);
        this._hijriItem = hijriItem;
        this._indicator.menu.addMenuItem(hijriItem);

        // ── Special Islamic message row ───────────────────────────────────────
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

        prayers.forEach(prayer => {
            const item = new PopupMenu.PopupBaseMenuItem({ reactive: false, hover: false });
            const iconPath = `${this.path}/assets/icons/${prayer.id}.svg`;
            const icon = new St.Icon({
                gicon: Gio.icon_new_for_string(iconPath),
                icon_size: 16,
                style_class: 'system-status-icon'
            });
            const nameLabel = new St.Label({ text: this._prayerName(prayer.name), x_expand: true, style: 'padding-left: 10px;' });
            const timeLabel = new St.Label({ text: '--:--' });

            item.add_child(icon);
            item.add_child(nameLabel);
            item.add_child(timeLabel);

            this._prayerItems[prayer.name] = { item, nameLabel, timeLabel };
            this._indicator.menu.addMenuItem(item);
        });

        this._indicator.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // ── Offline badge row ─────────────────────────────────────────────────
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

        // ── Settings shortcut ─────────────────────────────────────────────────
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
            this.openPreferences();
        });
        this._indicator.menu.addMenuItem(settingsItem);
        this._settingsItem = settingsItem;
        this._settingsItem.visible = this._settings.get_boolean('show-settings-button');

        this._indicator.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // ── Quran Player section ──────────────────────────────────────────────
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

        // Quran playback controls
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
            if (this._continuousQuran) {
                this._pauseQuran();
            } else {
                this._playQuran();
            }
        });

        controlsBox.add_child(this._playPauseBtn);
        controlsItem.add_child(controlsBox);
        this._indicator.menu.addMenuItem(controlsItem);

        // Keep references to all Quran items for show/hide
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
        this._quranItems.forEach(item => item.visible = show);
    }

    // ─── Quran Playback ───────────────────────────────────────────────────────

    _fetchSurahs() {
        const msg = Soup.Message.new('GET', 'https://api.alquran.cloud/v1/surah');
        const session = new Soup.Session();
        session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null, (session, res) => {
            try {
                const bytes = session.send_and_read_finish(res);
                const data = JSON.parse(new TextDecoder().decode(bytes.get_data()));
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
            // FIX: Resume from the exact position where it was paused —
            // previously this always called _fetchAndPlayAyah which called
            // setSource() → set_state(NULL), discarding the paused position.
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
            if (this._settings.get_boolean('show-quran-translation')) {
                bism += '\n\nIn the Name of Allah—the Most Compassionate, Most Merciful.';
            }
            this._verseLabel.set_text(bism);
        } else {
            const showTrans = this._settings.get_boolean('show-quran-translation');
            const editions = showTrans ? 'quran-uthmani,en.itani' : 'quran-uthmani';
            const textMsg = Soup.Message.new(
                'GET',
                `https://api.alquran.cloud/v1/ayah/${surah}:${ayah}/editions/${editions}`
            );
            const textSession = new Soup.Session();
            textSession.send_and_read_async(textMsg, GLib.PRIORITY_DEFAULT, null, (s, res) => {
                try {
                    const bytes = s.send_and_read_finish(res);
                    const data  = JSON.parse(new TextDecoder().decode(bytes.get_data()));
                    if (data.data && data.data[0]) {
                        let text = data.data[0].text;
                        if (showTrans && data.data[1]) {
                            text += '\n\n' + data.data[1].text;
                        }
                        this._verseLabel.set_text(text);
                        this._quranGlobalAyah = data.data[0].number;
                    }
                } catch (_e) {}
            });
        }
    }

    _onQuranVerseEnded(nextPlayer) {
        if (!this._continuousQuran) return;

        if (!this._isPlayingBismallah) {
            this._quranCurrentAyah++;
            this._quranGlobalAyah++;
        }

        this._activePlayer = nextPlayer;
        this._fetchAndPlayAyah(this._quranCurrentSurah, this._quranCurrentAyah, this._activePlayer);
    }

    // ─── Location / Coordinates ───────────────────────────────────────────────

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

    /** Debounced re-fetch: clears cache and refetches when location or method changes. */
    _refetchAndUpdate() {
        if (this._refetchTimeout) {
            GLib.Source.remove(this._refetchTimeout);
        }
        this._refetchTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
            this._refetchTimeout = null;
            this._api.clearCache(); // params changed — old cache is invalid
            this._fetchTodayTimes();
            return GLib.SOURCE_REMOVE;
        });
    }

    // ─── Online-first Prayer Time Fetching ────────────────────────────────────

    /**
     * Waterfall: monthly cache → AlAdhan API (2 months) → offline calculator.
     * On success, sets this._cachedTimes then calls _updateUI().
     */
    _fetchTodayTimes() {
        const latStr = this._settings.get_string('latitude');
        const lngStr = this._settings.get_string('longitude');
        let lat      = parseFloat(latStr || '');
        let lng      = parseFloat(lngStr || '');
        const method = this._settings.get_int('method') || 3;
        const school = this._settings.get_int('school') || 0;

        // If no coordinates set, use Makkah as a safe fallback and flag it
        const noCoords = !latStr || isNaN(lat);
        if (noCoords) { lat = 21.4225; lng = 39.8262; }
        this._noCoords = noCoords;

        // Step 1: monthly disk cache (skip if noCoords — Makkah cache isn't useful)
        if (!noCoords) {
            const cached = this._api.loadTodayFromCache(lat, lng, method, school);
            if (cached) {
                this._isOffline   = false;
                this._cachedTimes = cached.timings;
                this._apiHijri    = cached.hijri || null;
                this._updateUI();
                return;
            }
        }

        // Step 2: AlAdhan API
        this._api.fetchAndCacheMonthly(lat, lng, method, school).then(result => {
            console.debug('[SalatPrayerTime] Prayer times loaded from AlAdhan API.');
            this._isOffline   = false;
            this._cachedTimes = result.timings;
            this._apiHijri    = result.hijri || null;
            this._updateUI();
        }).catch(err => {
            console.warn('[SalatPrayerTime] API unavailable, using offline calc:', err.message);
            this._isOffline   = true;
            this._apiHijri    = null;
            this._cachedTimes = this._calcOfflineTimes(lat, lng, method, school);
            this._updateUI();
        });
    }

    /** Compute prayer times offline using the ported KDE calculator. */
    _calcOfflineTimes(lat, lng, methodIndex, schoolIndex) {
        // Get current UTC offset in hours from GLib
        const nowGLib    = GLib.DateTime.new_now_local();
        const utcOffset  = nowGLib.get_utc_offset() / (3600 * 1000000); // µs → hours

        const times = calcOfflineTimes(
            new Date(), lat, lng, utcOffset, methodIndex, schoolIndex
        );

        // Return only the 5 main prayers (drop Sunrise)
        return {
            Fajr:    times.Fajr,
            Dhuhr:   times.Dhuhr,
            Asr:     times.Asr,
            Maghrib: times.Maghrib,
            Isha:    times.Isha,
        };
    }

    // ─── Translation helpers ──────────────────────────────────────────────────

    /** Return en or ar string based on current language-index setting. */
    _t(en, ar) {
        return this._settings.get_int('language-index') === 1 ? ar : en;
    }

    /** Arabic prayer names */
    _prayerName(name) {
        const AR = { Fajr: 'الفجر', Dhuhr: 'الظهر', Asr: 'العصر', Maghrib: 'المغرب', Isha: 'العشاء', Sunrise: 'الشروق' };
        return this._t(name, AR[name] || name);
    }

    /**
     * Convert a string's ASCII digits to Arabic-Indic numerals (٠١٢٣٤٥٦٧٨٩)
     * when the use-arabic-numbers setting is enabled.
     */
    _toDisplayNum(str) {
        if (!this._settings.get_boolean('use-arabic-numbers')) return str;
        return String(str).replace(/[0-9]/g, d => '٠١٢٣٤٥٦٧٨٩'[d]);
    }

    /** Refresh all translatable text after language change without rebuilding the menu. */
    _refreshLanguage() {
        // Prayer name labels
        for (const [name, item] of Object.entries(this._prayerItems))
            if (item.nameLabel) item.nameLabel.set_text(this._prayerName(name));
        // Settings label
        if (this._settingsLabel)
            this._settingsLabel.set_text(this._t('Settings', 'الإعدادات'));
        // Re-render Hijri + topbar
        this._updateHijriDisplay();
        this._refreshTopbar();
    }

    // ─── Hijri Date Display ───────────────────────────────────────────────────

    _updateHijriDisplay() {
        const show = this._settings.get_boolean('show-hijri-date');
        if (this._hijriItem) this._hijriItem.visible = show;
        if (this._specialItem) this._specialItem.visible = show;
        if (!show) return;

        const offset = this._settings.get_int('hijri-offset') || 0;
        const isAr   = this._settings.get_int('language-index') === 1;
        let hDay, hMonth, hYear, mName;

        if (this._apiHijri) {
            // API Hijri — use the Arabic month name directly from AlAdhan
            hDay   = parseInt(this._apiHijri.day, 10) + offset;
            hMonth = parseInt(this._apiHijri.month.number, 10);
            hYear  = parseInt(this._apiHijri.year, 10);
            if (hDay > 30) { hDay -= 30; hMonth++; if (hMonth > 12) { hMonth = 1; hYear++; } }
            if (hDay < 1)  { hDay += 30; hMonth--; if (hMonth < 1)  { hMonth = 12; hYear--; } }
            // AlAdhan provides month.ar and month.en directly
            mName = isAr
                ? (this._apiHijri.month.ar || HIJRI_MONTHS_AR[hMonth - 1])
                : (this._apiHijri.month.en || HIJRI_MONTHS_EN[hMonth - 1]);
        } else {
            const h = getHijriDate(new Date(), offset);
            hDay = h.day; hMonth = h.month; hYear = h.year;
            mName = isAr ? HIJRI_MONTHS_AR[hMonth - 1] : HIJRI_MONTHS_EN[hMonth - 1];
        }

        const suffix = isAr ? 'هـ' : 'AH';
        // Apply Arabic-Indic digits to day and year numbers
        const displayDay  = this._toDisplayNum(String(hDay));
        const displayYear = this._toDisplayNum(String(hYear));
        this._hijriLabel.set_text(`${displayDay} ${mName} ${displayYear} ${suffix}`);

        const msg = this._getSpecialIslamicMessage(hDay, hMonth);
        this._specialLabel.set_text(msg);
        if (this._specialItem) this._specialItem.visible = show && msg !== '';
    }

    _getSpecialIslamicMessage(day, month) {
        const ar = this._settings.get_int('language-index') === 1;
        if (month === 9)  return ar ? 'شهر رمضان المبارك 🌙' : 'Month of Ramadan 🌙';
        if (month === 10 && day === 1)  return ar ? 'عيد الفطر المبارك 🎉' : 'Eid Al-Fitr 🎉';
        if (month === 12) {
            if (day === 9)  return ar ? 'يوم عرفة 🕋'          : 'Day of Arafah 🕋';
            if (day === 10) return ar ? 'عيد الأضحى المبارك 🐑' : 'Eid Al-Adha 🐑';
            if (day >= 1 && day <= 10) return ar ? 'العشر الأوائل من ذي الحجة ⭐' : 'First 10 Days of Dhu Al-Hijjah ⭐';
            if (day >= 11 && day <= 13) return ar ? 'أيام التشريق' : 'Ayyam Al-Tashreeq';
        }
        if (month === 1 && day === 1)  return ar ? 'رأس السنة الهجرية 🌙' : 'Islamic New Year 🌙';
        if (month === 1 && day === 10) return ar ? 'يوم عاشوراء'          : 'Day of Ashura';
        if (month === 3 && day === 12) return ar ? 'المولد النبوي الشريف ﷺ' : "Mawlid Al-Nabi ﷺ";
        if (day === 13 || day === 14 || day === 15)
            return ar ? 'الأيام البيض 🌕' : 'Ayyam Al-Bid (White Days) 🌕';
        if (day === 11)
            return ar ? 'الأيام البيض بعد يومين 🌔' : 'Ayyam Al-Bid in 2 days 🌔';
        if (day === 12)
            return ar ? 'الأيام البيض غداً 🌔' : 'Ayyam Al-Bid tomorrow 🌔';
        return '';
    }

    // ─── UI Update (uses pre-fetched this._cachedTimes) ──────────────────────

    _updateUI() {
        const rawTimes = this._cachedTimes;
        if (!rawTimes || Object.keys(rawTimes).length === 0) return;

        // Apply per-prayer offsets from settings
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

        // Store offset-applied times so _refreshTopbar can use them too
        this._adjustedTimes = times;

        // Record today's date string for midnight-rollover detection
        const now = GLib.DateTime.new_now_local();
        this._todayDateStr = `${now.get_day_of_month()}-${now.get_month()}-${now.get_year()}`;
        const todayKey = `${now.get_year()}-${String(now.get_month()).padStart(2,'0')}-${String(now.get_day_of_month()).padStart(2,'0')}`;

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

            // Roll past prayers to tomorrow
            if (pTime.getTime() <= jsNow.getTime()) pTime.setDate(pTime.getDate() + 1);

            const timeDiff = pTime.getTime() - jsNow.getTime();
            if (timeDiff > 0 && timeDiff < diffMs) { diffMs = timeDiff; nextPrayerName = prayer; }

            // Display in menu
            let displayStr;
            if (use12h) {
                const dh = h % 12 || 12;
                const ap = h >= 12 ? 'PM' : 'AM';
                displayStr = this._toDisplayNum(`${dh}:${m.toString().padStart(2,'0')}`) + ` ${ap}`;
            } else {
                displayStr = this._toDisplayNum(timeStr);
            }
            this._prayerItems[prayer].timeLabel.set_text(displayStr);

            // Pre-notification check (runs every minute via the update timer)
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
                    // Play pre-notification beep via GStreamer (no external process)
                    if (this._settings.get_boolean('pre-notification-sound'))
                        this._notifPlayer.playBeep(
                            this._settings.get_double('adhan-volume') || 0.5
                        );
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

    // ─── Offline Badge ─────────────────────────────────────────────────────

    _updateOfflineBadge() {
        if (!this._offlineItem) return;
        // Only show badge on first boot with no coordinates set
        if (this._isOffline && this._noCoords) {
            this._offlineLabel.set_text(
                this._t(
                    '⚠ No location set — open Settings and enter your coordinates.',
                    '⚠ لا يوجد موقع — افتح الإعدادات وأدخل الإحداثيات.'
                )
            );
            this._offlineItem.visible = true;
        } else {
            this._offlineItem.visible = false;
        }
    }


    /**
     * Refresh only the top-bar label without recalculating times.
     * Format options (topbar-display-format):
     *   0 → "PrayerName  12:30 PM"   (next prayer + absolute time)
     *   1 → "PrayerName  01:23"      (next prayer + countdown h:mm)
     *   2 → "01:23"                  (countdown only)
     */
    _refreshTopbar() {
        const name   = this._nextPrayerName;
        const diffMs = this._nextPrayerMs;

        if (!name) {
            this._nextPrayerLabel.set_text(
                this._isOffline ? this._t('🟡 Offline', '🟡 غير متصل') : '...'
            );
            return;
        }

        const fmt          = this._settings.get_int('topbar-display-format') || 0;
        const totalMinutes = Math.floor(diffMs / 60000);
        const rh           = Math.floor(totalMinutes / 60);
        const rm           = totalMinutes % 60;
        const countdown    = this._toDisplayNum(`${rh.toString().padStart(2, '0')}:${rm.toString().padStart(2, '0')}`);
        const pName        = this._prayerName(name);

        let text;
        if (fmt === 0) {
            // Prayer Name + absolute time
            const timeStr = (this._adjustedTimes && this._adjustedTimes[name]) || this._cachedTimes[name] || '';
            const [hStr, mStr] = timeStr.split(':');
            const h   = parseInt(hStr, 10);
            const m   = parseInt(mStr, 10);
            const use12h = this._settings.get_boolean('hour-format');
            let timePart;
            if (use12h) {
                const dh = h % 12 || 12;
                const ap = h >= 12 ? (this._t('PM', 'م')) : (this._t('AM', 'ص'));
                timePart = this._toDisplayNum(`${dh}:${m.toString().padStart(2,'0')}`) + ` ${ap}`;
            } else {
                timePart = this._toDisplayNum(timeStr);
            }
            text = `${pName}  ${timePart}`;
        } else if (fmt === 1) {
            // Prayer Name + countdown
            text = `${pName}  ${countdown}`;
        } else if (fmt === 2) {
            // Countdown only
            text = countdown;
        } else {
            // Format 3: "Fajr: 4:43 AM / in: 7:43"
            const timeStr = (this._adjustedTimes && this._adjustedTimes[name]) || this._cachedTimes[name] || '';
            const [hStr, mStr] = timeStr.split(':');
            const h   = parseInt(hStr, 10);
            const m   = parseInt(mStr, 10);
            const use12h = this._settings.get_boolean('hour-format');
            let timePart;
            if (use12h) {
                const dh = h % 12 || 12;
                const ap = h >= 12 ? (this._t('PM', 'م')) : (this._t('AM', 'ص'));
                timePart = this._toDisplayNum(`${dh}:${m.toString().padStart(2,'0')}`) + ` ${ap}`;
            } else {
                timePart = this._toDisplayNum(timeStr);
            }
            const inWord = this._t('In', 'بعد');
            text = `${pName}: ${timePart} / ${inWord}: ${countdown}`;
        }

        this._nextPrayerLabel.set_text(text);
    }

    // ─── Alarm Scheduling ─────────────────────────────────────────────────────

    /**
     * Schedule a precise one-shot timer for the exact prayer moment.
     * Pre-notifications are now handled inside _updateUI() which runs every minute,
     * so they fire reliably even if the extension starts mid-window.
     */
    _scheduleAtPrayerAlarm(prayerName, diffMs) {
        if (this._alarmTimerAtPrayer !== null) {
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

    // ─── Adhan ────────────────────────────────────────────────────────────────

    _triggerAdhan(prayerName) {
        // Schema uses 'dhuhr', prayerName from times dict is 'Dhuhr'
        const key = `play-adhan-for-${prayerName.toLowerCase()}`;
        if (!this._settings.get_boolean(key)) return;

        const mode = this._settings.get_int('adhan-playback-mode');
        if (mode === 0) return;

        if (this._continuousQuran) {
            this._pauseQuran();
            this._wasQuranPlayingBeforeAdhan = true;
        }

        const customPath = this._settings.get_string('adhan-audio-path');
        const audioPath  = customPath || `${this.path}/assets/audio/Adhan.mp3`;

        this._adhanPlayer.setVolume(this._settings.get_double('adhan-volume') || 0.5);
        this._adhanPlayer.setSource(audioPath);
        this._isAdhanPlaying = true;
        this._adhanPlayer.play();

        if (mode === 2) {
            // Short Adhan — stop after 40 s
            GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 40, () => {
                if (this._isAdhanPlaying) { this._adhanPlayer.stop(); this._onAdhanEnded(); }
                return GLib.SOURCE_REMOVE;
            });
        } else if (mode === 3) {
            // Takbeer only — stop after 15 s
            GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 15, () => {
                if (this._isAdhanPlaying) { this._adhanPlayer.stop(); this._onAdhanEnded(); }
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    _onAdhanEnded() {
        this._isAdhanPlaying = false;
        if (this._wasQuranPlayingBeforeAdhan) {
            this._playQuran();
            this._wasQuranPlayingBeforeAdhan = false;
        }
    }

    // ─── No Coordinates Prompt ────────────────────────────────────────────────

    _showNoCoordinatesPrompt() {
        // Update topbar
        this._nextPrayerLabel.set_text(this._t('Set location', 'حدد موقعك'));

        // Show a friendly hint in the Hijri date row
        if (this._hijriLabel)
            this._hijriLabel.set_text(
                this._t(
                    '⚠ No location set — open Settings to configure.',
                    '⚠ لا يوجد موقع — افتح الإعدادات للضبط.'
                )
            );
        if (this._hijriItem)  this._hijriItem.visible  = true;
        if (this._specialItem) this._specialItem.visible = false;

        // Grey out all prayer time labels
        for (const item of Object.values(this._prayerItems))
            item.timeLabel.set_text('--:--');
    }

    // ─── Lifecycle ────────────────────────────────────────────────────────────

    disable() {
        // Disconnect all GSettings signals first
        if (this._settings && this._settingsHandlers) {
            for (const id of this._settingsHandlers)
                this._settings.disconnect(id);
            this._settingsHandlers = null;
        }

        // Remove main loop sources
        if (this._updateTimer)       { GLib.Source.remove(this._updateTimer);       this._updateTimer       = null; }
        if (this._resolveTimeout)    { GLib.Source.remove(this._resolveTimeout);    this._resolveTimeout    = null; }
        if (this._refetchTimeout)    { GLib.Source.remove(this._refetchTimeout);    this._refetchTimeout    = null; }
        if (this._alarmTimerAtPrayer !== null) { GLib.Source.remove(this._alarmTimerAtPrayer); this._alarmTimerAtPrayer = null; }

        // Stop services and destroy objects
        if (this._locationService) {
            this._locationService.stop();
            this._locationService = null;
        }
        if (this._playerA)     { this._playerA.destroy();     this._playerA     = null; }
        if (this._playerB)     { this._playerB.destroy();     this._playerB     = null; }
        if (this._adhanPlayer) { this._adhanPlayer.destroy(); this._adhanPlayer = null; }
        if (this._notifPlayer) { this._notifPlayer.destroy(); this._notifPlayer = null; }
        if (this._indicator)   { this._indicator.destroy();   this._indicator   = null; }

        this._settingsHandlers = null;
        this._settings         = null;
    }
}
