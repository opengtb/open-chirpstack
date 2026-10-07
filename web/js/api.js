// Client de l'API ChirpStack : passe par le relais local (/api/...) ou par le backend de démo.

import { t, getLang } from './i18n.js';

export class ApiError extends Error {
    constructor(status, message, code = 0) {
        super(message);
        this.status = status;
        this.code = code;
    }
}

const conn = { url: '', token: '', mode: 'grpcweb', insecure: false, demo: null };

export function configure({ url, token, mode = 'grpcweb', insecure = false }) {
    Object.assign(conn, { url: url.trim().replace(/\/+$/, ''), token: cleanToken(token), mode, insecure, demo: null });
}

export async function configureDemo() {
    const { createDemoBackend } = await import('./demo.js');
    Object.assign(conn, { url: 'demo', token: '', mode: 'demo', insecure: false, demo: createDemoBackend({ lang: getLang() }) });
}

export function disconnect() {
    Object.assign(conn, { url: '', token: '', demo: null });
}

export const isDemo = () => !!conn.demo;
export const serverUrl = () => conn.url;
export const mode = () => conn.mode;

function cleanToken(t) {
    t = String(t || '').trim();
    return /^bearer\s+/i.test(t) ? t.replace(/^bearer\s+/i, '') : t;
}

async function rawCall(path, method, body) {
    if (conn.demo) {
        const r = await conn.demo.request(method, path, body ?? null);
        if (r.status >= 400) throw new ApiError(r.status, r.json?.message || t('Erreur {n}', { n: r.status }), r.json?.code);
        return r.json;
    }
    let res;
    try {
        res = await fetch(path, {
            method,
            headers: {
                Accept: 'application/json',
                'Content-Type': 'application/json',
                'Grpc-Metadata-Authorization': `Bearer ${conn.token}`,
                'X-ChirpStack-Server': conn.url,
                'X-ChirpStack-Mode': conn.mode,
                'X-ChirpStack-Insecure': conn.insecure ? '1' : '0',
            },
            body: body ? JSON.stringify(body) : undefined,
        });
    } catch {
        throw new ApiError(0, t('L’outil local ne répond plus. La fenêtre Open ChirpStack a-t-elle été fermée ? Relancez-la puis rechargez cette page.'));
    }
    const text = await res.text();
    let json = {};
    if (text) {
        try {
            json = JSON.parse(text);
        } catch {
            json = { message: text.slice(0, 300) };
        }
    }
    if (!res.ok) throw new ApiError(res.status, json.message || t('Erreur HTTP {n}', { n: res.status }), json.code);
    return json;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Appel avec réessais sur surcharge (429) ou indisponibilité passagère (502/503/504).
export async function call(path, { method = 'GET', body } = {}) {
    const delays = [400, 1200, 3000];
    for (let attempt = 0; ; attempt++) {
        try {
            return await rawCall(path, method, body);
        } catch (err) {
            const retriable = err instanceof ApiError && [429, 502, 503, 504].includes(err.status) && !/impossible de joindre|url/i.test(err.message);
            if (!retriable || attempt >= delays.length) throw err;
            await sleep(delays[attempt]);
        }
    }
}

export const get = (path) => call(path);
export const post = (path, body) => call(path, { method: 'POST', body });
export const put = (path, body) => call(path, { method: 'PUT', body });
export const del = (path) => call(path, { method: 'DELETE' });

// Exécute fn sur chaque élément avec au plus `limit` appels simultanés.
// Respecte signal.aborted (arrêt propre : les tâches en cours finissent, les suivantes ne partent pas).
export async function pool(items, limit, fn, signal) {
    const results = new Array(items.length);
    let next = 0;
    const worker = async () => {
        while (next < items.length) {
            if (signal?.aborted) return;
            const i = next++;
            results[i] = await fn(items[i], i);
        }
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return results;
}

export const CONCURRENCY = 6;
const PAGE = 500;

// Récupère toutes les pages d'une liste ChirpStack ; `path` contient déjà ses filtres.
export async function listAll(path, onProgress) {
    const sep = path.includes('?') ? '&' : '?';
    const first = await get(`${path}${sep}limit=${PAGE}&offset=0`);
    const total = parseInt(first.totalCount, 10) || 0;
    const items = [...(first.result || [])];
    onProgress?.(items.length, total);
    if (items.length >= total || items.length === 0) return items;

    const offsets = [];
    for (let o = PAGE; o < total; o += PAGE) offsets.push(o);
    let loaded = items.length;
    const pages = await pool(offsets, 4, async (o) => {
        const page = await get(`${path}${sep}limit=${PAGE}&offset=${o}`);
        loaded += (page.result || []).length;
        onProgress?.(Math.min(loaded, total), total);
        return page.result || [];
    });
    for (const p of pages) items.push(...p);
    // Dédoublonnage par sécurité si la liste a bougé pendant la lecture.
    const seen = new Set();
    return items.filter((it) => {
        const k = it.devEui || it.id || it.gatewayId;
        if (!k) return true;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
    });
}

export async function count(path) {
    const sep = path.includes('?') ? '&' : '?';
    const r = await get(`${path}${sep}limit=1`);
    return parseInt(r.totalCount, 10) || 0;
}

// Messages connus du relais Go (toujours en français) → anglais. Le message original reste dans err.message
// (call() s'en sert pour décider des réessais) ; seule la version affichée est traduite.
const RELAY_EN = [
    [/impossible de joindre l'API REST ChirpStack \(([^)]*)\) : /g, 'cannot reach the ChirpStack REST API ($1): '],
    [/impossible de joindre ChirpStack \(([^)]*)\) : /g, 'cannot reach ChirpStack ($1): '],
    [/le serveur (\S+) redirige vers (\S+) : utilisez directement cette adresse/g, 'server $1 redirects to $2: use that address directly'],
    [/le serveur (\S+) ne répond pas comme une API ChirpStack \(Content-Type ("[^"]*")\) : vérifiez l'URL/g, 'server $1 does not answer like a ChirpStack API (Content-Type $2): check the URL'],
    [/URL du serveur ChirpStack manquante/g, 'ChirpStack server URL missing'],
    [/URL du serveur ChirpStack invalide : /g, 'invalid ChirpStack server URL: '],
    [/URL ChirpStack invalide : /g, 'invalid ChirpStack URL: '],
    [/origine non autorisée/g, 'origin not allowed'],
    [/hôte non autorisé/g, 'host not allowed'],
    [/réponse gRPC-web tronquée/g, 'truncated gRPC-web response'],
    [/réponse vide du serveur ChirpStack/g, 'empty response from the ChirpStack server'],
    [/grpc-status invalide/g, 'invalid grpc-status'],
    [/L’outil local ne répond plus\. La fenêtre Open ChirpStack a-t-elle été fermée \? Relancez-la puis rechargez cette page\./g,
        'The local tool is no longer responding. Was the Open ChirpStack window closed? Restart it, then reload this page.'],
];

function relayText(msg) {
    if (getLang() !== 'en') return msg;
    return RELAY_EN.reduce((s, [re, en]) => s.replace(re, en), msg);
}

// Message lisible pour l'utilisateur.
export function humanize(err) {
    const msg = String(err?.message || err || '');
    const low = msg.toLowerCase();
    const status = err?.status ?? -1;

    if (status === 0) return relayText(msg);
    if (low.includes('invalid length') && low.includes('found 0')) return t('Device Profile manquant : choisissez-en un par défaut ou indiquez-le dans le fichier.');
    if (low.includes('invalid length')) return t('Identifiant invalide (UUID attendu) : vérifiez le Device Profile ou l’application.');
    if (status === 409 || low.includes('already exists') || low.includes('device_pkey')) return t('Ce DevEUI existe déjà sur le serveur.');
    if (status === 401) {
        if (/invalid ?token|jwt|signature/i.test(msg)) return t('Clé API refusée : vérifiez qu’elle est complète et qu’elle appartient bien à ce serveur.');
        return t('Accès refusé : cette clé API n’a pas les droits pour cette opération.');
    }
    if (status === 403 && !/non autoris/i.test(msg)) return t('Permission refusée pour cette clé API.');
    if (status === 404 && /object does not exist/i.test(msg)) return t('Introuvable sur le serveur (déjà supprimé ?).');
    if (status === 429) return t('Le serveur limite le nombre de requêtes : réessayez dans un instant.');
    const out = relayText(msg);
    return out.length > 220 ? out.slice(0, 220) + '…' : out;
}
