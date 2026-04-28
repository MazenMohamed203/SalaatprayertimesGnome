# Salaat Prayer Times

A GNOME Shell extension for Islamic prayer times that features built-in Adhan notifications and a full Quran audio player. It's built to work fully offline and integrate cleanly into the modern GNOME desktop (supports versions 45 through 50+).

## Features

- **Works offline:** After you set your location, it calculates a full month of prayer times locally so it doesn't need a constant internet connection.
- **Top bar placement:** You can move the widget to the left, center, or right of your GNOME top bar.
- **Built-in Adhan:** Automatically plays the call to prayer at the exact time using GNOME's native audio system. You can configure the volume and toggle it on or off for specific prayers.
- **Listen & Read the Quran:** Open the widget to stream the Quran verse-by-verse from 9 different reciters. You can follow along with the Arabic text and optionally display the Clear Quran English translation underneath.
- **Languages:** The interface fully supports both English and Arabic, and includes the Hijri date.

## Installation

**Method 1: GNOME Extensions Website**
*(Coming soon once approved on extensions.gnome.org)*

**Method 2: Manual Installation**
1. Download the repository as a ZIP file and extract it.
2. Ensure you have the `gnome-extensions` command line tool installed.
3. Build and install the extension (open the terminal in the folder):
```bash
gnome-extensions pack --extra-source=assets/ --extra-source=logic/ --extra-source=LICENSE --force
gnome-extensions install salatprayertime@mazen.github.com.shell-extension.zip --force
```
4. Log out and log back in.
5. Enable the extension via the **Extensions** app.

## Configuration

You can open the GNOME Extensions app and click the Settings gear next to **Salaat Prayer Times** to adjust things like:
* Your coordinates and calculation methods (school and authority).
* Adhan volume and which prayers you want to play the Adhan for.
* Quran reciter, playback volume, and whether to show the English translation.

## Contributing

Pull requests are welcome! If you find a bug or have an idea for a new feature, feel free to open an issue.

## License
This project is licensed under the GPL-2.0 License - see the LICENSE file for details.
