// Bereich MKV: Spuren einer Datei verwalten, ohne das Video neu zu kodieren.
import { el, pageHeader } from '../utils/dom.js';
import { folderOf } from '../utils/path.js';
import { createFileDrop } from '../components/file-drop.js';
import { createSendTo } from '../components/send-to.js';
import { t } from '../utils/i18n.js';

const invoke = (...args) => window.vitool.invoke(...args);

const LANGUAGES = {
  und: t('Unbestimmt'), deu: t('Deutsch'), ger: t('Deutsch'), eng: t('Englisch'), fra: t('Französisch'), fre: t('Französisch'),
  spa: t('Spanisch'), ita: t('Italienisch'), jpn: t('Japanisch'), kor: t('Koreanisch'), rus: t('Russisch'), tur: t('Türkisch'),
};
const LANGUAGE_CHOICES = ['und', 'deu', 'eng', 'fra', 'spa', 'ita', 'jpn', 'kor', 'rus', 'tur'];
const TYPE_LABELS = { video: t('Video'), audio: 'Audio', subtitle: t('Untertitel') };

const FEATURES = [
  { iconName: 'layers', title: t('Spuren auswählen'), text: t('Unnötige Tonspuren und Untertitel entfernen') },
  { iconName: 'tag', title: t('Benennen'), text: t('Sprache, Name, Standard und Erzwungen festlegen') },
  { iconName: 'music', title: t('Hinzufügen und herausholen'), text: t('Spuren einfügen oder als eigene Datei speichern') },
];

const state = { files: [], tracks: [], folder: null };
let parts = {};

function setMessage(text) {
  parts.message.textContent = text;
  parts.message.hidden = !text;
}

function languageSelect(track) {
  const choices = LANGUAGE_CHOICES.includes(track.language) ? LANGUAGE_CHOICES : [track.language, ...LANGUAGE_CHOICES];
  return el('select', {
    class: 'input',
    'aria-label': t('Sprache'),
    onchange: (event) => {
      track.language = event.target.value;
    },
  }, ...choices.map((code) => el('option', { value: code, selected: code === track.language }, LANGUAGES[code] ?? code)));
}

function flagToggle(label, active, onToggle) {
  return el('button', {
    class: `flag ${active ? 'active' : ''}`,
    'aria-pressed': String(active),
    onclick: onToggle,
  }, label);
}

// Pro Spurart kann nur eine Spur die Standardspur sein.
function toggleDefault(track) {
  const next = !track.isDefault;
  state.tracks.filter((entry) => entry.type === track.type).forEach((entry) => {
    entry.isDefault = false;
  });
  track.isDefault = next;
  renderTracks();
}

function trackRow(track) {
  const fromMain = track.source === 0;
  const keep = el('input', {
    type: 'checkbox',
    checked: track.keep,
    'aria-label': t('Spur behalten'),
    onchange: (event) => {
      track.keep = event.target.checked;
      renderTracks();
    },
  });

  return el('li', { class: `track-row ${track.keep ? '' : 'off'}` },
    keep,
    el('span', { class: `track-type ${track.type}` }, TYPE_LABELS[track.type]),
    el('div', { class: 'track-info' },
      el('strong', {}, track.codec.toUpperCase()),
      el('span', { class: 'muted' }, [track.info, fromMain ? '' : t('Neu')].filter(Boolean).join(' · ') || ' ')),
    languageSelect(track),
    el('input', {
      class: 'input track-name',
      value: track.name,
      placeholder: t('Name der Spur'),
      'aria-label': t('Name der Spur'),
      oninput: (event) => {
        track.name = event.target.value;
      },
    }),
    flagToggle(t('Standard'), track.isDefault, () => toggleDefault(track)),
    flagToggle(t('Erzwungen'), track.forced, () => {
      track.forced = !track.forced;
      renderTracks();
    }),
    fromMain
      ? el('button', { class: 'button small', onclick: () => extractTrack(track) }, t('Herausholen'))
      : el('button', { class: 'button small', onclick: () => removeSource(track.source) }, t('Entfernen')),
  );
}

function renderTracks() {
  parts.tracks.replaceChildren(...state.tracks.map(trackRow));
  const kept = state.tracks.filter((track) => track.keep).length;
  parts.count.textContent = t('{kept} von {total} Spuren werden behalten', { kept, total: state.tracks.length });
}

async function openFile(filePath) {
  setMessage('');
  const response = await invoke('mkv:read', filePath, 0);
  if (!response.ok) {
    setMessage(response.error);
    return;
  }

  state.files = [filePath];
  state.tracks = response.tracks;
  state.folder = folderOf(filePath);

  parts.name.textContent = filePath.slice(state.folder.length + 1);
  parts.name.title = filePath;
  parts.title.value = response.title;
  parts.folder.textContent = state.folder;
  parts.folder.title = state.folder;

  renderTracks();
  parts.drop.hidden = true;
  parts.workspace.hidden = false;
}

async function addFile(filePath) {
  setMessage('');
  const source = state.files.length;
  const response = await invoke('mkv:read', filePath, source);
  if (!response.ok) {
    setMessage(response.error);
    return;
  }
  state.files.push(filePath);
  state.tracks.push(...response.tracks.map((track) => ({ ...track, isDefault: false })));
  renderTracks();
}

// Die Dateinummern müssen lückenlos bleiben, weil FFmpeg die Spuren darüber zuordnet.
function removeSource(source) {
  state.files.splice(source, 1);
  state.tracks = state.tracks
    .filter((track) => track.source !== source)
    .map((track) => ({ ...track, source: track.source > source ? track.source - 1 : track.source }));
  renderTracks();
}

function closeFile() {
  state.files = [];
  state.tracks = [];
  setMessage('');
  parts.workspace.hidden = true;
  parts.drop.hidden = false;
}

async function extractTrack(track) {
  const response = await invoke('mkv:extract', { filePath: state.files[0], track, folder: state.folder });
  setMessage(response.ok ? '' : response.error);
}

async function chooseFolder() {
  const folder = await invoke('dialog:pickFolder', state.folder);
  if (!folder) return;
  state.folder = folder;
  parts.folder.textContent = folder;
  parts.folder.title = folder;
}

async function save() {
  const response = await invoke('mkv:save', {
    files: state.files,
    tracks: state.tracks,
    title: parts.title.value,
    folder: state.folder,
  });
  setMessage(response.ok ? '' : response.error);
}

function buildPage(root) {
  parts = {
    message: el('p', { class: 'message', role: 'alert', hidden: true }),
    drop: createFileDrop({ onFile: openFile, title: t('Video mit Spuren hierher ziehen'), features: FEATURES }),
    workspace: el('div', { class: 'stack', hidden: true }),
    name: el('h2', { class: 'file-name' }),
    count: el('p', { class: 'muted' }),
    title: el('input', { class: 'input grow', placeholder: t('Titel des Videos'), 'aria-label': t('Titel des Videos') }),
    tracks: el('ul', { class: 'track-list' }),
    folder: el('span', { class: 'folder-path' }),
  };

  parts.workspace.append(
    el('section', { class: 'card file-card' },
      el('div', { class: 'video-text' }, parts.name, parts.count),
      el('div', { class: 'file-actions' },
        createSendTo({ getPath: () => state.files[0], exclude: 'mkv' }),
        el('button', { class: 'button small', onclick: closeFile }, t('Andere Datei'))),
    ),
    el('section', { class: 'card stack' },
      el('div', { class: 'url-row' }, el('span', { class: 'muted' }, t('Titel')), parts.title),
      parts.tracks,
      createFileDrop({
        onFile: addFile,
        title: t('Spur hinzufügen'),
        hint: t('Audio, Untertitel oder Video hierher ziehen oder klicken'),
        dialog: 'dialog:pickTrack',
        compact: true,
      }),
    ),
    el('section', { class: 'card stack' },
      el('p', { class: 'muted' }, t('Das Ergebnis ist eine MKV-Datei. Es wird nichts neu kodiert, die Qualität bleibt gleich und es dauert meist nur Sekunden. Kapitel bleiben erhalten.')),
      el('div', { class: 'folder-row' },
        el('span', { class: 'muted' }, t('Zielordner')),
        parts.folder,
        el('button', { class: 'button small', onclick: chooseFolder }, t('Ändern')),
      ),
      el('div', {}, el('button', { class: 'button primary large', onclick: save }, t('Als MKV speichern'))),
    ),
  );

  root.append(
    pageHeader('MKV', t('Spuren verwalten, ohne das Video neu zu kodieren.')),
    parts.message,
    parts.drop,
    parts.workspace,
  );
}

export default {
  id: 'mkv',
  label: 'MKV',
  mount: buildPage,
  onShow(data) {
    if (data?.filePath) openFile(data.filePath);
  },
};
