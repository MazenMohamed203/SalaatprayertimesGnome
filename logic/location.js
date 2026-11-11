import Soup from 'gi://Soup';
import GLib from 'gi://GLib';

import { autoMethodFromCountry } from './methods.js';

/**
 * LocationService — resolves the user's location via IP geolocation.
 * Primary: ipwho.is  |  Fallback: freeipapi.com
 *
 * On success also auto-selects the best calculation method for the country.
 */
export class LocationService {
    constructor(settings, onFailure = null) {
        this._settings = settings;
        this._session  = new Soup.Session();
        this._starting = false;
        this._onFailure = onFailure;
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
            if (typeof this._onFailure === 'function') {
                try { this._onFailure(); } catch (e) { console.error('[SalatPrayerTime] location failure callback error:', e); }
            }
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
