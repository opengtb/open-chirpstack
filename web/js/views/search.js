// Recherche dans tout le tenant : DevEUI complet ou partiel, nom, tag.

import * as api from '../api.js';
import * as ops from '../ops.js';
import { session, devices, cached, statusOf, statusInfo, appName } from '../state.js';
import { $, html, render, icon, on, fmtNum, plural, timeAgo, copy } from '../ui.js';
import { normHex, isHex } from '../files.js';
import { t, cmd } from '../i18n.js';

export function mount(root, { chooseApp }) {
    let alive = true;
    let q = session.pendingSearch || '';
    session.pendingSearch = undefined;
    let results = null;
    let progress = null;
    let runId = 0;

    function draw() {
        if (!alive) return;
        render(root, html`<div class="page">
            <div class="page-head"><div>
                <div class="eyebrow">$ cs ${cmd('recherche')}</div>
                <h1>${t('Rechercher dans')} <em>${session.tenant.name}</em></h1>
                <p class="lede">${t('Un DevEUI complet ou partiel (avec ou sans séparateurs), un nom, une valeur de tag. Toutes les applications du tenant sont parcourues.')}</p>
            </div></div>
            <form id="s-form" class="row" style="max-width:720px">
                <div class="search-input grow">${icon('search')}<input type="search" id="s-q" data-search value="${q}" placeholder="${t('70b3d5…, CO2-R+1, batiment=A…')}" autofocus spellcheck="false" aria-label="${t('Recherche')}"></div>
                <button class="btn btn-primary" type="submit">${t('$ chercher →')}</button>
            </form>
            <div id="s-out" class="mt">${output()}</div>
        </div>`);
        $('#s-form', root).addEventListener('submit', (e) => {
            e.preventDefault();
            q = $('#s-q', root).value.trim();
            search();
        });
        const input = $('#s-q', root);
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
    }

    function output() {
        if (progress) return html`<div class="row"><div class="grow progress"><i style="width:${progress.total ? (progress.done / progress.total) * 100 : 0}%"></i></div><span class="mono small">${progress.label}</span></div>`;
        if (!results) return html`<div class="callout">${icon('search')}<div>${t('Astuce :')} <kbd>Ctrl</kbd> <kbd>K</kbd> ${t('puis tapez un DevEUI, depuis n’importe quel écran.')}</div></div>`;
        if (!results.length) return html`<div class="empty-state"><h3>${t('Aucun résultat')}</h3><p>${t('Rien ne correspond à « {q} » dans les {apps} du tenant.', { q, apps: plural(session.apps.length, 'application') })}</p></div>`;
        return html`<p class="hint" style="margin-bottom:.5rem">${plural(results.length, t('résultat'), t('résultats'))}${results.length > 300 ? t(' — 300 premiers affichés') : ''}</p>
            <div class="table-wrap scroll"><table class="tbl"><thead><tr><th>${t('Nom')}</th><th>DevEUI</th><th>${t('Application')}</th><th>Device Profile</th><th>${t('Dernier message')}</th><th>${t('Statut')}</th></tr></thead><tbody>
            ${results.slice(0, 300).map((r) => {
                const st = statusOf(r.d);
                const local = session.apps.some((a) => a.id === r.appId);
                return html`<tr class="${local ? 'clickable' : ''}" ${local ? html`data-act="open"` : ''} data-eui="${r.d.devEui}" data-app="${r.appId}">
                    <td class="name">${r.d.name}${r.why ? html`<small>${r.why}</small>` : ''}</td>
                    <td class="eui nowrap">${r.d.devEui}<button class="btn btn-ghost btn-xs copy" data-act="copy" data-v="${r.d.devEui}" title="${t('Copier')}">${icon('copy')}</button></td>
                    <td class="small">${local ? appName(r.appId) : html`<span class="dim">${t('autre tenant')}</span>`}</td>
                    <td class="small ellipsis">${r.d.deviceProfileName || ''}</td>
                    <td class="small nowrap">${timeAgo(r.d.lastSeenAt)}</td>
                    <td><span class="status ${st}">${statusInfo(st).one}</span></td></tr>`;
            })}</tbody></table></div>`;
    }

    function drawOut() {
        const el = $('#s-out', root);
        if (el && alive) render(el, output());
    }

    function matcher(query) {
        const low = query.toLowerCase();
        const hex = normHex(query);
        const [tk, ...tv] = query.split('=');
        const tagMode = tv.length > 0;
        return (d) => {
            if (tagMode) {
                const key = tk.trim().toLowerCase();
                const val = tv.join('=').trim().toLowerCase();
                const hit = Object.entries(d.tags || {}).find(([k, v]) => k.toLowerCase() === key && String(v).toLowerCase().includes(val));
                return hit ? t('tag {k}={v}', { k: hit[0], v: hit[1] }) : null;
            }
            if (hex.length >= 3 && /^[0-9a-f]+$/.test(hex) && d.devEui.includes(hex)) return '';
            if ((d.name || '').toLowerCase().includes(low)) return '';
            if ((d.description || '').toLowerCase().includes(low)) return t('description : {d}', { d: d.description });
            const tag = Object.entries(d.tags || {}).find(([, v]) => String(v).toLowerCase().includes(low));
            return tag ? t('tag {k}={v}', { k: tag[0], v: tag[1] }) : null;
        };
    }

    async function search() {
        const id = ++runId;
        results = null;
        if (!q) return drawOut();
        const hex = normHex(q);
        // DevEUI complet : une seule requête suffit.
        if (isHex(hex, 16)) {
            progress = { done: 0, total: 1, label: t('recherche directe…') };
            drawOut();
            try {
                const r = await ops.findDevice(hex);
                if (id !== runId) return;
                const d = r ? { ...r.device, lastSeenAt: r.lastSeenAt, createdAt: r.createdAt, deviceStatus: r.deviceStatus, deviceProfileName: session.deviceProfiles.find((p) => p.id === r.device.deviceProfileId)?.name || '' } : null;
                results = d ? [{ d, appId: d.applicationId }] : [];
                if (d && !session.apps.some((a) => a.id === d.applicationId)) results[0].why = t('dans un autre tenant');
            } catch (e) {
                results = [];
                progress = null;
                render($('#s-out', root), html`<div class="callout err">${icon('alert')}<div>${api.humanize(e)}</div></div>`);
                return;
            }
            progress = null;
            return drawOut();
        }
        // Sinon : parcours des applications (listes mises en cache pour les écrans suivants).
        const match = matcher(q);
        const found = [];
        const apps = session.apps;
        progress = { done: 0, total: apps.length, label: t('{done} / {total} applications', { done: 0, total: apps.length }) };
        drawOut();
        await api.pool(apps, 3, async (a) => {
            if (id !== runId) return;
            try {
                const list = cached(a.id) || await devices(a.id);
                for (const d of list) {
                    const why = match(d);
                    if (why !== null) found.push({ d, appId: a.id, why });
                }
            } catch {
                /* application illisible : ignorée */
            }
            if (id !== runId) return;
            progress.done++;
            progress.label = t('{done} / {total} applications · {n} trouvé(s)', { done: progress.done, total: apps.length, n: fmtNum(found.length) });
            drawOut();
        });
        if (id !== runId) return;
        progress = null;
        results = found.sort((x, y) => (x.d.name || '').localeCompare(y.d.name || ''));
        drawOut();
    }

    on(root, 'click', {
        copy: (el, e) => { e.stopPropagation(); copy(el.dataset.v); },
        open: (el, e) => {
            if (e.target.closest('button')) return;
            const a = session.apps.find((x) => x.id === el.dataset.app);
            if (!a) return;
            session.pendingOpen = el.dataset.eui;
            chooseApp(a, { go: 'devices' });
        },
    });

    draw();
    if (q) search();
    return () => { alive = false; runId++; };
}
