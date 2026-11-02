// Knopf mit kleinem Menü: Datei in einem anderen Bereich weiterbearbeiten.
import { el } from '../utils/dom.js';
import { SEND_TARGETS, sendTo } from '../utils/navigation.js';
import { t } from '../utils/i18n.js';

let openMenu = null;

function closeMenu() {
  openMenu?.remove();
  openMenu?.anchor.setAttribute('aria-expanded', 'false');
  openMenu = null;
}

document.addEventListener('pointerdown', (event) => {
  if (openMenu && !openMenu.contains(event.target) && event.target !== openMenu.anchor) closeMenu();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeMenu();
});
window.addEventListener('resize', closeMenu);
window.addEventListener('scroll', closeMenu, true);

// Das Menü hängt am Dokument, damit es nicht von Karten oder der Warteschlange abgeschnitten wird.
function showMenu(anchor, getPath, exclude) {
  const wasOpen = openMenu?.anchor === anchor;
  closeMenu();
  if (wasOpen) return;

  const menu = el('div', { class: 'send-menu', role: 'menu' },
    ...SEND_TARGETS.filter((target) => target.id !== exclude).map((target) => el('button', {
      class: 'send-item',
      role: 'menuitem',
      onclick: () => {
        const filePath = getPath();
        closeMenu();
        if (filePath) sendTo(target.id, filePath);
      },
    }, target.label)));
  menu.anchor = anchor;
  document.body.append(menu);

  const box = anchor.getBoundingClientRect();
  const height = menu.offsetHeight;
  const below = box.bottom + 6 + height <= window.innerHeight;
  menu.style.left = `${Math.min(box.left, window.innerWidth - menu.offsetWidth - 8)}px`;
  menu.style.top = `${below ? box.bottom + 6 : box.top - 6 - height}px`;
  anchor.setAttribute('aria-expanded', 'true');
  openMenu = menu;
  menu.querySelector('button')?.focus();
}

export function createSendTo({ getPath, exclude = null, label = t('Senden an') }) {
  const button = el('button', {
    class: 'button small',
    'aria-haspopup': 'menu',
    'aria-expanded': 'false',
    onclick: () => showMenu(button, getPath, exclude),
  }, `${label} ▾`);
  return button;
}
