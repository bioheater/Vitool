// Zusammengeklappte Verwaltung für Zusatzpakete und Modelle. Ist alles eingerichtet, braucht man sie selten,
// deshalb steht sie unter der Arbeitsfläche und zeigt zugeklappt nur eine Zeile Stand.
import { el } from '../utils/dom.js';

export function manageCard({ title, summary, open, onToggle, children }) {
  const card = el('details', { class: 'card manage-card', open },
    el('summary', {},
      el('span', { class: 'manage-title' }, el('strong', {}, title), el('span', { class: 'muted' }, summary))),
    el('div', { class: 'stack manage-body' }, ...children));
  card.addEventListener('toggle', () => onToggle(card.open));
  return card;
}
