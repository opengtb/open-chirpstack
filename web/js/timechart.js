// Graphique temporel interactif (SVG, sans dépendance) : axes par unité, curseur synchronisé,
// infobulle multi-courbes, zoom par sélection, double-clic pour revenir.
// Les couleurs sont écrites en attributs (pas en classes CSS) pour que l'export PNG reste fidèle.

const NS = 'http://www.w3.org/2000/svg';
const HOUR = 3600e3;
const DAY = 24 * HOUR;

const nf = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 2 });
export const fmtNumber = (v) => (v === null || v === undefined || !Number.isFinite(v) ? '—' : nf.format(v));

export function fmtTime(t, withYear = false) {
    return new Date(t).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', ...(withYear ? { year: 'numeric' } : {}), hour: '2-digit', minute: '2-digit' });
}

function el(tag, attrs = {}, parent) {
    const e = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null) e.setAttribute(k, v);
    if (parent) parent.appendChild(e);
    return e;
}

function theme() {
    const cs = getComputedStyle(document.documentElement);
    const v = (n) => cs.getPropertyValue(n).trim();
    return { fg: v('--fg'), dim: v('--text-dim'), soft: v('--text-soft'), grid: v('--line-soft'), border: v('--border'), card: v('--card'), mono: v('--font-mono'), primary: v('--primary') };
}

// Graduations « rondes » pour l'axe des valeurs.
function niceTicks(min, max, count = 5) {
    const span = max - min || 1;
    const raw = span / count;
    const mag = 10 ** Math.floor(Math.log10(raw));
    const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) || 10 * mag;
    const start = Math.ceil(min / step) * step;
    const ticks = [];
    for (let t = start; t <= max + step * 1e-9; t += step) ticks.push(Math.round(t / step) * step);
    return ticks;
}

// Graduations de temps alignées sur l'heure locale.
function timeTicks(from, to, width) {
    const maxTicks = Math.max(2, Math.floor(width / 95));
    const steps = [HOUR, 2 * HOUR, 3 * HOUR, 6 * HOUR, 12 * HOUR, DAY, 2 * DAY, 7 * DAY, 14 * DAY, 30 * DAY, 91 * DAY];
    const step = steps.find((s) => (to - from) / s <= maxTicks) || 182 * DAY;
    const ticks = [];
    const d = new Date(from);
    if (step >= 30 * DAY) {
        d.setDate(1); d.setHours(0, 0, 0, 0);
        const months = Math.round(step / (30 * DAY));
        while (d.getTime() < from) d.setMonth(d.getMonth() + 1);
        while (d.getTime() <= to) { ticks.push({ t: d.getTime(), label: d.toLocaleDateString('fr-FR', { month: 'short', year: '2-digit' }) }); d.setMonth(d.getMonth() + months); }
    } else if (step >= DAY) {
        d.setHours(0, 0, 0, 0);
        while (d.getTime() < from) d.setDate(d.getDate() + 1);
        const n = Math.round(step / DAY);
        while (d.getTime() <= to) { ticks.push({ t: d.getTime(), label: d.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' }) }); d.setDate(d.getDate() + n); }
    } else {
        d.setMinutes(0, 0, 0);
        const h = Math.round(step / HOUR);
        while (d.getTime() < from || d.getHours() % h) d.setHours(d.getHours() + 1);
        while (d.getTime() <= to) {
            const midnight = d.getHours() === 0;
            ticks.push({ t: d.getTime(), label: midnight ? d.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' }) : d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }), strong: midnight });
            d.setHours(d.getHours() + h);
        }
    }
    return ticks;
}

// Point le plus proche de t (tableau trié), dans la limite de tol.
function nearest(pts, t, tol) {
    let lo = 0;
    let hi = pts.length - 1;
    if (hi < 0) return null;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (pts[mid][0] < t) lo = mid + 1;
        else hi = mid;
    }
    let best = null;
    for (const i of [lo - 1, lo]) {
        const p = pts[i];
        if (p && p[1] !== null && Math.abs(p[0] - t) <= tol && (!best || Math.abs(p[0] - t) < Math.abs(best[0] - t))) best = p;
    }
    return best;
}

function bucketOf(pts) {
    const diffs = [];
    for (let i = 1; i < pts.length && diffs.length < 50; i++) diffs.push(pts[i][0] - pts[i - 1][0]);
    diffs.sort((a, b) => a - b);
    return diffs.length ? diffs[diffs.length >> 1] : HOUR;
}

/**
 * timeChart(container, { height }) → { set(model), cursor(t), svg(), destroy() }
 * model = { from, to, series: [{ label, color, unit, kind, axis: 'left'|'right', pts: [[t, v|null]] }],
 *           onCursor(t|null), onZoom(from, to), onReset() }
 */
export function timeChart(container, { height = 340 } = {}) {
    container.classList.add('tchart');
    container.style.position = 'relative';
    const svg = el('svg', { width: '100%', height, role: 'img' }, container);
    svg.style.display = 'block';
    svg.style.userSelect = 'none';
    const tip = document.createElement('div');
    tip.className = 'tchart-tip';
    tip.hidden = true;
    container.appendChild(tip);

    let model = null;
    let geo = null; // géométrie du dernier rendu
    let drag = null;
    let cursorT = null;

    function scales(width) {
        const hasRight = model.series.some((s) => s.axis === 'right');
        const m = { l: 58, r: hasRight ? 58 : 18, t: 14, b: 28 };
        const w = Math.max(50, width - m.l - m.r);
        const h = height - m.t - m.b;
        const x = (t) => m.l + ((t - model.from) / (model.to - model.from)) * w;
        const xinv = (px) => model.from + ((px - m.l) / w) * (model.to - model.from);
        const axes = {};
        for (const side of ['left', 'right']) {
            const ser = model.series.filter((s) => s.axis === side);
            if (!ser.length) continue;
            let lo = Infinity;
            let hi = -Infinity;
            for (const s of ser) {
                for (const [t, v] of s.pts) {
                    if (v === null || t < model.from || t > model.to) continue;
                    lo = Math.min(lo, v);
                    hi = Math.max(hi, v);
                }
                if (s.kind === 'ABSOLUTE') lo = Math.min(lo, 0);
            }
            if (!Number.isFinite(lo)) { lo = 0; hi = 1; }
            if (lo === hi) { lo -= 1; hi += 1; }
            const pad = (hi - lo) * 0.06;
            lo -= pad; hi += pad;
            const ticks = niceTicks(lo, hi);
            axes[side] = { lo, hi, ticks, unit: ser[0].unit, y: (v) => m.t + (1 - (v - lo) / (hi - lo)) * h };
        }
        return { m, w, h, x, xinv, axes, width };
    }

    function draw() {
        if (!model) return;
        const width = container.clientWidth || 600;
        svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
        svg.setAttribute('width', width);
        svg.textContent = '';
        const T = theme();
        const g = scales(width);
        geo = g;
        const { m, w, h, x, axes } = g;
        const font = { 'font-family': T.mono || 'monospace', 'font-size': 10.5, fill: T.dim };

        el('rect', { x: 0, y: 0, width, height, fill: T.card }, svg);
        // Grille et axe des temps
        for (const tk of timeTicks(model.from, model.to, w)) {
            const px = x(tk.t);
            el('line', { x1: px, x2: px, y1: m.t, y2: m.t + h, stroke: tk.strong ? T.border : T.grid, 'stroke-width': 1 }, svg);
            el('text', { ...font, x: px, y: height - 9, 'text-anchor': 'middle', fill: tk.strong ? T.soft : T.dim }, svg).textContent = tk.label;
        }
        for (const side of ['left', 'right']) {
            const a = axes[side];
            if (!a) continue;
            for (const tv of a.ticks) {
                const py = a.y(tv);
                if (side === 'left' || !axes.left) el('line', { x1: m.l, x2: m.l + w, y1: py, y2: py, stroke: T.grid }, svg);
                el('text', { ...font, x: side === 'left' ? m.l - 6 : m.l + w + 6, y: py + 3.5, 'text-anchor': side === 'left' ? 'end' : 'start' }, svg).textContent = fmtNumber(tv);
            }
            if (a.unit) el('text', { ...font, x: side === 'left' ? m.l - 6 : m.l + w + 6, y: m.t - 3, 'text-anchor': side === 'left' ? 'end' : 'start', fill: T.soft }, svg).textContent = a.unit;
        }
        el('line', { x1: m.l, x2: m.l + w, y1: m.t + h, y2: m.t + h, stroke: T.border }, svg);

        // Courbes (coupées aux trous) ; compteurs par période en barres
        const clip = el('clipPath', { id: `clip-${Math.random().toString(36).slice(2)}` }, el('defs', {}, svg));
        el('rect', { x: m.l, y: m.t, width: w, height: h }, clip);
        const plot = el('g', { 'clip-path': `url(#${clip.id})` }, svg);
        for (const s of model.series) {
            const a = axes[s.axis];
            if (!a || s.hidden) continue;
            if (s.kind === 'ABSOLUTE') {
                const bw = Math.max(1, (bucketOf(s.pts) / (model.to - model.from)) * w - 1);
                for (const [t, v] of s.pts) {
                    if (v === null) continue;
                    const y0 = a.y(Math.max(a.lo, 0));
                    const y1 = a.y(v);
                    el('rect', { x: x(t) - bw / 2, y: Math.min(y0, y1), width: bw, height: Math.max(1, Math.abs(y0 - y1)), fill: s.color, 'fill-opacity': 0.55 }, plot);
                }
                continue;
            }
            let d = '';
            let pen = false;
            let n = 0;
            for (const [t, v] of s.pts) {
                if (v === null) { pen = false; continue; }
                d += `${pen ? 'L' : 'M'}${x(t).toFixed(1)},${a.y(v).toFixed(1)}`;
                pen = true;
                n++;
            }
            el('path', { d, fill: 'none', stroke: s.color, 'stroke-width': s.dashed ? 1.6 : 2, 'stroke-dasharray': s.dashed ? '5 4' : null, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }, plot);
            // Points isolés (entre deux trous) visibles quand même
            if (n < 80) {
                s.pts.forEach(([t, v], i) => {
                    const prev = s.pts[i - 1]?.[1];
                    const next = s.pts[i + 1]?.[1];
                    if (v !== null && (prev === null || prev === undefined) && (next === null || next === undefined)) el('circle', { cx: x(t), cy: a.y(v), r: 2.5, fill: s.color }, plot);
                });
            }
        }

        // Calques interactifs
        geo.cursorLayer = el('g', {}, svg);
        geo.selLayer = el('rect', { y: m.t, height: h, fill: T.primary, 'fill-opacity': 0.12, stroke: T.primary, 'stroke-opacity': 0.4, visibility: 'hidden' }, svg);
        const hit = el('rect', { x: m.l, y: m.t, width: w, height: h, fill: 'transparent', style: 'cursor:crosshair' }, svg);
        hit.addEventListener('mousemove', onMove);
        hit.addEventListener('mouseleave', () => { if (!drag) model.onCursor?.(null); });
        hit.addEventListener('mousedown', onDown);
        hit.addEventListener('dblclick', () => model.onReset?.());
        if (cursorT !== null) cursor(cursorT);
    }

    const localX = (ev) => ev.clientX - svg.getBoundingClientRect().left;

    function onMove(ev) {
        const px = localX(ev);
        if (drag) {
            drag.x1 = Math.max(geo.m.l, Math.min(geo.m.l + geo.w, px));
            const a = Math.min(drag.x0, drag.x1);
            geo.selLayer.setAttribute('x', a);
            geo.selLayer.setAttribute('width', Math.abs(drag.x1 - drag.x0));
            geo.selLayer.setAttribute('visibility', 'visible');
        }
        model.onCursor?.(geo.xinv(px));
    }

    function onDown(ev) {
        if (ev.button !== 0) return;
        ev.preventDefault();
        drag = { x0: localX(ev), x1: localX(ev) };
        const up = () => {
            window.removeEventListener('mouseup', up);
            window.removeEventListener('mousemove', moveOut);
            const d = drag;
            drag = null;
            geo.selLayer.setAttribute('visibility', 'hidden');
            if (Math.abs(d.x1 - d.x0) > 8) {
                const a = geo.xinv(Math.min(d.x0, d.x1));
                const b = geo.xinv(Math.max(d.x0, d.x1));
                model.onZoom?.(a, b);
            }
        };
        const moveOut = (e) => { if (drag) onMove(e); };
        window.addEventListener('mouseup', up);
        window.addEventListener('mousemove', moveOut);
    }

    // Affiche le curseur à l'instant t (appelé aussi par les graphiques synchronisés).
    function cursor(t) {
        cursorT = t;
        if (!geo || !model) return;
        const layer = geo.cursorLayer;
        layer.textContent = '';
        if (t === null || t < model.from || t > model.to) { tip.hidden = true; return; }
        const T = theme();
        const px = geo.x(t);
        el('line', { x1: px, x2: px, y1: geo.m.t, y2: geo.m.t + geo.h, stroke: T.soft, 'stroke-width': 1, 'stroke-dasharray': '3 3' }, layer);
        const rows = [];
        let at = null;
        for (const s of model.series) {
            if (s.hidden) continue;
            const a = geo.axes[s.axis];
            const p = nearest(s.pts, t, bucketOf(s.pts) * 0.6);
            if (p && a) {
                el('circle', { cx: geo.x(p[0]), cy: a.y(p[1]), r: 4, fill: T.card, stroke: s.color, 'stroke-width': 2 }, layer);
                at = at ?? p[0];
            }
            rows.push({ s, v: p ? p[1] : null });
        }
        tip.textContent = '';
        const head = document.createElement('div');
        head.className = 'tchart-tip-head';
        head.textContent = fmtTime(at ?? t);
        tip.appendChild(head);
        for (const { s, v } of rows) {
            const r = document.createElement('div');
            r.className = 'tchart-tip-row';
            const sw = document.createElement('i');
            sw.style.background = s.color;
            const lab = document.createElement('span');
            lab.textContent = s.label;
            const val = document.createElement('strong');
            val.textContent = v === null ? '—' : `${fmtNumber(v)}${s.unit ? ' ' + s.unit : ''}`;
            r.append(sw, lab, val);
            tip.appendChild(r);
        }
        tip.hidden = false;
        const box = container.clientWidth;
        const tw = tip.offsetWidth;
        tip.style.left = `${px + 14 + tw > box ? px - tw - 14 : px + 14}px`;
        tip.style.top = `${geo.m.t + 4}px`;
    }

    const ro = new ResizeObserver(() => draw());
    ro.observe(container);

    return {
        set(next) { model = next; draw(); },
        cursor,
        svg: () => svg,
        destroy() { ro.disconnect(); container.textContent = ''; },
    };
}
