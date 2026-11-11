/**
 * Pure helpers for prayer-time computation (no GI imports).
 * Safe to import from prefs.js, tests, and the controller.
 */
import { applyOffset } from './offlineCalc.js';

export function applyOffsets(rawTimes, offsets) {
    const times = {};
    for (const [p, t] of Object.entries(rawTimes || {}))
        times[p] = applyOffset(t, (offsets && offsets[p]) || 0);
    return times;
}

export function findNextPrayer(times, jsNow) {
    let nextPrayerName = null;
    let diffMs = Infinity;
    for (const [prayer, timeStr] of Object.entries(times || {})) {
        if (!timeStr || timeStr === '--:--') continue;
        const [hStr, mStr] = timeStr.split(':');
        const h = parseInt(hStr, 10);
        const m = parseInt(mStr, 10);
        if (isNaN(h) || isNaN(m)) continue;
        const pTime = new Date(jsNow.getTime());
        pTime.setHours(h, m, 0, 0);
        if (pTime.getTime() <= jsNow.getTime()) pTime.setDate(pTime.getDate() + 1);
        const timeDiff = pTime.getTime() - jsNow.getTime();
        if (timeDiff > 0 && timeDiff < diffMs) { diffMs = timeDiff; nextPrayerName = prayer; }
    }
    if (nextPrayerName === null) diffMs = Infinity;
    return { name: nextPrayerName, ms: diffMs };
}

const _nightCache = new Map();
export function calcJafariNightTimes(maghribStr, fajrStr) {
    const key = (maghribStr || '') + '|' + (fajrStr || '');
    if (_nightCache.has(key)) return _nightCache.get(key);

    let result = null;
    if (maghribStr && fajrStr && maghribStr !== '--:--' && fajrStr !== '--:--') {
        const [mH, mM] = maghribStr.split(':').map(Number);
        const [fH, fM] = fajrStr.split(':').map(Number);
        if (!isNaN(mH) && !isNaN(mM) && !isNaN(fH) && !isNaN(fM)) {
            const maghribMin = mH * 60 + mM;
            const fajrMin = fH * 60 + fM;
            let nightDuration = fajrMin - maghribMin;
            if (nightDuration <= 0) nightDuration += 24 * 60;
            const midnightTotal = Math.round(maghribMin + (nightDuration / 2)) % (24 * 60);
            const lastThirdTotal = Math.round(maghribMin + (2 * nightDuration / 3)) % (24 * 60);
            const toHHMM = (totalMin) => {
                let m = totalMin % (24 * 60);
                if (m < 0) m += 24 * 60;
                const h = Math.floor(m / 60);
                const min = m % 60;
                return `${h.toString().padStart(2, '0')}:${min.toString().padStart(2, '0')}`;
            };
            result = { Midnight: toHHMM(midnightTotal), LastThird: toHHMM(lastThirdTotal) };
        }
    }
    _nightCache.set(key, result);
    return result;
}
