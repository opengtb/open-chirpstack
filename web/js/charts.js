// Petits graphiques SVG (sans dépendance) pour la fiche device : courbe de mesure et histogramme.

import { esc, raw } from './ui.js';
import { t, locale } from './i18n.js';

const W = 520;
const H = 130;
const PAD_TOP = 8;

// Formateur recréé si la langue change.
let nf2 = null;
const nf = () => {
    if (nf2?.resolvedOptions().locale !== locale()) nf2 = new Intl.NumberFormat(locale(), { maximumFractionDigits: 2 });
    return nf2;
};
export const fmtVal = (v) => (v === null || v === undefined || !Number.isFinite(v) ? '—' : nf().format(v));

export function fmtTs(t, agg) {
    const d = new Date(t);
    if (agg === 'MONTH') return d.toLocaleDateString(locale(), { month: 'short', year: 'numeric' });
    if (agg === 'DAY') return d.toLocaleDateString(locale(), { day: '2-digit', month: '2-digit' });
    return d.toLocaleString(locale(), { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

// Unité devinée depuis le nom de la mesure (« Index (Wh) ») ou sa clé (temperature, humidity…).
export function unitOf(key, name) {
    const paren = /\(([^)]{1,8})\)\s*$/.exec(name || '');
    if (paren) return paren[1];
    const k = `${key} ${name}`.toLowerCase();
    if (/temp/.test(k)) return '°C';
    if (/humid|hygro|\brh\b/.test(k)) return '%';
    if (/co2/.test(k)) return 'ppm';
    if (/volt|tension|_v\b|vbat/.test(k)) return 'V';
    if (/batt|pile/.test(k)) return '%';
    if (/press/.test(k)) return 'hPa';
    if (/lux|light|lumin|illum/.test(k)) return 'lx';
    if (/power|puissance/.test(k)) return 'W';
    return '';
}

function frame(inner, { min, max, unit, first, last, agg }) {
    return raw(`<svg class="chart" viewBox="0 0 ${W} ${H + 18}" preserveAspectRatio="none" role="img">
        <line class="grid-line" x1="0" x2="${W}" y1="${H}" y2="${H}"/>
        <line class="grid-line" x1="0" x2="${W}" y1="${PAD_TOP}" y2="${PAD_TOP}" stroke-dasharray="3 3"/>
        <line class="grid-line" x1="0" x2="${W}" y1="${(H + PAD_TOP) / 2}" y2="${(H + PAD_TOP) / 2}" stroke-dasharray="3 3"/>
        ${inner}
        <text x="${W}" y="${PAD_TOP + 10}" text-anchor="end">${esc(fmtVal(max))} ${esc(unit)}</text>
        <text x="${W}" y="${H - 4}" text-anchor="end">${esc(fmtVal(min))} ${esc(unit)}</text>
        <text x="0" y="${H + 14}">${first ? esc(fmtTs(first, agg)) : ''}</text>
        <text x="${W}" y="${H + 14}" text-anchor="end">${last ? esc(fmtTs(last, agg)) : ''}</text>
    </svg>`);
}

/**
 * Courbe ; values[i] = null pour un intervalle sans donnée (la courbe est interrompue).
 */
export function lineChart(timestamps, values, { unit = '', agg = 'HOUR' } = {}) {
    const pts = values.map((v, i) => ({ v, i })).filter((p) => p.v !== null && Number.isFinite(p.v));
    if (!pts.length) return raw(`<p class="dim small">${esc(t('Aucune valeur sur cette période.'))}</p>`);
    let min = Math.min(...pts.map((p) => p.v));
    let max = Math.max(...pts.map((p) => p.v));
    if (min === max) { min -= 1; max += 1; }
    const span = max - min;
    const lo = min - span * 0.08;
    const hi = max + span * 0.08;
    const n = Math.max(1, values.length - 1);
    const x = (i) => (values.length === 1 ? W / 2 : (i / n) * W);
    const y = (v) => PAD_TOP + (1 - (v - lo) / (hi - lo)) * (H - PAD_TOP);

    // Segments continus (coupés aux trous)
    const segs = [];
    let cur = [];
    values.forEach((v, i) => {
        if (v === null || !Number.isFinite(v)) {
            if (cur.length) segs.push(cur);
            cur = [];
        } else cur.push([x(i), y(v)]);
    });
    if (cur.length) segs.push(cur);
    const paths = segs.map((s) => {
        const d = s.map(([px, py], k) => `${k ? 'L' : 'M'}${px.toFixed(1)},${py.toFixed(1)}`).join('');
        const area = s.length > 1 ? `<path class="area" d="${d}L${s[s.length - 1][0].toFixed(1)},${H}L${s[0][0].toFixed(1)},${H}Z"/>` : '';
        return `${area}<path class="line" d="${d}"/>`;
    }).join('');
    const dots = pts.length <= 60
        ? pts.map((p) => `<circle class="dot" cx="${x(p.i).toFixed(1)}" cy="${y(p.v).toFixed(1)}" r="2.2"><title>${esc(t('{date} : {value}', { date: fmtTs(timestamps[p.i], agg), value: `${fmtVal(p.v)} ${unit}` }))}</title></circle>`).join('')
        // Trop de points : zones invisibles pour l'infobulle
        : pts.map((p) => `<rect class="hit" x="${(x(p.i) - W / values.length / 2).toFixed(1)}" y="0" width="${(W / values.length).toFixed(1)}" height="${H}"><title>${esc(t('{date} : {value}', { date: fmtTs(timestamps[p.i], agg), value: `${fmtVal(p.v)} ${unit}` }))}</title></rect>`).join('');
    return frame(paths + dots, { min, max, unit, first: timestamps[0], last: timestamps[timestamps.length - 1], agg });
}

export function barChart(timestamps, values, { unit = '', agg = 'HOUR', label = '' } = {}) {
    const vals = values.map((v) => (Number.isFinite(v) ? v : 0));
    const max = Math.max(1, ...vals);
    const bw = W / Math.max(1, vals.length);
    const bars = vals.map((v, i) => {
        const h = Math.max(v ? 2 : 1, (v / max) * (H - PAD_TOP));
        return `<rect class="bar ${v ? '' : 'zero'}" x="${(i * bw + 1).toFixed(1)}" y="${(H - h).toFixed(1)}" width="${Math.max(1, bw - 2).toFixed(1)}" height="${h.toFixed(1)}"><title>${esc(t('{date} : {value}', { date: fmtTs(timestamps[i], agg), value: `${fmtVal(v)} ${unit || label}` }))}</title></rect>`;
    }).join('');
    return frame(bars, { min: 0, max, unit, first: timestamps[0], last: timestamps[timestamps.length - 1], agg });
}
