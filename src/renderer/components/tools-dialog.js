// Prüft beim Start die Werkzeuge. Fehlt etwas, lädt Vitool es auf Wunsch selbst in seinen Datenordner.
// Wer lieber selbst installiert, findet die winget-Befehle weiter unten.
import { el } from '../utils/dom.js';
import { t } from '../utils/i18n.js';

// Gleiche Größen wie in tool-installer.js, nur für die Anzeige vor dem Download.
const DOWNLOAD_SIZES = { ytdlp: 24, ffmpeg: 200, deno: 43 };

function commandRow(tool) {
  const copy = el('button', {
    class: 'button small',
    onclick: async () => {
      await navigator.clipboard.writeText(tool.install);
      copy.textContent = t('Kopiert');
    },
  }, t('Befehl kopieren'));
  return el('li', { class: 'tool-row' }, el('code', {}, tool.install), copy);
}

function toolLine(tool) {
  return el('li', { class: 'tool-line' },
    el('strong', {}, tool.label),
    el('span', { class: 'muted' }, tool.required ? tool.purpose : t('{purpose} (empfohlen)', { purpose: tool.purpose })));
}

export async function checkTools(root) {
  root.replaceChildren();
  const { ok, tools } = await window.vitool.invoke('tools:check');
  const missing = tools.filter((tool) => !tool.found);
  if (missing.length === 0) return;

  const downloads = [...new Set(missing.map((tool) => tool.download).filter(Boolean))];
  const sizeMb = downloads.reduce((sum, id) => sum + (DOWNLOAD_SIZES[id] ?? 0), 0);
  // Mehrere Einträge teilen sich einen Download, etwa FFmpeg, ffprobe und FFmpeg für yt-dlp.
  // Gezeigt wird je Download eine Zeile und jeder Befehl einmal. Pflicht ist eine Zeile, sobald einer davon Pflicht ist.
  const lines = missing
    .filter((tool, index) => missing.findIndex((other) => (other.download ?? other.id) === (tool.download ?? tool.id)) === index)
    .map((tool) => ({ ...tool, required: missing.some((other) => (other.download ?? other.id) === (tool.download ?? tool.id) && other.required) }));
  const commands = missing.filter((tool, index) => missing.findIndex((other) => other.install === tool.install) === index);

  const status = el('p', { class: 'muted', role: 'status', hidden: true });
  const message = el('p', { class: 'message', role: 'alert', hidden: true });
  const install = el('button', { class: 'button primary' }, t('Automatisch einrichten (etwa {size} MB)', { size: sizeMb }));
  // Den Fortschritt liefert die Warteschlange, der Dialog zeigt ihn mit.
  const off = window.vitool.on('queue:update', (jobs) => {
    const job = jobs.find((entry) => entry.kind === 'tools' && entry.status === 'running');
    if (job) status.textContent = [job.detail, job.progress !== null ? `${Math.round(job.progress)} %` : ''].filter(Boolean).join(' · ');
  });
  const close = () => {
    off();
    root.replaceChildren();
  };
  const later = ok ? el('button', { class: 'button', onclick: close }, t('Später')) : null;
  const recheck = el('button', {
    class: 'button',
    onclick: () => {
      off();
      checkTools(root);
    },
  }, t('Erneut prüfen'));

  install.addEventListener('click', async () => {
    install.disabled = true;
    recheck.disabled = true;
    if (later) later.disabled = true;
    message.hidden = true;
    status.hidden = false;
    status.textContent = t('Startet …');
    const response = await window.vitool.invoke('tools:install', missing.map((tool) => tool.id));
    if (response.ok && response.tools.every((tool) => tool.found || !tool.required)) {
      off();
      checkTools(root);
      return;
    }
    install.disabled = false;
    recheck.disabled = false;
    if (later) later.disabled = false;
    status.hidden = true;
    message.textContent = response.error ?? t('Abgebrochen.');
    message.hidden = false;
  });

  root.append(
    el('div', { class: 'overlay' },
      el('div', { class: 'dialog', role: 'alertdialog', 'aria-modal': 'true', 'aria-label': t('Fehlende Programme') },
        el('h2', {}, ok ? t('Ein empfohlenes Programm fehlt') : t('Vitool braucht noch etwas')),
        el('ul', { class: 'tool-list' }, ...lines.map(toolLine)),
        el('p', { class: 'muted' }, t('Vitool lädt die Programme aus ihren offiziellen Quellen, prüft sie und legt sie in seinen eigenen Ordner. Am System wird nichts verändert.')),
        status,
        message,
        el('div', { class: 'dialog-actions' }, later, recheck, install),
        el('details', { class: 'tool-manual' },
          el('summary', { class: 'muted' }, t('Lieber selbst installieren')),
          el('p', { class: 'muted' }, t('Öffne die Windows-Eingabeaufforderung, führe die Befehle aus und klicke danach auf „Erneut prüfen“.')),
          el('ul', { class: 'tool-list' }, ...commands.map(commandRow))),
      ),
    ),
  );
}
