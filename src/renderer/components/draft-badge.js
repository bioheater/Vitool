// Hinweis auf der Dateikarte, wenn die geöffnete Datei ein Zwischenstand ist.
import { el } from '../utils/dom.js';
import { t } from '../utils/i18n.js';

export function draftBadge() {
  return el('p', {
    class: 'draft-badge',
    hidden: true,
    title: t('Diese Datei ist ein Zwischenstand aus einem anderen Bereich. Sie wird erst gespeichert, wenn du hier exportierst oder sie in der Warteschlange speicherst.'),
  }, t('Zwischenstand, noch nicht gespeichert'));
}
