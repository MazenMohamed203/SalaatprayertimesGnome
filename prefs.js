import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gst from 'gi://Gst';

// Auto-select calculation method based on country name
function autoMethodFromCountry(country) {
    const c = (country || '').toLowerCase();
    if (c.includes('egypt'))                                                          return 5;
    if (c.includes('saudi') || c.includes('makkah') || c.includes('medina'))         return 4;
    if (c.includes('pakistan') || c.includes('bangladesh') || c.includes('india') || c.includes('afghanistan')) return 1;
    if (c.includes('usa') || c.includes('united states') || c.includes('canada'))    return 2;
    if (c.includes('iran'))                                                            return 7;
    if (c.includes('kuwait'))                                                          return 9;
    if (c.includes('qatar'))                                                           return 10;
    if (c.includes('uae') || c.includes('emirates') || c.includes('dubai'))           return 8;
    if (c.includes('bahrain') || c.includes('oman') || c.includes('yemen'))           return 8;
    if (c.includes('singapore'))                                                       return 11;
    if (c.includes('france'))                                                          return 12;
    if (c.includes('turkey') || c.includes('türkiye'))                                return 13;
    if (c.includes('russia'))                                                          return 14;
    if (c.includes('morocco'))                                                         return 3;
    if (c.includes('jordan'))                                                          return 3;
    if (c.includes('algeria') || c.includes('tunisia'))                               return 5;
    if (c.includes('indonesia') || c.includes('malaysia'))                            return 11;
    return 3; // MWL default
}

export default class SalatPrayerTimePreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings('org.gnome.shell.extensions.salatprayertime');

        // ══════════════════════════════════════════════════════════════
        // PAGE 1: Location & Display
        // ══════════════════════════════════════════════════════════════
        const page1 = new Adw.PreferencesPage({
            title: 'Location & Display',
            icon_name: 'preferences-system-symbolic',
        });

        // ── Location ──────────────────────────────────────────────────
        const locationGroup = new Adw.PreferencesGroup({
            title: 'Location',
            description: 'How the extension finds your location.'
        });

        const autoLocRow = new Adw.ActionRow({ title: 'Auto-Location (IP)', subtitle: 'Detect city automatically via IP' });
        const autoLocSwitch = new Gtk.Switch({ valign: Gtk.Align.CENTER });
        settings.bind('auto-location', autoLocSwitch, 'active', Gio.SettingsBindFlags.DEFAULT);
        autoLocRow.add_suffix(autoLocSwitch);
        locationGroup.add(autoLocRow);

        const useCoordsRow = new Adw.ActionRow({ title: 'Use Exact Coordinates', subtitle: 'Recommended for accuracy' });
        const useCoordsSwitch = new Gtk.Switch({ valign: Gtk.Align.CENTER });
        settings.bind('use-coordinates', useCoordsSwitch, 'active', Gio.SettingsBindFlags.DEFAULT);
        useCoordsRow.add_suffix(useCoordsSwitch);
        locationGroup.add(useCoordsRow);

        const cityRow = new Adw.ActionRow({ title: 'City' });
        const cityEntry = new Gtk.Entry({ placeholder_text: 'e.g. Cairo', valign: Gtk.Align.CENTER, hexpand: true });
        settings.bind('city', cityEntry, 'text', Gio.SettingsBindFlags.DEFAULT);
        cityRow.add_suffix(cityEntry);
        locationGroup.add(cityRow);

        const countryRow = new Adw.ActionRow({ title: 'Country' });
        const countryEntry = new Gtk.Entry({ placeholder_text: 'e.g. Egypt', valign: Gtk.Align.CENTER, hexpand: true });
        settings.bind('country', countryEntry, 'text', Gio.SettingsBindFlags.DEFAULT);
        // Auto-select method when country changes
        countryEntry.connect('changed', () => {
            const m = autoMethodFromCountry(countryEntry.get_text());
            settings.set_int('method', m);
        });
        countryRow.add_suffix(countryEntry);
        locationGroup.add(countryRow);

        const latRow = new Adw.ActionRow({ title: 'Latitude' });
        const latEntry = new Gtk.Entry({ placeholder_text: 'e.g. 30.0626', valign: Gtk.Align.CENTER, hexpand: true });
        settings.bind('latitude', latEntry, 'text', Gio.SettingsBindFlags.DEFAULT);
        latRow.add_suffix(latEntry);
        locationGroup.add(latRow);

        const lngRow = new Adw.ActionRow({ title: 'Longitude' });
        const lngEntry = new Gtk.Entry({ placeholder_text: 'e.g. 31.2497', valign: Gtk.Align.CENTER, hexpand: true });
        settings.bind('longitude', lngEntry, 'text', Gio.SettingsBindFlags.DEFAULT);
        lngRow.add_suffix(lngEntry);
        locationGroup.add(lngRow);

        const tzRow = new Adw.ActionRow({ title: 'Timezone', subtitle: 'e.g. Africa/Cairo — blank = system timezone' });
        const tzEntry = new Gtk.Entry({ placeholder_text: 'e.g. Africa/Cairo', valign: Gtk.Align.CENTER, hexpand: true });
        settings.bind('timezone', tzEntry, 'text', Gio.SettingsBindFlags.DEFAULT);
        tzRow.add_suffix(tzEntry);
        locationGroup.add(tzRow);

        // Show/hide rows based on location mode + gray out online-only rows when offline
        const netMon = Gio.NetworkMonitor.get_default();

        const updateLocationVisibility = () => {
            const online    = netMon.network_available;
            const auto      = settings.get_boolean('auto-location');
            const useCoords = settings.get_boolean('use-coordinates');

            // Auto-location requires internet — gray it out when offline
            autoLocRow.sensitive = online;

            // "Use Coordinates" toggle: always sensitive (switching to coords works offline)
            useCoordsRow.sensitive = !auto;
            useCoordsRow.visible   = !auto;

            // City/Country: need internet for geocoding
            cityRow.sensitive    = online && !auto && !useCoords;
            countryRow.sensitive = online && !auto && !useCoords;
            cityRow.visible      = !auto && !useCoords;
            countryRow.visible   = !auto && !useCoords;

            // Coordinate fields: ALWAYS visible and active when offline with no auto
            // (so offline first-run users can enter their location)
            const showCoords = (!auto && useCoords) || (!online && !auto);
            latRow.visible   = showCoords;
            lngRow.visible   = showCoords;
            tzRow.visible    = showCoords;
            latRow.sensitive = !auto;
            lngRow.sensitive = !auto;
            tzRow.sensitive  = !auto;

            locationGroup.description = online
                ? 'How the extension finds your location.'
                : '⚠ Offline — enter your coordinates below to get accurate prayer times.';
        };

        settings.connect('changed::auto-location',   updateLocationVisibility);
        settings.connect('changed::use-coordinates', updateLocationVisibility);
        netMon.connect('network-changed', () => updateLocationVisibility());
        updateLocationVisibility();

        // ── Display ───────────────────────────────────────────────────
        const displayGroup = new Adw.PreferencesGroup({
            title: 'Display',
            description: 'What is shown in the top bar and menu.'
        });

        const topbarPlacementRow = new Adw.ComboRow({
            title: 'Top Bar Placement',
            model: Gtk.StringList.new(['Right (Default)', 'Center', 'Left'])
        });
        settings.bind('topbar-placement', topbarPlacementRow, 'selected', Gio.SettingsBindFlags.DEFAULT);
        displayGroup.add(topbarPlacementRow);

        const topbarFormatRow = new Adw.ComboRow({
            title: 'Top Bar Format',
            model: Gtk.StringList.new([
                'Prayer Name + Time (e.g. Dhuhr  12:30 PM)',
                'Prayer Name + Countdown (e.g. Dhuhr  01:23)',
                'Countdown only (e.g. 01:23)',
                'Prayer + Time / Countdown (e.g. Fajr: 4:43 AM / in: 07:43)'
            ])
        });
        settings.bind('topbar-display-format', topbarFormatRow, 'selected', Gio.SettingsBindFlags.DEFAULT);
        displayGroup.add(topbarFormatRow);

        const hourFormatRow = new Adw.ActionRow({ title: '12-Hour Format (AM/PM)', subtitle: 'Off = 24-hour format' });
        const hourFormatSwitch = new Gtk.Switch({ valign: Gtk.Align.CENTER });
        settings.bind('hour-format', hourFormatSwitch, 'active', Gio.SettingsBindFlags.DEFAULT);
        hourFormatRow.add_suffix(hourFormatSwitch);
        displayGroup.add(hourFormatRow);

        const showHijriRow = new Adw.ActionRow({ title: 'Show Hijri Date', subtitle: 'Show Islamic calendar date in the menu' });
        const showHijriSwitch = new Gtk.Switch({ valign: Gtk.Align.CENTER });
        settings.bind('show-hijri-date', showHijriSwitch, 'active', Gio.SettingsBindFlags.DEFAULT);
        showHijriRow.add_suffix(showHijriSwitch);
        displayGroup.add(showHijriRow);

        const hijriOffsetRow = new Adw.SpinRow({ title: 'Hijri Date Offset (days)', subtitle: 'Adjust if displayed date differs from moon sighting', numeric: true });
        hijriOffsetRow.set_range(-3, 3);
        hijriOffsetRow.adjustment.step_increment = 1;
        settings.bind('hijri-offset', hijriOffsetRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        displayGroup.add(hijriOffsetRow);

        const showQuranRow = new Adw.ActionRow({ title: 'Show Quran Player', subtitle: 'Display the Quran player section in the widget' });
        const showQuranSwitch = new Gtk.Switch({ valign: Gtk.Align.CENTER });
        settings.bind('show-quran-player', showQuranSwitch, 'active', Gio.SettingsBindFlags.DEFAULT);
        showQuranRow.add_suffix(showQuranSwitch);
        displayGroup.add(showQuranRow);

        const showSettingsRow = new Adw.ActionRow({ title: 'Show Settings Button', subtitle: 'Show the ⚙ Settings button inside the widget popup' });
        const showSettingsSwitch = new Gtk.Switch({ valign: Gtk.Align.CENTER });
        settings.bind('show-settings-button', showSettingsSwitch, 'active', Gio.SettingsBindFlags.DEFAULT);
        showSettingsRow.add_suffix(showSettingsSwitch);
        displayGroup.add(showSettingsRow);

        const languageGroup = new Adw.PreferencesGroup({
            title: 'Language / اللغة',
        });

        const langRow = new Adw.ComboRow({
            title: 'Language',
            model: Gtk.StringList.new(['English', 'العربية (Arabic)'])
        });
        settings.bind('language-index', langRow, 'selected', Gio.SettingsBindFlags.DEFAULT);
        languageGroup.add(langRow);

        const arabicNumRow = new Adw.ActionRow({
            title: 'Arabic Numerals (٠١٢٣٤٥٦٧٨٩)',
            subtitle: 'Use Arabic-Indic digits for times and dates'
        });
        const arabicNumSwitch = new Gtk.Switch({ valign: Gtk.Align.CENTER });
        settings.bind('use-arabic-numbers', arabicNumSwitch, 'active', Gio.SettingsBindFlags.DEFAULT);
        arabicNumRow.add_suffix(arabicNumSwitch);
        languageGroup.add(arabicNumRow);

        page1.add(locationGroup);
        page1.add(displayGroup);
        page1.add(languageGroup);
        window.add(page1);

        // ══════════════════════════════════════════════════════════════
        // PAGE 2: Calculation & Offsets
        // ══════════════════════════════════════════════════════════════
        const page2 = new Adw.PreferencesPage({
            title: 'Calculation',
            icon_name: 'accessories-calculator-symbolic',
        });

        const methodGroup = new Adw.PreferencesGroup({
            title: 'Calculation Method',
            description: 'Select the juristic authority for prayer time calculation.'
        });

        const methodRow = new Adw.ComboRow({
            title: 'Method',
            model: Gtk.StringList.new([
                'Shia Ithna-Ashari',
                'Karachi (HEC)',
                'ISNA (North America)',
                'Muslim World League',
                'Umm Al-Qura, Makkah',
                'Egyptian General Authority',
                'Custom',
                'Tehran',
                'Gulf Region',
                'Kuwait',
                'Qatar',
                'MUIS (Singapore)',
                'UOIF (France)',
                'Diyanet (Turkey)',
                'Russia'
            ])
        });
        settings.bind('method', methodRow, 'selected', Gio.SettingsBindFlags.DEFAULT);
        methodGroup.add(methodRow);

        const schoolRow = new Adw.ComboRow({
            title: 'Juristic School (Asr)',
            model: Gtk.StringList.new(['Standard (Shafi/Maliki/Hanbali)', 'Hanafi'])
        });
        settings.bind('school', schoolRow, 'selected', Gio.SettingsBindFlags.DEFAULT);
        methodGroup.add(schoolRow);

        // ── Prayer Time Offsets ───────────────────────────────────────
        const offsetGroup = new Adw.PreferencesGroup({
            title: 'Prayer Time Offsets',
            description: 'Fine-tune each prayer time by ±60 minutes to match local authority.'
        });

        const prayerOffsets = [
            { key: 'offset-fajr',    label: 'Fajr offset (minutes)'    },
            { key: 'offset-dhuhr',   label: 'Dhuhr offset (minutes)'   },
            { key: 'offset-asr',     label: 'Asr offset (minutes)'     },
            { key: 'offset-maghrib', label: 'Maghrib offset (minutes)' },
            { key: 'offset-isha',    label: 'Isha offset (minutes)'    },
        ];
        prayerOffsets.forEach(({ key, label }) => {
            const row = new Adw.SpinRow({ title: label, numeric: true });
            row.set_range(-60, 60);
            row.adjustment.step_increment = 1;
            settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
            offsetGroup.add(row);
        });

        page2.add(methodGroup);
        page2.add(offsetGroup);
        window.add(page2);

        // ══════════════════════════════════════════════════════════════
        // PAGE 3: Audio & Notifications
        // ══════════════════════════════════════════════════════════════
        const page3 = new Adw.PreferencesPage({
            title: 'Audio',
            icon_name: 'audio-speakers-symbolic',
        });

        // ── Notifications ─────────────────────────────────────────────
        const notifGroup = new Adw.PreferencesGroup({ title: 'Notifications' });

        const notifRow = new Adw.ActionRow({ title: 'At-Prayer Notifications', subtitle: 'Pop-up when prayer time arrives' });
        const notifSwitch = new Gtk.Switch({ valign: Gtk.Align.CENTER });
        settings.bind('notifications', notifSwitch, 'active', Gio.SettingsBindFlags.DEFAULT);
        notifRow.add_suffix(notifSwitch);
        notifGroup.add(notifRow);

        const preNotifRow = new Adw.SpinRow({
            title: 'Pre-Prayer Notification (minutes)',
            subtitle: '0 = disabled',
            numeric: true
        });
        preNotifRow.set_range(0, 60);
        preNotifRow.adjustment.step_increment = 1;
        settings.bind('pre-notification-minutes', preNotifRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        notifGroup.add(preNotifRow);

        const preNotifSoundRow = new Adw.ActionRow({
            title: 'Pre-Prayer Notification Sound',
            subtitle: 'Play system sound with the pre-prayer notification'
        });
        const preNotifSoundSwitch = new Gtk.Switch({ valign: Gtk.Align.CENTER });
        settings.bind('pre-notification-sound', preNotifSoundSwitch, 'active', Gio.SettingsBindFlags.DEFAULT);
        preNotifSoundRow.add_suffix(preNotifSoundSwitch);
        notifGroup.add(preNotifSoundRow);

        // ── Adhan ─────────────────────────────────────────────────────
        const audioGroup = new Adw.PreferencesGroup({ title: 'Adhan' });

        const adhanModeRow = new Adw.ComboRow({
            title: 'Adhan Playback',
            model: Gtk.StringList.new(['Off', 'Full Adhan', 'Short Adhan (40s)', 'Takbeer Only (15s)'])
        });
        settings.bind('adhan-playback-mode', adhanModeRow, 'selected', Gio.SettingsBindFlags.DEFAULT);
        audioGroup.add(adhanModeRow);

        const adhanVolRow = new Adw.SpinRow({ title: 'Adhan Volume', numeric: true });
        adhanVolRow.set_digits(2);
        adhanVolRow.set_range(0.0, 1.0);
        adhanVolRow.adjustment.step_increment = 0.05;
        settings.bind('adhan-volume', adhanVolRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        audioGroup.add(adhanVolRow);

        // ── Test Athan button ─────────────────────────────────────────────────
        const testRow = new Adw.ActionRow({
            title: 'Test Adhan',
            subtitle: 'Preview your current adhan choice and volume'
        });

        let testPipeline = null;
        let testStopTimer = null;

        const stopTestAdhan = () => {
            if (testStopTimer) { GLib.Source.remove(testStopTimer); testStopTimer = null; }
            if (testPipeline)  { testPipeline.set_state(Gst.State.NULL); testPipeline = null; }
            testBtn.label = 'Test Adhan ▶';
        };

        const testBtn = new Gtk.Button({
            label: 'Test Adhan ▶',
            valign: Gtk.Align.CENTER,
            css_classes: ['suggested-action']
        });

        testBtn.connect('clicked', () => {
            if (testPipeline) { stopTestAdhan(); return; }

            // Initialize GStreamer if not already done
            try { Gst.init(null); } catch (_) {}

            const customPath = settings.get_string('adhan-audio-path');
            const extPath    = this.metadata.path;
            const rawPath    = customPath || `${extPath}/assets/audio/Adhan.mp3`;
            const uri        = rawPath.startsWith('http') ? rawPath : `file://${rawPath}`;
            const vol        = settings.get_double('adhan-volume') || 0.5;
            const mode       = settings.get_int('adhan-playback-mode'); // 1=Full,2=40s,3=15s

            try {
                testPipeline = Gst.parse_launch(
                    `uridecodebin uri="${uri}" ! audioconvert ! audioresample ! volume volume=${vol} ! autoaudiosink`
                );
                testPipeline.set_state(Gst.State.PLAYING);
                testBtn.label = 'Stop Test ■';

                const cutoffSec = mode === 2 ? 40 : mode === 3 ? 15 : 0;
                if (cutoffSec > 0) {
                    testStopTimer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, cutoffSec, () => {
                        stopTestAdhan();
                        return GLib.SOURCE_REMOVE;
                    });
                }

                // Also stop when EOS (full playback ends naturally)
                const bus = testPipeline.get_bus();
                bus.add_watch(GLib.PRIORITY_DEFAULT, (_bus, msg) => {
                    if (msg.type === Gst.MessageType.EOS || msg.type === Gst.MessageType.ERROR)
                        stopTestAdhan();
                    return GLib.SOURCE_CONTINUE;
                });

            } catch (e) {
                console.error('[SalatPrayerTime] Test adhan failed:', e);
            }
        });

        testRow.add_suffix(testBtn);
        audioGroup.add(testRow);

        // Per-prayer Adhan toggles
        const adhanPrayerGroup = new Adw.PreferencesGroup({
            title: 'Play Adhan For',
            description: 'Toggle Adhan playback per prayer.'
        });
        [['fajr','Fajr'],['dhuhr','Dhuhr'],['asr','Asr'],['maghrib','Maghrib'],['isha','Isha']].forEach(([key, label]) => {
            const row = new Adw.ActionRow({ title: label });
            const sw  = new Gtk.Switch({ valign: Gtk.Align.CENTER });
            settings.bind(`play-adhan-for-${key}`, sw, 'active', Gio.SettingsBindFlags.DEFAULT);
            row.add_suffix(sw);
            adhanPrayerGroup.add(row);
        });

        // ══════════════════════════════════════════════════════════════
        // PAGE 4: Quran
        // ══════════════════════════════════════════════════════════════
        const page4 = new Adw.PreferencesPage({
            title: 'Quran',
            icon_name: 'media-tape-symbolic',
            description: 'Quran recitation and text settings.'
        });

        const quranGroup = new Adw.PreferencesGroup({ title: 'Quran Player' });

        const quranTransRow = new Adw.ActionRow({
            title: 'Show English Translation',
            subtitle: 'Display the Clear Quran translation under the Arabic text'
        });
        const quranTransSwitch = new Gtk.Switch({ valign: Gtk.Align.CENTER });
        settings.bind('show-quran-translation', quranTransSwitch, 'active', Gio.SettingsBindFlags.DEFAULT);
        quranTransRow.add_suffix(quranTransSwitch);
        quranGroup.add(quranTransRow);

        const reciterRow = new Adw.ComboRow({
            title: 'Reciter',
            model: Gtk.StringList.new([
                'Abdul Basit (Murattal)',
                'Abdul Basit (Mujawwad)',
                'Abdurrahmaan As-Sudais',
                'Saood ash-Shuraym',
                'Mishari Alafasy',
                'Menshawi (Mujawwad)',
                'Menshawi (Murattal)',
                'Husary',
                'Abu Bakr Al-Shatri'
            ])
        });
        settings.bind('quran-reciter-index', reciterRow, 'selected', Gio.SettingsBindFlags.DEFAULT);
        quranGroup.add(reciterRow);

        const quranVolRow = new Adw.SpinRow({ title: 'Quran Volume', numeric: true });
        quranVolRow.set_digits(2);
        quranVolRow.set_range(0.0, 1.0);
        quranVolRow.adjustment.step_increment = 0.05;
        settings.bind('quran-volume', quranVolRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        quranGroup.add(quranVolRow);

        page3.add(notifGroup);
        page3.add(audioGroup);
        page3.add(adhanPrayerGroup);
        window.add(page3);

        page4.add(quranGroup);
        window.add(page4);
    }
}
