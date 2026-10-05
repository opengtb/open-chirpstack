// Outils d'interface : rendu HTML échappé, icônes, toasts, dialogues, menus, formats.

// ---------- Rendu HTML sûr ----------
// html`...` échappe toutes les valeurs interpolées, sauf celles déjà produites par html`` ou raw().
export class Safe {
    constructor(s) { this.s = s; }
    toString() { return this.s; }
}
export const raw = (s) => new Safe(String(s));

export function esc(v) {
    return String(v ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function part(v) {
    if (v === null || v === undefined || v === false) return '';
    if (v instanceof Safe) return v.s;
    if (Array.isArray(v)) return v.map(part).join('');
    return esc(v);
}

export function html(strings, ...vals) {
    let out = strings[0];
    for (let i = 0; i < vals.length; i++) out += part(vals[i]) + strings[i + 1];
    return new Safe(out);
}

export function render(el, content) {
    el.innerHTML = part(content);
    return el;
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

// Délégation : on(root, 'click', { action: (el, ev) => ... }) sur les éléments [data-act="action"].
export function on(root, type, handlers) {
    root.addEventListener(type, (ev) => {
        const el = ev.target.closest('[data-act]');
        if (!el || !root.contains(el)) return;
        const fn = handlers[el.dataset.act];
        if (fn) fn(el, ev);
    });
}

export function debounce(fn, ms = 180) {
    let t;
    return (...args) => {
        clearTimeout(t);
        t = setTimeout(() => fn(...args), ms);
    };
}

// ---------- Icônes (traits type Lucide) ----------
const ICONS = {
    pulse: '<path d="M2 11 H6 L8 5 L12 17 L14 11 H20"/>',
    grid: '<rect width="7" height="7" x="3" y="3" rx="1"/><rect width="7" height="7" x="14" y="3" rx="1"/><rect width="7" height="7" x="14" y="14" rx="1"/><rect width="7" height="7" x="3" y="14" rx="1"/>',
    list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
    upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m17 8-5-5-5 5"/><path d="M12 3v12"/>',
    download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>',
    tag: '<path d="M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z"/><circle cx="7.5" cy="7.5" r=".5" fill="currentColor"/>',
    search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
    settings: '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
    radio: '<path d="M16.247 7.761a6 6 0 0 1 0 8.478"/><path d="M19.075 4.933a10 10 0 0 1 0 14.134"/><path d="M4.925 19.067a10 10 0 0 1 0-14.134"/><path d="M7.753 16.239a6 6 0 0 1 0-8.478"/><circle cx="12" cy="12" r="2"/>',
    file: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/>',
    refresh: '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
    trash: '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
    move: '<path d="M8 3 4 7l4 4"/><path d="M4 7h16"/><path d="m16 21 4-4-4-4"/><path d="M20 17H4"/>',
    layers: '<path d="m12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z"/><path d="m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65"/><path d="m22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65"/>',
    copy: '<rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
    external: '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
    chevron: '<path d="m6 9 6 6 6-6"/>',
    x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
    plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
    eye: '<path d="M2.06 12.35a1 1 0 0 1 0-.7 10.75 10.75 0 0 1 19.88 0 1 1 0 0 1 0 .7 10.75 10.75 0 0 1-19.88 0"/><circle cx="12" cy="12" r="3"/>',
    logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/>',
    play: '<polygon points="6 3 20 12 6 21 6 3"/>',
    stop: '<rect width="14" height="14" x="5" y="5" rx="1"/>',
    undo: '<path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13"/>',
    gateway: '<path d="M12 20v-8"/><path d="M8.5 8.5a5 5 0 0 1 7 0"/><path d="M5.6 5.6a9 9 0 0 1 12.8 0"/><rect width="8" height="4" x="8" y="18" rx="1"/>',
    sparkles: '<path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"/>',
    terminal: '<path d="m4 17 6-6-6-6"/><path d="M12 19h8"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    alert: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
    battery: '<rect width="16" height="10" x="2" y="7" rx="2"/><path d="M22 11v2"/>',
    paste: '<rect width="8" height="4" x="8" y="2" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/>',
    edit: '<path d="M12 20h9"/><path d="M16.376 3.622a1 1 0 0 1 3.002 3.002L7.368 18.635a2 2 0 0 1-.855.506l-2.872.838a.5.5 0 0 1-.62-.62l.838-2.872a2 2 0 0 1 .506-.854z"/>',
};

export function icon(name, cls = '') {
    return raw(`<svg class="${cls}" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`);
}

export const LOGO = raw('<svg width="20" height="20" viewBox="0 0 22 22" fill="none" aria-hidden="true"><path d="M2 11 H6 L8 5 L12 17 L14 11 H20" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/></svg>');

// ---------- Toasts ----------
export function toast(message, { type = 'ok', action, onAction, duration = 4200 } = {}) {
    let box = $('#toasts');
    if (!box) {
        box = document.createElement('div');
        box.id = 'toasts';
        box.className = 'toasts';
        box.setAttribute('role', 'status');
        box.setAttribute('aria-live', 'polite');
        document.body.appendChild(box);
    }
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    const span = document.createElement('span');
    span.textContent = message;
    el.appendChild(span);
    if (action && onAction) {
        const b = document.createElement('button');
        b.textContent = action;
        b.addEventListener('click', () => { onAction(); el.remove(); });
        el.appendChild(b);
    }
    box.appendChild(el);
    setTimeout(() => el.remove(), duration);
}

// ---------- Dialogues ----------
// openDialog({ title, body, foot, wide, onMount }) → { el, close }.
// Les boutons [data-close] ferment le dialogue ; la promesse `closed` est résolue avec la valeur passée à close().
export function openDialog({ title, body, foot, wide = false, cls = '', onMount }) {
    const dlg = document.createElement('dialog');
    dlg.className = `${wide ? 'wide' : ''} ${cls}`;
    render(dlg, html`
        ${title ? html`<div class="dlg-head"><h2>${title}</h2><button class="btn btn-ghost btn-icon x" data-close aria-label="Fermer">${icon('x')}</button></div>` : ''}
        <div class="dlg-body">${body}</div>
        ${foot ? html`<div class="dlg-foot">${foot}</div>` : ''}`);
    document.body.appendChild(dlg);
    let resolve;
    const closed = new Promise((r) => { resolve = r; });
    let value;
    const close = (v) => { value = v; dlg.close(); };
    dlg.addEventListener('close', () => { dlg.remove(); resolve(value); });
    dlg.addEventListener('click', (e) => {
        if (e.target === dlg) close();
        if (e.target.closest('[data-close]')) close();
    });
    dlg.showModal();
    if (onMount) onMount(dlg, close);
    const auto = dlg.querySelector('[autofocus]');
    if (auto) auto.focus();
    return { el: dlg, close, closed };
}

// Confirmation simple, ou avec saisie obligatoire (typed) pour les actions irréversibles.
export function confirmDialog({ title, message, confirm = 'Confirmer', danger = false, typed = null }) {
    const d = openDialog({
        title,
        body: html`<div class="stack">
            <div class="soft">${message}</div>
            ${typed ? html`<div class="field"><label for="cfm-typed">Tapez <strong class="mono ${danger ? 'err' : 'ok'}">${typed}</strong> pour confirmer</label>
                <input type="text" id="cfm-typed" class="mono" autocomplete="off" autofocus></div>` : ''}
        </div>`,
        foot: html`<button class="btn" data-close>Annuler</button>
            <button class="btn ${danger ? 'btn-danger solid' : 'btn-primary'}" data-ok ${typed ? 'disabled' : ''}>${confirm}</button>`,
        onMount(dlg, close) {
            const ok = dlg.querySelector('[data-ok]');
            const input = dlg.querySelector('#cfm-typed');
            if (input) {
                input.addEventListener('input', () => { ok.disabled = input.value.trim() !== String(typed); });
                input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !ok.disabled) close(true); });
            } else {
                ok.focus();
            }
            ok.addEventListener('click', () => close(true));
        },
    });
    return d.closed.then((v) => v === true);
}

// ---------- Menus flottants ----------
let openMenuEl = null;
export function closeMenu() {
    if (openMenuEl) {
        openMenuEl.remove();
        openMenuEl = null;
    }
}

// openMenu(anchor, { items:[{label, meta, current, value, group}], filter:true, onPick })
export function openMenu(anchor, { items, filter = false, placeholder = 'Filtrer…', onPick, footer }) {
    closeMenu();
    const menu = document.createElement('div');
    menu.className = 'menu';
    const r = anchor.getBoundingClientRect();
    menu.style.top = `${r.bottom + 4}px`;
    menu.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - 390))}px`;
    let active = 0;
    let shown = items;

    const draw = (q = '') => {
        const query = q.trim().toLowerCase();
        shown = query ? items.filter((it) => !it.group && `${it.label} ${it.meta || ''}`.toLowerCase().includes(query)) : items;
        if (active >= shown.length) active = 0;
        const list = menu.querySelector('.menu-list');
        render(list, shown.length ? shown.map((it, i) => it.group
            ? html`<div class="menu-title">${it.group}</div>`
            : it.sep ? html`<div class="menu-sep"></div>`
            : html`<button class="menu-item ${it.current ? 'current' : ''} ${i === active ? 'on' : ''}" data-i="${i}">
                <span class="grow" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${it.label}</span>${it.meta ? html`<span class="meta">${it.meta}</span>` : ''}</button>`)
            : html`<div class="menu-item dim">Aucun résultat</div>`);
    };

    render(menu, html`${filter ? html`<input type="search" class="sm" placeholder="${placeholder}" aria-label="${placeholder}">` : ''}<div class="menu-list"></div>${footer || ''}`);
    document.body.appendChild(menu);
    openMenuEl = menu;
    draw();

    const pick = (i) => {
        const it = shown[i];
        if (!it || it.group || it.sep) return;
        closeMenu();
        onPick(it);
    };
    menu.addEventListener('click', (e) => {
        const b = e.target.closest('.menu-item[data-i]');
        if (b) pick(Number(b.dataset.i));
    });
    const input = menu.querySelector('input');
    if (input) {
        input.focus();
        input.addEventListener('input', () => draw(input.value));
        input.addEventListener('keydown', (e) => {
            const selectable = shown.map((it, i) => (it.group || it.sep ? -1 : i)).filter((i) => i >= 0);
            const pos = selectable.indexOf(active);
            if (e.key === 'ArrowDown') { active = selectable[Math.min(pos + 1, selectable.length - 1)] ?? 0; draw(input.value); e.preventDefault(); }
            if (e.key === 'ArrowUp') { active = selectable[Math.max(pos - 1, 0)] ?? 0; draw(input.value); e.preventDefault(); }
            if (e.key === 'Enter') { pick(selectable.includes(active) ? active : selectable[0]); e.preventDefault(); }
            if (e.key === 'Escape') closeMenu();
        });
    }
    setTimeout(() => {
        const away = (e) => {
            if (!menu.contains(e.target)) {
                closeMenu();
                document.removeEventListener('mousedown', away);
            }
        };
        document.addEventListener('mousedown', away);
    }, 0);
    return menu;
}

// ---------- Fichiers ----------
export function download(content, filename, mime) {
    const blob = content instanceof Blob ? content : new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function copy(text) {
    try {
        await navigator.clipboard.writeText(text);
    } catch {
        const ta = document.createElement('textarea');
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
    }
    toast(`Copié : ${text.length > 40 ? text.slice(0, 40) + '…' : text}`);
}

// Zone de dépôt + input file caché.
export function bindDrop(zone, input, onFile) {
    zone.addEventListener('click', () => input.click());
    zone.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
    zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('over'); });
    zone.addEventListener('dragleave', () => zone.classList.remove('over'));
    zone.addEventListener('drop', (e) => {
        e.preventDefault();
        zone.classList.remove('over');
        if (e.dataTransfer.files.length) onFile(e.dataTransfer.files[0]);
    });
    input.addEventListener('change', () => {
        if (input.files.length) onFile(input.files[0]);
        input.value = '';
    });
}

// ---------- Formats ----------
const nf = new Intl.NumberFormat('fr-FR');
export const fmtNum = (n) => nf.format(n);
export const plural = (n, one, many = one + 's') => `${fmtNum(n)} ${n > 1 ? many : one}`;

export function timeAgo(iso) {
    if (!iso) return 'jamais';
    const s = (Date.now() - new Date(iso).getTime()) / 1000;
    if (s < 60) return "à l'instant";
    const m = s / 60;
    if (m < 60) return `il y a ${Math.floor(m)} min`;
    const h = m / 60;
    if (h < 24) return `il y a ${Math.floor(h)} h`;
    const d = h / 24;
    if (d < 30) return `il y a ${Math.floor(d)} j`;
    if (d < 365) return `il y a ${Math.floor(d / 30)} mois`;
    return `il y a ${Math.floor(d / 365)} an${d >= 730 ? 's' : ''}`;
}

export function fmtDate(iso) {
    if (!iso) return '—';
    return new Date(iso).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' });
}

export const today = () => new Date().toISOString().slice(0, 10);

export function slug(s) {
    return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase().slice(0, 40) || 'export';
}
