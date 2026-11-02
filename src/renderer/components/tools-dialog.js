// Prüft beim Start die Werkzeuge und erklärt, was bei Bedarf zu installieren ist.
import { el } from '../utils/dom.js';
import { t } from '../utils/i18n.js';

function toolRow(tool) {
  const copy = el('button', {
    class: 'button small',
    onclick: async () => {
      await navigator.clipboard.writeText(tool.install);
      copy.textContent = t('Kopiert');
    },
  }, t('Befehl kopieren'));

  return el('li', { class: 'tool-row' },
    el('div', {},
      el('strong', {}, tool.label),
      el('p', { class: 'muted' }, tool.required ? tool.purpose : t('{purpose} (empfohlen)', { purpose: tool.purpose })),
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
      el('div', { class: 'dialog', role: 'alertdialog', 'aria-modal': 'true', 'aria-label': t('Fehlende Programme') },
        el('h2', {}, ok ? t('Ein empfohlenes Programm fehlt') : t('Vitool braucht noch etwas')),
        el('p', { class: 'muted' },
          t('Es fehlt: {commands}. Öffne die Windows-Eingabeaufforderung, führe den Befehl aus und klicke danach auf „Erneut prüfen“.', { commands })),
        el('ul', { class: 'tool-list' }, ...missing.map(toolRow)),
        el('div', { class: 'dialog-actions' },
          ok ? el('button', { class: 'button', onclick: close }, t('Später')) : null,
          el('button', { class: 'button primary', onclick: () => checkTools(root) }, t('Erneut prüfen')),
        ),
      ),
    ),
  );
}
