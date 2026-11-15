// Knöpfe mit kleinem Menü, um in einem anderen Bereich weiterzumachen.
// "Senden an" gibt die geöffnete Datei unverändert weiter. "Weiter bearbeiten in" erstellt erst
// das Ergebnis als Zwischenstand und öffnet es dann im gewählten Bereich.
import { el, icon } from '../utils/dom.js';
import { ICONS } from '../utils/icons.js';
import { SEND_TARGETS, sendTo, followJob } from '../utils/navigation.js';
import { t } from '../utils/i18n.js';

let openMenu = null;

function closeMenu() {
  openMenu?.remove();
  openMenu?.anchor.setAttribute('aria-expanded', 'false');
  openMenu = null;
}

document.addEventListener('pointerdown', (event) => {
  if (openMenu && !openMenu.contains(event.target) && !openMenu.anchor.contains(event.target)) closeMenu();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeMenu();
});
window.addEventListener('resize', closeMenu);
window.addEventListener('scroll', closeMenu, true);

// Das Menü hängt am Dokument, damit es nicht von Karten oder der Warteschlange abgeschnitten wird.
function showMenu(anchor, { exclude, title, onPick }) {
  const wasOpen = openMenu?.anchor === anchor;
  closeMenu();
  if (wasOpen) return;

  const menu = el('div', { class: 'send-menu', role: 'menu' },
    title ? el('p', { class: 'send-menu-title' }, title) : null,
    ...SEND_TARGETS.filter((target) => target.id !== exclude).map((target) => el('button', {
      class: 'send-item',
      role: 'menuitem',
      onclick: () => {
        closeMenu();
        onPick(target.id);
      },
    }, icon(ICONS[target.id]), target.label)));
  menu.anchor = anchor;
  document.body.append(menu);

  const box = anchor.getBoundingClientRect();
  const height = menu.offsetHeight;
  const below = box.bottom + 6 + height <= window.innerHeight;
  menu.style.left = `${Math.max(8, Math.min(box.left, window.innerWidth - menu.offsetWidth - 8))}px`;
  menu.style.top = `${below ? box.bottom + 6 : box.top - 6 - height}px`;
  anchor.setAttribute('aria-expanded', 'true');
  openMenu = menu;
  menu.querySelector('button')?.focus();
}

function menuButton(className, label, onOpen) {
  const button = el('button', {
    class: className,
    'aria-haspopup': 'menu',
    'aria-expanded': 'false',
    onclick: () => onOpen(button),
  }, icon(ICONS.forward), el('span', {}, label), el('span', { class: 'send-caret' }, '▾'));
  return button;
}

export function createSendTo({ getPath, exclude = null, label = t('Senden an'), large = false }) {
  return menuButton(`button send-button ${large ? '' : 'small'}`, label, (button) => showMenu(button, {
    exclude,
    onPick: (target) => {
      const filePath = getPath();
      if (filePath) sendTo(target, filePath);
    },
  }));
}

// Steht neben dem Knopf zum Speichern. start(target) startet die Aufgabe als Zwischenstand
// und gibt die Antwort des Hauptprozesses zurück.
export function createContinue({ start, exclude = null, onError, compact = false }) {
  const button = menuButton(`button ${compact ? '' : 'large'} send-button continue-button`, t('Weiter bearbeiten in'), (anchor) => showMenu(anchor, {
    exclude,
    title: t('Erstellt das Ergebnis als Zwischenstand, ohne es zu speichern, und öffnet es dort.'),
    onPick: async (target) => {
      const response = await start(target);
      if (response?.ok && response.jobId) followJob(response.jobId, target);
      else if (response && !response.ok) onError?.(response.error ?? '');
    },
  }));
  button.title = t('Ergebnis direkt im nächsten Bereich weiterbearbeiten');
  return button;
}
