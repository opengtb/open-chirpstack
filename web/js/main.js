// Point d'entrée : connexion, coque de l'application (barre du haut, navigation), routage, thème, palette.

import * as api from './api.js';
import * as store from './store.js';
import { session, listen, setApp, loadTenantData, clearAll, devices } from './state.js';
import { $, $$, html, render, icon, LOGO, openMenu, closeMenu, toast, fmtNum } from './ui.js';
import { openPalette } from './palette.js';

const CARET = icon('chevron', 'caret');

import * as connectView from './views/connect.js';
import * as homeView from './views/home.js';
import * as devicesView from './views/devices.js';
import * as importView from './views/import.js';
import * as tagsView from './views/tags.js';
import * as searchView from './views/search.js';
import * as historyView from './views/history.js';
import * as settingsView from './views/settings.js';

export const ROUTES = [
    { path: 'vue', label: 'vue d\'ensemble', icon: 'grid', view: homeView, group: 'application' },
    { path: 'devices', label: 'devices', icon: 'list', view: devicesView, group: 'application', needsApp: true, count: true },
    { path: 'import', label: 'importer', icon: 'upload', view: importView, group: 'application', needsApp: true },
    { path: 'tags', label: 'tags par fichier', icon: 'tag', view: tagsView, group: 'application', needsApp: true },
    { path: 'historique', label: 'historique', icon: 'chart', view: historyView, group: 'tenant' },
    { path: 'recherche', label: 'rechercher', icon: 'search', view: searchView, group: 'tenant' },
    { path: 'reglages', label: 'réglages', icon: 'settings', view: settingsView, group: 'outil' },
];

const app = document.getElementById('app');
let cleanup = null;
let current = null;

// ---------- Thème (AUTO / MANU / HORS, comme sur OpenGTB) ----------
function applyTheme() {
    const p = store.prefs();
    const dark = p.theme === 'manu' ? p.manual !== 'light' : !matchMedia('(prefers-color-scheme: light)').matches;
    document.documentElement.classList.toggle('dark', dark);
    $$('.theme-switch button').forEach((b) => {
        b.setAttribute('aria-checked', String(b.dataset.mode === p.theme || (b.dataset.mode === 'auto' && !['manu'].includes(p.theme))));
        if (b.dataset.mode === 'manu') render(b, html`MANU${p.theme === 'manu' ? html`<span aria-hidden="true"> ${dark ? '☾' : '☀'}</span>` : ''}`);
        if (b.dataset.mode === 'auto') render(b, html`AUTO${p.theme !== 'manu' ? html`<span aria-hidden="true"> ${dark ? '☾' : '☀'}</span>` : ''}`);
    });
}
matchMedia('(prefers-color-scheme: light)').addEventListener('change', applyTheme);

export function setTheme(mode) {
    const p = store.prefs();
    if (mode === 'hors') return showHors();
    if (mode === 'manu') {
        const isDark = document.documentElement.classList.contains('dark');
        const manual = p.theme === 'manu' ? (isDark ? 'light' : 'dark') : (isDark ? 'dark' : 'light');
        store.setPrefs({ theme: 'manu', manual });
        applyTheme();
        toast(`MANU — thème ${manual === 'dark' ? 'sombre' : 'clair'} forcé. Recliquez pour basculer.`);
    } else {
        store.setPrefs({ theme: 'auto' });
        applyTheme();
        toast('AUTO — le thème suit celui du système.');
    }
}

function themeSwitch() {
    return html`<div class="theme-switch" role="radiogroup" aria-label="Commutateur de thème">
        <button type="button" role="radio" data-mode="auto" title="Suivre le thème du système">AUTO</button>
        <button type="button" role="radio" data-mode="manu" title="Forcer le thème — chaque clic bascule clair/sombre">MANU</button>
        <button type="button" role="radio" data-mode="hors" title="Mettre l'outil hors service">HORS</button>
    </div>`;
}

function showHors() {
    const el = document.createElement('div');
    el.className = 'hors';
    render(el, html`<div class="inner">
        <span class="lamp" aria-hidden="true"></span>
        <p class="sub">// défaut général</p>
        <p class="big">Automate à l'arrêt.</p>
        <p class="sub">Quelqu'un a mis le commutateur sur HORS. Aucune donnée ne remonte, plus aucun device n'est importé…</p>
        <p class="amber">Vos devices, eux, continuent d'émettre. Promis.</p>
        <button class="btn btn-primary" autofocus>$ réarmer →</button>
    </div>`);
    document.body.appendChild(el);
    const btn = $('button', el);
    btn.focus();
    btn.addEventListener('click', () => {
        el.remove();
        toast('Réarmement effectué — retour en AUTO.');
    });
}

document.addEventListener('click', (e) => {
    const b = e.target.closest('.theme-switch button');
    if (b) setTheme(b.dataset.mode);
});

// ---------- Connexion ----------
function showConnect() {
    teardown();
    current = null;
    render(app, html`
        <header class="topbar"><div class="topbar-inner">
            <a class="logo" href="#/" aria-label="open/chirpstack">${LOGO}<span>open<span class="slash">/</span><span class="accent">chirpstack</span></span></a>
            <span class="spacer"></span>
            ${themeSwitch()}
        </div></header>
        <main id="connect-root"></main>`);
    applyTheme();
    cleanup = connectView.mount($('#connect-root'), { onConnected });
}

// Appelé par la vue de connexion quand le tenant est choisi.
async function onConnected() {
    session.connected = true;
    const url = api.serverUrl();
    const last = store.lastContext(url);
    const remembered = session.apps.find((a) => a.id === last.appId);
    // En démo, on ouvre directement la première application pour montrer quelque chose de parlant.
    const only = session.apps.length === 1 || api.isDemo() ? session.apps[0] : null;
    session.app = remembered || only || null;
    renderShell();
    const target = (location.hash.replace(/^#\/?/, '').split('?')[0]) || (session.app ? 'devices' : 'vue');
    navigate(ROUTES.some((r) => r.path === target) ? target : 'vue', true);
}

export async function switchTenant(tenant) {
    try {
        await loadTenantData(tenant);
        store.rememberContext(api.serverUrl(), { tenantId: tenant.id });
        const last = store.lastContext(api.serverUrl());
        session.app = session.apps.find((a) => a.id === last.appId) || (session.apps.length === 1 ? session.apps[0] : null);
        renderShell();
        navigate(current?.needsApp && !session.app ? 'vue' : current?.path || 'vue', true);
        toast(`Tenant : ${tenant.name}`);
    } catch (e) {
        toast(api.humanize(e), { type: 'err' });
    }
}

export function chooseApp(appItem, { go } = {}) {
    if (!appItem) return;
    session.app = appItem;
    store.rememberContext(api.serverUrl(), { tenantId: session.tenant.id, appId: appItem.id });
    setApp(appItem);
    updateTopbar();
    devices(appItem.id).catch(() => {});
    if (go) navigate(go);
    else if (current) navigate(current.path, true);
}

export function logout() {
    api.disconnect();
    clearAll();
    location.hash = '';
    showConnect();
}

// ---------- Coque ----------
function renderShell() {
    teardown();
    const demo = api.isDemo();
    render(app, html`
        <header class="topbar"><div class="topbar-inner">
            <a class="logo" href="#/vue" aria-label="open/chirpstack — vue d'ensemble">${LOGO}<span>open<span class="slash">/</span><span class="accent">chirpstack</span></span></a>
            <nav class="context" aria-label="Contexte" id="context"></nav>
            <span class="spacer"></span>
            <button class="tb-btn" data-palette title="Commandes (Ctrl+K)" aria-label="Ouvrir la palette de commandes">&gt;_</button>
            ${themeSwitch()}
        </div></header>
        ${demo ? html`<div class="banner amber"><span class="pill amber">démo</span>
            <span><strong>Données fictives</strong> — rien n'est envoyé à un serveur, tout est remis à zéro au rechargement. Essayez tout, y compris la suppression.</span>
            <span class="spacer"></span><button class="btn btn-sm" data-logout>Se connecter à mon ChirpStack →</button></div>` : ''}
        <div class="shell">
            <aside class="sidebar" id="sidebar"></aside>
            <main class="main" id="view" tabindex="-1"></main>
        </div>`);
    applyTheme();
    $('[data-palette]').addEventListener('click', () => openPalette());
    $('[data-logout]')?.addEventListener('click', logout);
    updateTopbar();
    renderSidebar();
}

function updateTopbar() {
    const ctx = $('#context');
    if (!ctx) return;
    const host = api.isDemo() ? 'démo' : api.serverUrl().replace(/^https?:\/\//, '');
    render(ctx, html`
        <button class="ctx-chip" data-ctx="server" title="${api.serverUrl()}"><span class="ctx-dot ${api.isDemo() ? 'demo' : ''}"></span><span class="label">${host}</span>${CARET}</button>
        <span class="sep">/</span>
        <button class="ctx-chip" data-ctx="tenant" title="Tenant"><span class="label">${session.tenant?.name || '—'}</span>${session.tenants.length > 1 ? html`${CARET}` : ''}</button>
        <span class="sep">/</span>
        <button class="ctx-chip app" data-ctx="app" title="Application (Ctrl+K pour chercher)"><span class="label">${session.app?.name || 'choisir une application'}</span>${CARET}</button>`);
    ctx.onclick = (e) => {
        const b = e.target.closest('[data-ctx]');
        if (!b) return;
        if (b.dataset.ctx === 'app') appMenu(b);
        if (b.dataset.ctx === 'tenant' && session.tenants.length > 1) tenantMenu(b);
        if (b.dataset.ctx === 'server') serverMenu(b);
    };
    renderSidebar();
}

export function appMenu(anchor) {
    openMenu(anchor, {
        filter: session.apps.length > 6,
        placeholder: 'Filtrer les applications…',
        items: session.apps.map((a) => ({ label: a.name, value: a, current: a.id === session.app?.id, meta: session.appCounts[a.id] !== undefined ? fmtNum(session.appCounts[a.id]) : '' })),
        onPick: (it) => chooseApp(it.value),
    });
}

function tenantMenu(anchor) {
    openMenu(anchor, {
        filter: session.tenants.length > 6,
        placeholder: 'Filtrer les tenants…',
        items: session.tenants.map((t) => ({ label: t.name, value: t, current: t.id === session.tenant?.id })),
        onPick: (it) => switchTenant(it.value),
    });
}

function serverMenu(anchor) {
    const others = store.servers().filter((s) => s.url !== api.serverUrl());
    openMenu(anchor, {
        items: [
            { group: api.isDemo() ? 'mode démo' : api.serverUrl() },
            { label: 'Se déconnecter', value: 'logout', meta: 'clé oubliée' },
            ...(others.length ? [{ group: 'autres serveurs' }, ...others.map((s) => ({ label: s.name, meta: s.url.replace(/^https?:\/\//, ''), value: s }))] : []),
        ],
        onPick: (it) => {
            if (it.value === 'logout') return logout();
            store.setPrefs({ lastUrl: it.value.url });
            logout();
        },
    });
}

function renderSidebar() {
    const side = $('#sidebar');
    if (!side) return;
    const groups = [['application', '// application'], ['tenant', '// tenant'], ['outil', '// outil']];
    const n = session.app ? session.appCounts[session.app.id] : undefined;
    render(side, html`
        ${groups.map(([g, title]) => html`<div class="nav-group"><div class="nav-title">${title}</div>
            ${ROUTES.filter((r) => r.group === g).map((r) => html`<a class="nav-link ${current?.path === r.path ? 'active' : ''}" href="#/${r.path}" ${current?.path === r.path ? html`aria-current="page"` : ''}>
                ${icon(r.icon)}<span>${r.label}</span>${r.count && n !== undefined ? html`<span class="count">${fmtNum(n)}</span>` : ''}</a>`)}
        </div>`)}
        <div class="sidebar-foot">
            <p><kbd>Ctrl</kbd> <kbd>K</kbd> commandes</p>
            <p><kbd>/</kbd> rechercher</p>
            <p class="mt-s">Clé API gardée en mémoire seulement.</p>
        </div>`);
}
listen('counts', renderSidebar);
listen('devices', renderSidebar);

// ---------- Routage ----------
function teardown() {
    closeMenu();
    if (cleanup) {
        try { cleanup(); } catch { /* vue déjà démontée */ }
        cleanup = null;
    }
}

export function navigate(path, replace = false) {
    const route = ROUTES.find((r) => r.path === path) || ROUTES[0];
    const hash = `#/${route.path}`;
    const currentPath = location.hash.replace(/^#\/?/, '').split('?')[0];
    if (currentPath !== route.path) {
        if (replace) history.replaceState(null, '', hash);
        else {
            location.hash = hash;
            return; // hashchange rappellera navigate
        }
    }
    show(route);
}

function show(route) {
    if (!session.connected) return;
    teardown();
    current = route;
    renderSidebar();
    // Conteneur neuf à chaque écran : les écouteurs de l'écran précédent disparaissent avec l'ancien.
    const old = $('#view');
    const view = old.cloneNode(false);
    old.replaceWith(view);
    window.scrollTo(0, 0);
    if (route.needsApp && !session.app) {
        cleanup = mountAppPicker(view, route);
    } else {
        cleanup = route.view.mount(view, { navigate, chooseApp, appMenu }) || null;
    }
    document.title = `${route.label} · open/chirpstack`;
}

// Écran intermédiaire quand un outil a besoin d'une application et qu'aucune n'est choisie.
function mountAppPicker(view, route) {
    render(view, html`<div class="page narrow">
        <div class="page-head"><div><div class="eyebrow">$ cs ${route.path}</div><h1>Quelle application ?</h1>
            <p class="lede">Choisissez l'application sur laquelle travailler. Elle restera sélectionnée pour les autres outils.</p></div></div>
        ${session.apps.length ? html`<div class="table-wrap"><table class="tbl"><tbody>${session.apps.map((a) => html`<tr class="clickable" data-app="${a.id}">
            <td class="name">${a.name}${a.description ? html`<small>${a.description}</small>` : ''}</td>
            <td class="dim small nowrap" style="text-align:right">${session.appCounts[a.id] !== undefined ? `${fmtNum(session.appCounts[a.id])} devices` : ''}</td>
            <td style="width:1%"><span class="btn btn-sm">ouvrir →</span></td></tr>`)}</tbody></table></div>`
        : html`<div class="empty-state"><h3>Aucune application dans ce tenant</h3><p>Créez-en une dans ChirpStack, puis rechargez cette page.</p></div>`}
    </div>`);
    const h = (e) => {
        const tr = e.target.closest('[data-app]');
        if (tr) chooseApp(session.apps.find((a) => a.id === tr.dataset.app), { go: route.path });
    };
    view.addEventListener('click', h);
    return () => view.removeEventListener('click', h);
}

window.addEventListener('hashchange', () => {
    if (!session.connected) return;
    const path = location.hash.replace(/^#\/?/, '').split('?')[0];
    const route = ROUTES.find((r) => r.path === path);
    if (route && route !== current) show(route);
    else if (!route) navigate('vue', true);
});

// ---------- Raccourcis ----------
document.addEventListener('keydown', (e) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        if (session.connected) openPalette();
        return;
    }
    if (!typing && e.key === '`' && session.connected) {
        e.preventDefault();
        openPalette();
    }
    if (!typing && e.key === '/' && session.connected) {
        const s = $('#view [data-search]');
        if (s) {
            e.preventDefault();
            s.focus();
            s.select();
        }
    }
});

// Clé API en mémoire : prévenir avant de quitter une session connectée par erreur.
window.addEventListener('beforeunload', (e) => {
    if (document.querySelector('dialog[open] [data-stop]:not(:disabled)')) {
        e.preventDefault();
        e.returnValue = '';
    }
});

applyTheme();
showConnect();
