/**
 * Centralized mutable state for SalatController.
 * Data/UI handles live here so there is a single source of truth.
 * Services and methods stay on the controller instance.
 */
export class SalatState {
    constructor() {
        // audio/quran playback state
        this._adhanState      = 'idle'; // 'idle' | 'playing'
        this._quranStatus     = 'idle'; // 'idle' | 'playing' | 'paused'
        this._activePlayer    = null;

        this._quranCurrentSurah   = 1;
        this._quranCurrentAyah    = 1;
        this._quranGlobalAyah     = 1;
        this._bismallahState      = 'none'; // 'none' | 'playing'
        this._surahAyahCounts     = null;
        this._surahNames          = null;
        this._surahsLoaded        = false;

        // prayer data
        this._cachedTimes    = {};
        this._adjustedTimes  = null;
        this._apiHijri       = null;
        this._connectionState = 'online'; // 'online' | 'offline'
        this._locationState   = 'unset';  // 'unset' | 'set'
        this._nextPrayerName = null;
        this._nextPrayerMs   = 0;
        this._todayDateStr   = null;

        // collections
        this._prayerItems = {};
        this._nightItems  = {};
        this._quranItems  = [];

        // timers
        this._alarmTimerAtPrayer = null;
        this._adhanStopTimer     = null;
        this._resolveTimeout     = null;
        this._refetchTimeout     = null;
        this._updateTimer        = null;

        // adhan bookkeeping
        this._adhanTriggeredFor = null;
        this._lastAlarmKey      = null;
        this._resumeQuran       = false;
        this._preNotifiedSet    = new Set();

        // ui handles
        this._indicator        = null;
        this._nextPrayerLabel  = null;
        this._lastTopbarText   = null;
        this._hijriLabel       = null;
        this._hijriItem        = null;
        this._specialLabel     = null;
        this._specialItem      = null;
        this._offlineLabel     = null;
        this._offlineItem      = null;
        this._settingsLabel    = null;
        this._settingsItem     = null;
        this._verseLabel       = null;
        this._verseTextItem    = null;
        this._playPauseBtn     = null;
        this._surahSubMenu     = null;
        this._quranSeparator   = null;
    }
}
