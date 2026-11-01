// Ablagefläche für Dateien: hineinziehen oder anklicken.
import { el } from '../utils/dom.js';

export function createFileDrop({
  onFile,
  title = 'Video hierher ziehen',
  hint = 'oder klicken, um eine Datei auszuwählen',
  dialog = 'dialog:pickVideo',
  compact = false,
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
  el('strong', {}, title),
  el('span', { class: 'muted' }, hint));

  return drop;
}
