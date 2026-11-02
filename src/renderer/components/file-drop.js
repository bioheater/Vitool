// Ablagefläche für Dateien: hineinziehen oder anklicken.
// Mit features entsteht die große Startfläche eines Bereichs samt Funktionskarten.
// Mit onFiles nimmt sie mehrere Dateien auf einmal an.
import { el, icon } from '../utils/dom.js';
import { ICONS } from '../utils/icons.js';
import { t } from '../utils/i18n.js';

function featureCard({ iconName, title, text }) {
  return el('div', { class: 'feature-card' },
    el('span', { class: 'feature-icon' }, icon(ICONS[iconName])),
    el('strong', {}, title),
    el('span', { class: 'muted' }, text));
}

export function createFileDrop({
  onFile,
  onFiles,
  title = onFiles ? t('Videos hierher ziehen') : t('Video hierher ziehen'),
  hint = t('oder klicken, um eine Datei auszuwählen'),
  dialog = onFiles ? 'dialog:pickVideos' : 'dialog:pickVideo',
  compact = false,
  features = null,
}) {
  const deliver = (paths) => {
    if (paths.length === 0) return;
    if (onFiles) onFiles(paths);
    else onFile(paths[0]);
  };

  const pick = async () => {
    const result = await window.vitool.invoke(dialog);
    deliver([result].flat().filter(Boolean));
  };

  const drop = el('button', {
    class: `dropzone ${compact ? 'compact' : ''}`,
    onclick: pick,
    ondragover: (event) => {
      event.preventDefault();
      drop.classList.add('over');
    },
    ondragleave: () => drop.classList.remove('over'),
    ondrop: (event) => {
      event.preventDefault();
      drop.classList.remove('over');
      deliver([...event.dataTransfer.files].map((file) => window.vitool.pathForFile(file)));
    },
  },
  compact ? null : el('span', { class: 'drop-icon' }, icon(ICONS.upload)),
  el('strong', {}, title),
  el('span', { class: 'muted' }, hint));

  if (!features) return drop;
  return el('div', { class: 'drop-hero' }, drop, el('div', { class: 'feature-grid' }, ...features.map(featureCard)));
}
