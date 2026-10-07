// Traduction de l'interface. Le texte français du code sert de clé : t('Exporter') renvoie « Export » en anglais.
// Une clé absente du dictionnaire s'affiche en français (jamais de texte vide).

import en from './locales/en.js';

const DICTS = { en };
export const LANGS = [
    { code: 'fr', label: 'FR', name: 'Français' },
    { code: 'en', label: 'EN', name: 'English' },
];

const STORE_KEY = 'ocs.prefs';

function detect() {
    try {
        const p = JSON.parse(localStorage.getItem(STORE_KEY)) || {};
        if (LANGS.some((l) => l.code === p.lang)) return p.lang;
    } catch {
        /* préférences absentes */
    }
    return /^fr\b/i.test(navigator.language || '') ? 'fr' : 'en';
}

let lang = detect();
document.documentElement.lang = lang;

export const getLang = () => lang;

export function setLang(code) {
    if (!LANGS.some((l) => l.code === code)) return;
    lang = code;
    document.documentElement.lang = code;
    try {
        const p = JSON.parse(localStorage.getItem(STORE_KEY)) || {};
        localStorage.setItem(STORE_KEY, JSON.stringify({ ...p, lang: code }));
    } catch {
        /* stockage indisponible : la langue vaut pour la session */
    }
}

// Locale des dates et nombres.
export const locale = () => (lang === 'fr' ? 'fr-FR' : 'en-GB');

/**
 * t('Bonjour {name}', { name }) : traduit puis remplace les {variables}.
 * Les valeurs remplacées ne sont pas traduites.
 */
export function t(fr, vars) {
    let s = lang === 'fr' ? fr : (DICTS[lang]?.[fr] ?? fr);
    if (vars) s = s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
    return s;
}

// Séparateur et décimales des CSV : point-virgule + virgule pour Excel français, virgule + point sinon.
export const csvSeparator = () => (lang === 'fr' ? ';' : ',');
export function csvNumber(v) {
    if (v === null || v === undefined || v === '' || !Number.isFinite(Number(v))) return '';
    const s = String(v);
    return lang === 'fr' ? s.replace('.', ',') : s;
}

// Nom de commande affiché « $ cs … » pour un écran (le chemin de l'URL, lui, ne change pas).
const COMMANDS = {
    fr: { reglages: 'réglages' },
    en: { vue: 'overview', historique: 'history', recherche: 'search', reglages: 'settings' },
};
export const cmd = (path) => COMMANDS[lang]?.[path] ?? path;
