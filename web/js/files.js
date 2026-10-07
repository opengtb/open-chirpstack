// Lecture et écriture de fichiers : CSV (tous encodages), Excel, texte collé depuis un tableur.

import { t, csvSeparator } from './i18n.js';

// SheetJS n'est chargé qu'au premier besoin (fichier Excel ou export XLSX).
let xlsxLoading = null;
export function loadXLSX() {
    if (window.XLSX) return Promise.resolve(window.XLSX);
    if (!xlsxLoading) {
        xlsxLoading = new Promise((resolve, reject) => {
            const s = document.createElement('script');
            s.src = 'vendor/xlsx.full.min.js';
            s.onload = () => resolve(window.XLSX);
            s.onerror = () => reject(new Error(t('Impossible de charger le module Excel.')));
            document.head.appendChild(s);
        });
    }
    return xlsxLoading;
}

// ---------- Hexadécimal ----------
// Accepte « 70-B3-D5… », « 70:b3:d5… », « 0x70b3… », espaces : renvoie des minuscules sans séparateurs.
export function normHex(v) {
    return String(v ?? '').trim().replace(/^0x/i, '').replace(/[\s:\-_.]/g, '').toLowerCase();
}
export const isHex = (v, len) => new RegExp(`^[0-9a-f]{${len}}$`).test(v);

// ---------- CSV ----------
export function decodeText(buffer) {
    const bytes = new Uint8Array(buffer);
    let text;
    let encoding = 'UTF-8';
    try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
        // CSV enregistré par Excel en français : Windows-1252.
        text = new TextDecoder('windows-1252').decode(bytes);
        encoding = 'Windows-1252';
    }
    return { text: text.replace(/^\uFEFF/, ''), encoding };
}

export function detectSeparator(text) {
    const lines = [];
    let cur = '';
    let q = false;
    for (const ch of text.slice(0, 20000)) {
        if (ch === '"') q = !q;
        if ((ch === '\n') && !q) {
            if (cur.trim()) lines.push(cur);
            cur = '';
            if (lines.length >= 8) break;
        } else cur += ch;
    }
    if (cur.trim() && lines.length < 8) lines.push(cur);
    let best = ';';
    let bestScore = -1;
    for (const sep of ['\t', ';', ',', '|']) {
        const counts = lines.map((l) => {
            let n = 0;
            let inq = false;
            for (const ch of l) {
                if (ch === '"') inq = !inq;
                else if (ch === sep && !inq) n++;
            }
            return n;
        });
        if (!counts.length || counts[0] === 0) continue;
        const consistent = counts.every((c) => c === counts[0]);
        const score = (consistent ? 1000 : 0) + Math.min(...counts);
        if (score > bestScore) {
            bestScore = score;
            best = sep;
        }
    }
    return best;
}

// Analyseur RFC 4180 : guillemets, "" échappés, retours à la ligne dans les champs.
export function parseDelimited(text, sep) {
    const rows = [];
    let row = [];
    let field = '';
    let q = false;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (q) {
            if (ch === '"') {
                if (text[i + 1] === '"') {
                    field += '"';
                    i++;
                } else q = false;
            } else field += ch;
        } else if (ch === '"' && field === '') {
            q = true;
        } else if (ch === sep) {
            row.push(field);
            field = '';
        } else if (ch === '\n' || ch === '\r') {
            if (ch === '\r' && text[i + 1] === '\n') i++;
            row.push(field);
            rows.push(row);
            row = [];
            field = '';
        } else field += ch;
    }
    if (field !== '' || row.length) {
        row.push(field);
        rows.push(row);
    }
    return rows;
}

// Tableau brut (première ligne = en-têtes) → { headers, rows: [{entête: valeur}] }.
const isEmptyRow = (r) => !r || !r.some((c) => String(c ?? '').trim() !== '');

function toRecords(matrix, numericCells) {
    // On garde le numéro de ligne d'origine (1 = première ligne du fichier) pour les messages d'erreur.
    const nonEmpty = matrix.map((r, i) => ({ r, line: i + 1 })).filter((x) => !isEmptyRow(x.r));
    if (nonEmpty.length === 0) throw new Error(t('Le fichier est vide.'));
    const seen = {};
    const headers = nonEmpty[0].r.map((h, i) => {
        let name = String(h ?? '').trim() || `colonne_${i + 1}`;
        if (seen[name]) name = `${name}_${++seen[name]}`;
        else seen[name] = 1;
        return name;
    });
    const rows = nonEmpty.slice(1).map(({ r, line }) => {
        const o = {};
        headers.forEach((h, i) => { o[h] = String(r[i] ?? '').trim(); });
        Object.defineProperty(o, '_line', { value: line, enumerable: false });
        return o;
    });
    // numericCells : indices [ligne de données, colonne] des cellules Excel de type nombre
    const numeric = new Set();
    for (const [r, c] of numericCells || []) numeric.add(`${r}|${headers[c]}`);
    return { headers, rows, numeric };
}

export async function readFile(file) {
    const ext = file.name.split('.').pop().toLowerCase();
    const buffer = await file.arrayBuffer();
    if (['xlsx', 'xls', 'xlsm', 'ods'].includes(ext)) {
        const XLSX = await loadXLSX();
        const wb = XLSX.read(buffer, { type: 'array' });
        const name = wb.SheetNames[0];
        const ws = wb.Sheets[name];
        // Texte tel qu'affiché dans Excel (raw:false) pour garder les zéros de tête formatés.
        const matrix = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: false, blankrows: true });
        const range = XLSX.utils.decode_range(ws['!ref'] || 'A1:A1');
        const numericCells = [];
        let dataRow = -1;
        // Même critère de ligne vide que toRecords, appliqué au texte affiché (matrix).
        for (let r = range.s.r; r <= range.e.r; r++) {
            if (isEmptyRow(matrix[r - range.s.r])) continue;
            if (dataRow >= 0) {
                for (let c = range.s.c; c <= range.e.c; c++) {
                    const cell = ws[XLSX.utils.encode_cell({ r, c })];
                    if (cell && cell.t === 'n') numericCells.push([dataRow, c - range.s.c]);
                }
            }
            dataRow++;
        }
        return { ...toRecords(matrix, numericCells), source: t('{file} · feuille « {sheet} »', { file: file.name, sheet: name }), kind: 'excel' };
    }
    const { text, encoding } = decodeText(buffer);
    const sep = detectSeparator(text);
    return { ...toRecords(parseDelimited(text, sep)), source: t('{file} · {encoding} · séparateur {sep}', { file: file.name, encoding, sep: sepName(sep) }), kind: 'csv' };
}

export function readPasted(text) {
    const txt = text.replace(/^\uFEFF/, '');
    const sep = txt.includes('\t') ? '\t' : detectSeparator(txt);
    return { ...toRecords(parseDelimited(txt, sep)), source: t('texte collé · séparateur {sep}', { sep: sepName(sep) }), kind: 'paste' };
}

export function sepName(sep) {
    const names = { ';': 'point-virgule', ',': 'virgule', '\t': 'tabulation', '|': 'barre verticale' };
    return names[sep] ? t(names[sep]) : sep;
}

// ---------- Correspondance des colonnes ----------
const simplify = (s) => String(s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '');

export const FIELDS = [
    { key: 'dev_eui', label: 'DevEUI', required: true, aliases: ['deveui', 'eui', 'devui', 'deviceeui', 'eui64'] },
    { key: 'name', label: 'Nom', aliases: ['name', 'nom', 'devicename', 'nomdevice', 'libelle', 'designation', 'label'] },
    { key: 'description', label: 'Description', aliases: ['description', 'desc', 'commentaire', 'comment'] },
    { key: 'device_profile', label: 'Device Profile (nom ou ID)', aliases: ['deviceprofileid', 'deviceprofile', 'deviceprofilename', 'profil', 'profile', 'dp', 'dpid'] },
    { key: 'key', label: 'AppKey (LoRaWAN 1.0) / NwkKey', aliases: ['nwkkey', 'appkey', 'key', 'cle', 'cleapp', 'applicationkey'] },
    { key: 'app_key_11', label: 'AppKey LoRaWAN 1.1 (optionnel)', aliases: [] },
    { key: 'join_eui', label: 'JoinEUI / AppEUI (optionnel)', aliases: ['joineui', 'appeui', 'joinapp'] },
];

// Les libellés ci-dessus sont des clés françaises, traduites à l'affichage avec t(label).

// Colonnes jamais proposées comme tags par défaut (issues d'un export, état du device…).
const NOT_TAGS = ['key', 'cle', 'cleapp', 'applicationkey', 'name', 'nom', 'description', 'devicename', 'deviceprofile', 'deviceprofileid', 'createdat', 'updatedat', 'lastseenat', 'lastseen', 'derniervu', 'status', 'statut', 'battery', 'batterie', 'margin', 'application', 'applicationid', 'applicationname', 'deviceprofilename', 'tenant', 'tenantid', 'nwkkey', 'appkey', 'genappkey', 'joineui', 'appeui', 'deveui', 'devaddr', 'nwkskey', 'appskey'];

export function autoMap(headers) {
    const s = headers.map(simplify);
    const map = {};
    const used = new Set();
    const take = (field, cands) => {
        for (const c of cands) {
            const i = s.findIndex((h, idx) => !used.has(idx) && h === c);
            if (i >= 0) {
                map[field] = headers[i];
                used.add(i);
                return;
            }
        }
    };
    // LoRaWAN 1.1 : deux colonnes nwk_key et app_key distinctes.
    if (s.includes('nwkkey') && s.includes('appkey')) {
        take('key', ['nwkkey']);
        take('app_key_11', ['appkey']);
    }
    for (const f of FIELDS) if (!map[f.key]) take(f.key, f.aliases);
    // Correspondances partielles pour DevEUI et nom (« DevEUI capteur », « Nom du point »).
    if (!map.dev_eui) {
        const i = s.findIndex((h, idx) => !used.has(idx) && h.includes('deveui'));
        if (i >= 0) { map.dev_eui = headers[i]; used.add(i); }
    }
    if (!map.name) {
        const i = s.findIndex((h, idx) => !used.has(idx) && (h.startsWith('nom') || h.startsWith('name')));
        if (i >= 0) { map.name = headers[i]; used.add(i); }
    }
    return map;
}

// Colonnes restantes proposées comme tags (cochées si elles ressemblent à des tags).
export function tagCandidates(headers, mapping) {
    const mapped = new Set(Object.values(mapping));
    return headers.filter((h) => !mapped.has(h)).map((h) => {
        const prefixed = /^tags?[:.]/i.test(h);
        const key = prefixed ? h.replace(/^tags?[:.]/i, '').trim() : h;
        return { column: h, key, checked: prefixed || !NOT_TAGS.includes(simplify(h)) };
    });
}

// ---------- Export ----------
const csvCell = (v, sep) => {
    let s = String(v ?? '');
    // Une cellule commençant par = + - @ serait exécutée comme formule par Excel.
    if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+([.,]\d+)?$/.test(s)) s = `'${s}`;
    return /["\n\r]/.test(s) || s.includes(sep) ? `"${s.replace(/"/g, '""')}"` : s;
};

// CSV avec BOM UTF-8 ; séparateur selon la langue (point-virgule pour Excel français, virgule sinon).
export function toCSV(headers, rows) {
    const sep = csvSeparator();
    return '\uFEFF' + [headers, ...rows].map((r) => r.map((v) => csvCell(v, sep)).join(sep)).join('\r\n');
}

export async function toXLSX(headers, rows, sheet = 'devices') {
    const XLSX = await loadXLSX();
    const ws = XLSX.utils.aoa_to_sheet([headers, ...rows]);
    // Colonnes d'identifiants en texte pour qu'Excel ne les transforme pas en nombres.
    const range = XLSX.utils.decode_range(ws['!ref']);
    for (let r = 1; r <= range.e.r; r++) {
        for (let c = 0; c <= range.e.c; c++) {
            const cell = ws[XLSX.utils.encode_cell({ r, c })];
            if (cell) { cell.t = 's'; cell.v = String(cell.v ?? ''); cell.z = '@'; }
        }
    }
    ws['!cols'] = headers.map((h) => ({ wch: Math.min(40, Math.max(10, String(h).length + 2)) }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, sheet.slice(0, 31));
    const out = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
    return new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}
