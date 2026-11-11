const Gettext = imports.gettext;

const DOMAIN = 'salatprayertime@mazen.github.com';

export function initTranslations(basePath) {
    try {
        Gettext.bindtextdomain(DOMAIN, basePath + '/locale');
        Gettext.textdomain(DOMAIN);
    } catch (e) {
        // Translations are optional; keep running without them.
    }
}

export function _(str) {
    try { return Gettext.dgettext(DOMAIN, str); }
    catch (e) { return str; }
}
