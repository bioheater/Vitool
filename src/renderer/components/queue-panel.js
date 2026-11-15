// Zeigt laufende und fertige Aufgaben unten im Fenster.
// Zeilen bleiben bestehen und ändern nur Text und Balken, sonst würde die Liste bei jedem Schritt springen.
import { el } from '../utils/dom.js';
import { isMediaFile, sendTo, followTarget, forgetFollow, onFollowChange, targetLabel } from '../utils/navigation.js';
import { createSendTo } from './send-to.js';
import { fixButton } from './error-fix.js';
import { t } from '../utils/i18n.js';

const STATUS_CLASS = { done: 'ok', failed: 'bad', canceled: 'muted' };

function isActive(job) {
  return job.status === 'queued' || job.status === 'running';
}

function createRow(job) {
  const detail = el('span', { class: 'job-detail' });
  const fill = el('div', { class: 'progress-fill' });
  const bar = el('div', { class: 'progress', role: 'progressbar', 'aria-label': job.title }, fill);
  const actions = el('span', { class: 'job-actions' });
  const error = el('p', { class: 'job-error', hidden: true });
  const title = el('span', { class: 'job-title' });
  const node = el('li', { class: 'job' },
    el('div', { class: 'job-head' }, title, detail, actions),
    bar,
    error);
  return { node, title, detail, fill, bar, actions, error, status: null };
}

// Ein Zwischenstand wird erst hier zur richtigen Datei. Vorgeschlagen wird der Ordner der ursprünglichen Datei.
async function keepDraft(filePath) {
  const home = await window.vitool.invoke('drafts:home', filePath);
  const folder = await window.vitool.invoke('dialog:pickFolder', home);
  if (folder) await window.vitool.invoke('drafts:keep', { filePath, folder });
}

function updateRow(row, job) {
  const unknown = job.status === 'running' && job.progress === null;
  const value = job.status === 'done' ? 100 : job.progress ?? 0;
  const percent = job.status === 'running' && job.progress !== null ? `${Math.round(job.progress)} %` : '';

  // Bei Seiten aus einer Linkliste kennt Vitool den richtigen Titel erst nach der Suche.
  if (row.title.textContent !== job.title) {
    row.title.textContent = job.title;
    row.title.title = job.title;
    row.bar.setAttribute('aria-label', job.title);
  }
  const draft = job.status === 'done' && job.draft ? t('Zwischenstand, noch nicht gespeichert') : '';
  row.detail.textContent = [job.detail, percent, draft].filter(Boolean).join(' · ');
  row.detail.className = `job-detail ${STATUS_CLASS[job.status] ?? ''}`;
  row.bar.className = `progress ${job.status}`;
  row.fill.classList.toggle('unknown', unknown);
  row.fill.style.width = unknown ? '' : `${value}%`;
  if (unknown) row.bar.removeAttribute('aria-valuenow');
  else row.bar.setAttribute('aria-valuenow', String(Math.round(value)));
  // Nur neu aufbauen, wenn sich etwas ändert. Sonst entstünde der Knopf bei jedem Fortschritt anderer Aufgaben neu.
  const errorKey = `${job.error ?? ''}|${JSON.stringify(job.fix ?? '')}`;
  if (row.errorKey !== errorKey) {
    row.errorKey = errorKey;
    const button = job.fix ? fixButton(job.fix, { doneText: t('Erledigt. Starte den Download bitte noch einmal.') }) : null;
    row.error.replaceChildren(el('span', {}, job.error ?? ''), ...(button ? [' ', button] : []));
  }
  row.error.hidden = !job.error;

  // Wartet das Ergebnis darauf, im nächsten Bereich geöffnet zu werden, steht das als eigener Knopf da.
  const actionKey = `${job.status}|${followTarget(job.id) ?? ''}`;
  if (row.status === actionKey) return;
  row.status = actionKey;
  row.actions.replaceChildren();
  if (isActive(job)) {
    row.actions.append(el('button', { class: 'button small', onclick: () => window.vitool.invoke('queue:cancel', job.id) }, t('Abbrechen')));
  } else if (job.resultPath) {
    const target = job.status === 'done' ? followTarget(job.id) : null;
    if (target) {
      row.actions.append(el('button', {
        class: 'button small primary',
        onclick: () => {
          forgetFollow(job.id);
          sendTo(target, job.resultPath);
        },
      }, t('In {area} öffnen', { area: targetLabel(target) })));
    }
    if (isMediaFile(job.resultPath)) {
      row.actions.append(createSendTo({ getPath: () => job.resultPath, label: t('Weiter bearbeiten') }));
    }
    if (job.draft) {
      row.actions.append(el('button', { class: 'button small', onclick: () => keepDraft(job.resultPath) }, t('Speichern …')));
    } else {
      row.actions.append(el('button', { class: 'button small', onclick: () => window.vitool.invoke('shell:showFile', job.resultPath) }, t('Im Ordner zeigen')));
    }
  }
}

export function mountQueuePanel(root) {
  let showAll = false;
  let jobs = [];
  const rows = new Map();

  const count = el('span', { class: 'muted' });
  const clear = el('button', {
    class: 'button small',
    onclick: () => window.vitool.invoke('queue:clearFinished'),
  }, t('Erledigte entfernen'));
  const toggle = el('button', {
    class: 'button small',
    onclick: () => {
      showAll = !showAll;
      render();
    },
  });
  const list = el('ul', { class: 'job-list' });

  root.append(
    el('div', { class: 'queue-head' }, el('strong', {}, t('Warteschlange')), count, el('span', { class: 'spacer' }), clear, toggle),
    list,
  );

  // Eingeklappt erscheinen nur laufende Aufgaben, sonst die zuletzt fertige.
  function isVisible(job) {
    if (showAll) return true;
    return jobs.some(isActive) ? isActive(job) : job === jobs.at(-1);
  }

  function render() {
    const active = jobs.filter(isActive).length;
    count.textContent = active ? t('{count} aktiv', { count: active }) : t('Keine aktiven Aufgaben');
    clear.hidden = !showAll || jobs.length === active;
    toggle.hidden = jobs.length < 2;
    toggle.textContent = showAll ? t('Weniger anzeigen') : t('Alle anzeigen ({count})', { count: jobs.length });
    list.hidden = jobs.length === 0;

    const ids = new Set(jobs.map((job) => job.id));
    rows.forEach((row, id) => {
      if (ids.has(id)) return;
      row.node.remove();
      rows.delete(id);
    });

    [...jobs].reverse().forEach((job, index) => {
      if (!rows.has(job.id)) rows.set(job.id, createRow(job));
      const row = rows.get(job.id);
      updateRow(row, job);
      row.node.hidden = !isVisible(job);
      if (list.children[index] !== row.node) list.insertBefore(row.node, list.children[index] ?? null);
    });
  }

  window.vitool.on('queue:update', (next) => {
    jobs = next;
    render();
  });
  onFollowChange(render);
  window.vitool.invoke('queue:list').then((next) => {
    jobs = next;
    render();
  });
}
