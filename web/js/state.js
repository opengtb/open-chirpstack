// État de la session : contexte (tenant, application) et cache des devices par application.

import * as api from './api.js';
import { t } from './i18n.js';
import { resetMoveDetection } from './ops.js';

export const session = {
    connected: false,
    isAdmin: false,
    tenants: [],
    tenant: null, // { id, name }
    apps: [],
    app: null, // { id, name }
    deviceProfiles: [],
    appCounts: {}, // appId -> nombre de devices (totalCount)
};

// Bus d'événements : 'context' (tenant/app changé), 'devices' (cache modifié).
export const bus = new EventTarget();
export const emit = (type, detail) => bus.dispatchEvent(new CustomEvent(type, { detail }));
export const listen = (type, fn) => {
    const h = (e) => fn(e.detail);
    bus.addEventListener(type, h);
    return () => bus.removeEventListener(type, h);
};

// ---------- Statut d'activité ----------
// Libellés en getters : traduits à chaque affichage, la clé française reste dans le code.
export const STATUSES = [
    { key: 'active', get label() { return t('Actifs'); }, get one() { return t('Actif'); }, get hint() { return t('vus il y a moins de 24 h'); } },
    { key: 'recent', get label() { return t('Récents'); }, get one() { return t('Récent'); }, get hint() { return t('vus il y a 1 à 7 jours'); } },
    { key: 'inactive', get label() { return t('Inactifs'); }, get one() { return t('Inactif'); }, get hint() { return t('vus il y a 7 à 30 jours'); } },
    { key: 'offline', get label() { return t('Hors ligne'); }, get one() { return t('Hors ligne'); }, get hint() { return t('plus de 30 jours sans message'); } },
    { key: 'never', get label() { return t('Jamais vus'); }, get one() { return t('Jamais vu'); }, get hint() { return t('aucun message reçu'); } },
];
export const statusInfo = (k) => STATUSES.find((s) => s.key === k);

export function statusOf(d) {
    if (!d.lastSeenAt) return 'never';
    const h = (Date.now() - new Date(d.lastSeenAt).getTime()) / 3600000;
    if (h < 24) return 'active';
    if (h < 24 * 7) return 'recent';
    if (h < 24 * 30) return 'inactive';
    return 'offline';
}

export function battery(d) {
    const s = d.deviceStatus;
    if (!s) return null;
    if (s.externalPowerSource) return { ext: true };
    const lvl = Number(s.batteryLevel);
    return Number.isFinite(lvl) && lvl >= 0 ? { level: Math.round(lvl) } : null;
}

// ---------- Contexte ----------
export async function loadTenantData(tenant) {
    const [apps, dps] = await Promise.all([
        api.listAll(`/api/applications?tenantId=${encodeURIComponent(tenant.id)}`),
        api.listAll(`/api/device-profiles?tenantId=${encodeURIComponent(tenant.id)}`),
    ]);
    // Le contexte ne change qu'une fois tout chargé : un échec laisse l'ancien tenant intact.
    session.tenant = tenant;
    session.apps = apps;
    session.deviceProfiles = dps;
    session.appCounts = {};
    cache.clear();
    resetMoveDetection();
    refreshAppCounts();
}

// Nombre de devices par application, en tâche de fond (une requête légère par application).
export async function refreshAppCounts() {
    const apps = session.apps;
    await api.pool(apps, 4, async (a) => {
        try {
            session.appCounts[a.id] = await api.count(`/api/devices?applicationId=${encodeURIComponent(a.id)}`);
        } catch {
            /* compteur indisponible : sans conséquence */
        }
    });
    emit('counts');
}

export function setApp(app) {
    session.app = app;
    emit('context');
}

export const profileName = (id) => session.deviceProfiles.find((p) => p.id === id)?.name || '';
export const appName = (id) => session.apps.find((a) => a.id === id)?.name || id;

// ---------- Cache des devices ----------
const cache = new Map(); // appId -> { devices, loadedAt, loading }

export function cached(appId) {
    return cache.get(appId)?.devices || null;
}

export function loadedAt(appId) {
    return cache.get(appId)?.loadedAt || null;
}

let generation = 0;

export async function devices(appId, { force = false, onProgress } = {}) {
    const entry = cache.get(appId);
    if (entry?.devices && !force) return entry.devices;
    if (entry?.loading && !force) {
        if (onProgress) entry.listeners.add(onProgress);
        return entry.loading;
    }
    // Chaque chargement porte un numéro : un résultat arrivé après une invalidation est ignoré.
    const gen = ++generation;
    const listeners = new Set(onProgress ? [onProgress] : []);
    const loading = api.listAll(`/api/devices?applicationId=${encodeURIComponent(appId)}`, (n, t) => listeners.forEach((fn) => fn(n, t)))
        .then((list) => {
            if (cache.get(appId)?.gen === gen) {
                cache.set(appId, { devices: list, loadedAt: Date.now(), gen });
                session.appCounts[appId] = list.length;
                emit('devices', { appId });
            }
            return list;
        })
        .catch((err) => {
            if (cache.get(appId)?.gen === gen) cache.delete(appId);
            throw err;
        });
    cache.set(appId, { ...(entry?.devices && !force ? entry : {}), loading, listeners, gen });
    return loading;
}

// Mises à jour locales après une opération, pour éviter de tout recharger.
export function patchDevices(appId, patches) {
    const list = cached(appId);
    if (!list) return;
    const byEui = new Map(patches.map((p) => [p.devEui, p]));
    for (const d of list) {
        const p = byEui.get(d.devEui);
        if (p) Object.assign(d, p);
    }
    emit('devices', { appId });
}

export function removeDevices(appId, euis) {
    const entry = cache.get(appId);
    if (!entry?.devices) return;
    const set = new Set(euis);
    entry.devices = entry.devices.filter((d) => !set.has(d.devEui));
    session.appCounts[appId] = entry.devices.length;
    emit('devices', { appId });
}

export function invalidate(appId) {
    cache.delete(appId);
    emit('devices', { appId });
}

export function clearAll() {
    cache.clear();
    Object.assign(session, { connected: false, isAdmin: false, tenants: [], tenant: null, apps: [], app: null, deviceProfiles: [], appCounts: {} });
}
