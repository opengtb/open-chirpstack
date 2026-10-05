// Devices de l'application : liste filtrable, sélection, actions groupées, fiche détaillée.

import * as api from '../api.js';
import * as ops from '../ops.js';
import { session, devices, cached, loadedAt, statusOf, statusInfo, battery, STATUSES, patchDevices, removeDevices, invalidate, listen, profileName, appName } from '../state.js';
import { $, $$, html, render, raw, icon, on, debounce, fmtNum, plural, timeAgo, fmtDate, copy, toast, openDialog, confirmDialog, download, today, slug } from '../ui.js';
import { runJob } from '../jobs.js';
import { toCSV, toXLSX, normHex } from '../files.js';
import { lineChart, barChart, unitOf, fmtVal } from '../charts.js';
import { isValidTagKey } from '../store.js';

const PAGE = 300;

// Périodes d'historique, avec l'agrégation adaptée à la rétention par défaut de ChirpStack.
const PERIODS = {
    '24h': { label: '24 h', hours: 24, agg: 'HOUR' },
    '48h': { label: '48 h', hours: 48, agg: 'HOUR' },
    '7d': { label: '7 j', hours: 24 * 7, agg: 'DAY' },
    '30d': { label: '30 j', hours: 24 * 30, agg: 'DAY' },
    '1y': { label: '12 mois', hours: 24 * 365, agg: 'MONTH' },
};

export function mount(root, { navigate, chooseApp }) {
    const app = session.app;
    let alive = true;
    let list = null;
    let error = null;
    let shown = PAGE;
    const sel = new Set();
    let lastClicked = null;
    const f = { q: '', status: '', profile: '', tag: '', sort: 'lastSeenAt', asc: false };

    if (session.pendingFilter !== undefined) {
        f.status = session.pendingFilter || '';
        session.pendingFilter = undefined;
    }

    // ---------- Filtrage ----------
    function tagMatch(d, expr) {
        const [k, ...rest] = expr.split('=');
        const tags = d.tags || {};
        if (rest.length) {
            const key = k.trim().toLowerCase();
            const val = rest.join('=').trim().toLowerCase();
            return Object.entries(tags).some(([tk, tv]) => tk.toLowerCase() === key && (!val || String(tv).toLowerCase().includes(val)));
        }
        const q = expr.trim().toLowerCase();
        return Object.entries(tags).some(([tk, tv]) => tk.toLowerCase().includes(q) || String(tv).toLowerCase().includes(q));
    }

    function filtered() {
        if (!list) return [];
        const q = f.q.trim().toLowerCase();
        const qHex = normHex(q);
        let out = list.filter((d) => {
            if (f.status === 'lowbat') {
                const b = battery(d);
                if (!b || b.ext || b.level >= 20) return false;
            } else if (f.status && statusOf(d) !== f.status) return false;
            if (f.profile && d.deviceProfileId !== f.profile) return false;
            if (f.tag && !tagMatch(d, f.tag)) return false;
            if (q) {
                const hay = `${d.name} ${d.description || ''} ${Object.values(d.tags || {}).join(' ')}`.toLowerCase();
                if (!hay.includes(q) && !(qHex && d.devEui.includes(qHex))) return false;
            }
            return true;
        });
        const dir = f.asc ? 1 : -1;
        const key = {
            name: (d) => (d.name || '').toLowerCase(),
            devEui: (d) => d.devEui,
            profile: (d) => (d.deviceProfileName || '').toLowerCase(),
            lastSeenAt: (d) => (d.lastSeenAt ? new Date(d.lastSeenAt).getTime() : 0),
            battery: (d) => { const b = battery(d); return b ? (b.ext ? 101 : b.level) : -1; },
        }[f.sort];
        out = [...out].sort((a, b) => {
            const va = key(a);
            const vb = key(b);
            return va < vb ? -dir : va > vb ? dir : 0;
        });
        return out;
    }

    // ---------- Rendu ----------
    function head() {
        const at = loadedAt(app.id);
        return html`<div class="page-head">
            <div>
                <div class="eyebrow">$ cs devices</div>
                <h1>Devices <em>${app.name}</em></h1>
                <p class="lede">${list ? html`${plural(list.length, 'device')} · chargés ${timeAgo(at ? new Date(at).toISOString() : null)}` : 'Chargement…'}</p>
            </div>
            <div class="actions">
                <button class="btn" data-act="refresh" title="Recharger depuis le serveur">${icon('refresh')} Recharger</button>
                <button class="btn" data-act="export-all" ${list?.length ? '' : 'disabled'}>${icon('download')} Exporter</button>
                <button class="btn btn-primary" data-act="go-import">$ cs import →</button>
            </div>
        </div>`;
    }

    function chips() {
        const counts = Object.fromEntries(STATUSES.map((s) => [s.key, 0]));
        let low = 0;
        for (const d of list) {
            counts[statusOf(d)]++;
            const b = battery(d);
            if (b && !b.ext && b.level < 20) low++;
        }
        return html`<div class="filters" role="group" aria-label="Filtrer par statut">
            <button class="fchip ${!f.status ? 'on' : ''}" data-act="status" data-v="">Tous <span class="n">${fmtNum(list.length)}</span></button>
            ${STATUSES.map((s) => html`<button class="fchip ${f.status === s.key ? 'on' : ''}" data-act="status" data-v="${s.key}" title="${s.hint}"><span class="status ${s.key}"></span>${s.label} <span class="n">${fmtNum(counts[s.key])}</span></button>`)}
            ${low ? html`<button class="fchip ${f.status === 'lowbat' ? 'on' : ''}" data-act="status" data-v="lowbat">${icon('battery')} Piles &lt; 20 % <span class="n">${fmtNum(low)}</span></button>` : ''}
        </div>`;
    }

    function toolbar() {
        const profiles = [...new Map(list.map((d) => [d.deviceProfileId, d.deviceProfileName || profileName(d.deviceProfileId) || d.deviceProfileId])).entries()].sort((a, b) => a[1].localeCompare(b[1]));
        return html`<div class="toolbar">
            <div class="search-input">${icon('search')}<input type="search" data-search id="d-q" placeholder="Nom, DevEUI, tag, description…" value="${f.q}" aria-label="Rechercher"><kbd>/</kbd></div>
            <select id="d-profile" class="sm" style="width:auto;max-width:260px" aria-label="Device Profile">
                <option value="">Tous les profils</option>
                ${profiles.map(([id, name]) => html`<option value="${id}" ${f.profile === id ? 'selected' : ''}>${name}</option>`)}
            </select>
            <input type="text" id="d-tag" class="sm mono" style="width:200px" placeholder="tag : clé=valeur" value="${f.tag}" aria-label="Filtrer par tag">
            ${f.q || f.profile || f.tag || f.status ? html`<button class="btn btn-ghost btn-sm" data-act="clear">${icon('x')} effacer les filtres</button>` : ''}
        </div>`;
    }

    function sortTh(key, label) {
        const on = f.sort === key;
        return html`<th class="sortable" data-act="sort" data-k="${key}" aria-sort="${on ? (f.asc ? 'ascending' : 'descending') : 'none'}">${label}${on ? html`<span class="arrow">${f.asc ? '↑' : '↓'}</span>` : ''}</th>`;
    }

    function batteryCell(d) {
        const b = battery(d);
        if (!b) return html`<span class="dim">—</span>`;
        if (b.ext) return html`<span class="battery" title="Alimentation externe">⚡ secteur</span>`;
        const cls = b.level < 20 ? 'low' : b.level < 50 ? 'mid' : '';
        return html`<span class="battery ${cls}" title="Pile ${b.level} %"><span class="cell"><i style="width:${b.level}%"></i></span>${b.level} %</span>`;
    }

    function tagsCell(d) {
        const entries = Object.entries(d.tags || {});
        if (!entries.length) return html`<span class="dim">—</span>`;
        return html`<div class="tags">${entries.slice(0, 2).map(([k, v]) => html`<span class="tag" title="${k}=${v}"><span class="k">${k}</span><span class="v">${v}</span></span>`)}${entries.length > 2 ? html`<span class="tag more" title="${entries.slice(2).map(([k, v]) => `${k}=${v}`).join(', ')}">+${entries.length - 2}</span>` : ''}</div>`;
    }

    function table(rows) {
        const allSel = rows.length > 0 && rows.every((d) => sel.has(d.devEui));
        return html`<div class="table-wrap scroll"><table class="tbl" id="d-table">
            <thead><tr>
                <th class="w-check"><input type="checkbox" data-act="selall" ${allSel ? 'checked' : ''} aria-label="Tout sélectionner (filtrés)"></th>
                ${sortTh('name', 'Nom')}${sortTh('devEui', 'DevEUI')}${sortTh('profile', 'Device Profile')}
                <th>Tags</th>${sortTh('battery', 'Pile')}${sortTh('lastSeenAt', 'Dernier message')}<th>Statut</th>
            </tr></thead>
            <tbody>${rows.length ? rows.slice(0, shown).map((d) => {
                const st = statusOf(d);
                return html`<tr class="clickable ${sel.has(d.devEui) ? 'selected' : ''}" data-act="row" data-eui="${d.devEui}">
                    <td class="w-check"><input type="checkbox" data-act="check" data-eui="${d.devEui}" ${sel.has(d.devEui) ? 'checked' : ''} aria-label="Sélectionner ${d.name}"></td>
                    <td class="name" title="${d.name}">${d.name || '—'}${d.description ? html`<small>${d.description}</small>` : ''}</td>
                    <td class="eui nowrap">${d.devEui}<button class="btn btn-ghost btn-xs copy" data-act="copy" data-v="${d.devEui}" title="Copier le DevEUI">${icon('copy')}</button></td>
                    <td class="ellipsis small" title="${d.deviceProfileName}">${d.deviceProfileName || profileName(d.deviceProfileId) || '—'}</td>
                    <td>${tagsCell(d)}</td>
                    <td class="nowrap">${batteryCell(d)}</td>
                    <td class="nowrap small" title="${fmtDate(d.lastSeenAt)}">${timeAgo(d.lastSeenAt)}</td>
                    <td><span class="status ${st}">${statusInfo(st).one}</span></td>
                </tr>`;
            }) : html`<tr><td colspan="8" class="empty">${list.length ? 'Aucun device ne correspond aux filtres.' : 'Aucun device dans cette application.'}</td></tr>`}</tbody>
        </table></div>
        <div class="table-foot"><span>${fmtNum(Math.min(shown, rows.length))} affichés sur ${plural(rows.length, 'device')}${rows.length !== list.length ? ` filtrés (${fmtNum(list.length)} au total)` : ''}</span>
            <span class="spacer"></span>
            ${rows.length > shown ? html`<button class="btn btn-sm" data-act="more">Afficher ${fmtNum(Math.min(PAGE, rows.length - shown))} de plus</button>` : ''}
        </div>`;
    }

    function selbar(rows) {
        if (!sel.size) return '';
        const notAllFiltered = rows.length > 0 && rows.some((d) => !sel.has(d.devEui));
        return html`<div class="selbar" role="toolbar" aria-label="Actions sur la sélection">
            <span class="count"><strong>${fmtNum(sel.size)}</strong> sélectionné${sel.size > 1 ? 's' : ''}</span>
            ${notAllFiltered ? html`<button class="btn-link" data-act="selfiltered">+ sélectionner les ${fmtNum(rows.length)} filtrés</button>` : ''}
            <span class="spacer"></span>
            <button class="btn btn-sm" data-act="bulk-history" title="Comparer leurs mesures">${icon('chart')} Historique</button>
            <button class="btn btn-sm" data-act="bulk-export">${icon('download')} Exporter</button>
            <button class="btn btn-sm" data-act="bulk-tags">${icon('tag')} Tags</button>
            <button class="btn btn-sm" data-act="bulk-profile">${icon('layers')} Profil</button>
            <button class="btn btn-sm" data-act="bulk-move" ${session.apps.length < 2 ? 'disabled' : ''}>${icon('move')} Migrer</button>
            <button class="btn btn-sm btn-danger" data-act="bulk-delete">${icon('trash')} Supprimer</button>
            <button class="btn btn-sm btn-ghost" data-act="selnone" title="Tout désélectionner">${icon('x')}</button>
        </div>`;
    }

    function draw({ keepFocus = false } = {}) {
        if (!alive) return;
        const active = keepFocus ? document.activeElement?.id : null;
        const caret = active && document.activeElement.selectionStart;
        if (error) {
            render(root, html`<div class="page">${head()}<div class="callout err">${icon('alert')}<div><strong>Impossible de charger les devices.</strong> ${error}</div></div></div>`);
            return;
        }
        if (!list) {
            render(root, html`<div class="page">${head()}<div class="card"><div class="row"><div class="grow progress" id="d-prog"><i></i></div><span class="mono small" id="d-progt">connexion…</span></div></div></div>`);
            return;
        }
        const rows = filtered();
        render(root, html`<div class="page">${head()}${chips()}${toolbar()}${table(rows)}${selbar(rows)}</div>`);
        if (active) {
            const el = document.getElementById(active);
            if (el) {
                el.focus();
                if (caret !== null && el.setSelectionRange) try { el.setSelectionRange(caret, caret); } catch { /* type sans sélection */ }
            }
        }
    }

    async function load(force = false) {
        error = null;
        if (force) list = null;
        draw();
        try {
            list = await devices(app.id, {
                force,
                onProgress: (n, t) => {
                    const bar = $('#d-prog > i', root);
                    if (bar) bar.style.width = `${t ? (n / t) * 100 : 0}%`;
                    const txt = $('#d-progt', root);
                    if (txt) txt.textContent = `${fmtNum(n)} / ${fmtNum(t)}`;
                },
            });
            for (const e of [...sel]) if (!list.some((d) => d.devEui === e)) sel.delete(e);
        } catch (e) {
            error = api.humanize(e);
        }
        draw();
        if (session.pendingOpen && list) {
            const eui = session.pendingOpen;
            session.pendingOpen = undefined;
            openDevice(eui);
        }
    }

    // ---------- Événements ----------
    const onSearch = debounce(() => { shown = PAGE; draw({ keepFocus: true }); }, 150);
    root.addEventListener('input', (e) => {
        if (e.target.id === 'd-q') { f.q = e.target.value; onSearch(); }
        if (e.target.id === 'd-tag') { f.tag = e.target.value; onSearch(); }
    });
    root.addEventListener('change', (e) => {
        if (e.target.id === 'd-profile') { f.profile = e.target.value; shown = PAGE; draw({ keepFocus: true }); }
    });
    root.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && e.target.id === 'd-q' && f.q) { f.q = ''; draw({ keepFocus: true }); }
    });

    on(root, 'click', {
        refresh: () => { sel.clear(); load(true); },
        'go-import': () => navigate('import'),
        'export-all': () => exportDialog(filtered()),
        status: (el) => { f.status = el.dataset.v; shown = PAGE; draw(); },
        clear: () => { Object.assign(f, { q: '', status: '', profile: '', tag: '' }); draw(); },
        sort: (el) => {
            const k = el.dataset.k;
            if (f.sort === k) f.asc = !f.asc;
            else { f.sort = k; f.asc = k !== 'lastSeenAt' && k !== 'battery'; }
            draw();
        },
        more: () => { shown += PAGE; draw(); },
        copy: (el, ev) => { ev.stopPropagation(); copy(el.dataset.v); },
        selall: (el, ev) => {
            ev.stopPropagation();
            const rows = filtered();
            if (el.checked) rows.forEach((d) => sel.add(d.devEui));
            else rows.forEach((d) => sel.delete(d.devEui));
            draw();
        },
        check: (el, ev) => {
            ev.stopPropagation();
            const eui = el.dataset.eui;
            if (ev.shiftKey && lastClicked) {
                const rows = filtered().slice(0, shown).map((d) => d.devEui);
                const a = rows.indexOf(lastClicked);
                const b = rows.indexOf(eui);
                if (a >= 0 && b >= 0) {
                    const [from, to] = a < b ? [a, b] : [b, a];
                    for (let i = from; i <= to; i++) el.checked ? sel.add(rows[i]) : sel.delete(rows[i]);
                }
            } else if (el.checked) sel.add(eui);
            else sel.delete(eui);
            lastClicked = eui;
            draw();
        },
        row: (el, ev) => {
            if (ev.target.closest('input,button,a')) return;
            openDevice(el.dataset.eui);
        },
        selfiltered: () => { filtered().forEach((d) => sel.add(d.devEui)); draw(); },
        selnone: () => { sel.clear(); draw(); },
        'bulk-export': () => exportDialog(selected()),
        'bulk-history': () => {
            const chosen = selected().slice(0, 16);
            if (sel.size > 16) toast('16 devices au maximum dans l\'historique : les 16 premiers sont proposés.', { type: 'warn' });
            session.pendingHistory = { devices: chosen.map((d) => ({ eui: d.devEui, name: d.name })) };
            navigate('historique');
        },
        'bulk-tags': () => tagsDialog(selected()),
        'bulk-profile': () => profileDialog(selected()),
        'bulk-move': () => moveDialog(selected()),
        'bulk-delete': () => deleteFlow(selected()),
    });

    const selected = () => list.filter((d) => sel.has(d.devEui));
    let closeDrawer = () => {};

    // ---------- Export ----------
    function exportDialog(rows) {
        if (!rows.length) return;
        const d = openDialog({
            title: `Exporter ${plural(rows.length, 'device')}`,
            body: html`<div class="stack">
                <div class="field"><span class="label">Format</span>
                    <div class="seg" role="radiogroup"><label><input type="radio" name="fmt" value="xlsx" checked> Excel (.xlsx)</label><label><input type="radio" name="fmt" value="csv"> CSV (;)</label></div></div>
                <label class="check"><input type="checkbox" id="x-keys"> Inclure les clés (AppKey / NwkKey) et le JoinEUI</label>
                <div class="callout warn" id="x-warn" hidden>${icon('alert')}<div>Les clés seront <strong>en clair</strong> dans le fichier. Une requête par device : ${plural(rows.length, 'appel')} au serveur.</div></div>
                <p class="hint">Les colonnes reprennent celles de l'import : le fichier peut être modifié puis réimporté tel quel (tags en colonnes <code>tag:clé</code>).</p>
            </div>`,
            foot: html`<button class="btn" data-close>Annuler</button><button class="btn btn-primary" data-go>${icon('download')} Télécharger</button>`,
            onMount(el, close) {
                $('#x-keys', el).addEventListener('change', (e) => { $('#x-warn', el).hidden = !e.target.checked; });
                $('[data-go]', el).addEventListener('click', () => close({ fmt: $('input[name=fmt]:checked', el).value, keys: $('#x-keys', el).checked }));
            },
        });
        d.closed.then(async (opt) => {
            if (!opt) return;
            let extra = new Map();
            if (opt.keys) {
                const res = await runJob({
                    title: 'Lecture des clés',
                    verb: 'lu(s)',
                    items: rows,
                    label: (x) => x.name || x.devEui,
                    run: async (x) => {
                        const [full, keys] = await Promise.all([ops.getDevice(x.devEui), ops.getKeys(x.devEui)]);
                        extra.set(x.devEui, { joinEui: full.device?.joinEui || '', keys });
                        return keys ? '' : 'pas de clés';
                    },
                });
                if (res.stopped) return;
            }
            const tagKeys = [...new Set(rows.flatMap((x) => Object.keys(x.tags || {})))].sort();
            const headers = ['dev_eui', 'name', 'description', 'device_profile_id', 'device_profile', ...(opt.keys ? ['join_eui', 'nwk_key', 'app_key'] : []), 'last_seen_at', 'status', 'battery', ...tagKeys.map((k) => `tag:${k}`)];
            const data = rows.map((x) => {
                const e = extra.get(x.devEui);
                const b = battery(x);
                return [x.devEui, x.name, x.description || '', x.deviceProfileId, x.deviceProfileName || profileName(x.deviceProfileId),
                    ...(opt.keys ? [e?.joinEui || '', e?.keys?.nwkKey || '', e?.keys?.appKey && !/^0+$/.test(e.keys.appKey) ? e.keys.appKey : ''] : []),
                    x.lastSeenAt || '', statusInfo(statusOf(x)).one, b ? (b.ext ? 'secteur' : b.level) : '',
                    ...tagKeys.map((k) => x.tags?.[k] ?? '')];
            });
            const base = `${slug(app.name)}-devices-${today()}`;
            if (opt.fmt === 'csv') download(toCSV(headers, data), `${base}.csv`, 'text/csv;charset=utf-8');
            else download(await toXLSX(headers, data, app.name), `${base}.xlsx`);
            toast(`${plural(rows.length, 'device')} exporté${rows.length > 1 ? 's' : ''}.`);
        });
    }

    // ---------- Tags en masse ----------
    function tagsDialog(rows) {
        const existing = {};
        for (const x of rows) for (const k of Object.keys(x.tags || {})) existing[k] = (existing[k] || 0) + 1;
        const removals = new Set();
        const d = openDialog({
            title: `Tags de ${plural(rows.length, 'device')}`,
            wide: true,
            body: html`<div class="stack">
                <div><span class="label">Ajouter ou modifier</span>
                    <div id="t-rows" class="stack" style="gap:.4rem"></div>
                    <button class="btn btn-sm mt-s" data-addrow>${icon('plus')} Ajouter un tag</button>
                    <p class="hint">La valeur remplace l'existante. Valeur vide : le tag est créé vide.</p></div>
                ${Object.keys(existing).length ? html`<div><span class="label">Retirer (cliquez pour marquer)</span>
                    <div class="tags" id="t-rm">${Object.entries(existing).sort().map(([k, n]) => html`<button class="badge" data-rm="${k}" title="présent sur ${n} device(s)">${k} <span class="dim">${n}</span></button>`)}</div></div>` : ''}
                <div id="t-err" class="err small"></div>
            </div>`,
            foot: html`<button class="btn" data-close>Annuler</button><button class="btn btn-primary" data-go>Appliquer à ${plural(rows.length, 'device')}</button>`,
            onMount(el, close) {
                const addRow = (k = '', v = '') => {
                    const r = document.createElement('div');
                    r.className = 'row';
                    render(r, html`<input type="text" class="sm mono" placeholder="clé" value="${k}" data-k style="max-width:220px"><span class="dim">=</span><input type="text" class="sm" placeholder="valeur" value="${v}" data-v><button class="btn btn-ghost btn-icon" data-del aria-label="Retirer la ligne">${icon('x')}</button>`);
                    $('#t-rows', el).appendChild(r);
                    $('[data-k]', r).focus();
                };
                addRow();
                el.addEventListener('click', (e) => {
                    if (e.target.closest('[data-addrow]')) addRow();
                    const del = e.target.closest('[data-del]');
                    if (del) del.parentElement.remove();
                    const rm = e.target.closest('[data-rm]');
                    if (rm) {
                        const k = rm.dataset.rm;
                        removals.has(k) ? removals.delete(k) : removals.add(k);
                        rm.classList.toggle('diff-old', removals.has(k));
                        rm.style.borderColor = removals.has(k) ? 'var(--red)' : '';
                    }
                });
                $('[data-go]', el).addEventListener('click', () => {
                    const set = {};
                    for (const r of $$('#t-rows .row', el)) {
                        const k = $('[data-k]', r).value.trim();
                        if (!k) continue;
                        if (!isValidTagKey(k)) {
                            $('#t-err', el).textContent = `Clé de tag invalide : « ${k} » (lettres, chiffres, . - _ : / et espaces, 64 caractères max).`;
                            return;
                        }
                        set[k] = $('[data-v]', r).value.trim();
                    }
                    if (!Object.keys(set).length && !removals.size) {
                        $('#t-err', el).textContent = 'Rien à modifier.';
                        return;
                    }
                    close({ set, remove: [...removals] });
                });
            },
        });
        d.closed.then(async (opt) => {
            if (!opt) return;
            const patches = [];
            const res = await runJob({
                title: 'Mise à jour des tags',
                verb: 'mis à jour',
                items: rows,
                label: (x) => x.name || x.devEui,
                run: async (x) => {
                    const dev = await ops.updateDevice(x.devEui, (dv) => {
                        for (const k of opt.remove) delete dv.tags[k];
                        Object.assign(dv.tags, opt.set);
                        return dv;
                    });
                    patches.push({ devEui: x.devEui, tags: dev.tags });
                },
            });
            patchDevices(app.id, patches);
            if (!res.failed.length) sel.clear();
            draw();
        });
    }

    // ---------- Device Profile en masse ----------
    function profileDialog(rows) {
        const dps = [...session.deviceProfiles].sort((a, b) => a.name.localeCompare(b.name));
        const d = openDialog({
            title: `Device Profile de ${plural(rows.length, 'device')}`,
            body: html`<div class="stack">
                <div class="field"><label for="p-sel">Nouveau Device Profile</label>
                    <select id="p-sel" autofocus><option value="">— choisir —</option>${dps.map((p) => html`<option value="${p.id}">${p.name}${p.region ? ` · ${p.region}` : ''}${p.macVersion ? ` · ${p.macVersion.replace('LORAWAN_', '').replace(/_/g, '.')}` : ''}</option>`)}</select></div>
                <p class="hint">Les clés, tags et sessions des devices sont conservés.</p>
            </div>`,
            foot: html`<button class="btn" data-close>Annuler</button><button class="btn btn-primary" data-go disabled>Appliquer</button>`,
            onMount(el, close) {
                const s = $('#p-sel', el);
                s.addEventListener('change', () => { $('[data-go]', el).disabled = !s.value; });
                $('[data-go]', el).addEventListener('click', () => close(s.value));
            },
        });
        d.closed.then(async (dpId) => {
            if (!dpId) return;
            const name = profileName(dpId);
            const todo = rows.filter((x) => x.deviceProfileId !== dpId);
            if (!todo.length) return toast('Ces devices utilisent déjà ce profil.');
            const patches = [];
            const res = await runJob({
                title: `Changement de profil → ${name}`,
                verb: 'modifié(s)',
                items: todo,
                label: (x) => x.name || x.devEui,
                run: async (x) => {
                    await ops.updateDevice(x.devEui, (dv) => ({ ...dv, deviceProfileId: dpId }));
                    patches.push({ devEui: x.devEui, deviceProfileId: dpId, deviceProfileName: name });
                },
            });
            patchDevices(app.id, patches);
            if (!res.failed.length) sel.clear();
            draw();
        });
    }

    // ---------- Migration ----------
    function moveDialog(rows) {
        const others = session.apps.filter((a) => a.id !== app.id);
        const d = openDialog({
            title: `Migrer ${plural(rows.length, 'device')}`,
            body: html`<div class="stack">
                <div class="field"><label for="m-sel">Application de destination</label>
                    <select id="m-sel" autofocus><option value="">— choisir —</option>${others.map((a) => html`<option value="${a.id}">${a.name}</option>`)}</select></div>
                <div class="callout">${icon('move')}<div>Chaque device est d'abord <strong>copié</strong> (fiche, tags, clés, session). Si ChirpStack refuse le déplacement direct, il est recréé dans la destination ; en cas d'échec, il est <strong>remis automatiquement</strong> dans son application d'origine. Une sauvegarde JSON est proposée à la fin.</div></div>
            </div>`,
            foot: html`<button class="btn" data-close>Annuler</button><button class="btn btn-primary" data-go disabled>Migrer</button>`,
            onMount(el, close) {
                const s = $('#m-sel', el);
                s.addEventListener('change', () => { $('[data-go]', el).disabled = !s.value; });
                $('[data-go]', el).addEventListener('click', () => close(s.value));
            },
        });
        d.closed.then(async (dest) => {
            if (!dest) return;
            const snaps = [];
            const moved = [];
            const res = await runJob({
                title: `Migration → ${appName(dest)}`,
                verb: 'migré(s)',
                items: rows,
                label: (x) => x.name || x.devEui,
                run: async (x, ctx) => {
                    const r = await ops.migrateDevice(x.devEui, dest, ctx, (s) => snaps.push(s));
                    moved.push(x.devEui);
                    return r.message;
                },
                after: () => snaps.length ? [{ label: 'Télécharger la sauvegarde (JSON)', onClick: () => downloadBackup(snaps, 'migration') }] : [],
            });
            removeDevices(app.id, moved);
            invalidate(dest);
            moved.forEach((e) => sel.delete(e));
            session.appCounts[dest] = (session.appCounts[dest] || 0) + moved.length;
            draw();
            if (res.done.length) toast(`${plural(res.done.length, 'device')} dans « ${appName(dest)} ».`, { action: 'Ouvrir', onAction: () => chooseApp(session.apps.find((a) => a.id === dest), { go: 'devices' }) });
        });
    }

    // ---------- Suppression ----------
    async function deleteFlow(rows) {
        const n = rows.length;
        const d = openDialog({
            title: `Supprimer ${plural(n, 'device')}`,
            body: html`<div class="stack">
                <div class="callout err">${icon('alert')}<div>Suppression <strong>définitive</strong> dans ChirpStack : historique, clés et session sont effacés.</div></div>
                ${n <= 5 ? html`<ul class="small soft" style="margin:0;padding-left:1.2rem">${rows.map((x) => html`<li>${x.name} <span class="mono dim">${x.devEui}</span></li>`)}</ul>` : ''}
                <label class="check"><input type="checkbox" id="del-bk" checked> Garder une sauvegarde (fiche + clés) pour pouvoir les recréer</label>
                <div class="field"><label for="del-typed">Tapez <strong class="mono err">${n}</strong> pour confirmer</label><input type="text" id="del-typed" class="mono" autocomplete="off" autofocus></div>
            </div>`,
            foot: html`<button class="btn" data-close>Annuler</button><button class="btn btn-danger solid" data-go disabled>${icon('trash')} Supprimer</button>`,
            onMount(el, close) {
                const t = $('#del-typed', el);
                const go = $('[data-go]', el);
                t.addEventListener('input', () => { go.disabled = t.value.trim() !== String(n); });
                t.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !go.disabled) close({ backup: $('#del-bk', el).checked }); });
                go.addEventListener('click', () => close({ backup: $('#del-bk', el).checked }));
            },
        });
        const opt = await d.closed;
        if (!opt) return;
        const snaps = [];
        const deleted = [];
        await runJob({
            title: `Suppression de ${plural(n, 'device')}`,
            verb: 'supprimé(s)',
            items: rows,
            label: (x) => x.name || x.devEui,
            run: async (x) => {
                if (opt.backup) snaps.push(await ops.snapshot(x.devEui));
                await ops.deleteDevice(x.devEui);
                deleted.push(x.devEui);
            },
            after: () => snaps.length ? [{ label: 'Télécharger la sauvegarde (JSON)', onClick: () => downloadBackup(snaps, 'suppression') }] : [],
        });
        removeDevices(app.id, deleted);
        deleted.forEach((e) => sel.delete(e));
        draw();
    }

    function downloadBackup(snaps, why) {
        const data = { app: 'open-chirpstack', kind: 'backup', reason: why, createdAt: new Date().toISOString(), server: api.isDemo() ? 'demo' : api.serverUrl(), tenant: session.tenant?.name, application: app.name, devices: snaps };
        download(JSON.stringify(data, null, 2), `sauvegarde-${why}-${slug(app.name)}-${today()}.json`, 'application/json');
        toast('Sauvegarde téléchargée. Elle se réimporte depuis « importer ».');
    }

    // ---------- Fiche device ----------
    function openDevice(eui) {
        const d0 = list?.find((x) => x.devEui === eui);
        if (!d0) return;
        closeDrawer();
        const scrim = document.createElement('div');
        scrim.className = 'drawer-scrim';
        const dr = document.createElement('aside');
        dr.className = 'drawer';
        dr.setAttribute('role', 'dialog');
        dr.setAttribute('aria-label', `Device ${d0.name}`);
        document.body.append(scrim, dr);
        let full = null;
        let keys;
        let period = session.lastPeriod || '24h';
        let metrics = null; // { link, measures, … } | { error }
        let editing = false;

        const onEsc = (e) => { if (e.key === 'Escape' && !document.querySelector('dialog[open]')) close(); };
        const close = () => {
            dr.remove();
            scrim.remove();
            document.removeEventListener('keydown', onEsc);
            closeDrawer = () => {};
        };
        closeDrawer = close;
        document.addEventListener('keydown', onEsc);
        scrim.addEventListener('click', close);

        // Lien vers l'interface ChirpStack (pas en démo, ni en mode REST où l'adresse est celle de l'API).
        const chirpstackLink = () => (api.isDemo() || api.mode() === 'rest' ? null : `${api.serverUrl()}/#/tenants/${session.tenant.id}/applications/${app.id}/devices/${eui}`);

        // Séries prêtes à afficher : mesures du Device Profile + liaison radio, sur la même échelle de temps.
        function series() {
            const link = metrics.link || {};
            const ts = link.rxPackets?.timestamps || [];
            const rxData = (link.rxPackets?.datasets?.[0]?.data || []).map(Number);
            const rxByTs = new Map(ts.map((t, i) => [t, rxData[i] || 0]));
            const measures = Object.entries(metrics.measures?.metrics || {}).map(([key, m]) => {
                const mts = m.timestamps || [];
                // ChirpStack renvoie 0 pour un intervalle sans message : on en fait un trou (sauf compteurs par période).
                const values = (m.datasets?.[0]?.data || []).map(Number).map((v, i) => {
                    if (!Number.isFinite(v)) return null;
                    if (m.kind !== 'ABSOLUTE' && rxByTs.get(mts[i]) === 0) return null;
                    return v;
                });
                const vals = values.filter((v) => v !== null);
                return {
                    key, name: m.name || key, kind: m.kind, unit: unitOf(key, m.name), timestamps: mts, values,
                    last: [...values].reverse().find((v) => v !== null) ?? null,
                    min: vals.length ? Math.min(...vals) : null,
                    max: vals.length ? Math.max(...vals) : null,
                    avg: vals.length ? vals.reduce((x, y) => x + y, 0) / vals.length : null,
                    sum: vals.reduce((x, y) => x + y, 0),
                };
            });
            const states = Object.entries(metrics.measures?.states || {}).map(([key, st]) => ({ key, name: st.name || key, value: st.value }));
            return { link, ts, rx: rxData, measures, states };
        }

        function measuresBlock(S) {
            if (metrics.measuresError) return html`<p class="dim small">Mesures indisponibles : ${metrics.measuresError}</p>`;
            if (!S.measures.length && !S.states.length) {
                return html`<div class="callout">${icon('alert')}<div>Aucune mesure historisée pour ce device. ChirpStack n'enregistre que les mesures déclarées dans le
                    <strong>Device Profile</strong> (onglet <em>Measurements</em>, type autre que « Unknown ») et décodées par son codec.</div></div>`;
            }
            const agg = PERIODS[period].agg;
            const cur = S.measures.find((m) => m.key === session.lastMeasure) || S.measures[0];
            const tiles = cur && (cur.kind === 'ABSOLUTE'
                ? [['total', cur.sum], ['min / intervalle', cur.min], ['moyenne', cur.avg], ['max / intervalle', cur.max]]
                : [['dernière', cur.last], ['min', cur.min], ['moyenne', cur.avg], ['max', cur.max]]);
            return html`
                ${S.measures.length > 1 ? html`<div class="measure-chips" role="tablist">${S.measures.map((m) => html`<button class="fchip ${m === cur ? 'on' : ''}" data-act2="measure" data-k="${m.key}" role="tab" aria-selected="${m === cur}">
                    ${m.name} <strong>${fmtVal(m.kind === 'ABSOLUTE' ? m.sum : m.last)}${m.unit ? ` ${m.unit}` : ''}</strong></button>`)}</div>` : ''}
                ${cur ? html`
                    ${S.measures.length === 1 ? html`<p class="small soft" style="margin-bottom:.5rem"><strong>${cur.name}</strong></p>` : ''}
                    <div class="metric-tiles">${tiles.map(([label, v], i) => html`<div><div class="k-label">${label}</div><div class="k-value ${i === 0 ? 'ok' : ''}">${fmtVal(v)}<span class="xs dim"> ${cur.unit}</span></div></div>`)}</div>
                    ${cur.kind === 'ABSOLUTE' ? barChart(cur.timestamps, cur.values, { unit: cur.unit, agg }) : lineChart(cur.timestamps, cur.values, { unit: cur.unit, agg })}` : ''}
                ${S.states.length ? html`<dl class="kv mt">${S.states.map((st) => html`<dt>${st.name}</dt><dd class="mono small">${st.value}</dd>`)}</dl>` : ''}`;
        }

        function linkBlock(S) {
            if (metrics.linkError) return html`<p class="dim small">Liaison radio indisponible : ${metrics.linkError}</p>`;
            const m = S.link;
            const rx = S.rx;
            const sumDs = (metric) => (metric?.datasets || []).reduce((acc, ds) => { (ds.data || []).forEach((v, i) => { acc[i] = (acc[i] || 0) + Number(v || 0); }); return acc; }, []);
            const errs = sumDs(m.errors).reduce((a, b) => a + b, 0);
            const total = rx.reduce((a, b) => a + b, 0);
            // RSSI / SNR : moyenne sur les seuls intervalles où des paquets ont été reçus.
            const avg = (metric) => {
                const vals = (metric?.datasets?.[0]?.data || []).map(Number).filter((v, i) => rx[i] > 0 && Number.isFinite(v));
                return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
            };
            const rssi = avg(m.gwRssi);
            const snr = avg(m.gwSnr);
            const q = (v, good, ok) => (v === null ? '' : v >= good ? 'ok' : v >= ok ? 'warn' : 'err');
            return html`<div class="metric-tiles">
                    <div><div class="k-label">paquets</div><div class="k-value">${fmtNum(total)}</div></div>
                    <div><div class="k-label">erreurs</div><div class="k-value ${errs ? 'err' : ''}">${fmtNum(errs)}</div></div>
                    <div><div class="k-label">RSSI moyen</div><div class="k-value ${q(rssi, -100, -115)}">${rssi === null ? '—' : `${rssi.toFixed(0)}`}<span class="xs dim"> dBm</span></div></div>
                    <div><div class="k-label">SNR moyen</div><div class="k-value ${q(snr, 0, -10)}">${snr === null ? '—' : snr.toFixed(1)}<span class="xs dim"> dB</span></div></div>
                </div>
                ${barChart(S.ts, rx, { agg: PERIODS[period].agg, label: 'paquet(s)' })}`;
        }

        function metricsBlock() {
            if (!metrics) return html`<div class="skeleton" style="height:180px"></div>`;
            if (metrics.error) return html`<p class="err small">${metrics.error}</p>`;
            const S = series();
            return html`<div class="sub-title">// mesures</div>${measuresBlock(S)}
                <div class="sub-title">// liaison radio</div>${linkBlock(S)}
                <p class="hint">ChirpStack conserve des valeurs agrégées : par défaut 2 jours en horaire, 1 mois en journalier, 1 an en mensuel.</p>`;
        }

        // Export de l'historique affiché : une ligne par intervalle, une colonne par mesure.
        function exportHistory() {
            if (!metrics || metrics.error) return;
            const S = series();
            const cell = (v) => (v === null || v === undefined || !Number.isFinite(v) ? '' : String(v).replace('.', ','));
            const rssi = (S.link.gwRssi?.datasets?.[0]?.data || []).map((v, i) => (S.rx[i] > 0 ? Number(v) : null));
            const snr = (S.link.gwSnr?.datasets?.[0]?.data || []).map((v, i) => (S.rx[i] > 0 ? Number(v) : null));
            const all = [...new Set([...S.ts, ...S.measures.flatMap((m) => m.timestamps)])].sort();
            const pick = (arr, tsArr, t) => cell(arr[tsArr.indexOf(t)]);
            const head = ['horodatage', ...S.measures.map((m) => (m.unit ? `${m.name} (${m.unit})` : m.name)), 'paquets reçus', 'RSSI moyen (dBm)', 'SNR moyen (dB)'];
            const rows = all.map((t) => [new Date(t).toLocaleString('fr-FR'), ...S.measures.map((m) => pick(m.values, m.timestamps, t)), pick(S.rx, S.ts, t), pick(rssi, S.ts, t), pick(snr, S.ts, t)]);
            const d = list.find((x) => x.devEui === eui) || d0;
            download(toCSV(head, rows), `${slug(d.name)}-historique-${period}-${today()}.csv`, 'text/csv;charset=utf-8');
        }

        function editForm(dev) {
            const dps = [...session.deviceProfiles].sort((a, b) => a.name.localeCompare(b.name));
            const tags = Object.entries(dev.tags || {});
            return html`<form id="dv-edit" class="stack">
                <div class="field"><label for="dv-name">Nom</label><input type="text" id="dv-name" value="${dev.name}"></div>
                <div class="field"><label for="dv-desc">Description</label><input type="text" id="dv-desc" value="${dev.description || ''}"></div>
                <div class="field"><label for="dv-dp">Device Profile</label><select id="dv-dp">${dps.map((p) => html`<option value="${p.id}" ${p.id === dev.deviceProfileId ? 'selected' : ''}>${p.name}</option>`)}</select></div>
                <div class="field"><span class="label">Tags</span><div id="dv-tags" class="stack" style="gap:.4rem">
                    ${[...tags, ['', '']].map(([k, v]) => html`<div class="row"><input type="text" class="sm mono" placeholder="clé" value="${k}" data-k style="max-width:200px"><span class="dim">=</span><input type="text" class="sm" placeholder="valeur" value="${v}" data-v></div>`)}
                </div><button type="button" class="btn btn-sm mt-s" data-act2="addtag">${icon('plus')} tag</button></div>
                <div class="row"><span class="spacer"></span><button type="button" class="btn" data-act2="cancel">Annuler</button><button type="submit" class="btn btn-primary">Enregistrer</button></div>
            </form>`;
        }

        function drawDrawer() {
            const d = list.find((x) => x.devEui === eui) || d0;
            const st = statusOf(d);
            const dev = full?.device;
            const link = chirpstackLink();
            render(dr, html`
                <div class="drawer-head">
                    <div class="grow">
                        <div class="tag-line">// device · <span class="status ${st}">${statusInfo(st).one}</span></div>
                        <h2>${d.name}</h2>
                        <div class="row mt-s"><span class="mono small soft">${d.devEui}</span><button class="btn btn-ghost btn-xs" data-act2="copy" data-v="${d.devEui}">${icon('copy')}</button></div>
                    </div>
                    <button class="btn btn-ghost btn-icon" data-act2="close" aria-label="Fermer">${icon('x')}</button>
                </div>
                <div class="drawer-body">
                    <div class="row-wrap" style="margin-bottom:1rem">
                        <button class="btn btn-sm" data-act2="edit">${icon('edit')} Modifier</button>
                        ${link ? html`<a class="btn btn-sm" href="${link}" target="_blank" rel="noopener noreferrer">${icon('external')} Ouvrir dans ChirpStack</a>` : ''}
                        <span class="spacer"></span>
                        <button class="btn btn-sm btn-danger" data-act2="delete">${icon('trash')} Supprimer</button>
                    </div>
                    ${editing && dev ? editForm(dev) : html`
                    <dl class="kv">
                        <dt>Device Profile</dt><dd>${d.deviceProfileName || profileName(d.deviceProfileId)}</dd>
                        <dt>Description</dt><dd>${d.description || html`<span class="dim">—</span>`}</dd>
                        <dt>Dernier message</dt><dd>${fmtDate(d.lastSeenAt)} <span class="dim">(${timeAgo(d.lastSeenAt)})</span></dd>
                        <dt>Pile</dt><dd>${batteryCell(d)}${d.deviceStatus?.margin !== undefined ? html` <span class="dim small">· marge ${d.deviceStatus.margin} dB</span>` : ''}</dd>
                        <dt>JoinEUI</dt><dd class="mono small">${dev ? dev.joinEui || '—' : '…'}</dd>
                        <dt>Créé le</dt><dd>${fmtDate(d.createdAt)}</dd>
                        ${dev?.isDisabled ? html`<dt>État</dt><dd class="warn">désactivé</dd>` : ''}
                        <dt>Clés</dt><dd>${keys === undefined ? html`<button class="btn btn-xs" data-act2="keys">${icon('eye')} afficher</button>`
                            : keys === null ? html`<span class="dim">aucune clé (ABP ou non provisionné)</span>`
                            : html`<div class="secret">${keys.nwkKey}<button class="btn btn-ghost btn-xs" data-act2="copy" data-v="${keys.nwkKey}">${icon('copy')}</button></div>
                                ${keys.appKey && !/^0+$/.test(keys.appKey) ? html`<div class="secret dim">appKey ${keys.appKey}</div>` : ''}`}</dd>
                    </dl>
                    <h3 class="section-title" style="font-size:14px;margin-top:1.5rem">Tags</h3>
                    ${Object.keys(d.tags || {}).length ? html`<div class="tags">${Object.entries(d.tags).map(([k, v]) => html`<span class="tag"><span class="k">${k}</span><span class="v">${v}</span></span>`)}</div>` : html`<p class="dim small">Aucun tag.</p>`}
                    <h3 class="section-title" style="font-size:14px;margin-top:1.5rem">Historique
                        <span class="end row"><span class="seg">${Object.entries(PERIODS).map(([v, p]) => html`<button class="${period === v ? 'on' : ''}" data-act2="period" data-v="${v}">${p.label}</button>`)}</span>
                        <button class="btn btn-sm btn-ghost" data-act2="csv" title="Exporter l'historique (CSV)" ${metrics && !metrics.error ? '' : 'disabled'}>${icon('download')}</button>
                        <button class="btn btn-sm" data-act2="expand" title="Ouvrir dans l'outil d'historique">${icon('expand')} Agrandir</button></span></h3>
                    <div id="dv-metrics">${metricsBlock()}</div>`}
                </div>`);
        }

        async function loadMetrics() {
            metrics = null;
            const el = $('#dv-metrics', dr);
            if (el) render(el, metricsBlock());
            const end = new Date();
            const { hours, agg } = PERIODS[period];
            const start = new Date(end.getTime() - hours * 3600000);
            const qs = `start=${encodeURIComponent(start.toISOString())}&end=${encodeURIComponent(end.toISOString())}&aggregation=${agg}`;
            const asked = period;
            const [link, measures] = await Promise.allSettled([
                api.get(`/api/devices/${eui}/link-metrics?${qs}`),
                api.get(`/api/devices/${eui}/metrics?${qs}`),
            ]);
            if (asked !== period) return; // une autre période a été demandée entre-temps
            metrics = {
                link: link.status === 'fulfilled' ? link.value : null,
                linkError: link.status === 'rejected' ? api.humanize(link.reason) : null,
                measures: measures.status === 'fulfilled' ? measures.value : null,
                measuresError: measures.status === 'rejected' ? api.humanize(measures.reason) : null,
            };
            if (!metrics.link && !metrics.measures) metrics = { error: metrics.linkError };
            const box = $('#dv-metrics', dr);
            if (box) render(box, metricsBlock());
            const csvBtn = dr.querySelector('[data-act2="csv"]');
            if (csvBtn) csvBtn.disabled = !!metrics.error;
        }

        dr.addEventListener('click', async (e) => {
            const b = e.target.closest('[data-act2]');
            if (!b) return;
            const act = b.dataset.act2;
            if (act === 'close') close();
            if (act === 'copy') copy(b.dataset.v);
            if (act === 'keys') {
                b.classList.add('loading');
                try { keys = await ops.getKeys(eui); } catch (err) { toast(api.humanize(err), { type: 'err' }); }
                drawDrawer();
            }
            if (act === 'period') { period = b.dataset.v; session.lastPeriod = period; drawDrawer(); loadMetrics(); }
            if (act === 'measure') { session.lastMeasure = b.dataset.k; render($('#dv-metrics', dr), metricsBlock()); }
            if (act === 'csv') exportHistory();
            if (act === 'expand') {
                const S = metrics && !metrics.error ? series() : { measures: [] };
                const first = S.measures.find((m) => m.key === session.lastMeasure) || S.measures[0];
                // Mesure affichée d'abord, puis les autres du device ; à défaut, la liaison radio.
                const keys = first ? [first, ...S.measures.filter((m) => m !== first)].map((m) => ({ key: m.key, name: m.name, unit: m.unit, kind: m.kind })) : [{ key: '@rssi' }, { key: '@rx' }];
                const d = list.find((x) => x.devEui === eui) || d0;
                session.pendingHistory = { devEui: eui, name: d.name, keys, period: period === '1y' ? '1y' : period };
                close();
                navigate('historique');
            }
            if (act === 'edit') {
                if (!full) { b.classList.add('loading'); full = await ops.getDevice(eui).catch(() => null); }
                editing = !!full;
                drawDrawer();
                $('#dv-name', dr)?.focus();
            }
            if (act === 'cancel') { editing = false; drawDrawer(); loadMetrics(); }
            if (act === 'addtag') {
                const r = document.createElement('div');
                r.className = 'row';
                render(r, html`<input type="text" class="sm mono" placeholder="clé" data-k style="max-width:200px"><span class="dim">=</span><input type="text" class="sm" placeholder="valeur" data-v>`);
                $('#dv-tags', dr).appendChild(r);
                $('[data-k]', r).focus();
            }
            if (act === 'delete') {
                const ok = await confirmDialog({ title: 'Supprimer ce device ?', message: html`<strong>${d0.name}</strong> (<span class="mono">${eui}</span>) sera supprimé définitivement de ChirpStack.`, confirm: 'Supprimer', danger: true });
                if (!ok) return;
                try {
                    const snap = await ops.snapshot(eui);
                    await ops.deleteDevice(eui);
                    removeDevices(app.id, [eui]);
                    sel.delete(eui);
                    close();
                    draw();
                    toast('Device supprimé.', { action: 'Annuler', onAction: async () => {
                        try {
                            await ops.restore(snap);
                            invalidate(app.id);
                            load();
                            toast('Device recréé.');
                        } catch (err) { toast(api.humanize(err), { type: 'err' }); }
                    }, duration: 8000 });
                } catch (err) { toast(api.humanize(err), { type: 'err' }); }
            }
        });

        dr.addEventListener('submit', async (e) => {
            e.preventDefault();
            const tags = {};
            for (const r of $$('#dv-tags .row', dr)) {
                const k = $('[data-k]', r).value.trim();
                if (!k) continue;
                if (!isValidTagKey(k)) return toast(`Clé de tag invalide : « ${k} »`, { type: 'err' });
                tags[k] = $('[data-v]', r).value.trim();
            }
            const next = { ...full.device, name: $('#dv-name', dr).value.trim() || full.device.name, description: $('#dv-desc', dr).value.trim(), deviceProfileId: $('#dv-dp', dr).value, tags };
            try {
                await api.put(`/api/devices/${eui}`, { device: next });
                full.device = next;
                patchDevices(app.id, [{ devEui: eui, name: next.name, description: next.description, deviceProfileId: next.deviceProfileId, deviceProfileName: profileName(next.deviceProfileId), tags }]);
                editing = false;
                drawDrawer();
                loadMetrics();
                draw();
                toast('Device mis à jour.');
            } catch (err) {
                toast(api.humanize(err), { type: 'err' });
            }
        });

        drawDrawer();
        loadMetrics();
        ops.getDevice(eui).then((r) => { full = r; if (!editing) { const kv = dr.querySelector('.kv'); if (kv) { drawDrawer(); if (metrics) render($('#dv-metrics', dr), metricsBlock()); } } }).catch(() => {});
    }


    const offDevices = listen('devices', (d) => {
        if (d?.appId === app.id && alive) {
            const c = cached(app.id);
            if (c && c !== list) { list = c; draw(); }
        }
    });

    load();
    return () => {
        alive = false;
        offDevices();
        closeDrawer();
    };
}
