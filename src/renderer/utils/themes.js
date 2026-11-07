// Farbschemata zur Auswahl in den Einstellungen. Die Farben selbst stehen in styles/themes.css,
// hier nur Name und Vorschau: Hintergrund und die drei Akzente.
import { t } from './i18n.js';

export const THEMES = [
  { id: 'studio', name: 'Studio', colors: ['#111113', '#3b82f6', '#60a5fa', '#e7e9ed'] },
  { id: 'ocean', name: t('Ozean'), colors: ['#080d18', '#38bdf8', '#22d3ee', '#6366f1'] },
  { id: 'aurora', name: 'Aurora', colors: ['#0b0e14', '#3ddc97', '#2fc6e8', '#8b6cff'] },
  { id: 'sunset', name: t('Sonnenuntergang'), colors: ['#120b10', '#fb923c', '#f472b6', '#a855f7'] },
  { id: 'forest', name: t('Wald'), colors: ['#08110c', '#a3e635', '#34d399', '#14b8a6'] },
  { id: 'graphite', name: t('Graphit'), colors: ['#0c0c0e', '#f1f2f4', '#b8bcc6', '#6e7380'] },
  { id: 'light', name: t('Hell'), colors: ['#eef1f6', '#0d9f6e', '#0891b2', '#7c3aed'] },
];

// Studio ist der Standard für alle, die noch kein Theme gewählt haben.
export const DEFAULT_THEME = 'studio';

// Die Fensterknöpfe von Windows liegen über der eigenen Titelleiste. Sie bekommen deren Farbe und
// die Schriftfarbe des Themes. Electron versteht nur klassische Farbangaben. Deshalb wird jede
// CSS-Farbe, auch eine Mischfarbe mit Transparenz, als ein Pixel gemalt und als rgba() ausgelesen.
function cssColor(value) {
  const canvas = document.createElement('canvas');
  canvas.width = 1;
  canvas.height = 1;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.fillStyle = value;
  context.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data;
  return `rgba(${r}, ${g}, ${b}, ${(a / 255).toFixed(3)})`;
}

// Mit Glas ist die Leiste halbdurchsichtig. Windows würde den Hintergrund hinter den Knöpfen anders
// mischen, deshalb bleibt der Knopfbereich dann ganz durchsichtig und zeigt Vitools eigene Leiste.
export function syncTitleBar() {
  requestAnimationFrame(() => {
    const titlebar = document.getElementById('titlebar');
    if (!titlebar) return;
    const glass = document.documentElement.hasAttribute('data-glass');
    window.vitool.invoke('app:setTitleBar', {
      color: glass ? 'rgba(0, 0, 0, 0)' : cssColor(getComputedStyle(titlebar).backgroundColor),
      symbolColor: cssColor(getComputedStyle(document.body).color),
    });
  });
}

// Glas: Die Seite lässt ihren Hintergrund leicht durchscheinen, das Fenster liefert Acrylic.
export function applyGlass(on) {
  document.documentElement.toggleAttribute('data-glass', on);
  window.vitool.invoke('app:setGlass', on, document.documentElement.dataset.theme === 'light');
  syncTitleBar();
}

export function applyTheme(id) {
  const theme = THEMES.some((entry) => entry.id === id) ? id : DEFAULT_THEME;
  document.documentElement.dataset.theme = theme;
  syncTitleBar();
  return theme;
}
