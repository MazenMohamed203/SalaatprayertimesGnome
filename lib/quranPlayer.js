import Soup from 'gi://Soup';
import GLib from 'gi://GLib';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

export function fetchSurahs() {
        const msg = Soup.Message.new('GET', 'https://api.alquran.cloud/v1/surah');
        this._quranSession.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null, (session, res) => {
            try {
                const bytes = session.send_and_read_finish(res);
                if (!this._settings) return;
                const data = JSON.parse(new TextDecoder().decode(bytes.get_data()));

                this._surahAyahCounts = data.data.map(s => s.numberOfAyahs);
                this._surahNames      = data.data.map(s => s.englishName);
                this._surahSubMenu.label.set_text('Select Surah');
                data.data.forEach(surah => {
                    const item = new PopupMenu.PopupMenuItem(`${surah.number}. ${surah.englishName}`);
                    item.connect('activate', () => {
                        this._quranCurrentSurah = surah.number;
                        this._quranCurrentAyah  = 1;
                        this._isPaused = false;
                        this._isPlayingBismallah = false;
                        this._surahSubMenu.label.set_text(`Surah ${surah.englishName}`);
                        this._playQuran();
                    });
                    this._surahSubMenu.menu.addMenuItem(item);
                });
            } catch (e) {
                console.error('[SalatPrayerTime] Error fetching surahs:', e);
            }
        });
    }

export function playQuran() {
        this._continuousQuran = true;
        this._playPauseBtn.child.icon_name = 'media-playback-pause-symbolic';

        if (this._isPaused) {
            this._isPaused = false;
            this._activePlayer.play();
        } else {
            this._fetchAndPlayAyah(this._quranCurrentSurah, this._quranCurrentAyah, this._activePlayer);
        }
    }

export function pauseQuran() {
        this._continuousQuran = false;
        this._isPaused = true;
        this._playPauseBtn.child.icon_name = 'media-playback-start-symbolic';
        this._activePlayer.pause();
    }

export function fetchAndPlayAyah(surah, ayah, player) {
        let actualSurah = surah;
        let actualAyah  = ayah;

        if (ayah === 1 && surah !== 1 && surah !== 9 && !this._isPlayingBismallah) {
            this._isPlayingBismallah = true;
            actualSurah = 1;
            actualAyah  = 1;
        } else if (this._isPlayingBismallah) {
            this._isPlayingBismallah = false;
        }

        const reciters = [
            'Abdul_Basit_Murattal_192kbps',
            'Abdul_Basit_Mujawwad_128kbps',
            'Abdurrahmaan_As-Sudais_192kbps',
            'Saood_ash-Shuraym_128kbps',
            'Alafasy_128kbps',
            'Minshawy_Mujawwad_192kbps',
            'Minshawy_Murattal_128kbps',
            'Husary_128kbps',
            'Abu_Bakr_Ash-Shaatree_128kbps'
        ];
        const reciter     = reciters[this._settings.get_int('quran-reciter-index') || 0];
        const paddedSurah = actualSurah.toString().padStart(3, '0');
        const paddedAyah  = actualAyah.toString().padStart(3, '0');
        const url         = `https://everyayah.com/data/${reciter}/${paddedSurah}${paddedAyah}.mp3`;

        player.setVolume(this._settings.get_double('quran-volume') || 0.7);
        player.setSource(url);
        player.play();

        if (this._isPlayingBismallah) {
            let bism = 'بِسْمِ ٱللَّهِ ٱلرَّحْمَٰنِ ٱلرَّحِيمِ';
            if (this._settings.get_boolean('show-quran-translation'))
                bism += '\n\nIn the Name of Allah—the Most Compassionate, Most Merciful.';
            this._verseLabel.set_text(bism);
        } else {
            const showTrans = this._settings.get_boolean('show-quran-translation');
            const editions = showTrans ? 'quran-uthmani,en.itani' : 'quran-uthmani';
            const textMsg = Soup.Message.new(
                'GET',
                `https://api.alquran.cloud/v1/ayah/${surah}:${ayah}/editions/${editions}`
            );
            this._quranSession.send_and_read_async(textMsg, GLib.PRIORITY_DEFAULT, null, (s, res) => {
                try {
                    const bytes = s.send_and_read_finish(res);
                    if (!this._settings) return;
                    const data  = JSON.parse(new TextDecoder().decode(bytes.get_data()));
                    if (data.data && data.data[0]) {
                        let text = data.data[0].text;
                        if (showTrans && data.data[1])
                            text += '\n\n' + data.data[1].text;
                        this._verseLabel.set_text(text);
                        this._quranGlobalAyah = data.data[0].number;
                    }
                } catch (_e) {}
            });
        }
    }

export function onQuranVerseEnded(nextPlayer) {
        if (!this._continuousQuran) return;

        if (this._isPlayingBismallah) {
            this._activePlayer = nextPlayer;
            this._fetchAndPlayAyah(this._quranCurrentSurah, this._quranCurrentAyah, this._activePlayer);
            return;
        }

        if (!this._surahAyahCounts) {
            this._continuousQuran = false;
            this._playPauseBtn.child.icon_name = 'media-playback-start-symbolic';
            return;
        }

        this._quranCurrentAyah++;
        this._quranGlobalAyah++;

        const surahLength = this._surahAyahCounts
            ? this._surahAyahCounts[this._quranCurrentSurah - 1]
            : null;

        if (surahLength !== null && this._quranCurrentAyah > surahLength) {
            this._quranCurrentSurah = this._quranCurrentSurah >= 114
                ? 1
                : this._quranCurrentSurah + 1;
            this._quranCurrentAyah = 1;

            if (this._surahNames)
                this._surahSubMenu.label.set_text(`Surah ${this._surahNames[this._quranCurrentSurah - 1]}`);
        }

        this._activePlayer = nextPlayer;
        this._fetchAndPlayAyah(this._quranCurrentSurah, this._quranCurrentAyah, this._activePlayer);
    }
