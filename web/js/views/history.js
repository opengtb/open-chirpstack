// Historique : courbes de mesures (et de liaison radio) pour un ou plusieurs devices, sur une même échelle de temps.

import * as api from '../api.js';
import { session, devices, cached, appName } from '../state.js';
import { $, $$, html, render, icon, on, fmtNum, plural, toast, openDialog, download, today, slug, debounce } from '../ui.js';
import { toCSV } from '../files.js';
import { unitOf } from '../charts.js';
import { timeChart, fmtNumber, fmtTime } from '../timechart.js';

const HOUR = 3600e3;
const PRESETS = {
    '24h': { label: '24 h', hours: 24 },
    '48h': { label: '48 h', hours: 48 },
    '7d': { label: '7 j', hours: 24 * 7 },
    '30d': { label: '30 j', hours: 24 * 30 },
    '1y': { label: '12 mois', hours: 24 * 365 },
};
const MAX_SERIES = 16;
const COLORS = 8;
// Mesures de liaison radio proposées comme des mesures ordinaires.
const RADIO = {
    '@rssi': { name: 'RSSI', unit: 'dBm', kind: 'GAUGE' },
    '@snr': { name: 'SNR', unit: 'dB', kind: 'GAUGE' },
    '@rx': { name: 'Paquets reçus', unit: 'paquets', kind: 'ABSOLUTE' },
};

// Agrégation selon la durée, en cohérence avec la rétention par défaut de ChirpStack.
const aggFor = (span) => (span <= 2.5 * 24 * HOUR ? 'HOUR' : span <= 62 * 24 * HOUR ? 'DAY' : 'MONTH');
const AGG_LABEL = { HOUR: 'horaire', DAY: 'journalière', MONTH: 'mensuelle' };

// Cache des réponses par device et par plage (évite de recharger en changeant de courbe).
const dataCache = new Map();

export function mount(root) {
    let alive = true;
    let series = []; // { id, eui, device, key, name, unit, kind, color, hidden }
    let period = '24h';
    let custom = null; // { from, to }
    const zoomStack = [];
    let data = new Map(); // eui -> { metrics, link, error }
    let loading = false;
    let charts = [];
    let nextId = 1;

    const range = () => {
        if (custom) return { ...custom, agg: aggFor(custom.to - custom.from) };
        const to = Date.now();
        const from = to - PRESETS[period].hours * HOUR;
        return { from, to, agg: aggFor(to - from) };
    };

    const color = (s) => `var(--chart-${(s.color % COLORS) + 1})`;
    const resolvedColor = (s) => getComputedStyle(document.documentElement).getPropertyValue(`--chart-${(s.color % COLORS) + 1}`).trim();
    const freeColor = () => {
        const used = new Set(series.map((s) => s.color % COLORS));
        for (let i = 0; i < COLORS; i++) if (!used.has(i)) return i;
        return series.length;
    };

    // ---------- URL partageable ----------
    function writeUrl() {
        const q = new URLSearchParams();
        if (custom) { q.set('f', String(Math.round(custom.from))); q.set('t', String(Math.round(custom.to))); } else q.set('p', period);
        if (series.length) q.set('s', series.map((s) => `${s.eui}~${s.key}`).join(','));
        history.replaceState(null, '', `#/historique?${q}`);
    }

    function readUrl() {
        const q = new URLSearchParams(location.hash.split('?')[1] || '');
        if (q.get('f') && q.get('t')) custom = { from: Number(q.get('f')), to: Number(q.get('t')) };
        else if (PRESETS[q.get('p')]) period = q.get('p');
        for (const part of (q.get('s') || '').split(',').filter(Boolean)) {
            const [eui, ...k] = part.split('~');
            if (/^[0-9a-f]{16}$/i.test(eui) && k.length) addSeries(eui.toLowerCase(), k.join('~'), null);
        }
    }

    function deviceName(eui) {
        for (const a of session.apps) {
            const d = cached(a.id)?.find((x) => x.devEui === eui);
            if (d) return d.name;
        }
        return null;
    }

    function addSeries(eui, key, devName, meta = {}) {
        if (series.some((s) => s.eui === eui && s.key === key)) return false;
        if (series.length >= MAX_SERIES) return false;
        series.push({ id: nextId++, eui, device: devName || deviceName(eui) || eui, key, name: meta.name || RADIO[key]?.name || key, unit: meta.unit ?? RADIO[key]?.unit ?? null, kind: meta.kind || RADIO[key]?.kind || null, color: freeColor(), hidden: false });
        return true;
    }

    // ---------- Données ----------
    async function fetchDevice(eui, r) {
        const k = `${eui}|${Math.round(r.from / 60000)}|${Math.round(r.to / 60000)}|${r.agg}`;
        if (dataCache.has(k)) return dataCache.get(k);
        const qs = `start=${encodeURIComponent(new Date(r.from).toISOString())}&end=${encodeURIComponent(new Date(r.to).toISOString())}&aggregation=${r.agg}`;
        const [metrics, link] = await Promise.allSettled([api.get(`/api/devices/${eui}/metrics?${qs}`), api.get(`/api/devices/${eui}/link-metrics?${qs}`)]);
        const out = {
            metrics: metrics.status === 'fulfilled' ? metrics.value : null,
            link: link.status === 'fulfilled' ? link.value : null,
            error: metrics.status === 'rejected' && link.status === 'rejected' ? api.humanize(metrics.reason) : null,
        };
        if (!out.error) dataCache.set(k, out);
        if (dataCache.size > 200) dataCache.delete(dataCache.keys().next().value);
        return out;
    }

    async function load() {
        const r = range();
        loading = true;
        drawToolbar();
        const euis = [...new Set(series.map((s) => s.eui))];
        // Noms manquants (lien partagé, device d'une autre application)
        const unnamed = series.filter((s) => s.device === s.eui);
        const results = await api.pool(euis, 4, async (eui) => [eui, await fetchDevice(eui, r)]);
        await api.pool([...new Set(unnamed.map((s) => s.eui))], 4, async (eui) => {
            try {
                const d = await api.get(`/api/devices/${eui}`);
                for (const s of series) if (s.eui === eui) s.device = d.device.name;
            } catch { /* nom indisponible : on garde le DevEUI */ }
        });
        if (!alive) return;
        data = new Map(results);
        loading = false;
        draw();
    }

    // Points [t, v] d'une série ; un intervalle sans message devient un trou.
    function points(s) {
        const d = data.get(s.eui);
        if (!d) return [];
        const link = d.link || {};
        const lts = (link.rxPackets?.timestamps || []).map((t) => Date.parse(t));
        const rx = (link.rxPackets?.datasets?.[0]?.data || []).map(Number);
        const rxAt = new Map(lts.map((t, i) => [t, rx[i]]));
        if (RADIO[s.key]) {
            const metric = { '@rssi': link.gwRssi, '@snr': link.gwSnr, '@rx': link.rxPackets }[s.key];
            const vals = (metric?.datasets?.[0]?.data || []).map(Number);
            return lts.map((t, i) => [t, s.key === '@rx' ? vals[i] : rx[i] > 0 ? vals[i] : null]);
        }
        const m = d.metrics?.metrics?.[s.key];
        if (!m) return [];
        if (!s.unit && s.unit !== '') s.unit = unitOf(s.key, m.name);
        s.name = m.name || s.key;
        s.kind = m.kind;
        const ts = (m.timestamps || []).map((t) => Date.parse(t));
        const vals = (m.datasets?.[0]?.data || []).map(Number);
        return ts.map((t, i) => {
            const v = vals[i];
            if (!Number.isFinite(v)) return [t, null];
            if (m.kind !== 'ABSOLUTE' && rxAt.get(t) === 0) return [t, null];
            return [t, v];
        });
    }

    function stats(pts) {
        const vals = pts.filter((p) => p[1] !== null);
        if (!vals.length) return null;
        let min = vals[0];
        let max = vals[0];
        let sum = 0;
        for (const p of vals) {
            if (p[1] < min[1]) min = p;
            if (p[1] > max[1]) max = p;
            sum += p[1];
        }
        return { min, max, avg: sum / vals.length, last: vals[vals.length - 1], n: vals.length, sum };
    }

    // ---------- Rendu ----------
    function drawToolbar() {
        const el = $('#h-toolbar', root);
        if (!el) return;
        const r = range();
        const toLocal = (t) => { const d = new Date(t - new Date(t).getTimezoneOffset() * 60000); return d.toISOString().slice(0, 16); };
        render(el, html`
            <div class="seg">${Object.entries(PRESETS).map(([k, p]) => html`<button class="${!custom && period === k ? 'on' : ''}" data-act="preset" data-v="${k}">${p.label}</button>`)}</div>
            <div class="row small">
                <input type="datetime-local" id="h-from" class="sm" value="${toLocal(r.from)}" aria-label="Début" style="width:auto">
                <span class="dim">→</span>
                <input type="datetime-local" id="h-to" class="sm" value="${toLocal(r.to)}" aria-label="Fin" style="width:auto">
            </div>
            ${zoomStack.length ? html`<button class="btn btn-sm btn-ghost" data-act="unzoom">${icon('undo')} dézoomer</button>` : ''}
            <span class="spacer"></span>
            <span class="badge" title="Résolution des données renvoyées par ChirpStack">valeurs ${AGG_LABEL[r.agg]}s</span>
            ${loading ? html`<span class="mono small dim">chargement…</span>` : ''}`);
    }

    function legend() {
        return html`<div class="h-legend">
            ${series.map((s) => {
                const st = stats(points(s));
                return html`<span class="h-chip ${s.hidden ? 'off' : ''}">
                    <button class="h-chip-main" data-act="toggle" data-id="${s.id}" title="Afficher / masquer">
                        <i style="background:${color(s)}${s.color >= COLORS ? ';opacity:.6' : ''}"></i><span class="dev">${s.device}</span><span class="dim">·</span><span>${s.name}</span>
                        <strong>${st ? `${fmtNumber(s.kind === 'ABSOLUTE' ? st.sum : st.last[1])}${s.unit ? ' ' + s.unit : ''}` : '—'}</strong></button>
                    <button class="h-chip-x" data-act="remove" data-id="${s.id}" aria-label="Retirer">${icon('x')}</button></span>`;
            })}
            <button class="btn btn-sm" data-act="add">${icon('plus')} Ajouter des courbes</button>
            ${series.length > 1 ? html`<button class="btn-link" data-act="clear">tout retirer</button>` : ''}
        </div>`;
    }

    function statsTable() {
        const rows = series.map((s) => ({ s, st: stats(points(s)) }));
        return html`<div class="table-wrap"><table class="tbl">
            <thead><tr><th>Courbe</th><th class="num">Dernière</th><th class="num">Min</th><th class="num">Moyenne</th><th class="num">Max</th><th class="num">Valeurs</th></tr></thead>
            <tbody>${rows.map(({ s, st }) => html`<tr>
                <td><span class="h-sw" style="background:${color(s)}"></span><strong>${s.device}</strong> <span class="dim">·</span> ${s.name}${s.unit ? html` <span class="dim">(${s.unit})</span>` : ''}</td>
                ${st ? html`
                    <td class="num">${fmtNumber(st.last[1])}<div class="xs dim">${fmtTime(st.last[0])}</div></td>
                    <td class="num">${fmtNumber(st.min[1])}<div class="xs dim">${fmtTime(st.min[0])}</div></td>
                    <td class="num">${fmtNumber(s.kind === 'ABSOLUTE' ? st.sum / st.n : st.avg)}${s.kind === 'ABSOLUTE' ? html`<div class="xs dim">total ${fmtNumber(st.sum)}</div>` : ''}</td>
                    <td class="num">${fmtNumber(st.max[1])}<div class="xs dim">${fmtTime(st.max[0])}</div></td>
                    <td class="num">${fmtNum(st.n)}</td>`
                    : html`<td colspan="5" class="dim small">${data.get(s.eui)?.error || 'aucune valeur sur cette période'}</td>`}
            </tr>`)}</tbody></table></div>`;
    }

    // Répartition des courbes : 1re unité à gauche, 2e à droite, les suivantes dans des graphiques empilés.
    function layout() {
        const units = [];
        for (const s of series) {
            const u = s.unit ?? '';
            if (!units.includes(u)) units.push(u);
        }
        const groups = [{ height: 380, series: [] }];
        for (const s of series) {
            const i = units.indexOf(s.unit ?? '');
            if (i === 0) groups[0].series.push({ s, axis: 'left' });
            else if (i === 1) groups[0].series.push({ s, axis: 'right' });
            else {
                let g = groups.find((x) => x.unit === s.unit);
                if (!g) { g = { height: 190, unit: s.unit, series: [] }; groups.push(g); }
                g.series.push({ s, axis: 'left' });
            }
        }
        return groups;
    }

    function drawCharts() {
        for (const c of charts) c.destroy();
        charts = [];
        const box = $('#h-charts', root);
        if (!box) return;
        box.textContent = '';
        if (!series.length) return;
        const r = range();
        const groups = layout();
        const sync = (t) => charts.forEach((c) => c.cursor(t));
        for (const g of groups) {
            const div = document.createElement('div');
            div.className = 'h-chart';
            box.appendChild(div);
            const chart = timeChart(div, { height: g.height });
            charts.push(chart);
            chart.set({
                from: r.from,
                to: r.to,
                series: g.series.map(({ s, axis }) => ({ label: `${s.device} · ${s.name}`, color: resolvedColor(s), dashed: s.color >= COLORS, unit: s.unit ?? '', kind: s.kind, axis, hidden: s.hidden, pts: points(s) })),
                onCursor: sync,
                onZoom: (a, b) => {
                    zoomStack.push({ period, custom });
                    custom = { from: a, to: b };
                    reload();
                },
                onReset: () => unzoom(),
            });
        }
    }

    function draw() {
        if (!alive) return;
        render($('#h-legend', root), legend());
        drawToolbar();
        drawCharts();
        const st = $('#h-stats', root);
        render(st, series.length ? html`<h2 class="section-title">Statistiques <span class="dim">— sur la période affichée</span></h2>${statsTable()}` : '');
        const empty = $('#h-empty', root);
        empty.hidden = series.length > 0;
        $$('[data-act="csv"],[data-act="png"]', root).forEach((b) => { b.disabled = !series.length; });
    }

    function frame() {
        render(root, html`<div class="page">
            <div class="page-head">
                <div>
                    <div class="eyebrow">$ cs historique</div>
                    <h1>Historique</h1>
                    <p class="lede">Superposez les mesures de vos devices : survolez pour lire les valeurs, glissez pour zoomer, double-cliquez pour revenir.</p>
                </div>
                <div class="actions">
                    <button class="btn" data-act="csv">${icon('download')} CSV</button>
                    <button class="btn" data-act="png">${icon('download')} Image PNG</button>
                </div>
            </div>
            <div class="toolbar" id="h-toolbar"></div>
            <div id="h-legend"></div>
            <div id="h-empty" class="empty-state card" hidden>
                <h3>Aucune courbe</h3>
                <p>Choisissez un ou plusieurs devices puis leurs mesures (température, consigne, humidité…). Vous pouvez aussi ouvrir l'historique depuis la fiche d'un device.</p>
                <button class="btn btn-primary" data-act="add">${icon('plus')} Ajouter des courbes</button>
            </div>
            <div id="h-charts" class="stack" style="gap:.75rem"></div>
            <div id="h-stats"></div>
            <p class="hint mt">ChirpStack ne conserve que des valeurs agrégées des mesures déclarées dans les Device Profiles : par défaut 2 jours en horaire, 1 mois en journalier, 1 an en mensuel.</p>
        </div>`);
    }

    function reload() {
        writeUrl();
        load();
    }

    function unzoom() {
        const prev = zoomStack.pop();
        if (prev) { period = prev.period; custom = prev.custom; } else if (custom) custom = null;
        else return;
        reload();
    }

    // ---------- Ajout de courbes ----------
    async function addDialog(preselected = []) {
        let appId = session.app?.id || session.apps[0]?.id;
        let list = [];
        const chosen = new Map(preselected.map((d) => [d.eui, d.name]));
        let step = preselected.length ? 2 : 1;
        let q = '';
        let measureInfo = null; // [{ key, name, unit, kind, count }]

        const d = openDialog({ title: 'Ajouter des courbes', wide: true, body: html`<div id="ad-body"></div>`, foot: html`<div id="ad-foot" class="row grow"></div>` });
        const body = $('#ad-body', d.el);
        const foot = $('#ad-foot', d.el);

        const filtered = () => {
            const s = q.trim().toLowerCase();
            return s ? list.filter((x) => `${x.name} ${x.devEui} ${x.description || ''} ${Object.values(x.tags || {}).join(' ')}`.toLowerCase().includes(s)) : list;
        };

        function drawStep1() {
            const rows = filtered();
            render(body, html`
                <div class="row" style="margin-bottom:.75rem">
                    <select id="ad-app" class="sm" style="width:auto;max-width:280px">${session.apps.map((a) => html`<option value="${a.id}" ${a.id === appId ? 'selected' : ''}>${a.name}</option>`)}</select>
                    <div class="search-input grow">${icon('search')}<input type="search" id="ad-q" value="${q}" placeholder="Nom, DevEUI, tag (ex. R+1, Salle 104)…" autofocus></div>
                </div>
                <div class="row small" style="margin-bottom:.5rem"><button class="btn-link" data-ad="all">tout cocher (${fmtNum(Math.min(rows.length, MAX_SERIES))})</button><span class="dim">·</span><button class="btn-link" data-ad="none">tout décocher</button><span class="spacer"></span><span class="dim">${fmtNum(chosen.size)} sélectionné(s)</span></div>
                <div class="table-wrap short"><table class="tbl"><tbody>
                    ${rows.slice(0, 200).map((x) => html`<tr class="clickable" data-pick="${x.devEui}"><td class="w-check"><input type="checkbox" ${chosen.has(x.devEui) ? 'checked' : ''} tabindex="-1"></td>
                        <td class="name">${x.name}<small>${x.deviceProfileName || ''}</small></td><td class="eui">${x.devEui}</td></tr>`)}
                    ${!rows.length ? html`<tr><td class="empty">${list.length ? 'Aucun device ne correspond.' : 'Chargement…'}</td></tr>` : ''}
                </tbody></table></div>`);
            render(foot, html`<span class="spacer"></span><button class="btn" data-close>Annuler</button><button class="btn btn-primary" data-ad="next" ${chosen.size ? '' : 'disabled'}>Choisir les mesures →</button>`);
            const input = $('#ad-q', body);
            input.focus();
            input.setSelectionRange(input.value.length, input.value.length);
        }

        async function loadApp() {
            list = [];
            drawStep1();
            try { list = await devices(appId); } catch (e) { toast(api.humanize(e), { type: 'err' }); }
            if (step === 1) drawStep1();
        }

        async function drawStep2() {
            render(body, html`<p class="hint">Lecture des mesures de ${plural(chosen.size, 'device')}…</p><div class="progress indeterminate"><i></i></div>`);
            render(foot, html`<span class="spacer"></span><button class="btn" data-close>Annuler</button>`);
            const r = range();
            const per = await api.pool([...chosen.keys()], 4, async (eui) => [eui, await fetchDevice(eui, r).catch(() => null)]);
            const info = new Map();
            for (const [, res] of per) {
                for (const [key, m] of Object.entries(res?.metrics?.metrics || {})) {
                    const cur = info.get(key) || { key, name: m.name || key, unit: unitOf(key, m.name), kind: m.kind, count: 0 };
                    cur.count++;
                    info.set(key, cur);
                }
            }
            measureInfo = [...info.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
            const already = new Set(series.map((s) => s.key));
            const preferred = measureInfo.find((m) => /temp/i.test(m.key))?.key || measureInfo[0]?.key;
            render(body, html`
                <p class="soft small" style="margin-bottom:.75rem">${plural(chosen.size, 'device')} : ${[...chosen.values()].slice(0, 6).join(', ')}${chosen.size > 6 ? '…' : ''}
                    ${preselected.length ? '' : html` · <button class="btn-link" data-ad="back">modifier</button>`}</p>
                ${measureInfo.length ? html`<span class="label">Mesures enregistrées</span>
                    <div class="tags" style="gap:.4rem;margin-bottom:1rem">${measureInfo.map((m) => html`<label class="check badge" style="padding:.3rem .55rem"><input type="checkbox" data-key="${m.key}" ${already.has(m.key) || (!already.size && m.key === preferred) ? 'checked' : ''}> ${m.name}${m.unit ? html` <span class="dim">(${m.unit})</span>` : ''}${chosen.size > 1 ? html` <span class="dim">${m.count}/${chosen.size}</span>` : ''}</label>`)}</div>`
                    : html`<div class="callout" style="margin-bottom:1rem">${icon('alert')}<div>Aucune mesure historisée pour ${chosen.size > 1 ? 'ces devices' : 'ce device'} sur la période. ChirpStack n'enregistre que les mesures déclarées dans le Device Profile (onglet <em>Measurements</em>).</div></div>`}
                <span class="label">Liaison radio</span>
                <div class="tags" style="gap:.4rem">${Object.entries(RADIO).map(([k, m]) => html`<label class="check badge" style="padding:.3rem .55rem"><input type="checkbox" data-key="${k}" ${!measureInfo.length && k === '@rssi' ? 'checked' : ''}> ${m.name} <span class="dim">(${m.unit})</span></label>`)}</div>
                <p class="hint mt" id="ad-count"></p>`);
            const count = () => {
                const n = $$('input[data-key]:checked', body).length * chosen.size;
                const room = MAX_SERIES - series.length;
                $('#ad-count', body).textContent = `${plural(n, 'courbe')}${n > room ? ` — seules les ${room} premières seront ajoutées (${MAX_SERIES} au maximum)` : ''}`;
                $('[data-ad="add"]', foot).disabled = !n;
            };
            render(foot, html`<span class="spacer"></span><button class="btn" data-close>Annuler</button><button class="btn btn-primary" data-ad="add">Ajouter</button>`);
            body.addEventListener('change', count);
            count();
        }

        d.el.addEventListener('input', debounce((e) => { if (e.target.id === 'ad-q') { q = e.target.value; drawStep1(); } }, 120));
        d.el.addEventListener('change', (e) => { if (e.target.id === 'ad-app') { appId = e.target.value; loadApp(); } });
        d.el.addEventListener('click', (e) => {
            const pick = e.target.closest('[data-pick]');
            if (pick) {
                const x = list.find((y) => y.devEui === pick.dataset.pick);
                chosen.has(x.devEui) ? chosen.delete(x.devEui) : chosen.set(x.devEui, x.name);
                drawStep1();
                return;
            }
            const b = e.target.closest('[data-ad]');
            if (!b) return;
            const act = b.dataset.ad;
            if (act === 'all') { for (const x of filtered().slice(0, MAX_SERIES)) chosen.set(x.devEui, x.name); drawStep1(); }
            if (act === 'none') { chosen.clear(); drawStep1(); }
            if (act === 'next') { step = 2; drawStep2(); }
            if (act === 'back') { step = 1; drawStep1(); }
            if (act === 'add') {
                const keys = $$('input[data-key]:checked', body).map((i) => i.dataset.key);
                let added = 0;
                let skipped = 0;
                for (const key of keys) {
                    for (const [eui, name] of chosen) {
                        const m = measureInfo?.find((x) => x.key === key);
                        if (addSeries(eui, key, name, m ? { name: m.name, unit: m.unit, kind: m.kind } : {})) added++;
                        else skipped++;
                    }
                }
                d.close();
                if (skipped && series.length >= MAX_SERIES) toast(`${MAX_SERIES} courbes au maximum : ${skipped} non ajoutée(s).`, { type: 'warn' });
                if (added) reload();
            }
        });

        if (step === 1) loadApp();
        else drawStep2();
    }

    // ---------- Exports ----------
    function exportCsv() {
        const cols = series.map((s) => ({ s, map: new Map(points(s).map(([t, v]) => [t, v])) }));
        const times = [...new Set(cols.flatMap((c) => [...c.map.keys()]))].sort((a, b) => a - b);
        const head = ['horodatage', ...series.map((s) => `${s.device} · ${s.name}${s.unit ? ` (${s.unit})` : ''}`)];
        const rows = times.map((t) => [new Date(t).toLocaleString('fr-FR'), ...cols.map((c) => { const v = c.map.get(t); return v === null || v === undefined ? '' : String(v).replace('.', ','); })]);
        download(toCSV(head, rows), `historique-${today()}.csv`, 'text/csv;charset=utf-8');
    }

    async function exportPng() {
        const r = range();
        const scale = 2;
        const width = Math.max(...charts.map((c) => c.svg().clientWidth || 900));
        const legendRows = series.filter((s) => !s.hidden);
        const headH = 80 + legendRows.length * 20;
        const heights = charts.map((c) => Number(c.svg().getAttribute('height')));
        const total = headH + heights.reduce((a, b) => a + b + 12, 0) + 28;
        const canvas = document.createElement('canvas');
        canvas.width = width * scale;
        canvas.height = total * scale;
        const ctx = canvas.getContext('2d');
        ctx.scale(scale, scale);
        const cs = getComputedStyle(document.documentElement);
        const v = (n) => cs.getPropertyValue(n).trim();
        ctx.fillStyle = v('--card');
        ctx.fillRect(0, 0, width, total);
        ctx.fillStyle = v('--fg');
        ctx.font = `600 17px ${v('--font-sans')}`;
        ctx.fillText(`Historique — ${session.tenant?.name || ''}`, 16, 28);
        ctx.font = `12px ${v('--font-mono')}`;
        ctx.fillStyle = v('--text-dim');
        ctx.fillText(`${fmtTime(r.from, true)} → ${fmtTime(r.to, true)} · valeurs ${AGG_LABEL[r.agg]}s`, 16, 48);
        legendRows.forEach((s, i) => {
            const y = 82 + i * 20;
            ctx.fillStyle = resolvedColor(s);
            ctx.fillRect(16, y - 9, 12, 4);
            ctx.fillStyle = v('--fg');
            ctx.font = `13px ${v('--font-sans')}`;
            ctx.fillText(`${s.device} · ${s.name}${s.unit ? ` (${s.unit})` : ''}`, 36, y - 3);
        });
        let y = headH;
        for (const c of charts) {
            const svgEl = c.svg();
            const xml = new XMLSerializer().serializeToString(svgEl);
            const img = new Image();
            const url = URL.createObjectURL(new Blob([xml], { type: 'image/svg+xml' }));
            await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
            ctx.drawImage(img, 0, y, svgEl.clientWidth, Number(svgEl.getAttribute('height')));
            URL.revokeObjectURL(url);
            y += Number(svgEl.getAttribute('height')) + 12;
        }
        ctx.fillStyle = v('--text-dim');
        ctx.font = `11px ${v('--font-mono')}`;
        ctx.fillText('open/chirpstack', width - 120, total - 10);
        canvas.toBlob((blob) => download(blob, `historique-${slug(series[0]?.device || 'devices')}-${today()}.png`), 'image/png');
    }

    // ---------- Événements ----------
    on(root, 'click', {
        preset: (el) => { period = el.dataset.v; custom = null; zoomStack.length = 0; reload(); },
        unzoom: () => unzoom(),
        add: () => addDialog(),
        toggle: (el) => {
            const s = series.find((x) => x.id === Number(el.dataset.id));
            s.hidden = !s.hidden;
            render($('#h-legend', root), legend());
            drawCharts();
        },
        remove: (el) => {
            series = series.filter((x) => x.id !== Number(el.dataset.id));
            writeUrl();
            draw();
        },
        clear: () => { series = []; writeUrl(); draw(); },
        csv: () => exportCsv(),
        png: () => exportPng().catch((e) => toast(`Image impossible : ${e.message}`, { type: 'err' })),
    });
    root.addEventListener('change', (e) => {
        if (e.target.id === 'h-from' || e.target.id === 'h-to') {
            const from = Date.parse($('#h-from', root).value);
            const to = Date.parse($('#h-to', root).value);
            if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return toast('Plage de dates invalide.', { type: 'warn' });
            zoomStack.push({ period, custom });
            custom = { from, to };
            reload();
        }
    });
    // Redessin au changement de thème (couleurs lues à l'affichage).
    const themeObs = new MutationObserver(() => drawCharts());
    themeObs.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });

    // ---------- Démarrage ----------
    frame();
    readUrl();
    const pending = session.pendingHistory;
    session.pendingHistory = undefined;
    if (pending?.period && PRESETS[pending.period]) { period = pending.period; custom = null; }
    if (pending?.devEui) {
        series = [];
        for (const k of pending.keys || []) addSeries(pending.devEui, k.key, pending.name, k);
    }
    draw();
    if (series.length) reload();
    else writeUrl();
    if (pending?.devices?.length) addDialog(pending.devices);

    return () => {
        alive = false;
        themeObs.disconnect();
        for (const c of charts) c.destroy();
    };
}
