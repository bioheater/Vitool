// Zeigt laufende und fertige Aufgaben unten im Fenster.
import { el } from '../utils/dom.js';

const STATUS_CLASS = { done: 'ok', failed: 'bad', canceled: 'muted' };

function progressBar(job) {
  const unknown = job.status === 'running' && job.progress === null;
  const value = job.status === 'done' ? 100 : job.progress ?? 0;
  const fill = el('div', { class: `progress-fill ${unknown ? 'unknown' : ''}` });
  if (!unknown) fill.style.width = `${value}%`;

  const bar = el('div', { class: `progress ${job.status}`, role: 'progressbar', 'aria-label': job.title }, fill);
  if (!unknown) bar.setAttribute('aria-valuenow', String(Math.round(value)));
  return bar;
}

function jobRow(job) {
  const active = job.status === 'queued' || job.status === 'running';
  const percent = job.status === 'running' && job.progress !== null ? `${Math.round(job.progress)} %` : '';
  return el('li', { class: 'job' },
    el('div', { class: 'job-head' },
      el('span', { class: 'job-title', title: job.title }, job.title),
      el('span', { class: `job-detail ${STATUS_CLASS[job.status] ?? ''}` }, [job.detail, percent].filter(Boolean).join(' · ')),
      active
        ? el('button', { class: 'button small', onclick: () => window.vitool.invoke('queue:cancel', job.id) }, 'Abbrechen')
        : null,
      job.resultPath
        ? el('button', { class: 'button small', onclick: () => window.vitool.invoke('shell:showFile', job.resultPath) }, 'Im Ordner zeigen')
        : null,
    ),
    progressBar(job),
    job.error ? el('p', { class: 'job-error' }, job.error) : null,
  );
}

export function mountQueuePanel(root) {
  let open = true;
  let jobs = [];

  const count = el('span', { class: 'muted' });
  const clear = el('button', {
    class: 'button small',
    onclick: () => window.vitool.invoke('queue:clearFinished'),
  }, 'Erledigte entfernen');
  const toggle = el('button', {
    class: 'button small',
    onclick: () => {
      open = !open;
      render();
    },
  });
  const list = el('ul', { class: 'job-list' });

  root.append(
    el('div', { class: 'queue-head' }, el('strong', {}, 'Warteschlange'), count, el('span', { class: 'spacer' }), clear, toggle),
    list,
  );

  function render() {
    const active = jobs.filter((job) => job.status === 'queued' || job.status === 'running').length;
    count.textContent = active ? `${active} aktiv` : 'Keine aktiven Aufgaben';
    clear.hidden = jobs.length === active;
    toggle.textContent = open ? 'Einklappen' : 'Ausklappen';
    list.hidden = !open || jobs.length === 0;
    list.replaceChildren(...[...jobs].reverse().map(jobRow));
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
