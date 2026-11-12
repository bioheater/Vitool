// Bereich MKV: Spuren einer Datei verwalten, ohne das Video neu zu kodieren.
import { el, pageHeader } from '../utils/dom.js';
import { folderOf } from '../utils/path.js';
import { createFileDrop } from '../components/file-drop.js';
import { createSendTo } from '../components/send-to.js';
import { SyncPanel } from '../components/sync-panel.js';
import { VolumePanel, formatGain } from '../components/volume-panel.js';
import { t, LANGUAGE } from '../utils/i18n.js';

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
let syncPanel = null;
let volumePanel = null;

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

const OFFSET_FORMAT = new Intl.NumberFormat(LANGUAGE, { maximumFractionDigits: 3, useGrouping: false, signDisplay: 'exceptZero' });

// Erlaubt "1,5", "-0.25" oder "+2". Ein leeres Feld heißt: nicht verschieben.
function parseOffset(text) {
  const value = text.trim().replace(',', '.');
  if (value === '') return 0;
  if (!/^[+-]?\d*\.?\d+$/.test(value)) return null;
  const seconds = Number(value);
  return Math.abs(seconds) <= 3600 ? Math.round(seconds * 1000) / 1000 : null;
}

function offsetField(track) {
  const shown = (value) => (value ? OFFSET_FORMAT.format(value) : '');
  const input = el('input', {
    class: 'input',
    value: shown(track.offset),
    placeholder: '0',
    inputmode: 'decimal',
    'aria-label': t('Versatz in Sekunden'),
    onchange: () => {
      const value = parseOffset(input.value);
      if (value === null) {
        input.value = shown(track.offset);
        setMessage(t('Gib den Versatz in Sekunden ein, zum Beispiel 1,5 oder -0,3.'));
        return;
      }
      setMessage('');
      track.offset = value;
      input.value = shown(value);
      syncPanel.refresh();
    },
  });
  return el('label', {
    class: 'track-offset',
    title: t('Positiv: Die Spur setzt später ein. Negativ: Sie setzt früher ein.'),
  }, el('span', { class: 'muted' }, t('Versatz')), input, el('span', { class: 'muted' }, 's'));
}

// Angleichen lohnt sich nur, wenn es eine zweite Tonspur zum Vergleichen gibt.
function syncButton(track) {
  const audio = state.tracks.filter((entry) => entry.type === 'audio').length;
  if (track.type !== 'audio' || audio < 2) return null;
  const active = syncPanel.isOpenFor(track);
  return el('button', {
    class: `button small ${active ? 'active' : ''}`,
    'aria-pressed': String(active),
    title: t('Wellenform vergleichen, Versatz und Tempo automatisch finden'),
    onclick: () => {
      syncPanel.open(track);
      renderTracks();
    },
  }, t('Angleichen'));
}

function volumeButton(track) {
  if (track.type !== 'audio') return null;
  const active = volumePanel.isOpenFor(track);
  return el('button', {
    class: `button small ${active ? 'active' : ''}`,
    'aria-pressed': String(active),
    title: t('Lautstärke messen, angleichen oder von Hand ändern'),
    onclick: () => {
      volumePanel.open(track);
      renderTracks();
    },
  }, t('Lautstärke'));
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
      el('span', { class: 'muted' }, [
        track.info,
        fromMain ? '' : t('Neu'),
        Math.abs((track.stretch ?? 1) - 1) > 1e-6 ? t('Tempo angepasst') : '',
        Math.abs(track.gain ?? 0) >= 0.05 ? formatGain(track.gain) : '',
      ].filter(Boolean).join(' · ') || ' ')),
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
    // Werkzeuge für Ton und Untertitel in einer eigenen Zeile, damit die obere nicht überläuft.
    track.type === 'video' ? null : el('div', { class: 'track-tools' },
      offsetField(track),
      syncButton(track),
      volumeButton(track)),
  );
}

function renderTracks() {
  parts.tracks.replaceChildren(...state.tracks.map(trackRow));
  const kept = state.tracks.filter((track) => track.keep).length;
  parts.count.textContent = t('{kept} von {total} Spuren werden behalten', { kept, total: state.tracks.length });
  syncPanel.refresh();
  volumePanel.refresh();
}

// Das Bild kommt etwas später. Gehört es nicht mehr zur geöffneten Datei, wird es verworfen.
async function showThumbnail(filePath) {
  parts.thumb.hidden = true;
  parts.thumb.removeAttribute('src');
  const duration = Math.max(0, ...state.tracks.map((track) => track.duration ?? 0));
  const response = await invoke('media:thumbnail', filePath, duration);
  if (!response.ok || state.files[0] !== filePath) return;
  parts.thumb.src = response.url;
  parts.thumb.hidden = false;
}

async function openFile(filePath) {
  setMessage('');
  const response = await invoke('mkv:read', filePath, 0);
  if (!response.ok) {
    setMessage(response.error);
    return;
  }

  syncPanel.close();
  volumePanel.close();
  state.files = [filePath];
  state.tracks = response.tracks;
  state.folder = folderOf(filePath);

  parts.name.textContent = filePath.slice(state.folder.length + 1);
  showThumbnail(filePath);
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
  syncPanel.close();
  volumePanel.close();
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
    thumb: el('img', { class: 'thumb', alt: '', hidden: true }),
    count: el('p', { class: 'muted' }),
    title: el('input', { class: 'input grow', placeholder: t('Titel des Videos'), 'aria-label': t('Titel des Videos') }),
    tracks: el('ul', { class: 'track-list' }),
    folder: el('span', { class: 'folder-path' }),
  };

  syncPanel = new SyncPanel({
    getFiles: () => state.files,
    getTracks: () => state.tracks,
    onChange: renderTracks,
  });
  volumePanel = new VolumePanel({
    getFiles: () => state.files,
    getTracks: () => state.tracks,
    onChange: renderTracks,
  });

  parts.workspace.append(
    el('section', { class: 'card file-card' },
      el('div', { class: 'video-card' }, parts.thumb, el('div', { class: 'video-text' }, parts.name, parts.count)),
      el('div', { class: 'file-actions' },
        createSendTo({ getPath: () => state.files[0], exclude: 'mkv' }),
        el('button', { class: 'button small', onclick: closeFile }, t('Andere Datei'))),
    ),
    el('section', { class: 'card stack' },
      el('div', { class: 'url-row' }, el('span', { class: 'muted' }, t('Titel')), parts.title),
      parts.tracks,
      el('p', { class: 'muted' }, t('Passt eine Tonspur oder ein Untertitel nicht zum Bild, trage beim Versatz Sekunden ein: positiv, wenn der Ton zu früh kommt, negativ, wenn er zu spät kommt.')),
      createFileDrop({
        onFile: addFile,
        title: t('Spur hinzufügen'),
        hint: t('Audio, Untertitel oder Video hierher ziehen oder klicken'),
        dialog: 'dialog:pickTrack',
        compact: true,
      }),
    ),
    syncPanel.root,
    volumePanel.root,
    el('section', { class: 'card stack' },
      el('p', { class: 'muted' }, t('Das Ergebnis ist eine MKV-Datei. Es wird nichts neu kodiert, außer Tonspuren mit geänderter Lautstärke oder angepasstem Tempo. Die Qualität bleibt gleich und es dauert meist nur Sekunden. Kapitel bleiben erhalten.')),
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
