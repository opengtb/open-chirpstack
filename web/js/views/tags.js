// Mise à jour des tags depuis un fichier : aperçu des différences, puis envoi des seuls devices modifiés.

import * as api from '../api.js';
import * as ops from '../ops.js';
import { session, devices, patchDevices } from '../state.js';
import { $, html, render, icon, on, fmtNum, plural, bindDrop, confirmDialog, toast } from '../ui.js';
import { runJob } from '../jobs.js';
import { readFile, readPasted, autoMap, tagCandidates, normHex } from '../files.js';
import { isValidTagKey } from '../store.js';

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
            if (!eui) return { line: i + 2, eui, error: 'DevEUI vide' };
            if (!d) return { line: i + 2, eui, error: 'absent de cette application' };
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
                <h1>Tags par fichier — <em>${app.name}</em></h1>
                <p class="lede">Un fichier avec une colonne DevEUI et une colonne par tag. Vous voyez exactement ce qui change avant d'envoyer.</p>
            </div></div>
            <div class="stack" style="gap:1rem">
            <div class="card">
                <div class="card-head"><span class="tag-line">// 1 · fichier</span></div>
                <div class="drop" id="t-drop" tabindex="0" role="button">${icon('upload')}<div>Glissez un fichier ou <strong>cliquez pour parcourir</strong></div><div class="xs dim">CSV ou Excel · ou collez des cellules avec Ctrl+V n'importe où sur cette page</div></div>
                <input type="file" id="t-file" accept=".csv,.txt,.tsv,.xlsx,.xls,.ods" hidden>
                ${src ? html`<p class="hint mt">${icon('check')} <strong>${plural(src.rows.length, 'ligne')}</strong> · ${src.source}</p>` : ''}
            </div>
            ${src ? html`<div class="card">
                <div class="card-head"><span class="tag-line">// 2 · réglages</span></div>
                <div class="grid grid-2">
                    <div class="field"><label for="t-eui">Colonne DevEUI</label><select id="t-eui"><option value="">— choisir —</option>${src.headers.map((h) => html`<option value="${h}" ${euiCol === h ? 'selected' : ''}>${h}</option>`)}</select></div>
                    <div class="field"><span class="label">Mode</span><div class="seg"><label><input type="radio" name="tm" value="merge" ${mode === 'merge' ? 'checked' : ''}> Fusionner</label><label><input type="radio" name="tm" value="replace" ${mode === 'replace' ? 'checked' : ''}> Remplacer tous les tags</label></div>
                        <p class="hint">${mode === 'merge' ? 'Les tags absents du fichier sont conservés.' : html`<span class="warn">Les tags absents du fichier sont supprimés.</span>`}</p></div>
                </div>
                <div class="mt"><span class="label">Colonnes envoyées comme tags</span>
                    <div class="tags" style="gap:.4rem">${cols.map((c, i) => html`<label class="check badge" style="padding:.2rem .5rem"><input type="checkbox" data-col="${i}" ${c.checked ? 'checked' : ''}> ${c.key}</label>`)}</div>
                    <p class="hint">Les colonnes issues d'un export (nom, profil, clés, dates, statut…) sont décochées d'office : une clé ne doit jamais devenir un tag.</p>
                    ${badKeys.length ? html`<p class="err small">Nom de tag invalide : ${badKeys.map((c) => c.key).join(', ')}</p>` : ''}</div>
                <div class="mt"><span class="label">Case vide dans le fichier</span><div class="seg"><label><input type="radio" name="te" value="keep" ${empty === 'keep' ? 'checked' : ''}> Ne rien changer</label><label><input type="radio" name="te" value="remove" ${empty === 'remove' ? 'checked' : ''}> Supprimer le tag</label></div></div>
            </div>
            <div class="card">
                <div class="card-head"><span class="tag-line">// 3 · aperçu</span><label class="check small end"><input type="checkbox" id="t-all" ${showAll ? 'checked' : ''}> afficher aussi les lignes sans changement</label></div>
                ${!list ? html`<p class="hint">Chargement des devices de l'application…</p>` : !euiCol ? html`<p class="hint">Choisissez la colonne DevEUI.</p>` : html`
                <div class="kpis" style="grid-template-columns:repeat(3,1fr);margin-bottom:1rem">
                    <div class="kpi is-ok"><div class="k-label">à modifier</div><div class="k-value">${fmtNum(changed.length)}</div></div>
                    <div class="kpi"><div class="k-label">sans changement</div><div class="k-value">${fmtNum(rows.length - changed.length - errors.length)}</div></div>
                    <div class="kpi ${errors.length ? 'is-warn' : ''}"><div class="k-label">introuvables</div><div class="k-value">${fmtNum(errors.length)}</div></div>
                </div>
                <div class="table-wrap short"><table class="tbl"><thead><tr><th>ligne</th><th>Device</th><th>Changements</th></tr></thead><tbody>
                    ${shown.length ? shown.map((r) => html`<tr><td class="dim mono small">${r.line}</td>
                        <td class="name">${r.d ? r.d.name : html`<span class="mono">${r.eui || '—'}</span>`}${r.d ? html`<small class="mono">${r.eui}</small>` : ''}</td>
                        <td class="small">${r.error ? html`<span class="warn">${r.error}</span>` : r.changes.length ? r.changes.map((c) => html`<div><span class="mono">${c.k}</span> : ${c.from !== undefined ? html`<span class="diff-old">${c.from || '(vide)'}</span> ` : ''}${c.to !== undefined ? html`→ <span class="diff-new">${c.to || '(vide)'}</span>` : html`<span class="err">supprimé</span>`}</div>`) : html`<span class="dim">aucun</span>`}</td></tr>`)
                        : html`<tr><td colspan="3" class="empty">Aucun changement à appliquer.</td></tr>`}
                </tbody></table></div>
                <div class="row mt"><span class="grow"></span><button class="btn btn-primary btn-lg" data-act="run" ${changed.length && !badKeys.length ? '' : 'disabled'}>$ appliquer à ${plural(changed.length, 'device')} →</button></div>`}
            </div>` : ''}
            </div></div>`);
        const zone = $('#t-drop', root);
        bindDrop(zone, $('#t-file', root), async (file) => {
            try { setSource(await readFile(file)); } catch (e) { toast(`Lecture impossible : ${e.message}`, { type: 'err' }); }
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
                const ok = await confirmDialog({ title: 'Remplacer tous les tags ?', message: html`Sur <strong>${plural(changed.length, 'device')}</strong>, les tags absents du fichier seront supprimés.`, confirm: 'Remplacer', danger: true });
                if (!ok) return;
            }
            const patches = [];
            await runJob({
                title: `Tags — ${plural(changed.length, 'device')}`,
                verb: 'mis à jour',
                items: changed,
                label: (r) => r.d.name || r.eui,
                run: async (r) => {
                    // Recalcul sur les tags lus à l'instant sur le serveur (pas sur la liste en cache).
                    const dev = await ops.updateDevice(r.eui, (dv) => ({ ...dv, tags: apply(dv.tags, r.row, keys) }));
                    patches.push({ devEui: r.eui, tags: dev.tags });
                    return `${r.changes.length} changement(s)`;
                },
                after: () => [{ label: 'Voir les devices', onClick: () => navigate('devices') }],
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
