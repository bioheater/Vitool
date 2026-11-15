// Kurze Beschreibung neben der Seitenleiste, wenn man über einen Bereich fährt.
// Die erste erscheint nach einer kleinen Pause, danach wechselt sie beim Weiterfahren sofort.
import { el } from '../utils/dom.js';

const SHOW_DELAY = 450;
// So lange nach dem Verlassen gilt die Leiste noch als "angeschaut".
const WARM_MS = 600;
const GAP = 14;

let tip = null;
let showTimer = null;
let coolTimer = null;
let warm = false;

function ensureTip() {
  if (tip) return tip;
  tip = el('div', { class: 'nav-tip', role: 'tooltip', hidden: true },
    el('strong', { class: 'nav-tip-title' }),
    el('span', { class: 'nav-tip-text' }));
  document.body.append(tip);
  return tip;
}

function show(button, title, text) {
  const box = ensureTip();
  box.querySelector('.nav-tip-title').textContent = title;
  box.querySelector('.nav-tip-text').textContent = text;
  box.hidden = false;
  const rect = button.getBoundingClientRect();
  const height = box.offsetHeight;
  const top = Math.max(8, Math.min(window.innerHeight - height - 8, rect.top + rect.height / 2 - height / 2));
  box.style.left = `${Math.round(rect.right + GAP)}px`;
  box.style.top = `${Math.round(top)}px`;
  box.classList.add('visible');
  warm = true;
  clearTimeout(coolTimer);
}

function hide() {
  clearTimeout(showTimer);
  if (!tip || tip.hidden) return;
  tip.classList.remove('visible');
  tip.hidden = true;
  clearTimeout(coolTimer);
  coolTimer = setTimeout(() => { warm = false; }, WARM_MS);
}

export function attachNavTip(button, title, text) {
  // Die eigene Beschreibung ersetzt den Hinweis des Systems, sonst erschienen beide.
  button.removeAttribute('title');
  button.setAttribute('aria-description', text);
  button.addEventListener('pointerenter', () => {
    clearTimeout(showTimer);
    if (warm) show(button, title, text);
    else showTimer = setTimeout(() => show(button, title, text), SHOW_DELAY);
  });
  button.addEventListener('pointerleave', hide);
  button.addEventListener('pointerdown', hide);
  button.addEventListener('focus', () => {
    if (button.matches(':focus-visible')) show(button, title, text);
  });
  button.addEventListener('blur', hide);
}
