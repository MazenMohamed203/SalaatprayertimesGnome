import Soup from 'gi://Soup';
import GLib from 'gi://GLib';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

export function fetchSurahs() {
        if (this.state._surahsLoaded) {
            this._populateSurahMenu();
            return;
        }
        const msg = Soup.Message.new('GET', 'https://api.alquran.cloud/v1/surah');
        this._quranSession.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null, (session, res) => {
            try {
                const bytes = session.send_and_read_finish(res);
                if (!this._settings) return;
                const data = JSON.parse(new TextDecoder().decode(bytes.get_data()));

                this.state._surahAyahCounts = data.data.map(s => s.numberOfAyahs);
                this.state._surahNames      = data.data.map(s => s.englishName);
                this.state._surahsLoaded   = true;
                this._populateSurahMenu();
            } catch (e) {
                console.error('[SalatPrayerTime] Error fetching surahs:', e);
            }
        });
    }

export function populateSurahMenu() {
        if (!this.state._surahNames) return;
        this.state._surahSubMenu.label.set_text('Select Surah');
        this.state._surahSubMenu.menu.removeAll();
        this.state._surahNames.forEach((name, idx) => {
            const num = idx + 1;
            const item = new PopupMenu.PopupMenuItem(`${num}. ${name}`);
            item.connect('activate', () => {
                this.state._quranCurrentSurah = num;
                this.state._quranCurrentAyah  = 1;
                this.state._quranStatus = 'playing';
                this.state._bismallahState = 'none';
                this.state._surahSubMenu.label.set_text(`Surah ${name}`);
                this._playQuran();
            });
            this.state._surahSubMenu.menu.addMenuItem(item);
        });
    }

export function playQuran() {
        const wasPaused = this.state._quranStatus === 'paused';
        this.state._quranStatus = 'playing';
        this.state._playPauseBtn.child.icon_name = 'media-playback-pause-symbolic';

        if (wasPaused) {
            this.state._activePlayer.play();
        } else {
            this._fetchAndPlayAyah(this.state._quranCurrentSurah, this.state._quranCurrentAyah, this.state._activePlayer);
        }
    }

export function pauseQuran() {
        this.state._quranStatus = 'paused';
        this.state._playPauseBtn.child.icon_name = 'media-playback-start-symbolic';
        this.state._activePlayer.pause();
    }

export function fetchAndPlayAyah(surah, ayah, player) {
        let actualSurah = surah;
        let actualAyah  = ayah;

        if (ayah === 1 && surah !== 1 && surah !== 9 && this.state._bismallahState !== 'playing') {
            this.state._bismallahState = 'playing';
            actualSurah = 1;
            actualAyah  = 1;
        } else if (this.state._bismallahState === 'playing') {
            this.state._bismallahState = 'none';
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

        if (this.state._bismallahState === 'playing') {
            let bism = 'بِسْمِ ٱللَّهِ ٱلرَّحْمَٰنِ ٱلرَّحِيمِ';
            if (this._settings.get_boolean('show-quran-translation'))
                bism += '\n\nIn the Name of Allah—the Most Compassionate, Most Merciful.';
            this.state._verseLabel.set_text(bism);
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
                        this.state._verseLabel.set_text(text);
                        this.state._quranGlobalAyah = data.data[0].number;
                    }
                } catch (_e) {}
            });
        }
    }

export function onQuranVerseEnded(nextPlayer) {
        if (this.state._quranStatus !== 'playing') return;

        if (this.state._bismallahState === 'playing') {
            this.state._activePlayer = nextPlayer;
            this._fetchAndPlayAyah(this.state._quranCurrentSurah, this.state._quranCurrentAyah, this.state._activePlayer);
            return;
        }

        if (!this.state._surahAyahCounts) {
            this.state._quranStatus = 'idle';
            this.state._playPauseBtn.child.icon_name = 'media-playback-start-symbolic';
            return;
        }

        this.state._quranCurrentAyah++;
        this.state._quranGlobalAyah++;

        const surahLength = this.state._surahAyahCounts
            ? this.state._surahAyahCounts[this.state._quranCurrentSurah - 1]
            : null;

        if (surahLength !== null && this.state._quranCurrentAyah > surahLength) {
            this.state._quranCurrentSurah = this.state._quranCurrentSurah >= 114
                ? 1
                : this.state._quranCurrentSurah + 1;
            this.state._quranCurrentAyah = 1;

            if (this.state._surahNames)
                this.state._surahSubMenu.label.set_text(`Surah ${this.state._surahNames[this.state._quranCurrentSurah - 1]}`);
        }

        this.state._activePlayer = nextPlayer;
        this._fetchAndPlayAyah(this.state._quranCurrentSurah, this.state._quranCurrentAyah, this.state._activePlayer);
    }
