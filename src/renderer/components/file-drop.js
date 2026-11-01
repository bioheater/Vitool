// Ablagefläche für Dateien: hineinziehen oder anklicken.
// Mit features entsteht die große Startfläche eines Bereichs samt Funktionskarten.
import { el, icon } from '../utils/dom.js';
import { ICONS } from '../utils/icons.js';

function featureCard({ iconName, title, text }) {
  return el('div', { class: 'feature-card' },
    el('span', { class: 'feature-icon' }, icon(ICONS[iconName])),
    el('strong', {}, title),
    el('span', { class: 'muted' }, text));
}

export function createFileDrop({
  onFile,
  title = 'Video hierher ziehen',
  hint = 'oder klicken, um eine Datei auszuwählen',
  dialog = 'dialog:pickVideo',
  compact = false,
  features = null,
}) {
  const pick = async () => {
    const filePath = await window.vitool.invoke(dialog);
    if (filePath) onFile(filePath);
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
      const [file] = event.dataTransfer.files;
      if (file) onFile(window.vitool.pathForFile(file));
    },
  },
  compact ? null : el('span', { class: 'drop-icon' }, icon(ICONS.upload)),
  el('strong', {}, title),
  el('span', { class: 'muted' }, hint));

  if (!features) return drop;
  return el('div', { class: 'drop-hero' }, drop, el('div', { class: 'feature-grid' }, ...features.map(featureCard)));
}
