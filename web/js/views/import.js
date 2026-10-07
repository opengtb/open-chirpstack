// Import de devices : fichier (CSV/Excel), copier-coller depuis un tableur, saisie directe, ou restauration d'une sauvegarde.

import * as api from '../api.js';
import * as ops from '../ops.js';
import * as store from '../store.js';
import { session, devices, cached, invalidate, appName } from '../state.js';
import { $, $$, html, render, icon, on, debounce, fmtNum, plural, toast, openDialog, download, bindDrop, today, slug } from '../ui.js';
import { runJob } from '../jobs.js';
import { readFile, readPasted, FIELDS, autoMap, tagCandidates, normHex, isHex, toCSV, toXLSX } from '../files.js';
import { t, locale } from '../i18n.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MANUAL_COLS = ['dev_eui', 'name', 'app_key', 'description'];

export function mount(root, { navigate }) {
    const app = session.app;
    let alive = true;

    // Source chargée
    let src = null; // { headers, rows, numeric, source, kind }
    let tab = 'file';
    // Configuration
    let mapping = {};
    let tagCols = []; // [{ column, key, checked }]
    const fixedTags = [];
    let defaultDp = '';
    let importProfileId = '';
    const reqTagSource = {}; // tag -> { column } | { value }
    let dupMode = 'skip'; // skip | update
    let onlyErrors = false;
    let manualRows = Array.from({ length: 5 }, () => ({ dev_eui: '', name: '', app_key: '', description: '' }));

    // Derniers réglages utilisés pour cette application (gain de temps à l'import suivant).
    const remembered = store.prefs().importDefaults?.[app.id] || {};
    if (session.deviceProfiles.some((p) => p.id === remembered.dp)) defaultDp = remembered.dp;
    if (store.profiles().some((p) => p.id === remembered.profile)) importProfileId = remembered.profile;
    if (remembered.dup === 'update') dupMode = 'update';
    const remember = () => {
        const all = store.prefs().importDefaults || {};
        store.setPrefs({ importDefaults: { ...all, [app.id]: { dp: defaultDp, profile: importProfileId, dup: dupMode } } });
    };
    let existing = null; // Set des DevEUI déjà présents dans l'application

    const importProfile = () => store.profiles().find((p) => p.id === importProfileId) || null;
    const dpByName = () => {
        const m = new Map();
        for (const p of session.deviceProfiles) m.set(p.name.trim().toLowerCase(), p);
        return m;
    };

    // ---------- Construction et validation des lignes ----------
    function build() {
        if (!src) return [];
        const byName = dpByName();
        const prof = importProfile();
        const seen = new Map();
        const tagDefs = tagCols.filter((t) => t.checked);
        return src.rows.map((r, i) => {
            const line = r._line ?? i + 2;
            const exists = (eui) => !!(eui && existing?.has(eui));
            const errors = [];
            const warns = [];
            const cell = (field) => (mapping[field] ? r[mapping[field]] ?? '' : '');
            const numeric = (field) => mapping[field] && src.numeric?.has(`${i}|${mapping[field]}`);

            const devEui = normHex(cell('dev_eui'));
            if (!devEui) errors.push(['dev_eui', t('DevEUI manquant')]);
            else if (numeric('dev_eui')) errors.push(['dev_eui', t('cellule Excel au format nombre : la valeur a pu être altérée, passez la colonne au format Texte')]);
            else if (!isHex(devEui, 16)) errors.push(['dev_eui', t('DevEUI invalide ({n} caractères, 16 hexadécimaux attendus)', { n: devEui.length })]);
            else if (seen.has(devEui)) errors.push(['dev_eui', t('DevEUI en double (déjà ligne {line})', { line: seen.get(devEui) })]);
            if (devEui && !seen.has(devEui)) seen.set(devEui, line);

            const nwkKey = normHex(cell('key'));
            if (nwkKey && numeric('key')) errors.push(['key', t('cellule Excel au format nombre : passez la colonne au format Texte')]);
            else if (nwkKey && !isHex(nwkKey, 32)) errors.push(['key', t('clé invalide ({n} caractères, 32 hexadécimaux attendus)', { n: nwkKey.length })]);
            const appKey = normHex(cell('app_key_11'));
            if (appKey && !isHex(appKey, 32)) errors.push(['app_key_11', t('AppKey 1.1 invalide (32 hexadécimaux attendus)')]);
            const joinEui = normHex(cell('join_eui'));
            if (joinEui && !isHex(joinEui, 16)) errors.push(['join_eui', t('JoinEUI invalide (16 hexadécimaux attendus)')]);

            const dpRaw = String(cell('device_profile')).trim();
            let dp = null;
            if (dpRaw) {
                dp = UUID.test(dpRaw) ? session.deviceProfiles.find((p) => p.id === dpRaw.toLowerCase()) : byName.get(dpRaw.toLowerCase());
                if (!dp) {
                    const low = dpRaw.toLowerCase();
                    const close = session.deviceProfiles.filter((p) => p.name.toLowerCase().includes(low) || low.includes(p.name.toLowerCase()));
                    errors.push(['device_profile', close.length === 1
                        ? t('Device Profile inconnu : « {dp} » — vouliez-vous dire « {guess} » ?', { dp: dpRaw, guess: close[0].name })
                        : t('Device Profile inconnu : « {dp} »', { dp: dpRaw })]);
                }
            } else if (defaultDp) dp = session.deviceProfiles.find((p) => p.id === defaultDp);
            // Device existant mis à jour : sans profil indiqué, il garde le sien.
            else if (!(exists(devEui) && dupMode === 'update')) errors.push(['device_profile', t('Device Profile manquant : choisissez-en un par défaut')]);

            const tags = {};
            for (const t of tagDefs) {
                const v = String(r[t.column] ?? '').trim();
                if (v !== '') tags[t.key] = v;
            }
            for (const ft of fixedTags) if (ft.key) tags[ft.key] = ft.value;
            if (prof) {
                for (const tag of prof.requiredTags) {
                    const s = reqTagSource[tag] || {};
                    const v = s.column ? String(r[s.column] ?? '').trim() : String(s.value ?? '').trim();
                    if (v) tags[tag] = v;
                    else errors.push([`tag:${tag}`, t('tag obligatoire « {tag} » vide', { tag })]);
                }
            }

            const rawName = String(cell('name')).trim();
            const name = rawName || devEui;
            if (!rawName) warns.push(t('nom absent : le DevEUI sera utilisé'));
            // Pour une mise à jour, seuls les champs réellement fournis par le fichier sont transmis.
            const description = mapping.description ? String(cell('description')).trim() : undefined;
            return { line, devEui, name, rawName, description, dp, dpFromCol: !!dpRaw, nwkKey, appKey, joinEui, tags, errors, warns, exists: exists(devEui) };
        });
    }

    // ---------- Rendu ----------
    function head() {
        return html`<div class="page-head">
            <div>
                <div class="eyebrow">$ cs import</div>
                <h1>${t('Importer dans')} <em>${app.name}</em></h1>
                <p class="lede">${t('Fichier, copier-coller depuis Excel ou saisie directe. Tout est vérifié avant le moindre envoi.')}</p>
            </div>
            <div class="actions"><button class="btn" data-act="template">${icon('file')} ${t('Modèle à remplir')}</button></div>
        </div>`;
    }

    function sourceCard() {
        const tabs = [['file', 'Fichier', 'upload'], ['paste', 'Coller depuis Excel', 'paste'], ['manual', 'Saisie directe', 'edit']];
        return html`<div class="card">
            <div class="card-head"><span class="tag-line">// 1 · ${t('source')}</span>
                <div class="seg end">${tabs.map(([k, l, ic]) => html`<button class="${tab === k ? 'on' : ''}" data-act="tab" data-v="${k}">${icon(ic)} ${t(l)}</button>`)}</div></div>
            ${tab === 'file' ? html`
                <div class="drop" id="i-drop" tabindex="0" role="button" aria-label="${t('Choisir un fichier')}">
                    ${icon('upload')}
                    <div>${t('Glissez un fichier ici ou')} <strong>${t('cliquez pour parcourir')}</strong></div>
                    <div class="xs dim">${t('CSV (tout séparateur, UTF-8 ou Windows-1252), Excel .xlsx / .xls / .ods, sauvegarde .json')}</div>
                </div>
                <input type="file" id="i-file" accept=".csv,.txt,.tsv,.xlsx,.xls,.xlsm,.ods,.json" hidden>`
            : tab === 'paste' ? html`
                <textarea id="i-paste" rows="8" placeholder="${t('Copiez des cellules dans Excel (avec la ligne d’en-têtes) puis collez-les ici : Ctrl+V') + '\n\ndev_eui\tname\tapp_key\n70b3d52dd3000001\t' + t('Capteur salle 101') + '\t2b7e151628aed2a6abf7158809cf4f3c'}"></textarea>
                <div class="row mt-s"><span class="hint grow">${t('Les colonnes sont reconnues automatiquement (dev_eui, nom, profil, clé, tags…).')}</span><button class="btn btn-primary" data-act="parse-paste">${t('Analyser')} →</button></div>`
            : html`
                <div class="table-wrap"><table class="tbl" id="i-manual">
                    <thead><tr><th>#</th><th>DevEUI *</th><th>${t('Nom')}</th><th>AppKey</th><th>${t('Description')}</th><th></th></tr></thead>
                    <tbody>${manualRows.map((r, i) => html`<tr data-i="${i}"><td class="dim mono small">${i + 1}</td>
                        ${MANUAL_COLS.map((c) => html`<td><input type="text" class="${c === 'dev_eui' || c === 'app_key' ? 'mono' : ''}" data-c="${c}" value="${r[c]}" spellcheck="false" placeholder="${c === 'dev_eui' ? '16 hex' : c === 'app_key' ? t('32 hex (optionnel)') : ''}"></td>`)}
                        <td><button class="btn btn-ghost btn-icon" data-act="mrow-del" data-i="${i}" aria-label="${t('Retirer')}">${icon('x')}</button></td></tr>`)}</tbody>
                </table></div>
                <div class="row mt-s"><button class="btn btn-sm" data-act="mrow-add">${icon('plus')} ${t('5 lignes')}</button><span class="hint grow">${t('Astuce : vous pouvez coller une colonne entière de DevEUI dans la première case.')}</span></div>`}
            ${src ? html`<p class="hint mt">${icon('check')} <strong>${plural(src.rows.length, t('ligne'))}</strong> · ${src.kind === 'manual' ? t('saisie directe') : src.source} · <button class="btn-link" data-act="reset">${t('recommencer')}</button></p>` : ''}
        </div>`;
    }

    function configCard() {
        if (!src) return '';
        const prof = importProfile();
        const profiles = store.profiles();
        const dps = [...session.deviceProfiles].sort((a, b) => a.name.localeCompare(b.name));
        const mappedSummary = FIELDS.filter((f) => mapping[f.key]).map((f) => html`<span class="badge">${t(f.label)} ← <strong>${mapping[f.key]}</strong></span>`);
        const missingReq = !mapping.dev_eui;
        return html`<div class="card">
            <div class="card-head"><span class="tag-line">// 2 · ${t('réglages')}</span></div>
            <div class="grid grid-2">
                <div class="field">
                    <label for="i-dp">${t('Device Profile par défaut')}</label>
                    <select id="i-dp"><option value="">${mapping.device_profile ? t('— pris dans la colonne —') : t('— choisir —')}</option>${dps.map((p) => html`<option value="${p.id}" ${defaultDp === p.id ? 'selected' : ''}>${p.name}</option>`)}</select>
                    <p class="hint">${mapping.device_profile ? html`${t('Colonne')} <strong>${mapping.device_profile}</strong> : ${t('nom ou ID du profil. Le défaut s’applique aux cases vides.')}` : t('Appliqué à toutes les lignes.')}</p>
                </div>
                <div class="field">
                    <label for="i-prof">${t('Profil d’import (tags obligatoires)')}</label>
                    <div class="row"><select id="i-prof" class="grow"><option value="">${t('Aucun')}</option>${profiles.map((p) => html`<option value="${p.id}" ${importProfileId === p.id ? 'selected' : ''}>${p.name} (${plural(p.requiredTags.length, t('tag'))})</option>`)}</select>
                        <button class="btn btn-ghost btn-sm" data-act="profiles" title="${t('Gérer les profils d’import')}">${icon('settings')}</button></div>
                    <p class="hint">${t('Garantit que chaque device reçoit les tags attendus par vos intégrations.')}</p>
                </div>
            </div>

            ${prof && prof.requiredTags.length ? html`<div class="mt"><span class="label">${t('Tags obligatoires — {name}', { name: prof.name })}</span>
                <div class="stack" style="gap:.4rem">${prof.requiredTags.map((tg) => {
                    const s = reqTagSource[tg] || {};
                    return html`<div class="row"><span class="mono small" style="min-width:140px">${tg}</span>
                        <select class="sm" data-req-col="${tg}" style="max-width:240px"><option value="">${t('valeur fixe')} →</option>${src.headers.map((h) => html`<option value="${h}" ${s.column === h ? 'selected' : ''}>${t('colonne « {col} »', { col: h })}</option>`)}</select>
                        <input type="text" class="sm" data-req-val="${tg}" value="${s.value || ''}" placeholder="${t('valeur pour tous')}" ${s.column ? 'hidden' : ''}></div>`;
                })}</div></div>` : ''}

            <details class="more mt" ${missingReq ? 'open' : ''}>
                <summary>${t('colonnes :')} ${missingReq ? html`<span class="err">${t('DevEUI non trouvé, à indiquer')}</span>` : mappedSummary}</summary>
                <div class="mapping">${FIELDS.map((fd) => html`<div class="field" style="margin:0"><label class="${fd.required ? 'req' : ''}">${t(fd.label)}</label>
                    <select class="sm" data-map="${fd.key}"><option value="">${t('— aucune —')}</option>${src.headers.map((h) => html`<option value="${h}" ${mapping[fd.key] === h ? 'selected' : ''}>${h}</option>`)}</select></div>`)}</div>
            </details>

            <div class="mt">
                <span class="label">${t('Tags')}</span>
                ${tagCols.length ? html`<div class="tags" style="gap:.4rem">${tagCols.map((t, i) => html`<label class="check badge" style="padding:.2rem .5rem"><input type="checkbox" data-tagcol="${i}" ${t.checked ? 'checked' : ''}> ${t.key}${t.key !== t.column ? html` <span class="dim">(${t.column})</span>` : ''}</label>`)}</div>
                    <p class="hint">${t('Colonnes du fichier envoyées comme tags (décochez celles à ignorer).')}</p>` : html`<p class="hint">${t('Aucune autre colonne dans le fichier.')}</p>`}
                <div class="stack mt-s" style="gap:.4rem" id="i-fixed">${fixedTags.map((ft, i) => html`<div class="row"><input type="text" class="sm mono" placeholder="${t('clé')}" value="${ft.key}" data-fk="${i}" style="max-width:200px"><span class="dim">=</span><input type="text" class="sm" placeholder="${t('valeur pour tous')}" value="${ft.value}" data-fv="${i}"><button class="btn btn-ghost btn-icon" data-act="fixed-del" data-i="${i}" aria-label="${t('Retirer')}">${icon('x')}</button></div>`)}</div>
                <button class="btn btn-sm mt-s" data-act="fixed-add">${icon('plus')} ${t('Tag fixe pour tous')}</button>
            </div>

            <div class="mt"><span class="label">${t('Si le DevEUI existe déjà dans l’application')}</span>
                <div class="seg"><label><input type="radio" name="dup" value="skip" ${dupMode === 'skip' ? 'checked' : ''}> ${t('L’ignorer')}</label><label><input type="radio" name="dup" value="update" ${dupMode === 'update' ? 'checked' : ''}> ${t('Le mettre à jour')}</label></div>
                <p class="hint">${t('« Mettre à jour » ne modifie que ce que le fichier contient (nom, description, profil, tags fusionnés, clés) ; le profil par défaut ne s’applique qu’aux nouveaux devices. Le device n’est jamais supprimé : historique et session sont conservés.')}</p></div>
        </div>`;
    }

    function checkCard(rows) {
        if (!src) return '';
        const errs = rows.filter((r) => r.errors.length);
        const valid = rows.filter((r) => !r.errors.length);
        const exist = valid.filter((r) => r.exists);
        const create = valid.filter((r) => !r.exists);
        const willUpdate = dupMode === 'update' ? exist.length : 0;
        const willSkip = dupMode === 'skip' ? exist.length : 0;
        const toSend = create.length + willUpdate;
        const errFields = new Set();
        const show = (onlyErrors ? errs : rows).slice(0, 500);
        const keyCols = mapping.key || mapping.app_key_11;
        const tagKeys = [...new Set(rows.flatMap((r) => Object.keys(r.tags)))];
        for (const r of errs) for (const [f] of r.errors) errFields.add(f);
        const cellCls = (r, f) => (r.errors.some(([ef]) => ef === f) ? 'cell-err' : '');

        return html`<div class="card">
            <div class="card-head"><span class="tag-line">// 3 · ${t('vérification')}</span>
                <span class="end row">${errs.length ? html`<label class="check small"><input type="checkbox" id="i-onlyerr" ${onlyErrors ? 'checked' : ''}> ${t('erreurs seulement')}</label>
                    <button class="btn btn-sm" data-act="errors-csv">${icon('download')} ${t('erreurs')}</button>` : ''}</span></div>
            <div class="kpis" style="grid-template-columns:repeat(4,1fr);margin-bottom:1rem">
                <div class="kpi is-ok"><div class="k-label">${t('à créer')}</div><div class="k-value">${fmtNum(create.length)}</div></div>
                <div class="kpi"><div class="k-label">${t('existants')}</div><div class="k-value">${fmtNum(exist.length)}</div><div class="k-sub">${dupMode === 'update' ? t('mis à jour') : t('ignorés')}</div></div>
                <div class="kpi ${errs.length ? 'is-err' : ''}"><div class="k-label">${t('en erreur')}</div><div class="k-value">${fmtNum(errs.length)}</div><div class="k-sub">${errs.length ? t('non envoyés') : t('aucune')}</div></div>
                <div class="kpi"><div class="k-label">${t('tags')}</div><div class="k-value">${fmtNum(tagKeys.length)}</div><div class="k-sub">${tagKeys.slice(0, 3).join(', ')}${tagKeys.length > 3 ? '…' : ''}</div></div>
            </div>
            ${existing === null ? html`<p class="hint">${t('Vérification des doublons en cours…')}</p>` : ''}
            <div class="table-wrap short"><table class="tbl">
                <thead><tr><th>${t('ligne')}</th><th>DevEUI</th><th>${t('Nom')}</th><th>Device Profile</th>${keyCols ? html`<th>${t('Clé')}</th>` : ''}<th>${t('Tags')}</th><th>${t('Résultat')}</th></tr></thead>
                <tbody>${show.length ? show.map((r) => html`<tr>
                    <td class="dim mono small">${r.line}</td>
                    <td class="eui ${cellCls(r, 'dev_eui')}">${r.devEui || '—'}</td>
                    <td class="ellipsis">${r.name}</td>
                    <td class="ellipsis small ${cellCls(r, 'device_profile')}">${r.dp?.name || (r.exists ? html`<span class="dim">${t('inchangé')}</span>` : '—')}</td>
                    ${keyCols ? html`<td class="eui small nowrap ${cellCls(r, 'key')}">${r.nwkKey ? r.nwkKey.slice(0, 6) + '…' + r.nwkKey.slice(-4) : '—'}</td>` : ''}
                    <td>${Object.keys(r.tags).length ? html`<div class="tags">${Object.entries(r.tags).slice(0, 3).map(([k, v]) => html`<span class="tag"><span class="k">${k}</span><span class="v">${v}</span></span>`)}${Object.keys(r.tags).length > 3 ? html`<span class="tag more">+${Object.keys(r.tags).length - 3}</span>` : ''}</div>` : html`<span class="dim">—</span>`}</td>
                    <td class="small">${r.errors.length ? html`<span class="err">✗ ${r.errors.map((e) => e[1]).join(' · ')}</span>` : r.exists ? html`<span class="${dupMode === 'update' ? 'warn' : 'dim'}">↻ ${dupMode === 'update' ? t('existe — mis à jour') : t('existe — ignoré')}</span>` : html`<span class="ok">✓ ${t('nouveau')}</span>`}</td>
                </tr>`) : html`<tr><td colspan="7" class="empty">${t('Aucune ligne.')}</td></tr>`}</tbody>
            </table></div>
            ${(onlyErrors ? errs : rows).length > 500 ? html`<p class="hint">${t('500 premières lignes affichées.')}</p>` : ''}
            <div class="row mt">
                <span class="soft small grow">${toSend ? html`<strong>${plural(toSend, t('device'))}</strong> ${t('seront envoyés')}${willSkip ? `, ${t('{n} ignoré(s)', { n: fmtNum(willSkip) })}` : ''}${errs.length ? html`, <span class="err">${t('{n} en erreur non envoyée(s)', { n: plural(errs.length, t('ligne')) })}</span>` : ''}.` : t('Rien à envoyer pour l’instant.')}</span>
                <button class="btn btn-primary btn-lg" data-act="run" ${toSend && existing !== null ? '' : 'disabled'}>$ ${t('importer')} ${fmtNum(toSend)} →</button>
            </div>
        </div>`;
    }

    // Trois zones redessinées séparément pour ne jamais perdre la saisie en cours.
    function draw() {
        if (!alive) return;
        const scroll = window.scrollY;
        render(root, html`<div class="page narrow" style="max-width:1000px">${head()}<div class="stack" style="gap:1rem">
            <div id="i-src">${sourceCard()}</div><div id="i-cfg">${configCard()}</div><div id="i-chk">${checkCard(build())}</div></div></div>`);
        window.scrollTo(0, scroll);
        if (tab === 'file') {
            const zone = $('#i-drop', root);
            if (zone) bindDrop(zone, $('#i-file', root), loadFile);
        }
    }

    function drawConfig() {
        const el = $('#i-cfg', root);
        if (!el) return draw();
        const id = document.activeElement?.id;
        render(el, configCard());
        if (id) document.getElementById(id)?.focus();
        drawCheck();
    }

    function drawCheck() {
        const el = $('#i-chk', root);
        if (!el) return draw();
        render(el, checkCard(build()));
    }

    // Le résumé de la source (nombre de lignes) sans toucher au tableau en cours de saisie.
    function drawSourceHint() {
        if (!$('#i-cfg', root)?.firstElementChild && src) drawConfig();
        else if (!src) render($('#i-cfg', root), '');
        drawCheck();
    }

    // ---------- Chargement ----------
    function setSource(data) {
        src = data;
        mapping = autoMap(src.headers);
        tagCols = tagCandidates(src.headers, mapping);
        // Tags obligatoires : colonne de même nom si elle existe.
        const prof = importProfile();
        if (prof) for (const t of prof.requiredTags) if (!reqTagSource[t] && src.headers.includes(t)) reqTagSource[t] = { column: t };
        syncTagCols();
        draw();
        checkExisting();
    }


    // Une colonne utilisée pour un tag obligatoire n'est pas proposée en double.
    function syncTagCols() {
        const used = new Set(Object.values(reqTagSource).map((s) => s.column).filter(Boolean));
        tagCols = tagCandidates(src.headers, mapping).map((t) => {
            const prev = tagCols.find((x) => x.column === t.column);
            return { ...t, checked: used.has(t.column) ? false : prev ? prev.checked : t.checked };
        }).filter((t) => !used.has(t.column));
    }

    async function checkExisting() {
        existing = null;
        try {
            const list = cached(app.id) || await devices(app.id);
            existing = new Set(list.map((d) => d.devEui));
        } catch (e) {
            existing = new Set();
            toast(t('Doublons non vérifiés : {msg}', { msg: api.humanize(e) }), { type: 'warn' });
        }
        if (alive) drawCheck();
    }

    async function loadFile(file) {
        try {
            if (/\.json$/i.test(file.name)) return restoreBackup(JSON.parse(await file.text()));
            setSource(await readFile(file));
        } catch (e) {
            toast(t('Lecture impossible : {msg}', { msg: e.message }), { type: 'err', duration: 7000 });
        }
    }

    function manualToSource() {
        const withLine = (r, line) => Object.defineProperty({ ...r }, '_line', { value: line, enumerable: false });
        const rows = manualRows.map((r, i) => withLine(r, i + 1)).filter((r) => Object.values(r).some((v) => String(v).trim()));
        if (!rows.length) {
            src = null;
            return;
        }
        src = { headers: MANUAL_COLS, rows, numeric: new Set(), source: 'saisie directe', kind: 'manual' };
        mapping = { dev_eui: 'dev_eui', name: 'name', key: 'app_key', description: 'description' };
        tagCols = [];
        if (existing === null) checkExisting();
    }

    // ---------- Événements ----------
    const redrawCheck = debounce(drawCheck, 200);
    const redrawManual = debounce(drawSourceHint, 200);
    root.addEventListener('input', (e) => {
        const t = e.target;
        if (t.dataset.c) {
            const tr = t.closest('tr');
            manualRows[Number(tr.dataset.i)][t.dataset.c] = t.value;
            manualToSource();
            redrawManual();
        }
        if (t.dataset.reqVal !== undefined) { reqTagSource[t.dataset.reqVal] = { value: t.value }; redrawCheck(); }
        if (t.dataset.fk !== undefined) { fixedTags[Number(t.dataset.fk)].key = t.value.trim(); redrawCheck(); }
        if (t.dataset.fv !== undefined) { fixedTags[Number(t.dataset.fv)].value = t.value; redrawCheck(); }
    });
    // Coller une colonne de valeurs dans la saisie directe : réparties sur les lignes suivantes.
    root.addEventListener('paste', (e) => {
        const t = e.target;
        if (!t.dataset.c) return;
        const text = e.clipboardData.getData('text');
        if (!/[\r\n\t]/.test(text.trim())) return;
        e.preventDefault();
        const lines = text.replace(/\r/g, '').split('\n').filter((l, i, a) => l !== '' || i < a.length - 1);
        const start = Number(t.closest('tr').dataset.i);
        const cols = MANUAL_COLS.slice(MANUAL_COLS.indexOf(t.dataset.c));
        lines.forEach((line, k) => {
            const i = start + k;
            while (manualRows.length <= i) manualRows.push({ dev_eui: '', name: '', app_key: '', description: '' });
            line.split('\t').forEach((v, j) => { if (cols[j]) manualRows[i][cols[j]] = v.trim(); });
        });
        manualToSource();
        draw();
    });
    root.addEventListener('change', (e) => {
        const t = e.target;
        if (t.id === 'i-dp') defaultDp = t.value;
        if (t.id === 'i-prof') {
            importProfileId = t.value;
            const prof = importProfile();
            if (prof && src) for (const tag of prof.requiredTags) if (!reqTagSource[tag] && src.headers.includes(tag)) reqTagSource[tag] = { column: tag };
            if (src) syncTagCols();
        }
        if (t.dataset.map) {
            for (const k of Object.keys(mapping)) if (mapping[k] === t.value && k !== t.dataset.map) delete mapping[k];
            if (t.value) mapping[t.dataset.map] = t.value;
            else delete mapping[t.dataset.map];
            syncTagCols();
        }
        if (t.dataset.reqCol !== undefined) {
            reqTagSource[t.dataset.reqCol] = t.value ? { column: t.value } : { value: '' };
            syncTagCols();
        }
        if (t.dataset.tagcol !== undefined) tagCols[Number(t.dataset.tagcol)].checked = t.checked;
        if (t.name === 'dup') dupMode = t.value;
        if (t.id === 'i-dp' || t.id === 'i-prof' || t.name === 'dup') remember();
        if (t.id === 'i-onlyerr') { onlyErrors = t.checked; return drawCheck(); }
        if (t.dataset.c || t.dataset.fk !== undefined || t.dataset.fv !== undefined || t.dataset.reqVal !== undefined) return;
        drawConfig();
    });

    on(root, 'click', {
        tab: (el) => {
            // Changer d'onglet ne jette pas les données déjà chargées : c'est la nouvelle saisie qui les remplace.
            tab = el.dataset.v;
            if (tab === 'manual' && (!src || src.kind === 'manual')) manualToSource();
            draw();
            if (tab === 'paste') $('#i-paste', root)?.focus();
            if (tab === 'manual') $('#i-manual [data-c="dev_eui"]', root)?.focus();
        },
        'parse-paste': () => {
            const text = $('#i-paste', root).value;
            if (!text.trim()) return toast(t('Collez d’abord des cellules.'), { type: 'warn' });
            try {
                const data = readPasted(text);
                // Une seule colonne de DevEUI sans en-tête : on l'accepte telle quelle.
                if (data.headers.length === 1 && isHex(normHex(data.headers[0]), 16)) {
                    const values = [data.headers[0], ...data.rows.map((r) => Object.values(r)[0])];
                    data.rows = values.map((v, i) => Object.defineProperty({ dev_eui: v }, '_line', { value: i + 1, enumerable: false }));
                    data.headers = ['dev_eui'];
                }
                setSource(data);
            } catch (e) {
                toast(e.message, { type: 'err' });
            }
        },
        'mrow-add': () => {
            for (let i = 0; i < 5; i++) manualRows.push({ dev_eui: '', name: '', app_key: '', description: '' });
            draw();
        },
        'mrow-del': (el) => {
            manualRows.splice(Number(el.dataset.i), 1);
            if (!manualRows.length) manualRows.push({ dev_eui: '', name: '', app_key: '', description: '' });
            manualToSource();
            draw();
        },
        reset: () => {
            src = null;
            manualRows = Array.from({ length: 5 }, () => ({ dev_eui: '', name: '', app_key: '', description: '' }));
            draw();
        },
        'fixed-add': () => { fixedTags.push({ key: '', value: '' }); drawConfig(); $$('[data-fk]', root).pop()?.focus(); },
        'fixed-del': (el) => { fixedTags.splice(Number(el.dataset.i), 1); drawConfig(); },
        profiles: () => navigate('reglages'),
        template: () => templateDialog(),
        'errors-csv': () => {
            const rows = build().filter((r) => r.errors.length);
            download(toCSV([t('ligne'), 'dev_eui', t('nom'), t('erreurs')], rows.map((r) => [r.line, r.devEui, r.name, r.errors.map((e) => e[1]).join(' | ')])), `${t('erreurs-import')}-${today()}.csv`, 'text/csv;charset=utf-8');
        },
        run: () => runImport(),
    });

    // ---------- Envoi ----------
    async function runImport() {
        const rows = build().filter((r) => !r.errors.length && (!r.exists || dupMode === 'update'));
        if (!rows.length) return;
        const created = [];
        const updated = [];
        const res = await runJob({
            title: t('Import dans {app}', { app: app.name }),
            verb: t('importé(s)'),
            items: rows,
            label: (r) => t('ligne {line} · {name}', { line: r.line, name: r.name }),
            run: async (r, ctx) => {
                // Mise à jour : uniquement ce que le fichier fournit (nom, description, profil, JoinEUI, tags, clés).
                const update = () => ops.overwriteDevice({
                    devEui: r.devEui,
                    name: r.rawName || undefined,
                    description: r.description,
                    deviceProfileId: r.dpFromCol ? r.dp.id : undefined,
                    joinEui: r.joinEui || undefined,
                    tags: r.tags,
                    nwkKey: r.nwkKey,
                    appKey: r.appKey,
                });
                if (r.exists && dupMode === 'update') {
                    await update();
                    updated.push(r.devEui);
                    return t('mis à jour');
                }
                const device = { devEui: r.devEui, name: r.name, description: r.description ?? '', applicationId: app.id, deviceProfileId: r.dp.id, tags: r.tags, ...(r.joinEui ? { joinEui: r.joinEui } : {}) };
                try {
                    await ops.createDevice(device);
                } catch (e) {
                    if (e.status !== 409) throw e;
                    // Présent ailleurs : on dit où, sans rien modifier.
                    const found = await ops.findDevice(r.devEui).catch(() => null);
                    const where = found?.device?.applicationId;
                    if (where && where !== app.id) throw new Error(t('existe déjà dans l’application « {app} » (utilisez Migrer)', { app: appName(where) }));
                    if (!where) throw new Error(t('existe déjà dans un autre tenant'));
                    if (dupMode !== 'update') throw new Error(t('existe déjà dans cette application'));
                    await update();
                    updated.push(r.devEui);
                    return t('mis à jour');
                }
                created.push(r.devEui);
                if (r.nwkKey) {
                    try {
                        await ops.setKeys(r.devEui, { nwkKey: r.nwkKey, appKey: r.appKey });
                    } catch (e) {
                        ctx.warn(t('créé, mais clés refusées : {msg}', { msg: api.humanize(e) }));
                        return t('créé sans clés');
                    }
                    return t('créé avec sa clé');
                }
                return t('créé');
            },
            after: () => [
                ...(created.length ? [{ label: t('Annuler l’import (supprimer les {n} créés)', { n: fmtNum(created.length) }), danger: true, onClick: () => undo(created) }] : []),
                { label: t('Voir les devices'), onClick: () => navigate('devices') },
            ],
        });
        invalidate(app.id);
        if (res.done.length) checkExisting();
    }

    async function undo(euis) {
        await runJob({
            title: t('Annulation de l’import'),
            verb: t('supprimé(s)'),
            items: euis,
            label: (e) => e,
            run: async (e) => ops.deleteDevice(e),
        });
        invalidate(app.id);
        checkExisting();
    }

    // ---------- Restauration d'une sauvegarde ----------
    async function restoreBackup(data) {
        if (data?.app !== 'open-chirpstack' || data.kind !== 'backup' || !Array.isArray(data.devices)) {
            throw new Error(t('ce fichier JSON n’est pas une sauvegarde Open ChirpStack (les réglages s’importent depuis « réglages »)'));
        }
        const snaps = data.devices.filter((s) => s?.device?.devEui);
        const origin = snaps[0]?.device.applicationId;
        const originOk = session.apps.some((a) => a.id === origin);
        const d = openDialog({
            title: t('Restaurer {n}', { n: plural(snaps.length, t('device')) }),
            body: html`<div class="stack">
                <p class="soft">${t('Sauvegarde du {date} ({reason}, application « {app} »). Les devices sont recréés avec leurs tags, clés et session.', { date: new Date(data.createdAt).toLocaleString(locale()), reason: data.reason || t('sauvegarde'), app: data.application || '?' })}</p>
                <div class="field"><label for="rb-app">${t('Recréer dans')}</label><select id="rb-app">
                    ${originOk ? html`<option value="__origin">${t('leur application d’origine ({app})', { app: appName(origin) })}</option>` : ''}
                    ${session.apps.map((a) => html`<option value="${a.id}" ${!originOk && a.id === app.id ? 'selected' : ''}>${a.name}</option>`)}</select></div>
            </div>`,
            foot: html`<button class="btn" data-close>${t('Annuler')}</button><button class="btn btn-primary" data-go>${t('Restaurer')}</button>`,
            onMount(el, close) { $('[data-go]', el).addEventListener('click', () => close($('#rb-app', el).value)); },
        });
        const target = await d.closed;
        if (!target) return;
        await runJob({
            title: t('Restauration'),
            verb: t('restauré(s)'),
            items: snaps,
            label: (s) => s.device.name || s.device.devEui,
            run: async (s, ctx) => {
                const dev = { ...s.device, applicationId: target === '__origin' ? s.device.applicationId : target };
                await ops.createDevice(dev);
                if (s.keys) await ops.setKeys(dev.devEui, s.keys);
                if (s.activation) {
                    try {
                        await api.post(`/api/devices/${dev.devEui}/activate`, { deviceActivation: s.activation });
                    } catch (e) {
                        ctx.warn(t('session non restaurée : {msg}', { msg: api.humanize(e) }));
                    }
                }
            },
        });
        for (const a of session.apps) invalidate(a.id);
    }

    // ---------- Modèle ----------
    function templateDialog() {
        const profiles = store.profiles();
        const d = openDialog({
            title: t('Modèle à remplir'),
            body: html`<div class="stack">
                <div class="field"><span class="label">${t('Format')}</span><div class="seg"><label><input type="radio" name="tf" value="xlsx" checked> Excel</label><label><input type="radio" name="tf" value="csv"> CSV</label></div></div>
                <div class="field"><label for="t-prof">${t('Ajouter les colonnes d’un profil d’import')}</label><select id="t-prof"><option value="">${t('Aucun')}</option>${profiles.map((p) => html`<option value="${p.id}">${p.name}</option>`)}</select></div>
                <p class="hint">${t('Colonnes : dev_eui, name, description, device_profile (nom ou ID), app_key, join_eui, puis vos tags. Dans Excel, les colonnes sont au format Texte pour protéger les DevEUI.')}</p>
            </div>`,
            foot: html`<button class="btn" data-close>${t('Annuler')}</button><button class="btn btn-primary" data-go>${icon('download')} ${t('Télécharger')}</button>`,
            onMount(el, close) { $('[data-go]', el).addEventListener('click', () => close({ fmt: $('input[name=tf]:checked', el).value, prof: $('#t-prof', el).value })); },
        });
        d.closed.then(async (opt) => {
            if (!opt) return;
            const prof = profiles.find((p) => p.id === opt.prof);
            const extra = prof ? prof.requiredTags : ['batiment', 'etage'];
            const headers = ['dev_eui', 'name', 'description', 'device_profile', 'app_key', 'join_eui', ...extra];
            const dp = session.deviceProfiles[0]?.name || '';
            const rows = [['70b3d52dd3000001', t('Capteur salle 101'), t('exemple, à remplacer'), dp, '2b7e151628aed2a6abf7158809cf4f3c', '', ...extra.map(() => '')]];
            const base = `${t('modele-import')}-${slug(app.name)}`;
            if (opt.fmt === 'csv') download(toCSV(headers, rows), `${base}.csv`, 'text/csv;charset=utf-8');
            else download(await toXLSX(headers, rows, 'import'), `${base}.xlsx`);
        });
    }

    draw();
    return () => { alive = false; };
}
