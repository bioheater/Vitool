// Fenster "Was ist neu". Nach einem Update einmal von selbst, sonst über die Einstellungen.
import { el } from '../utils/dom.js';
import { t } from '../utils/i18n.js';

export function showWhatsNew(root, { version, entries }, { onClose } = {}) {
  if (!entries.length) return;
  const several = entries.length > 1;
  const close = () => {
    document.removeEventListener('keydown', onKey);
    root.replaceChildren();
    onClose?.();
  };
  const onKey = (event) => {
    if (event.key === 'Escape') close();
  };
  const body = el('div', { class: 'whats-new-body' },
    ...entries.flatMap((entry) => [
      ...(several ? [el('h3', {}, t('Version {version}', { version: entry.version }))] : []),
      el('ul', { class: 'whats-new-list' }, ...entry.items.map((item) => el('li', {}, item))),
    ]));
  const button = el('button', { class: 'button primary', onclick: close }, t('Weiter'));
  const overlay = el('div', {
    class: 'overlay',
    onclick: (event) => {
      if (event.target === overlay) close();
    },
  },
  el('div', { class: 'dialog whats-new-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('Was ist neu') },
    el('h2', {}, several ? t('Neu in Vitool') : t('Neu in Vitool {version}', { version: entries[0].version ?? version })),
    body,
    el('div', { class: 'dialog-actions' }, button)));
  document.addEventListener('keydown', onKey);
  root.replaceChildren(overlay);
  button.focus();
}
