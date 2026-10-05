// Palette de commandes (Ctrl+K ou `) : navigation, changement d'application, recherche de DevEUI.

import { ROUTES, navigate, chooseApp, setTheme, logout } from './main.js';
import { session, invalidate } from './state.js';
import { $, html, render, icon, fmtNum, openDialog } from './ui.js';
import { normHex } from './files.js';

function commands(q) {
    const list = [];
    const hex = normHex(q);
    if (hex.length >= 4 && /^[0-9a-f]+$/.test(hex)) {
        list.push({ group: 'rechercher' });
        list.push({ label: `Chercher le DevEUI « ${hex} » dans tout le tenant`, cmd: 'recherche', icon: 'search', run: () => { session.pendingSearch = hex; navigate('recherche'); } });
    } else if (q.trim().length >= 2) {
        list.push({ group: 'rechercher' });
        list.push({ label: `Chercher « ${q.trim()} » dans les noms de devices`, cmd: 'recherche', icon: 'search', run: () => { session.pendingSearch = q.trim(); navigate('recherche'); } });
    }
    list.push({ group: 'aller à' });
    for (const r of ROUTES) {
        list.push({ label: r.label.charAt(0).toUpperCase() + r.label.slice(1), cmd: `cs ${r.path}`, icon: r.icon, run: () => navigate(r.path), disabled: r.needsApp && !session.app });
    }
    if (session.apps.length) {
        list.push({ group: 'applications' });
        for (const a of session.apps) {
            const n = session.appCounts[a.id];
            list.push({ label: a.name, cmd: n !== undefined ? `${fmtNum(n)} devices` : '', icon: 'layers', current: a.id === session.app?.id, run: () => chooseApp(a, { go: 'devices' }) });
        }
    }
    list.push({ group: 'actions' });
    if (session.app) list.push({ label: 'Recharger les devices de l\'application', cmd: 'refresh', icon: 'refresh', run: () => { invalidate(session.app.id); navigate('devices'); } });
    list.push({ label: 'Basculer clair / sombre', cmd: 'manu', icon: 'sparkles', run: () => setTheme('manu') });
    list.push({ label: 'Se déconnecter', cmd: 'logout', icon: 'logout', run: () => logout() });
    return list;
}

function score(item, q) {
    if (item.group) return 1;
    if (!q) return 1;
    const t = `${item.label} ${item.cmd || ''}`.toLowerCase();
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    return words.every((w) => t.includes(w)) ? 1 : 0;
}

export function openPalette() {
    if (document.querySelector('dialog.palette-dlg')) return;
    let items = [];
    let active = 0;

    const d = openDialog({
        cls: 'palette-dlg',
        body: html`<div class="palette-input"><span class="prompt">$</span><input type="text" placeholder="aller à, application, DevEUI…" aria-label="Commande" autofocus spellcheck="false"></div>
            <div class="palette-list" role="listbox"></div>
            <div class="palette-foot"><span><kbd>↑</kbd> <kbd>↓</kbd> naviguer</span><span><kbd>Entrée</kbd> valider</span><span><kbd>Échap</kbd> fermer</span></div>`,
    });
    const el = d.el;
    el.querySelector('.dlg-body').style.padding = '0';
    const input = $('input', el);
    const listEl = $('.palette-list', el);

    const draw = () => {
        const q = input.value;
        const all = commands(q);
        // Les commandes de recherche restent toujours visibles ; filtrage sur le reste.
        items = all.filter((it, i) => {
            if (it.group) return true;
            if (it.cmd === 'recherche') return true;
            return score(it, q) && !it.disabled;
        });
        // Retire les titres de groupe vides.
        items = items.filter((it, i) => !it.group || (items[i + 1] && !items[i + 1].group));
        const selectable = items.map((it, i) => (it.group ? -1 : i)).filter((i) => i >= 0);
        if (!selectable.includes(active)) active = selectable[0] ?? 0;
        render(listEl, items.map((it, i) => it.group
            ? html`<div class="palette-group">// ${it.group}</div>`
            : html`<button class="palette-item ${i === active ? 'on' : ''}" data-i="${i}" role="option" aria-selected="${i === active}">${icon(it.icon || 'terminal')}<span>${it.label}</span>${it.current ? html`<span class="badge">actuelle</span>` : ''}<span class="cmd">${it.cmd || ''}</span></button>`));
        listEl.querySelector('.on')?.scrollIntoView({ block: 'nearest' });
    };

    const runAt = (i) => {
        const it = items[i];
        if (!it || it.group) return;
        d.close();
        it.run();
    };

    input.addEventListener('input', () => { active = -1; draw(); });
    input.addEventListener('keydown', (e) => {
        const selectable = items.map((it, i) => (it.group ? -1 : i)).filter((i) => i >= 0);
        const pos = selectable.indexOf(active);
        if (e.key === 'ArrowDown') { active = selectable[Math.min(pos + 1, selectable.length - 1)]; draw(); e.preventDefault(); }
        if (e.key === 'ArrowUp') { active = selectable[Math.max(pos - 1, 0)]; draw(); e.preventDefault(); }
        if (e.key === 'Enter') { runAt(active); e.preventDefault(); }
    });
    listEl.addEventListener('click', (e) => {
        const b = e.target.closest('[data-i]');
        if (b) runAt(Number(b.dataset.i));
    });
    listEl.addEventListener('mousemove', (e) => {
        const b = e.target.closest('[data-i]');
        if (b && Number(b.dataset.i) !== active) {
            active = Number(b.dataset.i);
            listEl.querySelectorAll('.palette-item').forEach((x) => x.classList.toggle('on', Number(x.dataset.i) === active));
        }
    });
    draw();
    input.focus();
}
