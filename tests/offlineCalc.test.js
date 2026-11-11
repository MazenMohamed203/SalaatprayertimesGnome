import { calcOfflineTimes, applyOffset, getHijriDate } from 'file:///home/ash/Documents/projects/SalaatprayertimesGnome/logic/offlineCalc.js';
import { autoMethodFromCountry } from 'file:///home/ash/Documents/projects/SalaatprayertimesGnome/logic/methods.js';

let failures = 0;
function check(name, cond) {
    if (cond) print('PASS: ' + name);
    else { print('FAIL: ' + name); failures++; }
}

// applyOffset
check('applyOffset +', applyOffset('12:30', 30) === '13:00');
check('applyOffset -', applyOffset('12:30', -30) === '12:00');
check('applyOffset wrap', applyOffset('23:45', 30) === '00:15');
check('applyOffset zero', applyOffset('12:30', 0) === '12:30');
check('applyOffset --:--', applyOffset('--:--', 10) === '--:--');

// autoMethodFromCountry
check('method egypt', autoMethodFromCountry('Egypt') === 5);
check('method saudi', autoMethodFromCountry('Saudi Arabia') === 4);
check('method usa', autoMethodFromCountry('United States') === 2);
check('method default', autoMethodFromCountry('Unknownland') === 3);

// calcOfflineTimes: sanity range
const t = calcOfflineTimes(new Date(2026, 0, 1), 30.0, 31.2, 2, 5, 0);
check('offline fajr format', /^\d{2}:\d{2}$/.test(t.Fajr));
check('offline dhuhr format', /^\d{2}:\d{2}$/.test(t.Dhuhr));
check('offline maghrib after dhuhr', t.Maghrib > t.Dhuhr);
check('offline isha after maghrib', t.Isha > t.Maghrib);

// getHijriDate: returns numbers
const h = getHijriDate(new Date(2026, 0, 1), 0);
check('hijri day', typeof h.day === 'number' && h.day >= 1 && h.day <= 30);
check('hijri month', typeof h.month === 'number' && h.month >= 1 && h.month <= 12);
check('hijri year', typeof h.year === 'number' && h.year > 1400);

if (failures > 0) { print('FAILURES: ' + failures); quit(1); }
else print('ALL TESTS PASSED');