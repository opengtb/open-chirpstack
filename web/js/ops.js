// Opérations sur les devices, prudentes : jamais de suppression sans copie de sauvegarde ni restauration en cas d'échec.

import { ApiError, del, get, humanize, post, put } from './api.js';

const p = (eui) => `/api/devices/${encodeURIComponent(eui)}`;
const is404 = (e) => e instanceof ApiError && e.status === 404;
const is409 = (e) => e instanceof ApiError && e.status === 409;
const ZERO_KEY = '00000000000000000000000000000000';

export async function getDevice(eui) {
    return get(p(eui));
}

export async function getKeys(eui) {
    try {
        const r = await get(`${p(eui)}/keys`);
        return r.deviceKeys || null;
    } catch (e) {
        if (is404(e)) return null;
        throw e;
    }
}

// Écrit les clés telles quelles (nwkKey, appKey, genAppKey) : création, ou mise à jour si elles existent déjà.
export async function setKeys(eui, keys) {
    const deviceKeys = { ...keys, devEui: eui, appKey: keys.appKey || ZERO_KEY };
    try {
        await post(`${p(eui)}/keys`, { deviceKeys });
    } catch (e) {
        if (!is409(e)) throw e;
        await put(`${p(eui)}/keys`, { deviceKeys });
    }
}

export async function getActivation(eui) {
    try {
        const r = await get(`${p(eui)}/activation`);
        const a = r.deviceActivation;
        return a && a.devAddr && !/^0+$/.test(a.devAddr) ? a : null;
    } catch (e) {
        if (is404(e)) return null;
        throw e;
    }
}

export async function createDevice(device) {
    await post('/api/devices', { device });
}

// Lit le device, applique `mutate`, renvoie le device écrit.
export async function updateDevice(eui, mutate) {
    const { device } = await getDevice(eui);
    const next = mutate({ ...device, tags: { ...(device.tags || {}) }, variables: { ...(device.variables || {}) } }) || device;
    await put(p(eui), { device: next });
    return next;
}

export async function deleteDevice(eui) {
    await del(p(eui));
}

// Suppression tolérante : un 404 (déjà supprimé, par exemple après un réessai) n'est pas une erreur.
async function deleteIfPresent(eui) {
    try {
        await deleteDevice(eui);
    } catch (e) {
        if (!is404(e)) throw e;
    }
}

// Copie complète d'un device (fiche, clés, session) pour sauvegarde ou restauration.
export async function snapshot(eui) {
    const full = await getDevice(eui);
    const keys = await getKeys(eui);
    let activation = null;
    try {
        activation = await getActivation(eui);
    } catch {
        /* session illisible : on continue sans */
    }
    return { device: full.device, keys, activation };
}

// Recrée un device depuis une copie (fiche, clés, puis session si possible).
export async function restore(snap, ctx) {
    await createDevice(snap.device);
    if (snap.keys) await setKeys(snap.device.devEui, snap.keys);
    if (snap.activation) {
        try {
            await post(`${p(snap.device.devEui)}/activate`, { deviceActivation: snap.activation });
        } catch (e) {
            ctx?.warn?.(`session non restaurée (${humanize(e)}) : le device devra refaire un join`);
        }
    }
}

// ChirpStack ne permet pas toujours de changer l'application d'un device par simple mise à jour :
// on le constate une fois par serveur, puis on choisit la méthode pour toute la série.
let inPlaceMove = null; // null = inconnu, true/false une fois constaté

export function resetMoveDetection() {
    inPlaceMove = null;
}

/**
 * Déplace un device vers une autre application.
 * 1. Essai de déplacement direct (conserve tout, y compris l'historique).
 * 2. Sinon : copie (fiche + clés + session) → suppression → recréation dans la cible.
 *    Si la recréation échoue, le device est restauré dans son application d'origine.
 * onSnap(copie) est appelé avant toute modification, pour que la sauvegarde existe même en cas d'échec.
 */
export async function migrateDevice(eui, destAppId, ctx, onSnap) {
    const snap = await snapshot(eui);
    onSnap?.(snap);
    if (snap.device.applicationId === destAppId) return { snap, message: 'déjà dans cette application' };

    if (inPlaceMove !== false) {
        let accepted = false;
        try {
            await put(p(eui), { device: { ...snap.device, applicationId: destAppId } });
            accepted = true;
        } catch (e) {
            // Refus explicite de la méthode : on bascule. Toute autre erreur (réseau, droits) est remontée.
            if (!(e instanceof ApiError) || ![400, 501].includes(e.status)) throw e;
        }
        if (accepted) {
            const after = await getDevice(eui);
            if (after.device.applicationId === destAppId) {
                inPlaceMove = true;
                return { snap, message: 'déplacé (historique, clés et session conservés)' };
            }
        }
        inPlaceMove = false;
    }

    await deleteIfPresent(eui);
    try {
        await restore({ ...snap, device: { ...snap.device, applicationId: destAppId } }, ctx);
    } catch (err) {
        try {
            await deleteIfPresent(eui);
            await restore(snap, ctx);
        } catch (err2) {
            throw new Error(`recréation impossible (${humanize(err)}) et restauration impossible (${humanize(err2)}). Recréez-le depuis la sauvegarde JSON proposée à la fin.`);
        }
        throw new Error(`refusé par l'application cible (${humanize(err)}) : device remis dans son application d'origine`);
    }
    return { snap, message: snap.activation ? 'recréé avec clés et session' : snap.keys ? 'recréé avec ses clés' : 'recréé' };
}

/**
 * Met à jour un device existant à partir d'une ligne d'import (au lieu de le supprimer).
 * Seuls les champs fournis (non undefined) sont modifiés ; les tags sont fusionnés ; les clés existantes
 * (AppKey 1.1, GenAppKey) sont conservées quand le fichier ne les précise pas.
 */
export async function overwriteDevice(row) {
    const { device } = await getDevice(row.devEui);
    const next = { ...device, tags: { ...(device.tags || {}), ...row.tags } };
    for (const k of ['name', 'description', 'deviceProfileId', 'joinEui']) {
        if (row[k] !== undefined) next[k] = row[k];
    }
    await put(p(row.devEui), { device: next });
    if (row.nwkKey) {
        const current = await getKeys(row.devEui);
        await setKeys(row.devEui, { ...(current || {}), nwkKey: row.nwkKey, ...(row.appKey ? { appKey: row.appKey } : {}) });
    }
    return { previous: device };
}

// Recherche d'un device par DevEUI exact (null si absent).
export async function findDevice(eui) {
    try {
        return await getDevice(eui);
    } catch (e) {
        if (is404(e)) return null;
        throw e;
    }
}
