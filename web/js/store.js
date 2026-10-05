// Préférences enregistrées dans le navigateur (jamais les clés API).

const KEYS = {
    prefs: 'ocs.prefs',
    servers: 'ocs.servers',
    profiles: 'ocs.profiles',
};

function read(key, fallback) {
    try {
        const v = JSON.parse(localStorage.getItem(key));
        return v ?? fallback;
    } catch {
        return fallback;
    }
}

function write(key, value) {
    try {
        localStorage.setItem(key, JSON.stringify(value));
        return true;
    } catch {
        return false;
    }
}

// Reprise des réglages d'une version précédente (même origine).
(function migrateLegacy() {
    if (localStorage.getItem(KEYS.servers) === null) {
        const old = read('cstoolbox.servers', null);
        if (Array.isArray(old)) write(KEYS.servers, old);
    }
    if (localStorage.getItem(KEYS.profiles) === null) {
        const old = read('cstoolbox.profiles', null);
        if (Array.isArray(old)) write(KEYS.profiles, old);
    }
})();

export const newId = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));

// ---------- Préférences ----------
export function prefs() {
    return { theme: 'auto', manual: 'dark', lastUrl: '', mode: 'grpcweb', insecure: false, contexts: {}, ...read(KEYS.prefs, {}) };
}

export function setPrefs(patch) {
    write(KEYS.prefs, { ...prefs(), ...patch });
}

// Dernier tenant / application utilisés pour un serveur donné.
export function lastContext(url) {
    return prefs().contexts[url] || {};
}

export function rememberContext(url, ctx) {
    const p = prefs();
    p.contexts = { ...p.contexts, [url]: { ...(p.contexts[url] || {}), ...ctx } };
    write(KEYS.prefs, p);
}

// ---------- Serveurs ----------
export function servers() {
    const list = read(KEYS.servers, []);
    return Array.isArray(list) ? list.filter((s) => s && s.url) : [];
}

export function saveServer({ name, url }) {
    const list = servers();
    const existing = list.find((s) => s.url === url);
    if (existing) existing.name = name || existing.name;
    else list.push({ id: newId(), name: name || url, url, createdAt: new Date().toISOString() });
    return write(KEYS.servers, list);
}

export function removeServer(id) {
    return write(KEYS.servers, servers().filter((s) => s.id !== id));
}

// ---------- Profils d'import (tags obligatoires) ----------
export function profiles() {
    const list = read(KEYS.profiles, []);
    return Array.isArray(list)
        ? list.filter((p) => p && p.name).map((p) => ({ ...p, requiredTags: Array.isArray(p.requiredTags) ? p.requiredTags.map(String) : [] }))
        : [];
}

export function saveProfile({ id, name, requiredTags }) {
    const list = profiles();
    const now = new Date().toISOString();
    const existing = id && list.find((p) => p.id === id);
    if (existing) Object.assign(existing, { name, requiredTags, updatedAt: now });
    else list.push({ id: newId(), name, requiredTags, createdAt: now, updatedAt: now });
    return write(KEYS.profiles, list);
}

export function removeProfile(id) {
    return write(KEYS.profiles, profiles().filter((p) => p.id !== id));
}

// ---------- Sauvegarde / restauration ----------
export function exportSettings() {
    return {
        app: 'open-chirpstack',
        version: 1,
        exportedAt: new Date().toISOString(),
        servers: servers().map(({ name, url }) => ({ name, url })),
        profiles: profiles().map(({ name, requiredTags }) => ({ name, requiredTags })),
    };
}

const TAG_RE = /^[\w.\-:/ ]{1,64}$/;

// Fusionne un fichier de réglages ; renvoie le nombre d'éléments ajoutés.
export function importSettings(data) {
    const inServers = Array.isArray(data?.servers) ? data.servers : [];
    const inProfiles = Array.isArray(data?.profiles) ? data.profiles : [];
    let addedServers = 0;
    let addedProfiles = 0;

    const list = servers();
    for (const s of inServers) {
        const url = String(s?.url || '').trim();
        if (!/^https?:\/\/[^\s]+$/i.test(url) || list.some((c) => c.url === url)) continue;
        list.push({ id: newId(), name: String(s.name || url).slice(0, 80), url, createdAt: new Date().toISOString() });
        addedServers++;
    }
    write(KEYS.servers, list);

    const plist = profiles();
    for (const p of inProfiles) {
        const name = String(p?.name || '').trim().slice(0, 80);
        if (!name || plist.some((c) => c.name === name)) continue;
        const tags = (Array.isArray(p.requiredTags) ? p.requiredTags : []).map((t) => String(t).trim()).filter((t) => TAG_RE.test(t));
        const now = new Date().toISOString();
        plist.push({ id: newId(), name, requiredTags: [...new Set(tags)], createdAt: now, updatedAt: now });
        addedProfiles++;
    }
    write(KEYS.profiles, plist);
    return { addedServers, addedProfiles };
}

export const isValidTagKey = (t) => TAG_RE.test(t);
