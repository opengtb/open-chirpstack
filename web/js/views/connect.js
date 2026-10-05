// Écran de connexion : adresse + clé API, choix du tenant, mode démo.

import * as api from '../api.js';
import * as store from '../store.js';
import { session, loadTenantData } from '../state.js';
import { $, html, render, icon, on, raw } from '../ui.js';

const RELEASES = 'https://github.com/OpenGTB/open-chirpstack/releases/latest';
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

export function mount(root, { onConnected }) {
    const p = store.prefs();
    let step = 'form';
    let busy = false;

    root.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.className = 'connect';
    root.appendChild(wrap);

    render(wrap, html`
        <section class="hero">
            <div class="eyebrow">$ open chirpstack</div>
            <h1>Vos devices ChirpStack, <em>en masse.</em></h1>
            <p class="lede">Importer, exporter, migrer, retagger, analyser des centaines de devices LoRaWAN en quelques clics. En local, sans rien installer sur le serveur.</p>
            <ul>
                <li>Import CSV, Excel ou copier-coller depuis un tableur, contrôlé avant envoi</li>
                <li>Sélection filtrée puis actions groupées : export, tags, profil, migration, suppression</li>
                <li>Santé du parc en un coup d'œil : silencieux, jamais vus, piles faibles</li>
                <li>Clé API gardée en mémoire seulement, aucune donnée envoyée ailleurs</li>
            </ul>
        </section>
        <section class="card connect-card" id="cx"></section>`);

    const card = $('#cx', wrap);

    function drawForm(status) {
        step = 'form';
        const saved = store.servers();
        const url = p.lastUrl || (saved[0]?.url ?? '');
        render(card, html`
            <div class="card-head"><span class="tag-line">// connexion</span></div>
            <form id="cx-form" class="stack" autocomplete="off" novalidate>
                <div class="field">
                    <label for="cx-url">Adresse de votre ChirpStack</label>
                    <input type="url" id="cx-url" class="mono" placeholder="http://192.168.1.10:8080" value="${url}" spellcheck="false" required>
                    ${saved.length ? html`<div class="saved-servers">${saved.slice(0, 6).map((s) => html`<button type="button" class="badge" data-act="pick" data-url="${s.url}" title="${s.url}">${s.name}</button>`)}</div>`
                        : html`<p class="hint">Celle que vous tapez pour ouvrir l'interface ChirpStack (port 8080 en général).</p>`}
                </div>
                <div class="field">
                    <label for="cx-key">Clé API</label>
                    <div class="input-group">
                        <input type="password" id="cx-key" class="mono" placeholder="eyJ0eXAiOiJKV1Qi…" spellcheck="false" autocomplete="off" required>
                        <button type="button" class="btn btn-icon" data-act="eye" title="Afficher / masquer" aria-label="Afficher la clé">${icon('eye')}</button>
                    </div>
                    <p class="hint">ChirpStack → <strong>API Keys</strong> → <em>Add API key</em> (clé admin), ou dans un tenant (clé limitée à ce tenant).</p>
                </div>
                <details class="more" ${p.mode === 'rest' || p.insecure ? 'open' : ''}>
                    <summary>options avancées</summary>
                    <div class="stack">
                        <div class="field">
                            <label for="cx-mode">Type d'accès</label>
                            <select id="cx-mode">
                                <option value="grpcweb" ${p.mode !== 'rest' ? 'selected' : ''}>Interface ChirpStack (recommandé)</option>
                                <option value="rest" ${p.mode === 'rest' ? 'selected' : ''}>API REST chirpstack-rest-api (port 8090)</option>
                            </select>
                        </div>
                        <label class="check"><input type="checkbox" id="cx-insecure" ${p.insecure ? 'checked' : ''}> Accepter un certificat HTTPS auto-signé</label>
                    </div>
                </details>
                <div id="cx-status" role="alert">${status || ''}</div>
                <div class="connect-foot">
                    <button type="submit" class="btn btn-primary btn-lg" id="cx-go">$ se connecter →</button>
                    <span class="spacer"></span>
                    <button type="button" class="btn-link" data-act="demo">essayer avec des données fictives →</button>
                </div>
            </form>`);
        const key = $('#cx-key', card);
        (url ? key : $('#cx-url', card)).focus();
        $('#cx-form', card).addEventListener('submit', (e) => {
            e.preventDefault();
            attempt();
        });
    }

    function setStatus(msg, cls = 'err') {
        const el = $('#cx-status', card);
        if (el) render(el, msg ? html`<div class="callout ${cls}">${icon(cls === 'err' ? 'alert' : 'check')}<div>${msg}</div></div>` : '');
    }

    async function attempt() {
        if (busy) return;
        let url = $('#cx-url', card).value.trim();
        const token = $('#cx-key', card).value.trim();
        const mode = $('#cx-mode', card).value;
        const insecure = $('#cx-insecure', card).checked;
        if (!url) return setStatus("Indiquez l'adresse de votre ChirpStack.");
        if (!token) return setStatus('Collez votre clé API.');
        if (!/^https?:\/\//i.test(url)) url = `http://${url}`;
        // Une adresse copiée depuis le navigateur peut contenir « /#/tenants/… » : on garde l'origine.
        let pastedTenant = null;
        const hashAt = url.indexOf('#');
        if (hashAt > 0) {
            pastedTenant = (url.slice(hashAt).match(/tenants\/([0-9a-f-]{36})/i) || [])[1] || null;
            url = url.slice(0, hashAt);
        }
        url = url.replace(/\/+$/, '');
        $('#cx-url', card).value = url;

        busy = true;
        const btn = $('#cx-go', card);
        btn.classList.add('loading');
        setStatus('');
        api.configure({ url, token, mode, insecure });
        try {
            let tenants = null;
            try {
                tenants = await api.listAll('/api/tenants');
            } catch (e) {
                const tenantKey = (e.status === 401 || e.status === 403) && !/invalid ?token|jwt|signature|malformed|expired/i.test(e.message);
                if (!tenantKey) throw e;
            }
            store.setPrefs({ lastUrl: url, mode, insecure });
            if (!store.servers().some((s) => s.url === url)) store.saveServer({ url, name: url.replace(/^https?:\/\//, '') });

            if (tenants) {
                session.isAdmin = true;
                session.tenants = tenants;
                if (!tenants.length) throw new Error('Connexion réussie, mais aucun tenant sur ce serveur.');
                const last = store.lastContext(url).tenantId;
                const pick = tenants.find((t) => t.id === pastedTenant) || (tenants.length === 1 ? tenants[0] : null);
                if (pick) return await useTenant(pick);
                return drawTenants(tenants, last);
            }
            session.isAdmin = false;
            drawTenantId(pastedTenant || store.lastContext(url).tenantId || '');
        } catch (e) {
            setStatus(api.humanize(e));
        } finally {
            busy = false;
            btn?.classList.remove('loading');
        }
    }

    function drawTenants(tenants, lastId) {
        step = 'tenants';
        const sorted = [...tenants].sort((a, b) => (a.id === lastId ? -1 : b.id === lastId ? 1 : a.name.localeCompare(b.name)));
        render(card, html`
            <div class="card-head"><span class="tag-line">// clé admin · ${tenants.length} tenants</span><button class="btn btn-ghost btn-sm end" data-act="back">← retour</button></div>
            <h2 style="font-size:18px;margin-bottom:.9rem">Quel tenant ?</h2>
            ${tenants.length > 8 ? html`<input type="search" id="cx-tf" placeholder="Filtrer…" class="sm" style="margin-bottom:.6rem" autofocus>` : ''}
            <div class="tenant-list" id="cx-tl">${sorted.map((t) => html`<button class="btn" data-act="tenant" data-id="${t.id}">${t.name}${t.id === lastId ? html`<span class="dim xs" style="margin-left:auto">dernier utilisé</span>` : ''}</button>`)}</div>
            <div id="cx-status" class="connect-status"></div>`);
        const f = $('#cx-tf', card);
        if (f) {
            f.addEventListener('input', () => {
                const q = f.value.toLowerCase();
                card.querySelectorAll('#cx-tl button').forEach((b) => { b.hidden = !b.textContent.toLowerCase().includes(q); });
            });
            f.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') card.querySelector('#cx-tl button:not([hidden])')?.click();
            });
        } else card.querySelector('#cx-tl button')?.focus();
    }

    function drawTenantId(value) {
        step = 'tenantId';
        render(card, html`
            <div class="card-head"><span class="tag-line">// clé tenant détectée</span><button class="btn btn-ghost btn-sm end" data-act="back">← retour</button></div>
            <form id="cx-tform" class="stack">
                <div class="field">
                    <label for="cx-tid">Identifiant du tenant</label>
                    <input type="text" id="cx-tid" class="mono" value="${value}" placeholder="Collez l'ID ou une adresse ChirpStack de ce tenant" spellcheck="false" autofocus>
                    <p class="hint">Astuce : collez simplement l'adresse d'une page ChirpStack de ce tenant (<code>…/#/tenants/<strong>ID</strong>/…</code>), l'ID en est extrait.</p>
                </div>
                <div id="cx-status"></div>
                <div class="connect-foot"><button type="submit" class="btn btn-primary btn-lg" id="cx-go">$ continuer →</button></div>
            </form>`);
        const input = $('#cx-tid', card);
        input.focus();
        input.select();
        $('#cx-tform', card).addEventListener('submit', async (e) => {
            e.preventDefault();
            const id = (input.value.match(UUID_RE) || [])[0];
            if (!id) return setStatus(raw('Identifiant introuvable : il doit ressembler à <code>52f14cd4-c6f1-4fbd-8f87-4025e1d49242</code>.'));
            const btn = $('#cx-go', card);
            btn.classList.add('loading');
            let name = `Tenant ${id.slice(0, 8)}`;
            try {
                const t = await api.get(`/api/tenants/${id}`);
                if (t.tenant?.name) name = t.tenant.name;
            } catch {
                /* lecture du nom non autorisée : sans conséquence */
            }
            try {
                session.tenants = [{ id, name }];
                await useTenant({ id, name });
            } catch (err) {
                setStatus(err.status === 401 || err.status === 403 ? "Cette clé n'a pas accès à ce tenant : vérifiez l'identifiant." : api.humanize(err));
            } finally {
                btn.classList.remove('loading');
            }
        });
    }

    async function useTenant(t) {
        await loadTenantData(t);
        store.rememberContext(api.serverUrl(), { tenantId: t.id });
        await onConnected();
    }

    async function startDemo() {
        await api.configureDemo();
        session.isAdmin = true;
        session.tenants = await api.listAll('/api/tenants');
        await useTenant(session.tenants[0]);
    }

    on(card, 'click', {
        pick: (el) => {
            $('#cx-url', card).value = el.dataset.url;
            $('#cx-key', card).focus();
        },
        eye: () => {
            const k = $('#cx-key', card);
            k.type = k.type === 'password' ? 'text' : 'password';
        },
        demo: () => startDemo().catch((e) => setStatus(api.humanize(e))),
        back: () => drawForm(),
        tenant: async (el) => {
            el.classList.add('loading');
            try {
                await useTenant(session.tenants.find((t) => t.id === el.dataset.id));
            } catch (e) {
                el.classList.remove('loading');
                setStatus(api.humanize(e));
            }
        },
    });

    // Page hébergée sans l'exécutable (GitHub Pages, blog) : seule la démo est possible.
    function drawStatic() {
        step = 'static';
        render(card, html`
            <div class="card-head"><span class="tag-line">// démo en ligne</span></div>
            <h2 style="font-size:20px;margin-bottom:.6rem">Essayez sans rien installer</h2>
            <p class="soft">Cette page tourne entièrement dans votre navigateur, avec un parc fictif de 247 devices répartis sur 4 applications. Tout fonctionne : filtres, import, export, migration, suppression…</p>
            <div class="connect-foot"><button class="btn btn-primary btn-lg" data-act="demo">$ lancer la démo →</button></div>
            <hr style="border:0;border-top:1px solid var(--border);margin:1.5rem 0">
            <p class="small soft">Pour travailler sur <strong>votre</strong> ChirpStack, téléchargez l'outil (un seul fichier, Windows, macOS ou Linux) : il s'ouvre dans votre navigateur et parle directement à votre serveur.</p>
            <p class="mt-s"><a class="btn" href="${RELEASES}" target="_blank" rel="noopener noreferrer">${icon('download')} Télécharger Open ChirpStack</a></p>`);
    }

    // Lien direct vers la démo : http://127.0.0.1:8765/?demo
    const wantsDemo = new URLSearchParams(location.search).has('demo');
    fetch('/__open-chirpstack', { method: 'GET', cache: 'no-store' })
        .then((r) => r.ok && r.headers.get('X-Open-Chirpstack') === '1')
        .catch(() => false)
        .then((local) => {
            if (step === null) return;
            if (wantsDemo) startDemo();
            else if (local) drawForm();
            else drawStatic();
        });

    return () => { step = null; };
}
