// Opérations sur les devices, prudentes : jamais de suppression sans copie de sauvegarde ni restauration en cas d'échec.

import { ApiError, del, get, humanize, post, put } from './api.js';

const p = (eui) => `/api/devices/${encodeURIComponent(eui)}`;
const is404 = (e) => e instanceof ApiError && e.status === 404;
const is409 = (e) => e instanceof ApiError && e.status === 409;

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

export async function setKeys(eui, { nwkKey, appKey }) {
    const deviceKeys = { devEui: eui, nwkKey, appKey: appKey || '00000000000000000000000000000000' };
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

async function restore(snap, ctx) {
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
// on le vérifie sur le premier device, puis on choisit la méthode pour toute la série.
let inPlaceMove = null; // null = inconnu, true/false après le premier essai

/**
 * Déplace un device vers une autre application.
 * 1. Essai de déplacement direct (conserve tout).
 * 2. Sinon : copie (fiche + clés + session) → suppression → recréation dans la cible.
 *    Si la recréation échoue, le device est restauré dans son application d'origine.
 * Renvoie la copie de sauvegarde.
 */
export async function migrateDevice(eui, destAppId, ctx) {
    const snap = await snapshot(eui);
    if (snap.device.applicationId === destAppId) return { snap, message: 'déjà dans cette application' };

    if (inPlaceMove !== false) {
        try {
            await put(p(eui), { device: { ...snap.device, applicationId: destAppId } });
            const after = await getDevice(eui);
            if (after.device.applicationId === destAppId) {
                inPlaceMove = true;
                return { snap, message: 'déplacé (clés et session conservées)' };
            }
        } catch {
            /* méthode non supportée : repli */
        }
        inPlaceMove = false;
    }

    await deleteDevice(eui);
    try {
        await restore({ ...snap, device: { ...snap.device, applicationId: destAppId } }, ctx);
    } catch (err) {
        try {
            await deleteDevice(eui).catch(() => {});
            await restore(snap, ctx);
        } catch (err2) {
            throw new Error(`recréation impossible (${humanize(err)}) et restauration impossible (${humanize(err2)}). Utilisez la sauvegarde JSON pour le recréer.`);
        }
        throw new Error(`refusé par l'application cible (${humanize(err)}) : device remis dans son application d'origine`);
    }
    return { snap, message: snap.activation ? 'recréé avec clés et session' : snap.keys ? 'recréé avec ses clés' : 'recréé' };
}

export function resetMoveDetection() {
    inPlaceMove = null;
}

/**
 * Met à jour un device existant à partir d'une ligne d'import (au lieu de le supprimer).
 * Seuls les champs renseignés sont modifiés ; les tags sont fusionnés.
 */
export async function overwriteDevice(row) {
    const { device } = await getDevice(row.devEui);
    const next = {
        ...device,
        name: row.name || device.name,
        description: row.description ?? device.description,
        deviceProfileId: row.deviceProfileId || device.deviceProfileId,
        joinEui: row.joinEui || device.joinEui,
        tags: { ...(device.tags || {}), ...row.tags },
    };
    const moved = next.applicationId !== row.applicationId;
    await put(p(row.devEui), { device: next });
    if (row.nwkKey) await setKeys(row.devEui, { nwkKey: row.nwkKey, appKey: row.appKey });
    return { previous: device, moved };
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
