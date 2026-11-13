// Zeigt in der Seitenleiste, dass es eine neue Version gibt: ein Schild an "Einstellungen", das bleibt,
// bis das Update installiert ist, und einmal pro Version ein kleiner Hinweis, den man wegklicken kann.
// Bei eingeklappter Leiste bleibt nur ein Punkt, der beim Erscheinen kurz pulsiert.
import { el } from '../utils/dom.js';
import { t } from '../utils/i18n.js';

const WAITING = ['available', 'downloading', 'ready'];

export function setupUpdateNotice({ settingsButton, openSettings }) {
  let dismissed = null;
  let shownFor = null;
  const badge = el('span', { class: 'nav-badge', hidden: true });
  const dot = el('span', { class: 'nav-dot', hidden: true, 'aria-hidden': 'true' });
  const text = el('span', {});
  const hint = el('div', { class: 'update-hint', role: 'status', hidden: true },
    text,
    el('div', { class: 'update-hint-actions' },
      el('button', { class: 'button small', onclick: () => openSettings() }, t('Ansehen')),
      el('button', {
        class: 'button small icon-only',
        'aria-label': t('Hinweis ausblenden'),
        title: t('Hinweis ausblenden'),
        onclick: () => {
          dismissed = shownFor;
          hint.hidden = true;
          window.vitool.invoke('settings:set', { updateHintDismissed: dismissed });
        },
      }, '×')));
  settingsButton.append(badge, dot);
  settingsButton.before(hint);

  function render(status) {
    const waiting = WAITING.includes(status.state);
    const labels = { available: t('Update'), downloading: t('Lädt'), ready: t('Neu starten') };
    badge.textContent = labels[status.state] ?? '';
    badge.hidden = !waiting;
    // Neu eingeblendet pulsiert der Punkt ein paar Mal und bleibt dann ruhig.
    if (waiting && dot.hidden) {
      dot.classList.remove('pulse');
      requestAnimationFrame(() => dot.classList.add('pulse'));
    }
    dot.hidden = !waiting;
    settingsButton.title = waiting ? `${t('Einstellungen')} · ${t('Version {version} ist verfügbar.', { version: status.version })}` : t('Einstellungen');
    shownFor = status.version ?? null;
    text.textContent = status.state === 'ready'
      ? t('Version {version} ist bereit.', { version: status.version })
      : t('Version {version} ist da.', { version: status.version });
    hint.hidden = !waiting || dismissed === shownFor;
  }

  window.vitool.invoke('settings:get').then((settings) => {
    dismissed = settings.updateHintDismissed ?? null;
    window.vitool.on('update:status', render);
    window.vitool.invoke('update:status').then(render);
  });
  return { render };
}
