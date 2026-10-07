// Réglages : profils d'import, serveurs enregistrés, sauvegarde des réglages.

import * as api from '../api.js';
import * as store from '../store.js';
import { $, html, render, icon, on, plural, toast, download, confirmDialog, today, raw } from '../ui.js';
import { t, cmd } from '../i18n.js';

export function mount(root) {
    let alive = true;
    let editing = null; // { id?, name, requiredTags: [] }

    function profileForm() {
        if (!editing) return html`<button class="btn btn-primary" data-act="new">${icon('plus')} ${t('Nouveau profil')}</button>`;
        return html`<form id="p-form" class="card stack" style="background:var(--bg)">
            <div class="field"><label for="p-name">${t('Nom du profil')}</label><input type="text" id="p-name" value="${editing.name}" placeholder="${t('Ex. : Client A — capteurs CVC')}" autofocus></div>
            <div class="field"><label for="p-tag">${t('Tags obligatoires')}</label>
                <div class="chip-input" id="p-chips">${editing.requiredTags.map((tag) => html`<span class="chip">${tag}<button type="button" data-act="rmtag" data-t="${tag}" aria-label="${t('Retirer {tag}', { tag })}">×</button></span>`)}
                    <input type="text" id="p-tag" placeholder="${t('tapez un tag puis Entrée (ex. batiment, etage, zone)')}"></div>
                <p class="hint">${t('À chaque import avec ce profil, ces tags devront être renseignés (colonne du fichier ou valeur fixe).')}</p></div>
            <div class="row"><span class="spacer"></span><button type="button" class="btn" data-act="cancel">${t('Annuler')}</button><button type="submit" class="btn btn-primary">${editing.id ? t('Enregistrer') : t('Créer le profil')}</button></div>
        </form>`;
    }

    function draw() {
        if (!alive) return;
        const profiles = store.profiles();
        const servers = store.servers();
        render(root, html`<div class="page narrow">
            <div class="page-head"><div>
                <div class="eyebrow">$ cs ${cmd('reglages')}</div>
                <h1>${t('Réglages')}</h1>
                <p class="lede">${t('Enregistrés dans ce navigateur uniquement. Les clés API ne sont jamais conservées.')}</p>
            </div></div>

            <h2 class="section-title">${t('Profils d’import')} <span class="dim">${t('— tags obligatoires')}</span></h2>
            ${profiles.length ? html`<div class="table-wrap"><table class="tbl"><tbody>${profiles.map((p) => html`<tr>
                <td class="name">${p.name}</td>
                <td><div class="tags">${p.requiredTags.length ? p.requiredTags.map((tag) => html`<span class="tag"><span class="k">${tag}</span></span>`) : html`<span class="dim small">${t('aucun tag')}</span>`}</div></td>
                <td class="nowrap" style="text-align:right"><button class="btn btn-sm btn-ghost" data-act="edit" data-id="${p.id}">${icon('edit')} ${t('Modifier')}</button><button class="btn btn-sm btn-ghost" data-act="delprof" data-id="${p.id}" aria-label="${t('Supprimer')}">${icon('trash')}</button></td>
            </tr>`)}</tbody></table></div>` : html`<p class="dim small" style="margin-bottom:.75rem">${raw(t('Aucun profil. Un profil impose des tags à chaque import (par exemple {a}, {b}) : pratique quand vos intégrations en dépendent.', { a: '<code>batiment</code>', b: '<code>etage</code>' }))}</p>`}
            <div class="mt">${profileForm()}</div>

            <h2 class="section-title">${t('Serveurs enregistrés')}</h2>
            ${servers.length ? html`<div class="table-wrap"><table class="tbl"><tbody>${servers.map((s) => html`<tr>
                <td style="width:40%"><input type="text" class="sm" value="${s.name}" data-rename="${s.id}" aria-label="${t('Nom du serveur')}"></td>
                <td class="mono small soft">${s.url}${s.url === api.serverUrl() ? html` <span class="badge">${t('connecté')}</span>` : ''}</td>
                <td style="text-align:right"><button class="btn btn-sm btn-ghost" data-act="delsrv" data-id="${s.id}" aria-label="${t('Oublier ce serveur')}">${icon('trash')}</button></td>
            </tr>`)}</tbody></table></div>
            <p class="hint">${t('Chaque serveur auquel vous vous connectez est ajouté ici. Renommez-les pour les reconnaître sur l’écran de connexion.')}</p>`
            : html`<p class="dim small">${t('Aucun serveur enregistré.')}</p>`}

            <h2 class="section-title">${t('Sauvegarde des réglages')}</h2>
            <div class="row-wrap">
                <button class="btn" data-act="export">${icon('download')} ${t('Exporter (JSON)')}</button>
                <button class="btn" data-act="import">${icon('upload')} ${t('Importer…')}</button>
                <input type="file" id="set-file" accept=".json,application/json" hidden>
            </div>
            <p class="hint">${t('Pour partager vos profils et serveurs avec un collègue, ou les retrouver sur un autre poste. Les clés API n’en font jamais partie.')}</p>

            <h2 class="section-title">${t('Raccourcis')}</h2>
            <dl class="kv">
                <dt><kbd>Ctrl</kbd> <kbd>K</kbd> ${t('ou')} <kbd>\`</kbd></dt><dd>${t('palette de commandes : aller à un écran, changer d’application, chercher un DevEUI')}</dd>
                <dt><kbd>/</kbd></dt><dd>${t('rechercher dans la liste affichée')}</dd>
                <dt><kbd>${t('Maj')}</kbd> ${t('+ clic')}</dt><dd>${t('sélectionner une plage de devices')}</dd>
                <dt><kbd>${t('Échap')}</kbd></dt><dd>${t('fermer une fenêtre ou la fiche d’un device')}</dd>
            </dl>

            <p class="hint" style="margin-top:2.5rem">${raw(t('open/chirpstack — outil libre (licence MIT) de la boîte à outils {link}. Projet indépendant, non affilié à ChirpStack.', { link: '<a href="https://opengtb.com" target="_blank" rel="noopener noreferrer">OpenGTB</a>' }))}</p>
        </div>`);
    }

    function addChip(input) {
        const tag = input.value.trim().replace(/,$/, '');
        if (!tag) return;
        if (!store.isValidTagKey(tag)) return toast(t('Tag invalide : « {tag} »', { tag }), { type: 'err' });
        if (!editing.requiredTags.includes(tag)) editing.requiredTags.push(tag);
        editing.name = $('#p-name', root).value;
        draw();
        $('#p-tag', root).focus();
    }

    root.addEventListener('keydown', (e) => {
        if (e.target.id === 'p-tag' && (e.key === 'Enter' || e.key === ',')) {
            e.preventDefault();
            addChip(e.target);
        }
        if (e.target.id === 'p-tag' && e.key === 'Backspace' && !e.target.value && editing.requiredTags.length) {
            editing.requiredTags.pop();
            editing.name = $('#p-name', root).value;
            draw();
            $('#p-tag', root).focus();
        }
    });
    root.addEventListener('submit', (e) => {
        e.preventDefault();
        const name = $('#p-name', root).value.trim();
        const pending = $('#p-tag', root).value.trim();
        if (pending && store.isValidTagKey(pending) && !editing.requiredTags.includes(pending)) editing.requiredTags.push(pending);
        if (!name) return toast(t('Donnez un nom au profil.'), { type: 'warn' });
        store.saveProfile({ id: editing.id, name, requiredTags: editing.requiredTags });
        toast(editing.id ? t('Profil enregistré.') : t('Profil créé.'));
        editing = null;
        draw();
    });
    root.addEventListener('change', (e) => {
        const id = e.target.dataset.rename;
        if (id) {
            const s = store.servers().find((x) => x.id === id);
            if (s) store.saveServer({ url: s.url, name: e.target.value.trim() || s.url });
            toast(t('Serveur renommé.'));
        }
        if (e.target.id === 'set-file' && e.target.files[0]) {
            e.target.files[0].text().then((txt) => {
                const r = store.importSettings(JSON.parse(txt));
                toast(t('{servers} et {profiles} ajoutés (doublons ignorés).', { servers: plural(r.addedServers, t('serveur'), t('serveurs')), profiles: plural(r.addedProfiles, t('profil'), t('profils')) }));
                draw();
            }).catch((err) => toast(t('Fichier invalide : {error}', { error: err.message }), { type: 'err' }));
        }
    });

    on(root, 'click', {
        new: () => { editing = { name: '', requiredTags: [] }; draw(); $('#p-name', root).focus(); },
        edit: (el) => {
            const p = store.profiles().find((x) => x.id === el.dataset.id);
            editing = { ...p, requiredTags: [...p.requiredTags] };
            draw();
            $('#p-name', root).focus();
        },
        cancel: () => { editing = null; draw(); },
        rmtag: (el) => {
            editing.requiredTags = editing.requiredTags.filter((tag) => tag !== el.dataset.t);
            editing.name = $('#p-name', root).value;
            draw();
        },
        delprof: async (el) => {
            const p = store.profiles().find((x) => x.id === el.dataset.id);
            if (await confirmDialog({ title: t('Supprimer ce profil ?'), message: html`${t('Le profil')} <strong>${p.name}</strong> ${t('sera supprimé de ce navigateur.')}`, confirm: t('Supprimer'), danger: true })) {
                store.removeProfile(p.id);
                draw();
            }
        },
        delsrv: (el) => { store.removeServer(el.dataset.id); draw(); },
        export: () => download(JSON.stringify(store.exportSettings(), null, 2), `open-chirpstack-reglages-${today()}.json`, 'application/json'),
        import: () => $('#set-file', root).click(),
    });

    draw();
    return () => { alive = false; };
}
