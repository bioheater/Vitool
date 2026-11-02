// Zeigt laufende und fertige Aufgaben unten im Fenster.
// Zeilen bleiben bestehen und ändern nur Text und Balken, sonst würde die Liste bei jedem Schritt springen.
import { el } from '../utils/dom.js';
import { isMediaFile } from '../utils/navigation.js';
import { createSendTo } from './send-to.js';
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
  const node = el('li', { class: 'job' },
    el('div', { class: 'job-head' }, el('span', { class: 'job-title', title: job.title }, job.title), detail, actions),
    bar,
    error);
  return { node, detail, fill, bar, actions, error, status: null };
}

function updateRow(row, job) {
  const unknown = job.status === 'running' && job.progress === null;
  const value = job.status === 'done' ? 100 : job.progress ?? 0;
  const percent = job.status === 'running' && job.progress !== null ? `${Math.round(job.progress)} %` : '';

  row.detail.textContent = [job.detail, percent].filter(Boolean).join(' · ');
  row.detail.className = `job-detail ${STATUS_CLASS[job.status] ?? ''}`;
  row.bar.className = `progress ${job.status}`;
  row.fill.classList.toggle('unknown', unknown);
  row.fill.style.width = unknown ? '' : `${value}%`;
  if (unknown) row.bar.removeAttribute('aria-valuenow');
  else row.bar.setAttribute('aria-valuenow', String(Math.round(value)));
  row.error.textContent = job.error ?? '';
  row.error.hidden = !job.error;

  if (row.status === job.status) return;
  row.status = job.status;
  row.actions.replaceChildren();
  if (isActive(job)) {
    row.actions.append(el('button', { class: 'button small', onclick: () => window.vitool.invoke('queue:cancel', job.id) }, t('Abbrechen')));
  } else if (job.resultPath) {
    if (isMediaFile(job.resultPath)) {
      row.actions.append(createSendTo({ getPath: () => job.resultPath, label: t('Weiter bearbeiten') }));
    }
    row.actions.append(el('button', { class: 'button small', onclick: () => window.vitool.invoke('shell:showFile', job.resultPath) }, t('Im Ordner zeigen')));
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
  window.vitool.invoke('queue:list').then((next) => {
    jobs = next;
    render();
  });
}
