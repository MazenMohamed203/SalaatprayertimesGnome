import Soup from 'gi://Soup';
import GLib from 'gi://GLib';

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
 * Primary: ipwho.is  |  Fallback: freeipapi.com
 *
 * On success also auto-selects the best calculation method for the country.
 */
export class LocationService {
    constructor(settings) {
        this._settings = settings;
        this._session  = new Soup.Session();
        this._starting = false;
    }

    start() {
        if (this._starting) return;
        this._starting = true;
        this._tryPrimary();
    }

    _tryPrimary() {
        const message = Soup.Message.new('GET', 'https://ipwho.is/');
        this._session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, null, (session, res) => {
            try {
                const bytes = session.send_and_read_finish(res);
                if (message.status_code === 200) {
                    const data = JSON.parse(new TextDecoder('utf-8').decode(bytes.get_data()));
                    if (data.success && data.latitude != null && data.longitude != null) {
                        if (!this._starting) return;
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

    _tryFallback() {
        const message = Soup.Message.new('GET', 'https://freeipapi.com/api/json');
        this._session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, null, (session, res) => {
            try {
                const bytes = session.send_and_read_finish(res);
                if (message.status_code === 200) {
                    const data = JSON.parse(new TextDecoder('utf-8').decode(bytes.get_data()));
                    if (data.latitude != null && data.longitude != null) {
                        if (!this._starting) return;
                        this._apply(data.latitude, data.longitude, data.timeZone, data.countryName);
                        this._starting = false;
                        return;
                    }
                }
            } catch (e) {
                console.error('[SalatPrayerTime] freeipapi.com geolocation failed:', e);
            }
            console.error('[SalatPrayerTime] All geolocation services failed.');
            this._starting = false;
        });
    }

    _apply(lat, lng, timezone, country) {
        this._settings.set_string('latitude',  lat.toString());
        this._settings.set_string('longitude', lng.toString());

        if (timezone)
            this._settings.set_string('timezone', timezone);

        if (country)
            this._settings.set_string('country', country);

        if (country)
            this._settings.set_int('method', autoMethodFromCountry(country));
    }

    stop() {
        this._starting = false;
        if (this._session) {
            this._session.abort();
            this._session = null;
        }
    }
}
