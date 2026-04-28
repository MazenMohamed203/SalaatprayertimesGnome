/**
 * Offline Prayer Time Calculator — GNOME Extension
 *
 * Ported from the user's working KDE .pragma library implementation.
 * Uses the standard praytimes.org astronomical algorithm with a proper
 * Julian Date formula independent of GLib.Date.
 *
 * Usage:
 *   import { calcOfflineTimes } from './logic/offlineCalc.js';
 *   const times = calcOfflineTimes(new Date(), lat, lng, utcOffsetHours, methodIndex, asrSchool);
 *   // returns { Fajr, Sunrise, Dhuhr, Asr, Maghrib, Isha } as "HH:MM" strings
 */

/** AlAdhan method index → Fajr/Isha angles */
const METHODS = {
    0:  { fajr: 18.0, isha: 17.0  }, // Shia Ithna-Ashari
    1:  { fajr: 15.0, isha: 15.0  }, // Karachi
    2:  { fajr: 18.0, isha: 18.0  }, // ISNA
    3:  { fajr: 18.0, isha: 17.0  }, // MWL
    4:  { fajr: 18.5, isha: 90.0  }, // Umm Al-Qura (90 = fixed 90-min after Maghrib)
    5:  { fajr: 19.5, isha: 17.5  }, // Egyptian General Authority
    7:  { fajr: 18.0, isha: 18.0  }, // Tehran
    8:  { fajr: 18.0, isha: 17.5  }, // Gulf
    9:  { fajr: 18.0, isha: 18.0  }, // Kuwait
    10: { fajr: 18.0, isha: 18.0  }, // Qatar
    11: { fajr: 18.0, isha: 18.0  }, // MUIS (Singapore)
    12: { fajr: 18.0, isha: 18.0  }, // UOIF (France)
    13: { fajr: 18.0, isha: 17.0  }, // Diyanet (Turkey)
    14: { fajr: 18.0, isha: 18.0  }, // Russia
};

// ── Math helpers ──────────────────────────────────────────────────────────────
const dtr      = d => (d * Math.PI) / 180;
const rtd      = r => (r * 180) / Math.PI;
const sin      = d => Math.sin(dtr(d));
const cos      = d => Math.cos(dtr(d));
const tan      = d => Math.tan(dtr(d));
const arcsin   = d => rtd(Math.asin(d));
const arccos   = d => rtd(Math.acos(d));
const arccot   = x => rtd(Math.atan(1 / x));
const fixAngle = a => { a = a - 360 * Math.floor(a / 360); return a < 0 ? a + 360 : a; };
const fixHour  = a => { a = a - 24  * Math.floor(a / 24);  return a < 0 ? a + 24  : a; };

// ── Julian Date (standard formula, no GLib dependency) ───────────────────────
function julianDate(year, month, day) {
    if (month <= 2) { year -= 1; month += 12; }
    const A  = Math.floor(year / 100);
    const B  = 2 - A + Math.floor(A / 4);
    return Math.floor(365.25 * (year + 4716)) + Math.floor(30.6001 * (month + 1)) + day + B - 1524.5;
}

// ── Solar position ────────────────────────────────────────────────────────────
function sunPosition(jd) {
    const D  = jd - 2451545.0;
    const g  = fixAngle(357.529 + 0.98560028 * D);
    const q  = fixAngle(280.459 + 0.98564736 * D);
    const L  = fixAngle(q + 1.915 * sin(g) + 0.020 * sin(2 * g));
    const e  = 23.439 - 0.00000036 * D;
    const d  = arcsin(sin(e) * sin(L));
    let   RA = arccos(cos(L) / cos(d));
    RA = fixAngle(RA);
    if (sin(L) < 0) RA = 360 - RA;
    const eqt = q / 15 - RA / 15;
    return { declination: d, equation: eqt };
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Calculate offline prayer times.
 *
 * @param {Date}   date          - JavaScript Date object for the target day
 * @param {number} lat           - Latitude in decimal degrees
 * @param {number} lng           - Longitude in decimal degrees
 * @param {number} utcOffset     - UTC offset in hours (e.g. +3 for Cairo DST)
 * @param {number} methodIndex   - AlAdhan method index (0-14)
 * @param {number} asrSchool     - 0 = Standard (Shafi), 1 = Hanafi
 *
 * @returns {{ Fajr, Sunrise, Dhuhr, Asr, Maghrib, Isha }} — "HH:MM" strings
 */
export function calcOfflineTimes(date, lat, lng, utcOffset, methodIndex, asrSchool) {
    lat = parseFloat(lat);
    lng = parseFloat(lng);

    const m  = METHODS[methodIndex] ?? METHODS[3];

    // JD adjusted for longitude (shift to local solar day)
    const jd = julianDate(date.getFullYear(), date.getMonth() + 1, date.getDate())
               - lng / (15 * 24);

    const eqt    = sunPosition(jd).equation;
    const midDay = fixHour(12 - eqt - lng / 15);

    // Helper: hour angle for a given altitude angle (positive = after midday)
    const computeTime = (angle, timeOffset) => {
        const decl = sunPosition(jd + timeOffset).declination;
        const ha   = arccos(
            (sin(angle) - sin(lat) * sin(decl)) / (cos(lat) * cos(decl))
        );
        return ha / 15;
    };

    const sunrise = midDay - computeTime(-0.833, -0.25);
    const sunset  = midDay + computeTime(-0.833,  0.25);
    const fajr    = midDay - computeTime(-m.fajr, -0.3);
    const isha    = midDay + computeTime(-m.isha,  0.3);

    // Asr: angle depends on shadow factor (Shafi = 1, Hanafi = 2)
    const shadowFactor = asrSchool === 1 ? 2 : 1;
    const asrDecl      = sunPosition(jd + 0.1).declination;
    const asrAngle     = arccot(shadowFactor + tan(Math.abs(lat - asrDecl)));
    const asr          = midDay + computeTime(asrAngle, 0.1);

    // Umm Al-Qura: Isha is 90 fixed minutes after Maghrib
    const ishaFinal = m.isha === 90 ? sunset + (90 / 60) : isha;

    // Format solar hours → local "HH:MM"
    const fmt = h => {
        if (isNaN(h)) return '--:--';
        h = fixHour(h + utcOffset);
        let hrs  = Math.floor(h);
        let mins = Math.floor((h - hrs) * 60 + 0.5);
        if (mins >= 60) { hrs += 1; mins -= 60; }
        hrs = ((hrs % 24) + 24) % 24;
        return String(hrs).padStart(2, '0') + ':' + String(mins).padStart(2, '0');
    };

    return {
        Fajr:    fmt(fajr),
        Sunrise: fmt(sunrise),
        Dhuhr:   fmt(midDay),
        Asr:     fmt(asr),
        Maghrib: fmt(sunset),
        Isha:    fmt(ishaFinal),
    };
}

// ── Hijri Date Calculator (ported from KDE widget) ────────────────────────────

/**
 * Convert a JS Date to Hijri date.
 * @param {Date}   date       - Gregorian date
 * @param {number} adjustment - Day offset (e.g. -1, 0, +1)
 * @returns {{ day, month, year }}
 */
export function getHijriDate(date, adjustment = 0) {
    let day   = date.getDate();
    let month = date.getMonth() + 1;
    let year  = date.getFullYear();

    let m = month;
    let y = year;
    if (m < 3) { y -= 1; m += 12; }

    let a = Math.floor(y / 100);
    let b = 2 - a + Math.floor(a / 4);
    if (y < 1583) b = 0;
    if (y === 1582) {
        if (m > 10) b = -10;
        if (m === 10) { b = 0; if (day > 4) b = -10; }
    }

    let jd = Math.floor(365.25 * (y + 4716))
           + Math.floor(30.6001 * (m + 1))
           + day + b - 1524;
    jd += Math.floor(adjustment || 0);

    // Convert JD to Hijri
    let z = jd - 1948084;
    const iyear  = 10631 / 30;
    const shift1 = 8.01 / 60;

    const cyc = Math.floor(z / 10631);
    z = z - 10631 * cyc;
    const j  = Math.floor((z - shift1) / iyear);
    const iy = 30 * cyc + j;
    z = z - Math.floor(j * iyear + shift1);
    let im = Math.floor((z + 28.5001) / 29.5);
    if (im === 13) im = 12;
    const id = z - Math.floor(29.5001 * im - 29);

    return { day: Math.floor(id), month: Math.floor(im), year: Math.floor(iy) };
}

// ── Hijri Month Names ─────────────────────────────────────────────────────────

export const HIJRI_MONTHS_EN = [
    'Muharram', 'Safar', "Rabi' Al-Awwal", "Rabi' Al-Thani",
    'Jumada Al-Awwal', 'Jumada Al-Thani', 'Rajab', "Sha'ban",
    'Ramadan', 'Shawwal', "Dhu Al-Qi'dah", 'Dhu Al-Hijjah'
];

export const HIJRI_MONTHS_AR = [
    'محرم', 'صفر', 'ربيع الأول', 'ربيع الآخر',
    'جمادى الأولى', 'جمادى الآخرة', 'رجب', 'شعبان',
    'رمضان', 'شوال', 'ذو القعدة', 'ذو الحجة'
];

// ── Prayer time offset helper ─────────────────────────────────────────────────

/**
 * Add/subtract minutes from an "HH:MM" string.
 * @param {string} timeStr   - "HH:MM"
 * @param {number} offsetMin - Minutes to add (negative = subtract)
 * @returns {string} adjusted "HH:MM"
 */
export function applyOffset(timeStr, offsetMin) {
    if (!timeStr || timeStr === '--:--' || !offsetMin) return timeStr;
    const [h, m]    = timeStr.split(':').map(Number);
    let total        = ((h * 60 + m + offsetMin) % 1440 + 1440) % 1440;
    const fh         = Math.floor(total / 60);
    const fm         = total % 60;
    return `${String(fh).padStart(2, '0')}:${String(fm).padStart(2, '0')}`;
}

