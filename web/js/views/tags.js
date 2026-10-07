// Mise à jour des tags depuis un fichier : aperçu des différences, puis envoi des seuls devices modifiés.

import * as api from '../api.js';
import * as ops from '../ops.js';
import { session, devices, patchDevices } from '../state.js';
import { $, html, render, icon, on, fmtNum, plural, bindDrop, confirmDialog, toast } from '../ui.js';
import { runJob } from '../jobs.js';
import { readFile, readPasted, autoMap, tagCandidates, normHex } from '../files.js';
import { isValidTagKey } from '../store.js';
import { t } from '../i18n.js';

export function mount(root, { navigate }) {
    const app = session.app;
    let alive = true;
    let src = null;
    let euiCol = '';
    let cols = [];
    let mode = 'merge'; // merge | replace
    let empty = 'keep'; // keep | remove
    let list = null;
    let showAll = false;

    // Calcule les tags après application d'une ligne du fichier.
    function apply(current, row, keys) {
        const out = mode === 'replace' ? {} : { ...current };
        for (const c of keys) {
            const v = String(row[c.column] ?? '').trim();
            if (v !== '') out[c.key] = v;
            else if (empty === 'remove') delete out[c.key];
        }
        return out;
    }

    function diff() {
        if (!src || !euiCol || !list) return [];
        const byEui = new Map(list.map((d) => [d.devEui, d]));
        const keys = cols.filter((c) => c.checked);
        return src.rows.map((r, i) => {
            const eui = normHex(r[euiCol]);
            const d = byEui.get(eui);
            if (!eui) return { line: i + 2, eui, error: t('DevEUI vide') };
            if (!d) return { line: i + 2, eui, error: t('absent de cette application') };
            const before = { ...(d.tags || {}) };
            const after = apply(before, r, keys);
            const changes = [];
            for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
                if (before[k] !== after[k]) changes.push({ k, from: before[k], to: after[k] });
            }
            return { line: i + 2, eui, d, row: r, after, changes };
        });
    }

    function draw() {
        if (!alive) return;
        const rows = diff();
        const changed = rows.filter((r) => r.changes?.length);
        const errors = rows.filter((r) => r.error);
        const badKeys = cols.filter((c) => c.checked && !isValidTagKey(c.key));
        const shown = (showAll ? rows : [...errors, ...changed]).slice(0, 400);
        render(root, html`<div class="page narrow" style="max-width:1000px">
            <div class="page-head"><div>
                <div class="eyebrow">$ cs tags</div>
                <h1>${t('Tags par fichier')} — <em>${app.name}</em></h1>
                <p class="lede">${t('Un fichier avec une colonne DevEUI et une colonne par tag. Vous voyez exactement ce qui change avant d’envoyer.')}</p>
            </div></div>
            <div class="stack" style="gap:1rem">
            <div class="card">
                <div class="card-head"><span class="tag-line">// 1 · ${t('fichier')}</span></div>
                <div class="drop" id="t-drop" tabindex="0" role="button" aria-label="${t('Choisir un fichier')}">${icon('upload')}<div>${t('Glissez un fichier ou')} <strong>${t('cliquez pour parcourir')}</strong></div><div class="xs dim">${t('CSV ou Excel · ou collez des cellules avec Ctrl+V n’importe où sur cette page')}</div></div>
                <input type="file" id="t-file" accept=".csv,.txt,.tsv,.xlsx,.xls,.ods" hidden>
                ${src ? html`<p class="hint mt">${icon('check')} <strong>${plural(src.rows.length, t('ligne'))}</strong> · ${src.source}</p>` : ''}
            </div>
            ${src ? html`<div class="card">
                <div class="card-head"><span class="tag-line">// 2 · ${t('réglages')}</span></div>
                <div class="grid grid-2">
                    <div class="field"><label for="t-eui">${t('Colonne DevEUI')}</label><select id="t-eui"><option value="">${t('— choisir —')}</option>${src.headers.map((h) => html`<option value="${h}" ${euiCol === h ? 'selected' : ''}>${h}</option>`)}</select></div>
                    <div class="field"><span class="label">${t('Mode')}</span><div class="seg"><label><input type="radio" name="tm" value="merge" ${mode === 'merge' ? 'checked' : ''}> ${t('Fusionner')}</label><label><input type="radio" name="tm" value="replace" ${mode === 'replace' ? 'checked' : ''}> ${t('Remplacer tous les tags')}</label></div>
                        <p class="hint">${mode === 'merge' ? t('Les tags absents du fichier sont conservés.') : html`<span class="warn">${t('Les tags absents du fichier sont supprimés.')}</span>`}</p></div>
                </div>
                <div class="mt"><span class="label">${t('Colonnes envoyées comme tags')}</span>
                    <div class="tags" style="gap:.4rem">${cols.map((c, i) => html`<label class="check badge" style="padding:.2rem .5rem"><input type="checkbox" data-col="${i}" ${c.checked ? 'checked' : ''}> ${c.key}</label>`)}</div>
                    <p class="hint">${t('Les colonnes issues d’un export (nom, profil, clés, dates, statut…) sont décochées d’office : une clé ne doit jamais devenir un tag.')}</p>
                    ${badKeys.length ? html`<p class="err small">${t('Nom de tag invalide : {keys}', { keys: badKeys.map((c) => c.key).join(', ') })}</p>` : ''}</div>
                <div class="mt"><span class="label">${t('Case vide dans le fichier')}</span><div class="seg"><label><input type="radio" name="te" value="keep" ${empty === 'keep' ? 'checked' : ''}> ${t('Ne rien changer')}</label><label><input type="radio" name="te" value="remove" ${empty === 'remove' ? 'checked' : ''}> ${t('Supprimer le tag')}</label></div></div>
            </div>
            <div class="card">
                <div class="card-head"><span class="tag-line">// 3 · ${t('aperçu')}</span><label class="check small end"><input type="checkbox" id="t-all" ${showAll ? 'checked' : ''}> ${t('afficher aussi les lignes sans changement')}</label></div>
                ${!list ? html`<p class="hint">${t('Chargement des devices de l’application…')}</p>` : !euiCol ? html`<p class="hint">${t('Choisissez la colonne DevEUI.')}</p>` : html`
                <div class="kpis" style="grid-template-columns:repeat(3,1fr);margin-bottom:1rem">
                    <div class="kpi is-ok"><div class="k-label">${t('à modifier')}</div><div class="k-value">${fmtNum(changed.length)}</div></div>
                    <div class="kpi"><div class="k-label">${t('sans changement')}</div><div class="k-value">${fmtNum(rows.length - changed.length - errors.length)}</div></div>
                    <div class="kpi ${errors.length ? 'is-warn' : ''}"><div class="k-label">${t('introuvables')}</div><div class="k-value">${fmtNum(errors.length)}</div></div>
                </div>
                <div class="table-wrap short"><table class="tbl"><thead><tr><th>${t('ligne')}</th><th>${t('Device')}</th><th>${t('Changements')}</th></tr></thead><tbody>
                    ${shown.length ? shown.map((r) => html`<tr><td class="dim mono small">${r.line}</td>
                        <td class="name">${r.d ? r.d.name : html`<span class="mono">${r.eui || '—'}</span>`}${r.d ? html`<small class="mono">${r.eui}</small>` : ''}</td>
                        <td class="small">${r.error ? html`<span class="warn">${r.error}</span>` : r.changes.length ? r.changes.map((c) => html`<div><span class="mono">${c.k}</span> : ${c.from !== undefined ? html`<span class="diff-old">${c.from || t('(vide)')}</span> ` : ''}${c.to !== undefined ? html`→ <span class="diff-new">${c.to || t('(vide)')}</span>` : html`<span class="err">${t('supprimé')}</span>`}</div>`) : html`<span class="dim">${t('aucun')}</span>`}</td></tr>`)
                        : html`<tr><td colspan="3" class="empty">${t('Aucun changement à appliquer.')}</td></tr>`}
                </tbody></table></div>
                <div class="row mt"><span class="grow"></span><button class="btn btn-primary btn-lg" data-act="run" ${changed.length && !badKeys.length ? '' : 'disabled'}>$ ${t('appliquer à {n}', { n: plural(changed.length, t('device')) })} →</button></div>`}
            </div>` : ''}
            </div></div>`);
        const zone = $('#t-drop', root);
        bindDrop(zone, $('#t-file', root), async (file) => {
            try { setSource(await readFile(file)); } catch (e) { toast(t('Lecture impossible : {msg}', { msg: e.message }), { type: 'err' }); }
        });
    }

    function setSource(data) {
        src = data;
        const m = autoMap(src.headers);
        euiCol = m.dev_eui || '';
        cols = tagCandidates(src.headers, { dev_eui: euiCol, name: m.name, description: m.description, device_profile: m.device_profile, key: m.key, app_key_11: m.app_key_11, join_eui: m.join_eui });
        draw();
    }

    root.addEventListener('change', (e) => {
        const t = e.target;
        if (t.id === 't-eui') {
            euiCol = t.value;
            const prev = cols;
            cols = tagCandidates(src.headers, { ...autoMap(src.headers), dev_eui: euiCol }).map((c) => ({ ...c, checked: prev.find((p) => p.column === c.column)?.checked ?? c.checked }));
        }
        if (t.dataset.col !== undefined) cols[Number(t.dataset.col)].checked = t.checked;
        if (t.name === 'tm') mode = t.value;
        if (t.name === 'te') empty = t.value;
        if (t.id === 't-all') showAll = t.checked;
        draw();
    });

    const onPaste = (e) => {
        if (!alive || /^(INPUT|TEXTAREA)$/.test(e.target.tagName)) return;
        const text = e.clipboardData.getData('text');
        if (!text.includes('\n')) return;
        try { setSource(readPasted(text)); } catch (err) { toast(err.message, { type: 'err' }); }
    };
    document.addEventListener('paste', onPaste);

    on(root, 'click', {
        run: async () => {
            const all = diff();
            const keys = cols.filter((c) => c.checked);
            // Un DevEUI présent plusieurs fois : seule sa dernière ligne compte (évite deux écritures concurrentes).
            const last = new Map();
            for (const r of all) if (r.changes?.length) last.set(r.eui, r);
            const changed = [...last.values()];
            if (mode === 'replace') {
                const ok = await confirmDialog({ title: t('Remplacer tous les tags ?'), message: html`${t('Sur')} <strong>${plural(changed.length, t('device'))}</strong>, ${t('les tags absents du fichier seront supprimés.')}`, confirm: t('Remplacer'), danger: true });
                if (!ok) return;
            }
            const patches = [];
            await runJob({
                title: t('Tags — {n}', { n: plural(changed.length, t('device')) }),
                verb: t('mis à jour'),
                items: changed,
                label: (r) => r.d.name || r.eui,
                run: async (r) => {
                    // Recalcul sur les tags lus à l'instant sur le serveur (pas sur la liste en cache).
                    const dev = await ops.updateDevice(r.eui, (dv) => ({ ...dv, tags: apply(dv.tags, r.row, keys) }));
                    patches.push({ devEui: r.eui, tags: dev.tags });
                    return t('{n} changement(s)', { n: r.changes.length });
                },
                after: () => [{ label: t('Voir les devices'), onClick: () => navigate('devices') }],
            });
            patchDevices(app.id, patches);
            draw();
        },
    });

    draw();
    devices(app.id).then((l) => { list = l; draw(); }).catch((e) => toast(api.humanize(e), { type: 'err' }));
    return () => {
        alive = false;
        document.removeEventListener('paste', onPaste);
    };
}
