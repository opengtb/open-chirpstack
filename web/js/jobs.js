// Exécution d'une opération en masse avec fenêtre de progression, arrêt, journal et rapport d'erreurs.

import { CONCURRENCY, humanize, pool } from './api.js';
import { $, download, fmtNum, html, icon, openDialog, render, today } from './ui.js';
import { toCSV } from './files.js';
import { t } from './i18n.js';

/**
 * runJob({
 *   title, verb,                 // « Suppression », « supprimé(s) »
 *   items,                       // éléments à traiter
 *   label: (item) => string,     // texte du journal (nom / DevEUI)
 *   run: async (item, ctx) => message|undefined,  // lève une erreur en cas d'échec ; ctx.warn(msg) pour un avertissement
 *   concurrency,
 *   after: (result) => [{ label, onClick, danger }]  // actions proposées à la fin
 * }) → Promise<{ done: [], failed: [{ item, error }], warnings: [], stopped }>
 */
export function runJob({ title, verb = t('traité(s)'), items, label, run, concurrency = CONCURRENCY, after }) {
    const controller = new AbortController();
    const done = [];
    const failed = [];
    const warnings = [];
    let running = true;

    const dlg = openDialog({
        title,
        wide: true,
        body: html`
            <div class="row"><div class="grow progress"><i></i></div><span class="mono small num" data-pct>0 %</span></div>
            <div class="job-stats">
                <span>${t('total')} <strong class="num">${fmtNum(items.length)}</strong></span>
                <span class="ok">${verb} <strong class="num" data-ok>0</strong></span>
                <span class="err">${t('erreurs')} <strong class="num" data-err>0</strong></span>
                <span class="warn" data-warnwrap hidden>${t('avertissements')} <strong class="num" data-warn>0</strong></span>
            </div>
            <div class="log" data-log aria-live="polite"></div>
            <div data-summary class="mt"></div>`,
        foot: html`<span class="left xs dim" data-hint>${t('Ne fermez pas cette page pendant l’opération.')}</span>
            <button class="btn btn-danger" data-stop>${icon('stop')} ${t('Arrêter')}</button>`,
        keepOpen: () => running,
    });
    const el = dlg.el;
    // Échap ne doit pas fermer la fenêtre pendant le traitement.
    el.addEventListener('cancel', (e) => { if (running) e.preventDefault(); });
    el.addEventListener('click', (e) => { if (running && (e.target === el || e.target.closest('[data-close]'))) e.stopImmediatePropagation(); }, true);

    const logBox = $('[data-log]', el);
    const bar = $('.progress > i', el);
    let lines = 0;
    const log = (text, cls) => {
        const d = document.createElement('div');
        d.className = cls;
        d.textContent = text;
        logBox.appendChild(d);
        if (++lines > 400) logBox.firstChild.remove();
        logBox.scrollTop = logBox.scrollHeight;
    };
    const update = () => {
        const n = done.length + failed.length;
        const pct = items.length ? Math.round((n / items.length) * 100) : 100;
        bar.style.width = `${pct}%`;
        $('[data-pct]', el).textContent = `${pct} %`;
        $('[data-ok]', el).textContent = fmtNum(done.length);
        $('[data-err]', el).textContent = fmtNum(failed.length);
        $('[data-warn]', el).textContent = fmtNum(warnings.length);
        $('[data-warnwrap]', el).hidden = warnings.length === 0;
    };

    $('[data-stop]', el).addEventListener('click', (e) => {
        controller.abort();
        e.currentTarget.disabled = true;
        e.currentTarget.textContent = t('Arrêt en cours…');
    });

    const promise = (async () => {
        await pool(items, concurrency, async (item) => {
            const name = label(item);
            try {
                const msg = await run(item, { warn: (w) => { warnings.push({ item, warning: w }); log(`⚠ ${name} : ${w}`, 'l-warn'); }, signal: controller.signal });
                done.push(item);
                log(`✓ ${name}${msg ? ' — ' + msg : ''}`, 'l-ok');
            } catch (err) {
                const error = humanize(err);
                failed.push({ item, error });
                log(`✗ ${name} : ${error}`, 'l-err');
            }
            update();
        }, controller.signal);
        running = false;
        const stopped = controller.signal.aborted;
        const notRun = items.length - done.length - failed.length;
        const result = { done, failed, warnings, stopped };

        $('.progress', el).classList.toggle('indeterminate', false);
        const cls = failed.length ? 'warn' : stopped ? 'warn' : 'ok';
        render($('[data-summary]', el), html`<div class="callout ${cls}">${icon(failed.length ? 'alert' : 'check')}<div>
            <strong>${stopped ? t('Opération arrêtée.') : t('Terminé.')}</strong>
            ${fmtNum(done.length)} ${verb}${failed.length ? html`, <span class="err">${t('{n} en erreur', { n: fmtNum(failed.length) })}</span>` : ''}${notRun > 0 ? `, ${t('{n} non traité(s)', { n: fmtNum(notRun) })}` : ''}.
        </div></div>`);

        const extra = after ? after(result) : [];
        const foot = $('.dlg-foot', el);
        render(foot, html`
            ${failed.length ? html`<button class="btn left" data-errors>${icon('download')} ${t('Rapport d’erreurs (CSV)')}</button>` : html`<span class="left"></span>`}
            ${extra.map((a, i) => html`<button class="btn ${a.danger ? 'btn-danger' : ''}" data-extra="${i}">${a.label}</button>`)}
            <button class="btn btn-primary" data-close autofocus>${t('Fermer')}</button>`);
        foot.addEventListener('click', (e) => {
            if (e.target.closest('[data-errors]')) {
                const rows = failed.map((f) => [label(f.item), f.item?.devEui || '', f.error]);
                download(toCSV([t('element'), 'dev_eui', t('erreur')], rows), `${t('erreurs')}-${today()}.csv`, 'text/csv;charset=utf-8');
            }
            const x = e.target.closest('[data-extra]');
            if (x) {
                dlg.close();
                extra[Number(x.dataset.extra)].onClick();
            }
        });
        $('[data-close]', foot).focus();
        return result;
    })();

    return promise;
}
