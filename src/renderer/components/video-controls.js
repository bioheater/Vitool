// Bildgenaue Steuerung und Tasten, die immer für das gerade sichtbare Video gelten.
import { el } from '../utils/dom.js';
import { t } from '../utils/i18n.js';

const DEFAULT_FPS = 30;

export function stepFrame(video, direction) {
  video.pause();
  const fps = Number(video.dataset.fps) || DEFAULT_FPS;
  video.currentTime = Math.max(0, video.currentTime + direction / fps);
}

export function frameButtons(video) {
  return [
    el('button', { class: 'button small', onclick: () => stepFrame(video, -1) }, t('◀ Ein Bild zurück')),
    el('button', { class: 'button small', onclick: () => stepFrame(video, 1) }, t('Ein Bild vor ▶')),
  ];
}

function visibleVideo() {
  return [...document.querySelectorAll('.page video')]
    .find((video) => video.offsetParent && video.getAttribute('src'));
}

function isTyping(target) {
  if (target.closest('select, textarea') || target.isContentEditable) return true;
  return target.tagName === 'INPUT' && !['range', 'radio', 'checkbox'].includes(target.type);
}

export function installVideoKeys() {
  // Beim Einfangen, damit Seite, Knöpfe und Player die Taste nicht zusätzlich auswerten.
  document.addEventListener('keydown', (event) => {
    if (isTyping(event.target) || event.ctrlKey || event.altKey || event.metaKey) return;
    if (event.target.closest('[role="slider"]') && event.key !== ' ') return;
    if (event.target.type === 'range' && event.key !== ' ') return;

    const video = visibleVideo();
    if (!video) return;

    if (event.key === ' ') {
      if (!event.repeat) {
        if (video.paused) video.play();
        else video.pause();
      }
    } else if (event.key === 'ArrowLeft') {
      stepFrame(video, -1);
    } else if (event.key === 'ArrowRight') {
      stepFrame(video, 1);
    } else {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
  }, true);

  // Sonst würde ein zuletzt angeklickter Knopf durch die Leertaste erneut ausgelöst.
  document.addEventListener('keyup', (event) => {
    if (event.key === ' ' && !isTyping(event.target) && visibleVideo()) event.preventDefault();
  }, true);
}
