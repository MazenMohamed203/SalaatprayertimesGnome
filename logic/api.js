import Soup from 'gi://Soup';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

const CACHE_DIR        = GLib.build_filenamev([GLib.get_user_cache_dir(), 'salatprayertime']);
const MONTHLY_CACHE    = GLib.build_filenamev([CACHE_DIR, 'monthly_cache.json']);
const CACHE_MAX_AGE_MS = 5 * 24 * 60 * 60 * 1000;

export class AlAdhanAPI {
    constructor() {
        this.session = new Soup.Session();
        this.session.timeout = 10;
        this._ensureCacheDirectory();
    }

    _ensureCacheDirectory() {
        try {
            const dir = Gio.File.new_for_path(CACHE_DIR);
            if (!dir.query_exists(null))
                dir.make_directory_with_parents(null);
        } catch (e) {
            console.error('[SalatPrayerTime] Cache dir error:', e);
        }
    }

    destroy() {
        if (this.session) {
            this.session.abort();
            this.session = null;
        }
    }

    // ── Monthly Calendar Cache ─────────────────────────────────────────────────

    /**
     * Get prayer times (and Hijri date) for today from cache.
     * Returns { timings, hijri } or null if cache is missing/stale/params changed.
     * hijri: { day, month: { number, en, ar }, year } as returned by AlAdhan.
     */
    async loadTodayFromCache(lat, lng, method, school) {
        const cache = await this._readMonthlyCache();
        if (!cache) return null;

        if (cache.lat !== lat || cache.lng !== lng ||
            cache.method !== method || cache.school !== school)
            return null;

        if (Date.now() - (cache.fetchedAt || 0) > CACHE_MAX_AGE_MS)
            return null;

        const entry = cache.days && cache.days[this._todayKey()];
        return entry ? { timings: entry.timings, hijri: entry.hijri || null } : null;
    }

    /**
     * Fetch the current month + next month from AlAdhan API.
     * Stores all days in the cache as a flat lookup:
     *   { fetchedAt, lat, lng, method, school, days: { "YYYY-MM-DD": {Fajr,...}, ... } }
     * Returns today's timings on success.
     */
    async fetchAndCacheMonthly(lat, lng, method, school) {
        const now   = GLib.DateTime.new_now_local();
        const year  = now.get_year();
        const month = now.get_month();

        const [thisMonth, nextMonth] = await Promise.all([
            this._fetchMonth(lat, lng, method, school, year, month),
            this._fetchMonth(lat, lng, method, school,
                month === 12 ? year + 1 : year,
                month === 12 ? 1 : month + 1),
        ]);

        const days = {};
        for (const entry of [...thisMonth, ...nextMonth]) {
            const key = this._entryDateKey(entry);
            if (key) days[key] = {
                timings: this._extractTimings(entry),
                hijri:   this._extractHijri(entry),
            };
        }

        this._writeMonthlyCache({ fetchedAt: Date.now(), lat, lng, method, school, days });

        const today = days[this._todayKey()];
        if (!today) throw new Error('Today not found in API response');
        return today;
    }

    /** Fetch a single month from AlAdhan (/v1/calendar/{year}/{month}) */
    _fetchMonth(lat, lng, method, school, year, month) {
        const url = `https://api.aladhan.com/v1/calendar/${year}/${month}` +
                    `?latitude=${lat}&longitude=${lng}&method=${method}&school=${school}`;
        return new Promise((resolve, reject) => {
            const message = Soup.Message.new('GET', url);
            this.session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, null, (session, res) => {
                try {
                    const bytes = session.send_and_read_finish(res);
                    if (message.status_code === 200) {
                        const data = JSON.parse(new TextDecoder('utf-8').decode(bytes.get_data()));
                        if (data.code === 200 && Array.isArray(data.data)) {
                            resolve(data.data);
                        } else {
                            reject(new Error(`AlAdhan error: ${data.status || 'unknown'}`));
                        }
                    } else {
                        reject(new Error(`AlAdhan HTTP ${message.status_code} for ${year}/${month}`));
                    }
                } catch (e) {
                    reject(e);
                }
            });
        });
    }

    /** Extract YYYY-MM-DD key from an AlAdhan calendar entry */
    _entryDateKey(entry) {
        const g = entry?.date?.gregorian;
        if (!g) return null;
        const m = g.month.number.toString().padStart(2, '0');
        const d = g.day.padStart(2, '0');
        return `${g.year}-${m}-${d}`;
    }

    /** Today as "YYYY-MM-DD" */
    _todayKey() {
        const now = GLib.DateTime.new_now_local();
        return `${now.get_year()}-` +
               `${now.get_month().toString().padStart(2, '0')}-` +
               `${now.get_day_of_month().toString().padStart(2, '0')}`;
    }

    /** Pull the 5 main prayers from an AlAdhan entry's timings object */
    _extractTimings(entry) {
        const t = entry.timings;
        return {
            Fajr:    this._strip(t.Fajr),
            Dhuhr:   this._strip(t.Dhuhr),
            Asr:     this._strip(t.Asr),
            Maghrib: this._strip(t.Maghrib),
            Isha:    this._strip(t.Isha),
        };
    }

    /** Pull Hijri date from an AlAdhan entry (null if missing) */
    _extractHijri(entry) {
        return entry?.date?.hijri ?? null;
    }

    /** Strip " (TZ)" or ":SS" suffix → plain "HH:MM" */
    _strip(s) {
        if (!s) return '--:--';
        return s.split(' ')[0].substring(0, 5);
    }

    // ── Cache I/O ─────────────────────────────────────────────────────────────

    _readMonthlyCache() {
        return new Promise((resolve) => {
            const file = Gio.File.new_for_path(MONTHLY_CACHE);
            if (!file.query_exists(null)) { resolve(null); return; }
            file.load_contents_async(null, (ff, r) => {
                try {
                    const [ok, bytes] = ff.load_contents_finish(r);
                    resolve(ok ? JSON.parse(new TextDecoder('utf-8').decode(bytes)) : null);
                } catch (e) {
                    console.error('[SalatPrayerTime] Cache read error:', e);
                    resolve(null);
                }
            });
        });
    }

    _writeMonthlyCache(data) {
        const file = Gio.File.new_for_path(MONTHLY_CACHE);
        const bytes = new TextEncoder().encode(JSON.stringify(data));
        file.replace_contents_bytes_async(
            new GLib.Bytes(bytes),
            null, false, Gio.FileCreateFlags.NONE, null,
            (f, res) => {
                try {
                    f.replace_contents_finish(res);
                } catch (e) {
                    console.error('[SalatPrayerTime] Cache write error:', e);
                }
            }
        );
    }

    /** Invalidate cache (called when user changes location/method) */
    clearCache() {
        const file = Gio.File.new_for_path(MONTHLY_CACHE);
        if (file.query_exists(null)) {
            file.delete_async(GLib.PRIORITY_DEFAULT, null, (f, res) => {
                try {
                    f.delete_finish(res);
                } catch (e) {
                    console.error('[SalatPrayerTime] Cache clear error:', e);
                }
            });
        }
    }

    // ── Geocoding ─────────────────────────────────────────────────────────────

    async getCoordinatesByCity(city, country) {
        const url = `https://geocoding-api.open-meteo.com/v1/search` +
                    `?name=${encodeURIComponent(`${city}, ${country}`)}&count=1&format=json`;
        return new Promise((resolve, reject) => {
            const message = Soup.Message.new('GET', url);
            this.session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, null, (session, res) => {
                try {
                    const bytes = session.send_and_read_finish(res);
                    if (message.status_code === 200) {
                        const data = JSON.parse(new TextDecoder('utf-8').decode(bytes.get_data()));
                        if (data?.results?.length > 0) {
                            const r = data.results[0];
                            resolve({ lat: r.latitude, lng: r.longitude, timezone: r.timezone });
                        } else {
                            reject(new Error('City not found'));
                        }
                    } else {
                        reject(new Error(`Geocoding HTTP ${message.status_code}`));
                    }
                } catch (e) {
                    reject(e);
                }
            });
        });
    }
}
