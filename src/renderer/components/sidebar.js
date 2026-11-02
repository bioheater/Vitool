// Seitenleiste: Breite per Ziehen am rechten Rand, ganz einklappen auf die Symbole.
// Breite und Zustand bleiben in den Einstellungen gespeichert.
import { el, icon } from '../utils/dom.js';
import { t } from '../utils/i18n.js';

const DEFAULT_WIDTH = 208;
const MIN_WIDTH = 170;
const MAX_WIDTH = 360;
const COLLAPSED_WIDTH = 64;
// Wer schmaler als das zieht, möchte die Leiste offenbar einklappen.
const SNAP_WIDTH = 120;
const ICON_COLLAPSE = 'M15 6l-6 6 6 6';
const ICON_EXPAND = 'M9 6l6 6-6 6';

export async function setupSidebar({ shell, bottom, resizer }) {
  const settings = await window.vitool.invoke('settings:get');
  let width = clamp(settings.sidebarWidth ?? DEFAULT_WIDTH);
  let collapsed = Boolean(settings.sidebarCollapsed);

  const label = el('span', { class: 'nav-label' });
  const toggle = el('button', { class: 'nav-item sidebar-toggle', onclick: () => setCollapsed(!collapsed) }, label);
  bottom.append(toggle);

  function clamp(value) {
    return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(value)));
  }

  function apply() {
    shell.classList.toggle('collapsed', collapsed);
    shell.style.setProperty('--sidebar-width', `${collapsed ? COLLAPSED_WIDTH : width}px`);
    const text = collapsed ? t('Seitenleiste ausklappen') : t('Seitenleiste einklappen');
    label.textContent = text;
    toggle.title = text;
    toggle.setAttribute('aria-label', text);
    toggle.querySelector('svg')?.remove();
    toggle.prepend(icon(collapsed ? ICON_EXPAND : ICON_COLLAPSE));
    resizer.title = t('Breite ändern (Doppelklick: Standard)');
  }

  function save() {
    window.vitool.invoke('settings:set', { sidebarWidth: width, sidebarCollapsed: collapsed });
  }

  function setCollapsed(value) {
    collapsed = value;
    apply();
    save();
  }

  resizer.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = collapsed ? COLLAPSED_WIDTH : width;
    shell.classList.add('resizing');

    const move = (moveEvent) => {
      const next = startWidth + moveEvent.clientX - startX;
      collapsed = next < SNAP_WIDTH;
      if (!collapsed) width = clamp(next);
      apply();
    };
    const stop = () => {
      shell.classList.remove('resizing');
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
      save();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);
  });

  resizer.addEventListener('dblclick', () => {
    width = DEFAULT_WIDTH;
    setCollapsed(false);
  });

  apply();
}
