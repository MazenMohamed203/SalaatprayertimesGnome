import { applyOffsets, findNextPrayer, calcJafariNightTimes } from 'file:///home/ash/Documents/projects/SalaatprayertimesGnome/logic/prayerCompute.js';

let failures = 0;
function check(name, cond) { if (cond) print('PASS: ' + name); else { print('FAIL: ' + name); failures++; } }

check('applyOffsets basic', JSON.stringify(applyOffsets({ Fajr: '05:00', Dhuhr: '12:00' }, { Fajr: 10 })) === JSON.stringify({ Fajr: '05:10', Dhuhr: '12:00' }));
check('applyOffsets empty', JSON.stringify(applyOffsets({}, {})) === '{}');

const jsNow = new Date(); jsNow.setHours(10, 0, 0, 0);
const r = findNextPrayer({ Fajr: '05:00', Dhuhr: '12:00', Asr: '15:00' }, jsNow);
check('findNextPrayer picks Dhuhr', r.name === 'Dhuhr');

const n = calcJafariNightTimes('18:00', '05:00');
check('jafari not null', n !== null);
check('jafari midnight format', /^\d{2}:\d{2}$/.test(n.Midnight));
check('jafari null on bad', calcJafariNightTimes('--:--', '05:00') === null);

if (failures > 0) { print('FAILURES: ' + failures); quit(1); }
else print('ALL TESTS PASSED');