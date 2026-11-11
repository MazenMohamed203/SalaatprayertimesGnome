import GLib from 'gi://GLib';

    // location

export function resolveCoordinates() {
        if (this._settings.get_boolean('auto-location')) return;
        if (this._settings.get_boolean('use-coordinates')) return;

        if (this.state._resolveTimeout) {
            GLib.Source.remove(this.state._resolveTimeout);
            this.state._resolveTimeout = null;
        }

        this.state._resolveTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1500, () => {
            this.state._resolveTimeout = null;
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

export function refetchAndUpdate() {
        if (this.state._refetchTimeout) {
            GLib.Source.remove(this.state._refetchTimeout);
            this.state._refetchTimeout = null;
        }
        this.state._refetchTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
            this.state._refetchTimeout = null;
            this._api.clearCache();
            this._fetchTodayTimes();
            return GLib.SOURCE_REMOVE;
        });
    }

    // prayer times

export function fetchTodayTimes() {
        const latStr = this._settings.get_string('latitude');
        const lngStr = this._settings.get_string('longitude');
        let lat      = parseFloat(latStr || '');
        let lng      = parseFloat(lngStr || '');
        const method = this._settings.get_int('method') || 3;
        const school = this._settings.get_int('school') || 0;
        const tz     = this._settings.get_string('timezone') || '';

        const noCoords = !latStr || isNaN(lat);
        if (noCoords) { lat = 21.4225; lng = 39.8262; }
        this.state._locationState = noCoords ? 'unset' : 'set';

        const fetchOnline = () => {
            this._api.fetchAndCacheMonthly(lat, lng, method, school, tz).then(result => {
                if (!this._settings) return;
                if (this.state._locationState === 'unset') {
                    this._showNoCoordinatesPrompt();
                    return;
                }
                this.state._connectionState = 'online';
                this.state._cachedTimes = result.timings;
                this.state._apiHijri    = result.hijri || null;
                this._updateUI();
            }).catch(err => {
                if (!this._settings) return;
                console.warn('[SalatPrayerTime] API unavailable, using offline calc:', err.message);
                this.state._connectionState = 'offline';
                this.state._apiHijri    = null;
                this.state._cachedTimes = this._calcOfflineTimes(lat, lng, method, school, tz);
                this._updateUI();
            });
        };

        if (noCoords) {
            fetchOnline();
            return;
        }

        this._api.loadTodayFromCache(lat, lng, method, school, tz).then(cached => {
            if (!this._settings) return;
            if (cached) {
                this.state._connectionState = 'online';
                this.state._cachedTimes = cached.timings;
                this.state._apiHijri    = cached.hijri || null;
                this._updateUI();
            } else {
                fetchOnline();
            }
        });
    }

export function calcOfflineTimes(lat, lng, methodIndex, schoolIndex, tz = '') {
        let utcOffset;
        if (tz) {
            try {
                const zone = GLib.TimeZone.new(tz);
                const unix = GLib.DateTime.new_now_local().to_unix();
                const interval = zone.find_interval(GLib.TimeType.UNIVERSAL, unix);
                utcOffset = zone.get_offset(interval) / 3600;
            } catch (e) {
                console.warn('[SalatPrayerTime] Invalid timezone, falling back to system:', e);
                utcOffset = null;
            }
        }
        if (utcOffset === null || utcOffset === undefined) {
            const now = GLib.DateTime.new_now_local();
            utcOffset = now.get_utc_offset() / (3600 * 1000000);
        }
        const times = calcOfflineTimes(new Date(), lat, lng, utcOffset, methodIndex, schoolIndex);
        return {
            Fajr:    times.Fajr,
            Dhuhr:   times.Dhuhr,
            Asr:     times.Asr,
            Maghrib: times.Maghrib,
            Isha:    times.Isha,
        };
    }
export { calcJafariNightTimes } from '../logic/prayerCompute.js';
