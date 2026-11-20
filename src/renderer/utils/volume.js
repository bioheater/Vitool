// Eine Lautstärke für alle Vorschauen in Vitool. Sie wird gespeichert und gilt für jeden Player,
// auch wenn man sie am eingebauten Regler eines Videos ändert. Das Ergebnis beim Export bleibt davon unberührt.
import { el, icon } from './dom.js';
import { t } from './i18n.js';

const ICON_ON = 'M4 9h4l5-4v14l-5-4H4zM16 9a4 4 0 0 1 0 6M18.5 6.5a8 8 0 0 1 0 11';
const ICON_OFF = 'M4 9h4l5-4v14l-5-4H4zM16 9l5 6M21 9l-5 6';
const SAVE_DELAY = 400;

let level = 1;
// Zum Wiederherstellen nach dem Stummschalten über das Lautsprecher-Symbol.
let lastAudible = 1;
let applying = false;
let saveTimer = null;
const listeners = new Set();
// Player, die nicht im Dokument hängen (etwa die Hörprobe), melden sich hier an.
const detached = new Set();

function isMedia(node) {
  return node instanceof HTMLMediaElement;
}

function applyTo(media) {
  if (!isMedia(media) || Math.abs(media.volume - level) < 0.001) return;
  applying = true;
  media.volume = level;
  applying = false;
}

function applyAll() {
  document.querySelectorAll('video, audio').forEach(applyTo);
  detached.forEach(applyTo);
}

export function getVolume() {
  return level;
}

export function setVolume(value, { save = true } = {}) {
  const next = Math.min(1, Math.max(0, Number(value) || 0));
  if (next > 0) lastAudible = next;
  if (Math.abs(next - level) < 0.001) return;
  level = next;
  applyAll();
  listeners.forEach((listener) => listener(level));
  if (!save) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => window.vitool.invoke('settings:set', { previewVolume: level }), SAVE_DELAY);
}

export function registerMedia(media) {
  detached.add(media);
  applyTo(media);
}

export async function setupVolume() {
  const settings = await window.vitool.invoke('settings:get');
  if (Number.isFinite(settings.previewVolume)) setVolume(settings.previewVolume, { save: false });
  // Jeder Player bekommt die Lautstärke, sobald er lädt oder startet.
  document.addEventListener('loadedmetadata', (event) => applyTo(event.target), true);
  document.addEventListener('play', (event) => applyTo(event.target), true);
  // Ändert jemand die Lautstärke am eingebauten Regler eines Videos, gilt sie überall.
  document.addEventListener('volumechange', (event) => {
    if (applying || !isMedia(event.target)) return;
    setVolume(event.target.volume);
  }, true);
}

// Lautsprecher-Symbol zum Stummschalten und ein Regler, für eigene Abspielleisten.
export function volumeControl() {
  const button = el('button', { class: 'icon-button volume-toggle', type: 'button' });
  const slider = el('input', {
    type: 'range', min: 0, max: 100, step: 1, class: 'volume-slider', 'aria-label': t('Lautstärke der Vorschau'),
    oninput: () => setVolume(Number(slider.value) / 100),
  });
  const root = el('div', { class: 'volume-control' }, button, slider);
  const render = () => {
    slider.value = String(Math.round(level * 100));
    slider.style.setProperty('--fill', `${level * 100}%`);
    const label = level > 0 ? t('Stumm schalten') : t('Ton einschalten');
    button.title = `${label} (${Math.round(level * 100)} %)`;
    button.setAttribute('aria-label', label);
    button.replaceChildren(icon(level > 0 ? ICON_ON : ICON_OFF));
  };
  button.addEventListener('click', () => setVolume(level > 0 ? 0 : lastAudible || 1));
  listeners.add(render);
  render();
  return root;
}
