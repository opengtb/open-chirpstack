// Vue d'ensemble : santé de l'application, applications du tenant, gateways.

import * as api from '../api.js';
import { session, devices, cached, statusOf, battery, STATUSES, listen } from '../state.js';
import { $, html, render, icon, fmtNum, plural, timeAgo, on } from '../ui.js';

export function mount(root, { navigate, chooseApp, appMenu }) {
    let alive = true;
    let gateways = null;
    let gwError = null;

    function goFiltered(filter) {
        session.pendingFilter = filter;
        navigate('devices');
    }

    function appHealth() {
        if (!session.app) {
            return html`<div class="callout">${icon('layers')}<div>Choisissez une application ci-dessous (ou dans la barre du haut) pour voir l'état de ses devices.</div></div>`;
        }
        const list = cached(session.app.id);
        if (!list) {
            return html`<div class="kpis">${STATUSES.map(() => html`<div class="kpi"><div class="skeleton" style="width:60%"></div><div class="skeleton" style="height:28px;margin-top:.5rem;width:40%"></div></div>`)}</div>
                <p class="hint" data-progress>Chargement des devices…</p>`;
        }
        const counts = Object.fromEntries(STATUSES.map((s) => [s.key, 0]));
        const byProfile = {};
        let lowBat = 0;
        for (const d of list) {
            counts[statusOf(d)]++;
            const name = d.deviceProfileName || 'Sans profil';
            byProfile[name] = (byProfile[name] || 0) + 1;
            const b = battery(d);
            if (b && !b.ext && b.level < 20) lowBat++;
        }
        const total = list.length || 1;
        const profiles = Object.entries(byProfile).sort((a, b) => b[1] - a[1]);
        const max = profiles[0]?.[1] || 1;
        const silent = list.filter((d) => statusOf(d) === 'recent').sort((a, b) => new Date(b.lastSeenAt) - new Date(a.lastSeenAt)).slice(0, 6);
        const cls = { active: 'is-ok', recent: '', inactive: 'is-warn', offline: 'is-err', never: '' };

        return html`
            <div class="kpis">
                <button class="kpi" data-act="filter" data-f="">
                    <div class="k-label">total</div><div class="k-value">${fmtNum(list.length)}</div><div class="k-sub">devices</div></button>
                ${STATUSES.map((s) => html`<button class="kpi ${cls[s.key]}" data-act="filter" data-f="${s.key}" title="${s.hint}">
                    <div class="k-label"><span class="status ${s.key}"></span>${s.label.toLowerCase()}</div>
                    <div class="k-value">${fmtNum(counts[s.key])}</div>
                    <div class="k-sub">${Math.round((counts[s.key] / total) * 100)} %</div></button>`)}
                <button class="kpi ${lowBat ? 'is-err' : ''}" data-act="filter" data-f="lowbat" title="Niveau de pile inférieur à 20 %">
                    <div class="k-label">${icon('battery')} piles &lt; 20 %</div><div class="k-value">${fmtNum(lowBat)}</div><div class="k-sub">à remplacer</div></button>
            </div>
            <div class="stackbar" style="margin-top:1rem" aria-hidden="true">${STATUSES.map((s) => html`<span class="c-${s.key}" style="width:${(counts[s.key] / total) * 100}%"></span>`)}</div>
            <div class="legend">${STATUSES.map((s) => html`<span><i class="c-${s.key}"></i>${s.one} — ${s.hint}</span>`)}</div>

            <div class="grid grid-2 mt">
                <div class="card">
                    <div class="card-head"><h3>Répartition par Device Profile</h3><span class="end dim xs">${plural(profiles.length, 'profil')}</span></div>
                    <div class="bars">${profiles.slice(0, 10).map(([name, n]) => html`<div class="bar-row"><span class="name" title="${name}">${name}</span><div class="bar-track"><div class="bar-fill" style="width:${(n / max) * 100}%"></div></div><span class="val">${fmtNum(n)}</span></div>`)}</div>
                    ${profiles.length > 10 ? html`<p class="hint">+ ${profiles.length - 10} autres profils</p>` : ''}
                </div>
                <div class="card">
                    <div class="card-head"><h3>Devenus silencieux</h3><span class="end dim xs">vus il y a 1 à 7 jours</span></div>
                    ${silent.length ? html`<table class="tbl"><tbody>${silent.map((d) => html`<tr class="clickable" data-act="open" data-eui="${d.devEui}">
                        <td class="name">${d.name || d.devEui}<small>${d.deviceProfileName || ''}</small></td>
                        <td class="dim small nowrap" style="text-align:right">${timeAgo(d.lastSeenAt)}</td></tr>`)}</tbody></table>
                        <button class="btn-link mt" data-act="filter" data-f="recent">voir tous les récents →</button>`
                        : html`<p class="dim small">Aucun device dans cette situation. Tout le monde parle.</p>`}
                </div>
            </div>`;
    }

    function appsSection() {
        if (!session.apps.length) return html`<div class="empty-state"><h3>Aucune application</h3><p>Créez une application dans ChirpStack pour pouvoir y importer des devices.</p></div>`;
        return html`<div class="joined cols-3" style="grid-template-columns:repeat(auto-fill,minmax(250px,1fr))">${session.apps.map((a) => {
            const n = session.appCounts[a.id];
            const on = a.id === session.app?.id;
            return html`<button class="tile" data-act="app" data-id="${a.id}" style="border-right:1px solid var(--border);border-bottom:1px solid var(--border)">
                <span class="tag-line">// ${on ? 'application courante' : 'application'}</span>
                <h3>${a.name}</h3>
                <p>${n === undefined ? '…' : plural(n, 'device')}${a.description ? ` · ${a.description}` : ''}</p>
                <span class="go">${on ? 'devices →' : 'ouvrir →'}</span></button>`;
        })}</div>`;
    }

    // Santé de toutes les applications (chargement à la demande, listes mises en cache).
    let scan = null; // { done, total } pendant le chargement
    function tenantHealth() {
        const allCached = session.apps.length && session.apps.every((a) => cached(a.id));
        if (!allCached) {
            const total = session.apps.reduce((n, a) => n + (session.appCounts[a.id] || 0), 0);
            return scan ? html`<div class="row"><div class="grow progress"><i style="width:${(scan.done / scan.total) * 100}%"></i></div><span class="mono small">${scan.done} / ${scan.total} applications</span></div>`
                : html`<div class="row-wrap"><button class="btn" data-act="scan">${icon('refresh')} Analyser les ${plural(session.apps.length, 'application')}</button><span class="hint">${total ? `${fmtNum(total)} devices à lire` : ''} — actifs, silencieux et piles faibles, application par application.</span></div>`;
        }
        const rows = session.apps.map((a) => {
            const list = cached(a.id);
            const c = Object.fromEntries(STATUSES.map((s) => [s.key, 0]));
            let low = 0;
            for (const d of list) {
                c[statusOf(d)]++;
                const b = battery(d);
                if (b && !b.ext && b.level < 20) low++;
            }
            return { a, n: list.length, c, low };
        });
        const sum = (k) => rows.reduce((n, r) => n + (k === 'n' ? r.n : k === 'low' ? r.low : r.c[k]), 0);
        return html`<div class="table-wrap"><table class="tbl"><thead><tr><th>Application</th><th class="num">Devices</th>${STATUSES.map((s) => html`<th class="num"><span class="status ${s.key}"></span>${s.label}</th>`)}<th class="num">Piles &lt; 20 %</th></tr></thead><tbody>
            ${rows.map((r) => html`<tr class="clickable" data-act="app" data-id="${r.a.id}"><td class="name">${r.a.name}</td><td class="num">${fmtNum(r.n)}</td>
                ${STATUSES.map((s) => html`<td class="num ${r.c[s.key] && (s.key === 'offline') ? 'err' : r.c[s.key] && s.key === 'inactive' ? 'warn' : ''}">${r.c[s.key] ? fmtNum(r.c[s.key]) : html`<span class="dim">·</span>`}</td>`)}
                <td class="num ${r.low ? 'err' : ''}">${r.low ? fmtNum(r.low) : html`<span class="dim">·</span>`}</td></tr>`)}
            <tr><td class="name">Total tenant</td><td class="num"><strong>${fmtNum(sum('n'))}</strong></td>${STATUSES.map((s) => html`<td class="num"><strong>${fmtNum(sum(s.key))}</strong></td>`)}<td class="num"><strong>${fmtNum(sum('low'))}</strong></td></tr>
        </tbody></table></div>`;
    }

    async function runScan() {
        const todo = session.apps.filter((a) => !cached(a.id));
        scan = { done: session.apps.length - todo.length, total: session.apps.length };
        draw();
        await api.pool(todo, 3, async (a) => {
            try { await devices(a.id); } catch { /* application illisible : ignorée */ }
            scan.done++;
            const el = alive && $('#h-tenant', root);
            if (el) render(el, tenantHealth());
        });
        scan = null;
        if (alive) draw();
    }

    function gatewaysSection() {
        if (gwError) return html`<p class="dim small">Gateways indisponibles : ${gwError}</p>`;
        if (!gateways) return html`<div class="skeleton" style="height:60px"></div>`;
        if (!gateways.length) return html`<p class="dim small">Aucune gateway dans ce tenant.</p>`;
        const by = { ONLINE: [], OFFLINE: [], NEVER_SEEN: [] };
        for (const g of gateways) (by[g.state] || by.NEVER_SEEN).push(g);
        const problems = [...by.OFFLINE, ...by.NEVER_SEEN];
        return html`
            <div class="kpis" style="grid-template-columns:repeat(3,1fr)">
                <div class="kpi is-ok"><div class="k-label"><span class="status active"></span>en ligne</div><div class="k-value">${by.ONLINE.length}</div><div class="k-sub">sur ${gateways.length}</div></div>
                <div class="kpi ${by.OFFLINE.length ? 'is-err' : ''}"><div class="k-label"><span class="status offline"></span>hors ligne</div><div class="k-value">${by.OFFLINE.length}</div></div>
                <div class="kpi"><div class="k-label"><span class="status never"></span>jamais vues</div><div class="k-value">${by.NEVER_SEEN.length}</div></div>
            </div>
            ${problems.length ? html`<div class="table-wrap mt" style="max-height:240px"><table class="tbl"><thead><tr><th>Gateway</th><th>ID</th><th>État</th><th>Dernier contact</th></tr></thead><tbody>
                ${problems.map((g) => html`<tr><td class="name">${g.name}</td><td class="eui">${g.gatewayId}</td>
                    <td><span class="status ${g.state === 'OFFLINE' ? 'offline' : 'never'}">${g.state === 'OFFLINE' ? 'Hors ligne' : 'Jamais vue'}</span></td>
                    <td class="dim small">${timeAgo(g.lastSeenAt)}</td></tr>`)}</tbody></table></div>` : ''}`;
    }

    function draw() {
        if (!alive) return;
        render(root, html`<div class="page">
            <div class="page-head">
                <div>
                    <div class="eyebrow">$ cs vue</div>
                    <h1>${session.app ? html`${session.app.name}` : html`${session.tenant?.name || 'Tenant'}`}</h1>
                    <p class="lede">${session.app ? html`Santé de l'application — tenant <strong>${session.tenant?.name}</strong>.` : 'Vue d\'ensemble du tenant.'}</p>
                </div>
                <div class="actions">
                    ${session.app ? html`<button class="btn" data-act="go" data-to="import">${icon('upload')} Importer</button>
                        <button class="btn btn-primary" data-act="go" data-to="devices">$ cs devices →</button>` : html`<button class="btn btn-primary" data-act="pickapp">Choisir une application</button>`}
                </div>
            </div>
            <section id="h-health">${appHealth()}</section>
            <h2 class="section-title">Applications <span class="dim">— ${session.tenant?.name}</span></h2>
            ${appsSection()}
            ${session.apps.length > 1 ? html`<h2 class="section-title">Santé par application <span class="dim">— tout le tenant</span></h2><section id="h-tenant">${tenantHealth()}</section>` : ''}
            <h2 class="section-title">Gateways <span class="dim">— état du réseau</span></h2>
            <section id="h-gw">${gatewaysSection()}</section>
        </div>`);
    }

    on(root, 'click', {
        filter: (el) => goFiltered(el.dataset.f),
        scan: () => runScan(),
        go: (el) => navigate(el.dataset.to),
        pickapp: (el) => appMenu(el),
        app: (el) => {
            const a = session.apps.find((x) => x.id === el.dataset.id);
            chooseApp(a, { go: 'devices' });
        },
        open: (el) => {
            session.pendingOpen = el.dataset.eui;
            navigate('devices');
        },
    });

    draw();

    if (session.app && !cached(session.app.id)) {
        devices(session.app.id, {
            onProgress: (n, t) => {
                const p = $('[data-progress]', root);
                if (p) p.textContent = `Chargement des devices… ${fmtNum(n)} / ${fmtNum(t)}`;
            },
        }).then(() => alive && draw()).catch((e) => {
            const h = $('#h-health', root);
            if (h) render(h, html`<div class="callout err">${icon('alert')}<div>${api.humanize(e)}</div></div>`);
        });
    }

    api.listAll(`/api/gateways?tenantId=${encodeURIComponent(session.tenant.id)}`)
        .then((g) => { gateways = g; })
        .catch((e) => { gwError = api.humanize(e); })
        .finally(() => {
            const el = alive && $('#h-gw', root);
            if (el) render(el, gatewaysSection());
        });

    const off1 = listen('counts', () => draw());
    const off2 = listen('context', () => draw());
    return () => { alive = false; off1(); off2(); };
}
