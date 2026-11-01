// Prüft beim Start die Werkzeuge und erklärt, was bei Bedarf zu installieren ist.
import { el } from '../utils/dom.js';

function toolRow(tool) {
  const copy = el('button', {
    class: 'button small',
    onclick: async () => {
      await navigator.clipboard.writeText(tool.install);
      copy.textContent = 'Kopiert';
    },
  }, 'Befehl kopieren');

  return el('li', { class: 'tool-row' },
    el('div', {},
      el('strong', {}, tool.label),
      el('p', { class: 'muted' }, tool.required ? tool.purpose : `${tool.purpose} (empfohlen)`),
      el('code', {}, tool.install),
    ),
    copy,
  );
}

export async function checkTools(root) {
  root.replaceChildren();
  const { ok, tools } = await window.vitool.invoke('tools:check');
  const missing = tools.filter((tool) => !tool.found);
  if (missing.length === 0) return;

  const close = () => root.replaceChildren();
  const commands = [...new Set(missing.map((tool) => tool.label))].join(', ');

  root.append(
    el('div', { class: 'overlay' },
      el('div', { class: 'dialog', role: 'alertdialog', 'aria-modal': 'true', 'aria-label': 'Fehlende Programme' },
        el('h2', {}, ok ? 'Ein empfohlenes Programm fehlt' : 'Vitool braucht noch etwas'),
        el('p', { class: 'muted' },
          `Es fehlt: ${commands}. Öffne die Windows-Eingabeaufforderung, führe den Befehl aus und klicke danach auf „Erneut prüfen“.`),
        el('ul', { class: 'tool-list' }, ...missing.map(toolRow)),
        el('div', { class: 'dialog-actions' },
          ok ? el('button', { class: 'button', onclick: close }, 'Später') : null,
          el('button', { class: 'button primary', onclick: () => checkTools(root) }, 'Erneut prüfen'),
        ),
      ),
    ),
  );
}
