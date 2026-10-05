// Réglages : profils d'import, serveurs enregistrés, sauvegarde des réglages.

import * as api from '../api.js';
import * as store from '../store.js';
import { $, html, render, icon, on, plural, toast, download, confirmDialog, today } from '../ui.js';

export function mount(root) {
    let alive = true;
    let editing = null; // { id?, name, requiredTags: [] }

    function profileForm() {
        if (!editing) return html`<button class="btn btn-primary" data-act="new">${icon('plus')} Nouveau profil</button>`;
        return html`<form id="p-form" class="card stack" style="background:var(--bg)">
            <div class="field"><label for="p-name">Nom du profil</label><input type="text" id="p-name" value="${editing.name}" placeholder="Ex. : Client A — capteurs CVC" autofocus></div>
            <div class="field"><label for="p-tag">Tags obligatoires</label>
                <div class="chip-input" id="p-chips">${editing.requiredTags.map((t) => html`<span class="chip">${t}<button type="button" data-act="rmtag" data-t="${t}" aria-label="Retirer ${t}">×</button></span>`)}
                    <input type="text" id="p-tag" placeholder="tapez un tag puis Entrée (ex. batiment, etage, zone)"></div>
                <p class="hint">À chaque import avec ce profil, ces tags devront être renseignés (colonne du fichier ou valeur fixe).</p></div>
            <div class="row"><span class="spacer"></span><button type="button" class="btn" data-act="cancel">Annuler</button><button type="submit" class="btn btn-primary">${editing.id ? 'Enregistrer' : 'Créer le profil'}</button></div>
        </form>`;
    }

    function draw() {
        if (!alive) return;
        const profiles = store.profiles();
        const servers = store.servers();
        render(root, html`<div class="page narrow">
            <div class="page-head"><div>
                <div class="eyebrow">$ cs réglages</div>
                <h1>Réglages</h1>
                <p class="lede">Enregistrés dans ce navigateur uniquement. Les clés API ne sont jamais conservées.</p>
            </div></div>

            <h2 class="section-title">Profils d'import <span class="dim">— tags obligatoires</span></h2>
            ${profiles.length ? html`<div class="table-wrap"><table class="tbl"><tbody>${profiles.map((p) => html`<tr>
                <td class="name">${p.name}</td>
                <td><div class="tags">${p.requiredTags.length ? p.requiredTags.map((t) => html`<span class="tag"><span class="k">${t}</span></span>`) : html`<span class="dim small">aucun tag</span>`}</div></td>
                <td class="nowrap" style="text-align:right"><button class="btn btn-sm btn-ghost" data-act="edit" data-id="${p.id}">${icon('edit')} Modifier</button><button class="btn btn-sm btn-ghost" data-act="delprof" data-id="${p.id}" aria-label="Supprimer">${icon('trash')}</button></td>
            </tr>`)}</tbody></table></div>` : html`<p class="dim small" style="margin-bottom:.75rem">Aucun profil. Un profil impose des tags à chaque import (par exemple <code>batiment</code>, <code>etage</code>) : pratique quand vos intégrations en dépendent.</p>`}
            <div class="mt">${profileForm()}</div>

            <h2 class="section-title">Serveurs enregistrés</h2>
            ${servers.length ? html`<div class="table-wrap"><table class="tbl"><tbody>${servers.map((s) => html`<tr>
                <td style="width:40%"><input type="text" class="sm" value="${s.name}" data-rename="${s.id}" aria-label="Nom du serveur"></td>
                <td class="mono small soft">${s.url}${s.url === api.serverUrl() ? html` <span class="badge">connecté</span>` : ''}</td>
                <td style="text-align:right"><button class="btn btn-sm btn-ghost" data-act="delsrv" data-id="${s.id}" aria-label="Oublier ce serveur">${icon('trash')}</button></td>
            </tr>`)}</tbody></table></div>
            <p class="hint">Chaque serveur auquel vous vous connectez est ajouté ici. Renommez-les pour les reconnaître sur l'écran de connexion.</p>`
            : html`<p class="dim small">Aucun serveur enregistré.</p>`}

            <h2 class="section-title">Sauvegarde des réglages</h2>
            <div class="row-wrap">
                <button class="btn" data-act="export">${icon('download')} Exporter (JSON)</button>
                <button class="btn" data-act="import">${icon('upload')} Importer…</button>
                <input type="file" id="set-file" accept=".json,application/json" hidden>
            </div>
            <p class="hint">Pour partager vos profils et serveurs avec un collègue, ou les retrouver sur un autre poste. Les clés API n'en font jamais partie.</p>

            <h2 class="section-title">Raccourcis</h2>
            <dl class="kv">
                <dt><kbd>Ctrl</kbd> <kbd>K</kbd> ou <kbd>\`</kbd></dt><dd>palette de commandes : aller à un écran, changer d'application, chercher un DevEUI</dd>
                <dt><kbd>/</kbd></dt><dd>rechercher dans la liste affichée</dd>
                <dt><kbd>Maj</kbd> + clic</dt><dd>sélectionner une plage de devices</dd>
                <dt><kbd>Échap</kbd></dt><dd>fermer une fenêtre ou la fiche d'un device</dd>
            </dl>

            <p class="hint" style="margin-top:2.5rem">open/chirpstack — outil libre (licence MIT) de la boîte à outils <a href="https://opengtb.com" target="_blank" rel="noopener noreferrer">OpenGTB</a>. Projet indépendant, non affilié à ChirpStack.</p>
        </div>`);
    }

    function addChip(input) {
        const t = input.value.trim().replace(/,$/, '');
        if (!t) return;
        if (!store.isValidTagKey(t)) return toast(`Tag invalide : « ${t} »`, { type: 'err' });
        if (!editing.requiredTags.includes(t)) editing.requiredTags.push(t);
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
        if (!name) return toast('Donnez un nom au profil.', { type: 'warn' });
        store.saveProfile({ id: editing.id, name, requiredTags: editing.requiredTags });
        toast(editing.id ? 'Profil enregistré.' : 'Profil créé.');
        editing = null;
        draw();
    });
    root.addEventListener('change', (e) => {
        const id = e.target.dataset.rename;
        if (id) {
            const s = store.servers().find((x) => x.id === id);
            if (s) store.saveServer({ url: s.url, name: e.target.value.trim() || s.url });
            toast('Serveur renommé.');
        }
        if (e.target.id === 'set-file' && e.target.files[0]) {
            e.target.files[0].text().then((t) => {
                const r = store.importSettings(JSON.parse(t));
                toast(`${plural(r.addedServers, 'serveur')} et ${plural(r.addedProfiles, 'profil')} ajoutés (doublons ignorés).`);
                draw();
            }).catch((err) => toast(`Fichier invalide : ${err.message}`, { type: 'err' }));
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
            editing.requiredTags = editing.requiredTags.filter((t) => t !== el.dataset.t);
            editing.name = $('#p-name', root).value;
            draw();
        },
        delprof: async (el) => {
            const p = store.profiles().find((x) => x.id === el.dataset.id);
            if (await confirmDialog({ title: 'Supprimer ce profil ?', message: html`Le profil <strong>${p.name}</strong> sera supprimé de ce navigateur.`, confirm: 'Supprimer', danger: true })) {
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
