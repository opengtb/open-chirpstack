// Applique le thème avant l'affichage pour éviter un flash clair/sombre (script non-module, exécuté tôt).
(function () {
    var p = {};
    try { p = JSON.parse(localStorage.getItem('ocs.prefs')) || {}; } catch (e) { /* préférences absentes */ }
    var dark = p.theme === 'manu' ? p.manual !== 'light' : !window.matchMedia('(prefers-color-scheme: light)').matches;
    document.documentElement.classList.toggle('dark', dark);
})();
