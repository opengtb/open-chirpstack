// Applique le thème et la langue avant l'affichage pour éviter un flash clair/sombre (script non-module, exécuté tôt).
(function () {
    var p = {};
    try { p = JSON.parse(localStorage.getItem('ocs.prefs')) || {}; } catch (e) { /* préférences absentes */ }
    var dark = p.theme === 'manu' ? p.manual !== 'light' : !window.matchMedia('(prefers-color-scheme: light)').matches;
    document.documentElement.classList.toggle('dark', dark);
    // Même règle que i18n.js : préférence enregistrée, sinon langue du navigateur.
    var lang = p.lang === 'fr' || p.lang === 'en' ? p.lang : (/^fr\b/i.test(navigator.language || '') ? 'fr' : 'en');
    document.documentElement.lang = lang;
})();
