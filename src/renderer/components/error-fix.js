// Knopf neben einer Fehlermeldung, der die Ursache gleich behebt: yt-dlp aktualisieren oder bei YouTube anmelden.
import { el } from '../utils/dom.js';
import { openPage } from '../utils/navigation.js';
import { t } from '../utils/i18n.js';

const invoke = (...args) => window.vitool.invoke(...args);

const FIXES = {
  update: {
    label: () => t('yt-dlp aktualisieren'),
    busy: () => t('Aktualisiert …'),
    run: () => invoke('tools:updateYtDlp'),
  },
  ownCopy: {
    label: () => t('Aktuelles yt-dlp laden'),
    busy: () => t('Lädt …'),
    run: () => invoke('tools:install', ['ytdlp']),
  },
};

// onDone(ok) wird nach einem erfolgreichen Update gerufen, etwa um es gleich noch einmal zu versuchen.
export function fixButton(fix, { onDone, doneText } = {}) {
  if (fix === 'signin') {
    return el('span', { class: 'fix-row' },
      el('button', { class: 'button small', onclick: () => openPage('settings', { section: 'signin' }) }, t('Anmelden …')));
  }
  const entry = FIXES[fix];
  if (!entry) return null;
  const note = el('span', { class: 'muted' });
  const button = el('button', {
    class: 'button small',
    onclick: async () => {
      button.disabled = true;
      button.textContent = entry.busy();
      const response = await entry.run();
      if (!response.ok) {
        button.disabled = false;
        button.textContent = entry.label();
        note.textContent = response.canceled ? '' : response.error ?? '';
        return;
      }
      button.replaceWith(note);
      note.textContent = doneText ?? response.message ?? t('Fertig');
      onDone?.(true);
    },
  }, entry.label());
  return el('span', { class: 'fix-row' }, button, note);
}
