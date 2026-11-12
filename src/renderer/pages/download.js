// Bereich Download: Link prüfen, Optionen und Abschnitte wählen, Aufgabe starten.
import { el, icon, pageHeader } from '../utils/dom.js';
import { ICONS } from '../utils/icons.js';
import { formatTime } from '../utils/time.js';
import { SectionEditor } from '../components/section-editor.js';
import { t, formatDate } from '../utils/i18n.js';

const invoke = (...args) => window.vitool.invoke(...args);

const PLAYLIST_HEIGHTS = [2160, 1440, 1080, 720, 480, 360];

const state = {
  info: null,
  settings: null,
  mode: 'video',
  useSections: false,
  playlist: null,
  playlistMode: 'video',
  finder: { url: null, open: false, items: [] },
};

let parts = {};
let editor = null;
let stream = null;
let previewStarted = false;

function setMessage(text) {
  parts.message.textContent = text;
  parts.message.hidden = !text;
}

async function loadInfo() {
  const url = parts.url.value.trim();
  if (!url) return;

  parts.load.disabled = true;
  parts.load.textContent = t('Lädt …');
  parts.result.hidden = true;
  parts.playlistView.hidden = true;
  parts.playlistNote.hidden = true;
  parts.finder.hidden = true;
  setMessage('');
  // Der eingefügte Link enthält die Playlist, die Videoinfo nur noch das einzelne Video.
  state.pastedUrl = url;

  const response = await invoke('download:info', url);

  parts.load.disabled = false;
  parts.load.textContent = t('Prüfen');
  if (!response.ok) {
    if (response.canSearchPage) offerFinder(url);
    else setMessage(response.error);
    return;
  }
  // Ein reiner Playlist-Link zeigt gleich die Liste, ein einzelnes Video daraus bietet sie an.
  if (response.info.playlist === 'only') loadPlaylist(url);
  else showInfo(response.info);
}

async function loadPlaylist(url) {
  setMessage('');
  parts.playlistButton.disabled = true;
  parts.load.disabled = true;
  parts.load.textContent = t('Lädt Playlist …');
  const response = await invoke('download:playlist', url);
  parts.playlistButton.disabled = false;
  parts.load.disabled = false;
  parts.load.textContent = t('Prüfen');
  if (!response.ok) {
    setMessage(response.error);
    return;
  }
  stopPreview();
  parts.playlistNote.hidden = true;
  parts.plStatus.hidden = true;
  state.playlist = response.playlist;
  state.playlist.entries.forEach((entry) => {
    entry.selected = entry.available;
  });
  parts.result.hidden = true;
  parts.playlistView.hidden = false;
  renderPlaylist();
}

function closePlaylist() {
  state.playlist = null;
  parts.playlistView.hidden = true;
  const single = state.info && state.info.playlist === 'member';
  parts.result.hidden = !single;
  parts.playlistNote.hidden = !single;
}

function renderPlaylist() {
  const { playlist } = state;
  const selected = playlist.entries.filter((entry) => entry.selected);
  const unavailable = playlist.entries.filter((entry) => !entry.available).length;
  parts.playlistTitle.textContent = playlist.title;
  parts.playlistMeta.textContent = [
    playlist.uploader,
    t('{count} Videos', { count: playlist.entries.length }),
    unavailable ? t('{count} nicht verfügbar', { count: unavailable }) : null,
  ].filter(Boolean).join(' · ');
  parts.playlistList.replaceChildren(...playlist.entries.map((entry) => {
    const check = el('input', {
      type: 'checkbox',
      checked: entry.selected,
      disabled: !entry.available,
      'aria-label': entry.title,
      onchange: () => {
        entry.selected = check.checked;
        renderPlaylistCount();
      },
    });
    return el('li', {},
      el('label', { class: `playlist-row ${entry.available ? '' : 'unavailable'}` },
        check,
        el('span', { class: 'muted playlist-index' }, String(entry.index)),
        el('span', { class: 'playlist-name', title: entry.title }, entry.title),
        el('span', { class: 'muted' }, entry.duration ? formatTime(entry.duration) : '')));
  }));
  const audio = state.playlistMode === 'audio';
  parts.plVideo.classList.toggle('active', !audio);
  parts.plAudio.classList.toggle('active', audio);
  parts.plVideo.setAttribute('aria-pressed', String(!audio));
  parts.plAudio.setAttribute('aria-pressed', String(audio));
  parts.plQuality.hidden = audio;
  parts.plFolder.textContent = state.settings.downloadDir;
  parts.plFolder.title = state.settings.downloadDir;
  parts.plSubfolderName.textContent = t('„{name}“', { name: playlist.title });
  renderPlaylistCount(selected);
}

function renderPlaylistCount(selected = state.playlist.entries.filter((entry) => entry.selected)) {
  const count = selected.length;
  parts.plCount.textContent = t('{count} ausgewählt', { count });
  parts.plStart.disabled = count === 0;
  parts.plStart.textContent = count === 1 ? t('1 Video herunterladen') : t('{count} Videos herunterladen', { count });
}

function selectAll(selected) {
  state.playlist.entries.forEach((entry) => {
    entry.selected = selected && entry.available;
  });
  renderPlaylist();
}

async function startPlaylist() {
  const { playlist } = state;
  const entries = playlist.entries.filter((entry) => entry.selected);
  const response = await invoke('download:playlistStart', {
    entries: entries.map(({ url, title, thumbnail, duration }) => ({ url, title, thumbnail, duration })),
    mode: state.playlistMode,
    height: Number(parts.plQuality.value) || null,
    folder: state.settings.downloadDir,
    subfolder: parts.plSubfolder.checked,
    playlistTitle: playlist.title,
  });
  if (!response.ok) {
    setMessage(response.error);
    return;
  }
  setMessage('');
  parts.plStatus.textContent = response.count === 1
    ? t('1 Video ist in der Warteschlange. Ziel: {folder}', { folder: response.folder })
    : t('{count} Videos sind in der Warteschlange. Ziel: {folder}', { count: response.count, folder: response.folder });
  parts.plStatus.hidden = false;
}

// yt-dlp kennt nicht jede Seite. Dann öffnet Vitool sie in einem eigenen Fenster und
// merkt sich die Videoadressen, die der Player dort beim Abspielen lädt.
function offerFinder(url) {
  state.finder = { url, open: false, items: [] };
  renderFinder();
  parts.finder.hidden = false;
}

async function openFinder() {
  setMessage('');
  const response = await invoke('download:findOnPage', state.finder.url);
  if (!response.ok) setMessage(response.error);
}

async function useFound(item, button) {
  button.disabled = true;
  button.textContent = t('Lädt …');
  const response = await invoke('download:fromPage', item.id);
  button.disabled = false;
  button.textContent = t('Verwenden');
  if (!response.ok) {
    setMessage(response.error);
    return;
  }
  setMessage('');
  parts.finder.hidden = true;
  showInfo(response.info);
}

const KIND_LABELS = { hls: 'Stream', dash: 'Stream', file: t('Datei') };

function foundRow(item) {
  const button = el('button', { class: 'button small', onclick: () => useFound(item, button) }, t('Verwenden'));
  return el('li', { class: 'found-row' },
    el('span', { class: 'found-kind' }, KIND_LABELS[item.kind]),
    el('div', { class: 'video-text' },
      el('span', { class: 'found-name', title: item.name }, item.name || item.host),
      el('span', { class: 'muted' }, item.host)),
    button);
}

function renderFinder() {
  const { open, items } = state.finder;
  let text;
  if (open && items.length === 0) text = t('Starte das Video im geöffneten Fenster. Sobald Vitool es findet, erscheint es hier.');
  else if (open) text = t('Gefunden. Läuft vorher Werbung, erscheinen mehrere Einträge. Der eigentliche Film ist meist ein Stream.');
  else if (items.length === 0) text = t('yt-dlp kennt diese Seite nicht. Vitool kann sie in einem eigenen Fenster öffnen und das Video finden, während es dort läuft.');
  else text = t('Das Fenster ist geschlossen. Du kannst ein gefundenes Video trotzdem noch verwenden.');
  parts.finderText.textContent = text;
  parts.finderList.replaceChildren(...items.map(foundRow));
  parts.finderList.hidden = items.length === 0;
  parts.finderOpen.hidden = open;
  parts.finderOpen.textContent = items.length || state.finder.wasOpened ? t('Seite erneut öffnen') : t('Seite öffnen');
  parts.finderClose.hidden = !open;
}

function onPageMedia({ open, items }) {
  if (!state.finder.url) return;
  if (open) state.finder.wasOpened = true;
  state.finder.open = open;
  state.finder.items = items;
  renderFinder();
}

function showInfo(info) {
  state.info = info;
  state.useSections = false;
  parts.playlistNote.hidden = info.playlist !== 'member';

  parts.thumb.src = info.thumbnail ?? '';
  parts.thumb.hidden = !info.thumbnail;
  parts.title.textContent = info.title;
  parts.meta.textContent = [info.uploader, info.isLive ? t('Live-Übertragung') : info.duration ? formatTime(info.duration) : null]
    .filter(Boolean).join(' · ');

  parts.quality.replaceChildren(
    el('option', { value: '' }, t('Beste Qualität')),
    ...info.heights.map((height) => el('option', { value: String(height) }, `${height}p`)),
  );

  parts.sectionToggle.checked = false;
  parts.sectionRow.hidden = !info.duration;
  parts.sections.hidden = true;
  stopPreview();
  if (info.duration) editor.load(info.duration);

  parts.result.hidden = false;
  renderOptions();
}

function renderOptions() {
  const audio = state.mode === 'audio';
  parts.modeVideo.classList.toggle('active', !audio);
  parts.modeAudio.classList.toggle('active', audio);
  parts.modeVideo.setAttribute('aria-pressed', String(!audio));
  parts.modeAudio.setAttribute('aria-pressed', String(audio));
  parts.qualityField.hidden = audio;
}

function nextRange(duration, last) {
  const start = last ? Math.min(last.end, Math.max(0, duration - 10)) : 0;
  const end = last ? Math.min(duration, start + 30) : Math.min(duration, Math.max(30, duration * 0.2));
  return { start, end };
}

function showNoPreview() {
  parts.preview.hidden = true;
  parts.previewHint.hidden = false;
}

function stopPreview() {
  stream?.destroy();
  stream = null;
  previewStarted = false;
  parts.video.removeAttribute('src');
  parts.video.load();
}

function startPreview() {
  const { previewUrl, previewKind } = state.info;
  parts.preview.hidden = !previewUrl;
  parts.previewHint.hidden = Boolean(previewUrl);
  if (!previewUrl || previewStarted) return;
  previewStarted = true;

  if (previewKind !== 'hls') {
    parts.video.src = previewUrl;
    return;
  }
  if (!window.Hls?.isSupported()) {
    showNoPreview();
    return;
  }
  stream = new window.Hls({ enableWorker: false });
  stream.on(window.Hls.Events.ERROR, (_event, data) => {
    if (data.fatal) showNoPreview();
  });
  stream.loadSource(previewUrl);
  stream.attachMedia(parts.video);
}

function enableSections(enabled) {
  state.useSections = enabled;
  parts.sections.hidden = !enabled;
  if (!enabled) {
    parts.video.pause();
    return;
  }
  editor.ensureRange();
  startPreview();
  editor.render();
}

async function startDownload() {
  const { info, settings } = state;
  const sections = state.useSections ? editor.ranges : [];
  const response = await invoke('download:start', {
    url: info.url,
    title: info.title,
    thumbnail: info.thumbnail,
    duration: info.duration,
    mode: state.mode,
    height: Number(parts.quality.value) || null,
    sections,
    exact: parts.exact.checked,
    merge: editor.merge && sections.length > 1,
    folder: settings.downloadDir,
    openInCut: parts.openInCut.checked,
    headers: info.headers ?? null,
    pageUrl: info.pageUrl ?? null,
  });
  if (!response.ok) setMessage(response.error);
  else setMessage('');
}

async function chooseFolder() {
  const folder = await invoke('dialog:pickFolder', state.settings.downloadDir);
  if (!folder) return;
  state.settings = await invoke('settings:set', { downloadDir: folder });
  [parts.folder, parts.plFolder].forEach((node) => {
    node.textContent = folder;
    node.title = folder;
  });
}

// Ohne Bild, etwa bei älteren Einträgen oder ohne Internet, erscheint ein Symbol.
function historyThumb(entry) {
  const fallback = el('span', { class: 'history-thumb placeholder' }, icon(entry.mode === 'audio' ? ICONS.music : ICONS.download));
  if (!entry.thumbnail) return fallback;
  const image = el('img', { class: 'history-thumb', alt: '', src: entry.thumbnail, loading: 'lazy' });
  image.addEventListener('error', () => image.replaceWith(fallback));
  return image;
}

function historyRow(entry) {
  const date = formatDate(entry.date);
  const count = entry.files.length > 1 ? ` · ${t('{count} Dateien', { count: entry.files.length })}` : '';
  return el('li', { class: 'history-row' },
    historyThumb(entry),
    el('div', { class: 'history-text' },
      el('span', { class: 'job-title', title: entry.title }, entry.title),
      el('span', { class: 'muted' }, `${date} · ${entry.mode === 'audio' ? 'MP3' : 'Video'}${count}`),
    ),
    el('button', { class: 'button small', onclick: () => invoke('shell:openFile', entry.files[0]) }, t('Öffnen')),
    el('button', { class: 'button small', onclick: () => invoke('shell:showFile', entry.files[0]) }, t('Im Ordner zeigen')),
  );
}

function renderHistory(history) {
  parts.historyEmpty.hidden = history.length > 0;
  parts.historyClear.hidden = history.length === 0;
  parts.history.replaceChildren(...history.map(historyRow));
}

function buildPage(root) {
  parts = {
    url: el('input', {
      class: 'input grow',
      placeholder: t('Link zum Video einfügen'),
      'aria-label': t('Link zum Video'),
      spellcheck: false,
      onkeydown: (event) => {
        if (event.key === 'Enter') loadInfo();
      },
      onpaste: () => setTimeout(loadInfo),
    }),
    load: el('button', { class: 'button primary', onclick: loadInfo }, t('Prüfen')),
    message: el('p', { class: 'message', role: 'alert', hidden: true }),
    result: el('div', { class: 'stack', hidden: true }),
    thumb: el('img', { class: 'thumb', alt: '' }),
    title: el('h2', {}),
    meta: el('p', { class: 'muted' }),
    modeVideo: el('button', { class: 'segment', onclick: () => { state.mode = 'video'; renderOptions(); } }, t('Video')),
    modeAudio: el('button', { class: 'segment', onclick: () => { state.mode = 'audio'; renderOptions(); } }, t('Nur Audio (MP3)')),
    quality: el('select', { class: 'input', 'aria-label': t('Qualität') }),
    qualityField: el('div', {}),
    sectionToggle: el('input', {
      type: 'checkbox',
      onchange: (event) => enableSections(event.target.checked),
    }),
    sectionRow: el('label', { class: 'switch' }),
    sections: el('div', { class: 'stack', hidden: true }),
    preview: el('div', { class: 'preview' }),
    previewHint: el('p', { class: 'muted', hidden: true }),
    video: el('video', { controls: true, preload: 'metadata' }),
    exact: el('input', { type: 'checkbox' }),
    folder: el('span', { class: 'folder-path' }),
    openInCut: el('input', { type: 'checkbox' }),
    history: el('ul', { class: 'history-list' }),
    historyEmpty: el('p', { class: 'muted' }, t('Noch keine Downloads.')),
    historyClear: el('button', { class: 'button small', onclick: async () => renderHistory(await invoke('download:clearHistory')) }, t('Verlauf leeren')),
    playlistNote: el('section', { class: 'card playlist-note', hidden: true }),
    playlistButton: el('button', { class: 'button small', onclick: () => loadPlaylist(state.pastedUrl) }, t('Ganze Playlist anzeigen')),
    playlistView: el('div', { class: 'stack', hidden: true }),
    playlistTitle: el('h2', {}),
    playlistMeta: el('p', { class: 'muted' }),
    playlistList: el('ul', { class: 'playlist-list' }),
    plCount: el('span', { class: 'muted' }),
    plVideo: el('button', { class: 'segment', onclick: () => { state.playlistMode = 'video'; renderPlaylist(); } }, t('Video')),
    plAudio: el('button', { class: 'segment', onclick: () => { state.playlistMode = 'audio'; renderPlaylist(); } }, t('Nur Audio (MP3)')),
    plQuality: el('select', { class: 'input', 'aria-label': t('Qualität für alle Videos') },
      el('option', { value: '' }, t('Beste Qualität')),
      ...PLAYLIST_HEIGHTS.map((height) => el('option', { value: String(height) }, t('Höchstens {height}p', { height })))),
    plFolder: el('span', { class: 'folder-path' }),
    plSubfolder: el('input', { type: 'checkbox', checked: true }),
    plSubfolderName: el('strong', {}),
    plStart: el('button', { class: 'button primary large', onclick: startPlaylist }),
    plStatus: el('p', { class: 'notice', role: 'status', hidden: true }),
    finder: el('section', { class: 'card stack', hidden: true }),
    finderText: el('p', { class: 'muted' }),
    finderList: el('ul', { class: 'found-list', hidden: true }),
    finderOpen: el('button', { class: 'button primary', onclick: openFinder }),
    finderClose: el('button', { class: 'button small', onclick: () => invoke('download:closeFinder') }, t('Fenster schließen')),
  };

  parts.finder.append(
    el('div', { class: 'section-head' }, el('h2', {}, t('Video auf der Seite suchen')), parts.finderClose),
    parts.finderText,
    parts.finderList,
    el('div', {}, parts.finderOpen),
  );

  parts.playlistNote.append(
    el('span', {}, t('Dieses Video gehört zu einer Playlist.')),
    parts.playlistButton,
  );
  parts.playlistView.append(
    el('section', { class: 'card stack' },
      el('div', { class: 'section-head' },
        el('div', { class: 'video-text' }, parts.playlistTitle, parts.playlistMeta),
        el('button', { class: 'button small', onclick: closePlaylist }, t('Schließen'))),
      el('div', { class: 'marker-row' },
        el('button', { class: 'button small', onclick: () => selectAll(true) }, t('Alle')),
        el('button', { class: 'button small', onclick: () => selectAll(false) }, t('Keine')),
        parts.plCount),
      parts.playlistList,
    ),
    el('section', { class: 'card stack' },
      el('div', { class: 'option-row' },
        el('div', { class: 'segments', role: 'group', 'aria-label': t('Art des Downloads') }, parts.plVideo, parts.plAudio),
        parts.plQuality),
      el('div', { class: 'folder-row' },
        el('span', { class: 'muted' }, t('Zielordner')),
        parts.plFolder,
        el('button', { class: 'button small', onclick: chooseFolder }, t('Ändern'))),
      el('label', { class: 'check' }, parts.plSubfolder, el('span', {}, t('In einen eigenen Unterordner '), parts.plSubfolderName)),
      parts.plStatus,
      el('div', {}, parts.plStart),
    ),
  );

  parts.previewHint.textContent = t('Für dieses Video ist keine Vorschau möglich. Lege die Zeiten über Griffe oder Eingabefelder fest.');
  parts.preview.append(parts.video);
  parts.qualityField.append(parts.quality);
  parts.sectionRow.append(parts.sectionToggle, el('span', { class: 'switch-track' }), t('Nur einen Abschnitt herunterladen'));

  editor = new SectionEditor({ video: parts.video, onMessage: setMessage, createRange: nextRange });

  parts.video.addEventListener('error', () => {
    if (parts.video.getAttribute('src')) showNoPreview();
  });

  parts.sections.append(
    parts.preview,
    parts.previewHint,
    editor.root,
    el('label', { class: 'check' }, parts.exact,
      el('span', {}, t('Exakt schneiden'), el('small', { class: 'muted' }, t('Genauer, aber langsamer, da neu kodiert wird. Ohne diese Option kann der Schnitt um einige Sekunden abweichen.')))),
  );

  parts.result.append(
    el('section', { class: 'card video-card' },
      parts.thumb,
      el('div', { class: 'video-text' }, parts.title, parts.meta),
    ),
    el('section', { class: 'card stack' },
      el('div', { class: 'option-row' },
        el('div', { class: 'segments', role: 'group', 'aria-label': t('Art des Downloads') }, parts.modeVideo, parts.modeAudio),
        parts.qualityField,
      ),
      parts.sectionRow,
      parts.sections,
    ),
    el('section', { class: 'card stack' },
      el('div', { class: 'folder-row' },
        el('span', { class: 'muted' }, t('Zielordner')),
        parts.folder,
        el('button', { class: 'button small', onclick: chooseFolder }, t('Ändern')),
      ),
      el('label', { class: 'check' }, parts.openInCut, el('span', {}, t('Nach dem Download im Bereich Schneiden öffnen'))),
      el('div', {}, el('button', { class: 'button primary large', onclick: startDownload }, t('Herunterladen'))),
    ),
  );

  root.append(
    pageHeader('Download', t('Link einfügen, Qualität wählen, fertig.')),
    el('section', { class: 'card stack' },
      el('div', { class: 'url-row' }, parts.url, parts.load),
      // Bewusst nur eine ruhige Zeile: ein Hinweis, keine Hürde.
      el('p', { class: 'muted small-note' }, t('Lade nur Videos herunter, die du nutzen darfst, etwa eigene oder frei lizenzierte. Urheberrecht und die Regeln der jeweiligen Seite gelten weiter.'))),
    parts.message,
    parts.finder,
    parts.playlistNote,
    parts.result,
    parts.playlistView,
    el('section', { class: 'card stack history' },
      el('div', { class: 'section-head' }, el('h2', {}, t('Verlauf')), parts.historyClear),
      parts.historyEmpty,
      parts.history,
    ),
  );
}

export default {
  id: 'download',
  label: 'Download',
  async mount(root) {
    buildPage(root);
    state.settings = await invoke('settings:get');
    parts.folder.textContent = state.settings.downloadDir;
    parts.folder.title = state.settings.downloadDir;
    parts.openInCut.checked = state.settings.openInCut;
    parts.openInCut.addEventListener('change', async (event) => {
      state.settings = await invoke('settings:set', { openInCut: event.target.checked });
    });
    renderHistory(await invoke('download:history'));
    window.vitool.on('download:historyChanged', renderHistory);
    window.vitool.on('download:pageMedia', onPageMedia);
  },
  onHide() {
    parts.video.pause();
  },
};
