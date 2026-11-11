/**
 * Shared helpers for selecting an AlAdhan calculation method from a country name.
 * Pure module: no GNOME/GI imports, safe to import from both extension.js and prefs.js.
 */

export function autoMethodFromCountry(country) {
    const c = (country || '').toLowerCase();
    if (c.includes('egypt'))                                                           return 5;
    if (c.includes('saudi') || c.includes('makkah') || c.includes('medina'))          return 4;
    if (c.includes('pakistan') || c.includes('bangladesh') ||
        c.includes('india')   || c.includes('afghanistan'))                           return 1;
    if (c.includes('usa') || c.includes('united states') || c.includes('canada'))     return 2;
    if (c.includes('iran'))                                                            return 7;
    if (c.includes('kuwait'))                                                          return 9;
    if (c.includes('qatar'))                                                           return 10;
    if (c.includes('uae') || c.includes('emirates') || c.includes('dubai'))           return 8;
    if (c.includes('bahrain') || c.includes('oman') || c.includes('yemen'))           return 8;
    if (c.includes('singapore'))                                                       return 11;
    if (c.includes('france'))                                                          return 12;
    if (c.includes('turkey') || c.includes('türkiye'))                                return 13;
    if (c.includes('russia'))                                                          return 14;
    if (c.includes('morocco'))                                                         return 3;
    if (c.includes('jordan'))                                                          return 3;
    if (c.includes('algeria') || c.includes('tunisia'))                               return 5;
    if (c.includes('indonesia') || c.includes('malaysia'))                            return 11;
    return 3; // Muslim World League — safe global default
}
