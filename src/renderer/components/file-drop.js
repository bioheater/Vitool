// Ablagefläche für Dateien: hineinziehen oder anklicken.
// Mit features entsteht die große Startfläche eines Bereichs samt Funktionskarten und der Liste
// der zuletzt verwendeten Dateien. Mit onFiles nimmt sie mehrere Dateien auf einmal an.
import { el, icon } from '../utils/dom.js';
import { ICONS } from '../utils/icons.js';
import { t } from '../utils/i18n.js';
import { isMediaFile } from '../utils/navigation.js';

const RECENT_KEY = 'vitool-recent-files';
const RECENT_LIMIT = 6;
const RECENT_SHOWN = 4;
const AUDIO_EXTENSIONS = ['mp3', 'm4a', 'wav', 'flac', 'ogg', 'opus', 'aac'];

// Die Liste ist nur eine Bequemlichkeit: Fehlt der Speicher, gibt es eben keine.
function readRecent() {
  try {
    const list = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
    return Array.isArray(list) ? list.filter((entry) => typeof entry === 'string') : [];
  } catch {
    return [];
  }
}

function writeRecent(list) {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(list));
  } catch {
    // Ohne Speicher bleibt die Liste leer.
  }
  window.dispatchEvent(new Event('vitool-recent'));
}

export function rememberFile(filePath) {
  if (!filePath || !isMediaFile(filePath)) return;
  writeRecent([filePath, ...readRecent().filter((entry) => entry !== filePath)].slice(0, RECENT_LIMIT));
}

const fileName = (filePath) => filePath.split(/[\\/]/).pop();
const folderName = (filePath) => filePath.slice(0, -fileName(filePath).length - 1);

// Reine Info-Karten zeigen, was der Bereich kann. Mit onSelect werden sie zu Knöpfen,
// die gleich das passende Werkzeug wählen und eine Datei abfragen.
function featureCard({ iconName, title, text, onSelect }, pick, deliver) {
  const content = [
    el('span', { class: 'feature-icon' }, icon(ICONS[iconName])),
    el('strong', {}, title),
    el('span', { class: 'muted' }, text),
  ];
  if (!onSelect) return el('div', { class: 'feature-card' }, ...content);
  return el('button', {
    class: 'feature-card action',
    onclick: () => {
      onSelect();
      pick();
    },
    ondragover: (event) => event.preventDefault(),
    ondrop: (event) => {
      event.preventDefault();
      onSelect();
      deliver([...event.dataTransfer.files].map((file) => window.vitool.pathForFile(file)));
    },
  }, ...content);
}

function recentList(deliver, allowAudio) {
  const list = el('ul', { class: 'recent-list' });
  const root = el('section', { class: 'card stack recent-card', hidden: true },
    el('div', { class: 'section-head' },
      el('h2', {}, t('Zuletzt verwendet')),
      el('button', { class: 'button small', onclick: () => writeRecent([]) }, t('Liste leeren'))),
    list);
  const render = () => {
    const files = readRecent()
      .filter((filePath) => allowAudio || !AUDIO_EXTENSIONS.includes(filePath.split('.').pop().toLowerCase()))
      .slice(0, RECENT_SHOWN);
    root.hidden = files.length === 0;
    list.replaceChildren(...files.map((filePath) => el('li', {},
      el('button', { class: 'recent-item', title: filePath, onclick: () => deliver([filePath]) },
        el('span', { class: 'recent-icon' }, icon(ICONS.file)),
        el('span', { class: 'recent-text' },
          el('strong', {}, fileName(filePath)),
          el('span', { class: 'muted' }, folderName(filePath)))))));
  };
  window.addEventListener('vitool-recent', render);
  render();
  return root;
}

export function createFileDrop({
  onFile,
  onFiles,
  title = onFiles ? t('Videos hierher ziehen') : t('Video hierher ziehen'),
  hint = t('oder klicken, um eine Datei auszuwählen'),
  dialog = onFiles ? 'dialog:pickVideos' : 'dialog:pickVideo',
  compact = false,
  features = null,
  allowAudio = false,
}) {
  const deliver = (paths) => {
    if (paths.length === 0) return;
    // Nur Einzeldateien kommen in die Liste, ein ganzer Stapel würde sie sofort füllen.
    if (paths.length === 1) rememberFile(paths[0]);
    if (onFiles) onFiles(paths);
    else onFile(paths[0]);
  };

  const pick = async () => {
    const result = await window.vitool.invoke(dialog);
    deliver([result].flat().filter(Boolean));
  };

  const drop = el('button', {
    class: `dropzone ${compact ? 'compact' : ''}`,
    onclick: pick,
    ondragover: (event) => {
      event.preventDefault();
      drop.classList.add('over');
    },
    ondragleave: () => drop.classList.remove('over'),
    ondrop: (event) => {
      event.preventDefault();
      drop.classList.remove('over');
      deliver([...event.dataTransfer.files].map((file) => window.vitool.pathForFile(file)));
    },
  },
  compact ? null : el('span', { class: 'drop-icon' }, icon(ICONS.upload)),
  el('strong', {}, title),
  el('span', { class: 'muted' }, hint));

  if (!features) return drop;
  const actions = features.some((feature) => feature.onSelect);
  return el('div', { class: 'drop-hero' },
    drop,
    el('div', { class: `feature-grid ${actions ? 'actions' : ''}` }, ...features.map((feature) => featureCard(feature, pick, deliver))),
    recentList(deliver, allowAudio));
}
