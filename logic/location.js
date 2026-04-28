import Soup from 'gi://Soup?version=3.0';
import GLib from 'gi://GLib';

// ── Auto method selection from country name ─────────────────────────────────
// Mirrors the same logic in prefs.js so first-boot auto-location picks the
// right calculation method without the user needing to open Settings.
function autoMethodFromCountry(country) {
    const c = (country || '').toLowerCase();
    if (c.includes('egypt'))                                                           return 5;
    if (c.includes('saudi') || c.includes('makkah') || c.includes('medina'))          return 4;
    if (c.includes('pakistan') || c.includes('bangladesh') ||
        c.includes('india')   || c.includes('afghanistan'))                           return 1;
    if (c.includes('usa') || c.includes('united states') || c.includes('canada'))     return 2;
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
    return 3; // Muslim World League — safe global default
}

/**
 * LocationService — resolves the user's location via IP geolocation.
 * Primary: ipwho.is  |  Fallback: ip-api.com
 *
 * On success also auto-selects the best calculation method for the country.
 */
export class LocationService {
    constructor(settings) {
        this._settings = settings;
        this._starting = false;
    }

    start() {
        if (this._starting) return;
        this._starting = true;
        this._tryPrimary();
    }

    /** ipwho.is — free, no key required, returns JSON with success flag */
    _tryPrimary() {
        const url     = 'https://ipwho.is/';
        const message = Soup.Message.new('GET', url);
        const session = new Soup.Session();

        session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, null, (session, res) => {
            try {
                const bytes = session.send_and_read_finish(res);
                if (message.status_code === 200) {
                    const data = JSON.parse(new TextDecoder('utf-8').decode(bytes.get_data()));
                    if (data.success && data.latitude != null && data.longitude != null) {
                        this._apply(data.latitude, data.longitude, data.timezone, data.country);
                        this._starting = false;
                        return;
                    }
                }
            } catch (e) {
                console.error('[SalatPrayerTime] ipwho.is geolocation failed:', e);
            }
            this._tryFallback();
        });
    }

    /**
     * ip-api.com — free (non-commercial).
     * Adds 'country' to the fields list.
     */
    _tryFallback() {
        const url     = 'http://ip-api.com/json/?fields=status,lat,lon,timezone,country';
        const message = Soup.Message.new('GET', url);
        const session = new Soup.Session();

        session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, null, (session, res) => {
            try {
                const bytes = session.send_and_read_finish(res);
                if (message.status_code === 200) {
                    const data = JSON.parse(new TextDecoder('utf-8').decode(bytes.get_data()));
                    if (data.status === 'success' && data.lat != null && data.lon != null) {
                        this._apply(data.lat, data.lon, data.timezone, data.country);
                        this._starting = false;
                        return;
                    }
                }
            } catch (e) {
                console.error('[SalatPrayerTime] ip-api.com geolocation failed:', e);
            }
            console.error('[SalatPrayerTime] All geolocation services failed.');
            this._starting = false;
        });
    }

    _apply(lat, lng, timezone, country) {
        console.log(`[SalatPrayerTime] Geolocation resolved: ${lat}, ${lng}, tz=${timezone}, country=${country}`);

        this._settings.set_string('latitude',  lat.toString());
        this._settings.set_string('longitude', lng.toString());

        if (timezone && typeof timezone === 'string' && timezone !== '')
            this._settings.set_string('timezone', timezone);

        // Auto-set the country name so the user sees it in Settings
        if (country && typeof country === 'string' && country !== '')
            this._settings.set_string('country', country);

        // Auto-select the best calculation method for this country
        if (country) {
            const method = autoMethodFromCountry(country);
            console.log(`[SalatPrayerTime] Auto-selected method ${method} for country: ${country}`);
            this._settings.set_int('method', method);
        }
    }

    stop() {
        this._starting = false;
    }
}
