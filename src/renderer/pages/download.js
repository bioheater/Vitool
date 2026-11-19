// Bereich Download: Link prüfen, Optionen und Abschnitte wählen, Aufgabe starten.
import { el, icon, pageHeader } from '../utils/dom.js';
import { ICONS } from '../utils/icons.js';
import { formatTime } from '../utils/time.js';
import { SectionEditor } from '../components/section-editor.js';
import { t, formatDate, LANGUAGE } from '../utils/i18n.js';
import { fixButton } from '../components/error-fix.js';

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
  languages: null,
  extraLanguages: new Set(),
};

let parts = {};
let editor = null;
let stream = null;
let previewStarted = false;
let previewTimer = null;
let previewRetries = 0;
// Gibt YouTube eine Adresse noch nicht frei, klappt es oft beim zweiten Versuch kurz danach.
const PREVIEW_RETRY_MS = 3000;
const PREVIEW_RETRIES = 2;
// Sicherheitsabstand zur Freigabezeit, falls die Uhr des PCs etwas abweicht.
const PREVIEW_MARGIN_MS = 1500;
const PREVIEW_MAX_WAIT_MS = 15000;

// Mit fix steht ein Knopf daneben, der die Ursache behebt. Nach einem Update geht es mit retry weiter.
function setMessage(text, fix = null, retry = null) {
  const button = fix ? fixButton(fix, { onDone: retry }) : null;
  parts.message.replaceChildren(el('span', {}, text ?? ''), ...(button ? [button] : []));
  parts.message.hidden = !text;
}

// Mehr als ein Link im Feld oder in einer Textdatei wird eine Liste.
function countUrls(text) {
  return new Set(String(text ?? '').match(/https?:\/\/[^\s"'<>]+/gi) ?? []).size;
}

function hideResults() {
  parts.result.hidden = true;
  parts.playlistView.hidden = true;
  parts.playlistNote.hidden = true;
  parts.finder.hidden = true;
  setMessage('');
}

async function loadInfo() {
  const url = parts.url.value.trim();
  if (!url) return;
  if (countUrls(url) > 1) {
    loadLinks(url);
    return;
  }

  cancelSearch();
  parts.load.disabled = true;
  parts.load.textContent = t('Lädt …');
  hideResults();
  // Der eingefügte Link enthält die Playlist, die Videoinfo nur noch das einzelne Video.
  state.pastedUrl = url;

  const response = await invoke('download:info', url);

  parts.load.disabled = false;
  parts.load.textContent = t('Prüfen');
  if (!response.ok) {
    if (response.canSearchPage) searchPage(url);
    else setMessage(response.error, response.fix, loadInfo);
    return;
  }
  // Ein reiner Playlist-Link zeigt gleich die Liste, ein einzelnes Video daraus bietet sie an.
  if (response.info.playlist === 'only') loadPlaylist(url);
  else showInfo(response.info);
}

async function loadLinks(text) {
  cancelSearch();
  hideResults();
  const response = await invoke('download:links', text);
  if (!response.ok) {
    setMessage(response.error);
    return;
  }
  parts.url.value = '';
  state.info = null;
  showPlaylist(response.playlist);
}

// Zieht man eine Datei oder einen Link über den Inhaltsbereich, deckt eine Ablagefläche ihn ganz ab.
// Die Seitenleiste bleibt frei. Der Bereich ist größer als die Seite selbst, wenn sie wenig Inhalt hat.
function setupDrop(root) {
  const area = root.parentElement;
  const overlay = el('div', { class: 'page-drop', hidden: true, 'aria-hidden': 'true' },
    el('div', { class: 'page-drop-inner' },
      icon(ICONS.download),
      el('strong', {}, t('Hier loslassen, um die Links zu laden')),
      el('span', { class: 'muted' }, t('Eine Textdatei mit Links oder ein Link aus dem Browser')))
  );
  document.body.append(overlay);
  let depth = 0;
  const active = (event) => !root.hidden
    && [...(event.dataTransfer?.types ?? [])].some((type) => ['Files', 'text/plain', 'text/uri-list'].includes(type));
  const show = (visible) => {
    if (visible) {
      const { top, left, width, height } = area.getBoundingClientRect();
      Object.assign(overlay.style, { top: `${top}px`, left: `${left}px`, width: `${width}px`, height: `${height}px` });
    }
    overlay.hidden = !visible;
  };
  area.addEventListener('dragenter', (event) => {
    if (!active(event)) return;
    depth += 1;
    show(true);
  });
  area.addEventListener('dragleave', () => {
    depth = Math.max(0, depth - 1);
    if (depth === 0) show(false);
  });
  area.addEventListener('dragover', (event) => {
    if (!active(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  });
  area.addEventListener('drop', (event) => {
    depth = 0;
    show(false);
    if (active(event)) onDrop(event);
  });
}

// Eine Textdatei mit Links oder ein Link, der aus dem Browser hierher gezogen wird.
async function onDrop(event) {
  event.preventDefault();
  const file = [...(event.dataTransfer?.files ?? [])].find((entry) => /\.(txt|csv|url|list)$/i.test(entry.name) || entry.type.startsWith('text/'));
  const text = file ? await file.text() : event.dataTransfer?.getData('text/uri-list') || event.dataTransfer?.getData('text/plain');
  if (!text) return;
  if (file || countUrls(text) > 1) {
    loadLinks(text);
    return;
  }
  parts.url.value = text.trim();
  loadInfo();
}

function onPaste(event) {
  const text = event.clipboardData?.getData('text') ?? '';
  // Ein Eingabefeld hat nur eine Zeile und würde mehrere Links aneinanderhängen.
  if (countUrls(text) > 1) {
    event.preventDefault();
    loadLinks(text);
    return;
  }
  setTimeout(loadInfo);
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
    setMessage(response.error, response.fix, () => loadPlaylist(url));
    return;
  }
  showPlaylist(response.playlist);
}

// Der Haken für den eigenen Unterordner gilt für alle Listen und bleibt, wie man ihn zuletzt gesetzt hat.
function showPlaylist(playlist) {
  stopPreview();
  parts.playlistNote.hidden = true;
  parts.plStatus.hidden = true;
  parts.plSubfolder.checked = state.settings.playlistSubfolder !== false;
  state.playlist = playlist;
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
  parts.result.hidden = !state.info;
  renderNote();
}

function renderNote() {
  parts.playlistNote.hidden = Boolean(state.playlist) || state.info?.playlist !== 'member';
}

function renderPlaylist() {
  const { playlist } = state;
  const selected = playlist.entries.filter((entry) => entry.selected);
  const unavailable = playlist.entries.filter((entry) => !entry.available).length;
  const count = playlist.entries.length;
  parts.playlistTitle.textContent = playlist.title;
  parts.playlistMeta.textContent = [
    playlist.uploader,
    playlist.source === 'links' ? (count === 1 ? t('1 Link') : t('{count} Links', { count })) : t('{count} Videos', { count }),
    unavailable ? t('{count} nicht verfügbar', { count: unavailable }) : null,
  ].filter(Boolean).join(' · ');
  parts.playlistLinksNote.hidden = playlist.source !== 'links';
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
        el('span', { class: 'playlist-name', title: entry.url ?? entry.title }, entry.title),
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
    entries: entries.map(({ url, title, thumbnail, duration, namedByLink }) => ({ url, title, thumbnail, duration, namedByLink })),
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

// yt-dlp kennt nicht jede Seite. Dann öffnet Vitool sie erst unsichtbar, startet das Video stumm
// und merkt sich den Stream. Klappt das nicht, öffnet man die Seite sichtbar und startet das Video selbst.
async function searchPage(url) {
  state.finder = { url, open: false, items: [], searching: true };
  renderFinder();
  parts.finder.hidden = false;
  const response = await invoke('download:probe', url);
  if (state.finder.url !== url || !state.finder.searching) return;
  state.finder.searching = false;
  if (response.canceled) return;
  if (!response.ok) {
    state.finder.failed = true;
    renderFinder();
    setMessage(response.error);
    return;
  }
  if (response.info) {
    parts.finder.hidden = true;
    showInfo(response.info);
  } else if (response.links) {
    parts.finder.hidden = true;
    showPlaylist(response.links);
  } else {
    state.finder.failed = true;
    renderFinder();
  }
}

function cancelSearch() {
  if (!state.finder.searching) return;
  state.finder.searching = false;
  invoke('download:cancelProbe');
}

async function openFinder() {
  setMessage('');
  cancelSearch();
  renderFinder();
  const response = await invoke('download:findOnPage', state.finder.url);
  if (!response.ok) setMessage(response.error);
}

// Aus einer Fehlermeldung der Warteschlange: Die Seite gleich sichtbar öffnen.
function openPageFromQueue(url) {
  cancelSearch();
  hideResults();
  state.info = null;
  state.playlist = null;
  parts.url.value = url;
  state.finder = { url, open: false, items: [], failed: true };
  renderFinder();
  parts.finder.hidden = false;
  openFinder();
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
  const { open, items, searching, failed } = state.finder;
  let text;
  if (searching) text = t('yt-dlp kennt diese Seite nicht. Vitool öffnet sie unsichtbar, startet das Video ohne Ton und sucht den Stream. Das dauert ein paar Sekunden.');
  else if (open && items.length === 0) text = t('Starte das Video im geöffneten Fenster. Sobald Vitool es findet, erscheint es hier.');
  else if (open) text = t('Gefunden. Läuft vorher Werbung, erscheinen mehrere Einträge. Der eigentliche Film ist meist ein Stream.');
  else if (items.length) text = t('Das Fenster ist geschlossen. Du kannst ein gefundenes Video trotzdem noch verwenden.');
  else if (failed) text = t('Vitool hat das Video nicht von selbst gefunden. Öffne die Seite und starte es dort selbst.');
  else text = t('yt-dlp kennt diese Seite nicht. Vitool kann sie in einem eigenen Fenster öffnen und das Video finden, während es dort läuft.');
  parts.finderText.textContent = text;
  parts.finderSpinner.hidden = !searching;
  parts.finderCancel.hidden = !searching;
  parts.finderList.replaceChildren(...items.map(foundRow));
  parts.finderList.hidden = items.length === 0;
  parts.finderOpen.hidden = open;
  parts.finderOpen.className = `button ${searching ? 'small' : 'primary'}`;
  parts.finderOpen.textContent = searching ? t('Selbst öffnen') : items.length || state.finder.wasOpened ? t('Seite erneut öffnen') : t('Seite öffnen');
  parts.finderClose.hidden = !open;
}

function onPageMedia({ open, items }) {
  if (!state.finder.url || state.finder.searching) return;
  if (open) state.finder.wasOpened = true;
  state.finder.open = open;
  state.finder.items = items;
  renderFinder();
}

function showInfo(info) {
  state.info = info;
  state.useSections = false;
  state.playlist = null;
  parts.playlistView.hidden = true;
  renderNote();

  parts.thumb.src = info.thumbnail ?? '';
  parts.thumb.hidden = !info.thumbnail;
  parts.title.textContent = info.title;
  parts.meta.textContent = [info.uploader, info.isLive ? t('Live-Übertragung') : info.duration ? formatTime(info.duration) : null]
    .filter(Boolean).join(' · ');

  parts.quality.replaceChildren(
    el('option', { value: '' }, t('Beste Qualität')),
    ...info.heights.map((height) => el('option', { value: String(height) }, `${height}p`)),
  );

  renderLanguages(info.audioLanguages ?? []);

  parts.sectionToggle.checked = false;
  parts.sectionRow.hidden = !info.duration;
  parts.sections.hidden = true;
  stopPreview();
  if (info.duration) editor.load(info.duration);

  parts.result.hidden = false;
  renderOptions();
}

// Sprachnamen in der Sprache der Oberfläche, etwa "Deutsch" statt "German".
const LANGUAGE_NAMES = (() => {
  try {
    return new Intl.DisplayNames([LANGUAGE], { type: 'language' });
  } catch {
    return null;
  }
})();

function languageName({ code, name }) {
  try {
    const shown = LANGUAGE_NAMES?.of(code);
    if (shown && shown !== code) return shown[0].toUpperCase() + shown.slice(1);
  } catch {
    // Unbekanntes Kürzel: dann der Name, den yt-dlp mitliefert.
  }
  return name ?? code;
}

function languageLabel(language) {
  const parts = [languageName(language)];
  if (language.original) parts.push(t('Original'));
  else if (language.auto) parts.push(t('automatisch übersetzt'));
  return parts.length > 1 ? `${parts[0]} (${parts.slice(1).join(', ')})` : parts[0];
}

// Das Original steht oben und ist vorgewählt, die übrigen Sprachen folgen alphabetisch.
function renderLanguages(languages) {
  const original = languages.filter((language) => language.original);
  const others = languages.filter((language) => !language.original)
    .sort((a, b) => languageName(a).localeCompare(languageName(b), LANGUAGE));
  state.languages = [...original, ...others];
  state.extraLanguages = new Set();
  parts.audioLanguage.replaceChildren(...state.languages.map((language) =>
    el('option', { value: language.code }, languageLabel(language))));
  if (!original.length) parts.audioLanguage.prepend(el('option', { value: '' }, t('Standard')));
  parts.audioLanguage.value = original[0]?.code ?? '';
  parts.languageField.hidden = languages.length < 2;
  parts.extraLanguages.open = false;
  renderExtraLanguages();
}

// Weitere Tonspuren zum Ankreuzen. Die Hauptspur fehlt in der Liste, sie ist ohnehin dabei.
function renderExtraLanguages() {
  const main = parts.audioLanguage.value;
  state.extraLanguages.delete(main);
  parts.extraList.replaceChildren(...state.languages.filter((language) => language.code !== main).map((language) => {
    const box = el('input', {
      type: 'checkbox',
      checked: state.extraLanguages.has(language.code),
      onchange: () => {
        if (box.checked) state.extraLanguages.add(language.code);
        else state.extraLanguages.delete(language.code);
        renderExtraSummary();
      },
    });
    return el('label', { class: 'check' }, box, el('span', {}, languageLabel(language)));
  }));
  renderExtraSummary();
}

function renderExtraSummary() {
  const count = state.extraLanguages.size;
  parts.extraSummary.textContent = count
    ? t('Weitere Tonspuren mitladen: {count}', { count })
    : t('Weitere Tonspuren mitladen');
  parts.extraHint.hidden = count === 0;
  // Nur ein Video kann mehrere Tonspuren enthalten, eine MP3 nicht.
  parts.extraLanguages.hidden = parts.languageField.hidden || state.mode === 'audio';
}

// Die Hauptspur zuerst, sie wird in der Datei die Standardspur. Bleibt es beim Original allein, ist nichts zu tun.
function chosenAudioTracks() {
  if (parts.languageField.hidden) return [];
  const byCode = new Map(state.languages.map((language) => [language.code, language]));
  const main = byCode.get(parts.audioLanguage.value);
  const extras = state.mode === 'audio' ? [] : [...state.extraLanguages].map((code) => byCode.get(code)).filter(Boolean);
  const tracks = [main, ...extras].filter(Boolean);
  if (tracks.length === 1 && tracks[0].original) return [];
  return tracks.map((language) => ({ code: language.code, original: language.original, name: language.name }));
}

function renderOptions() {
  const audio = state.mode === 'audio';
  parts.modeVideo.classList.toggle('active', !audio);
  parts.modeAudio.classList.toggle('active', audio);
  parts.modeVideo.setAttribute('aria-pressed', String(!audio));
  parts.modeAudio.setAttribute('aria-pressed', String(audio));
  parts.qualityField.hidden = audio;
  if (state.languages) renderExtraSummary();
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
  clearTimeout(previewTimer);
  previewTimer = null;
  previewRetries = 0;
  stream?.destroy();
  stream = null;
  previewStarted = false;
  parts.video.removeAttribute('src');
  parts.video.load();
}

function startPreview() {
  const { info } = state;
  const { previewUrl, previewAvailableAt } = info;
  parts.preview.hidden = !previewUrl;
  parts.previewHint.hidden = Boolean(previewUrl);
  if (!previewUrl || previewStarted) return;
  previewStarted = true;
  parts.video.poster = info.thumbnail ?? '';

  // YouTube gibt eine neue Adresse erst ein paar Sekunden nach der Abfrage frei und antwortet bis
  // dahin mit "403 Forbidden". Bis dahin zeigt der Player das Vorschaubild.
  const wait = previewAvailableAt ? previewAvailableAt * 1000 + PREVIEW_MARGIN_MS - Date.now() : 0;
  if (wait > 0) {
    previewTimer = setTimeout(() => {
      previewTimer = null;
      if (state.info === info) loadPreview();
    }, Math.min(wait, PREVIEW_MAX_WAIT_MS));
    return;
  }
  loadPreview();
}

function loadPreview() {
  const { previewUrl, previewKind } = state.info;
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
    audioTracks: chosenAudioTracks(),
    sections,
    exact: parts.exact.checked,
    merge: editor.merge && sections.length > 1,
    folder: settings.downloadDir,
    openInCut: parts.openInCut.checked,
    headers: info.headers ?? null,
    pageUrl: info.pageUrl ?? null,
    subtitles: info.subtitles ?? [],
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
    urlCard: el('section', { class: 'card stack' }),
    url: el('input', {
      class: 'input grow',
      placeholder: t('Link zum Video einfügen'),
      'aria-label': t('Link zum Video'),
      spellcheck: false,
      onkeydown: (event) => {
        if (event.key === 'Enter') loadInfo();
      },
      onpaste: onPaste,
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
    audioLanguage: el('select', { class: 'input', 'aria-label': t('Tonspur'), onchange: () => renderExtraLanguages() }),
    extraLanguages: el('details', { class: 'extra-languages', hidden: true }),
    extraSummary: el('summary', {}),
    extraList: el('div', { class: 'extra-language-list' }),
    extraHint: el('p', { class: 'muted', hidden: true }, t('Mit mehreren Tonspuren wird das Video als MKV gespeichert. Die oben gewählte Spur ist die Standardspur.')),
    languageField: el('label', { class: 'field', hidden: true }),
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
    playlistLinksNote: el('p', { class: 'muted small-note', hidden: true }, t('Kennt yt-dlp eine Seite nicht, sucht Vitool das Video dort beim Download von selbst. Gefundene Untertitel landen als SRT neben dem Video.')),
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
    plSubfolder: el('input', {
      type: 'checkbox',
      checked: true,
      onchange: async (event) => {
        state.settings = await invoke('settings:set', { playlistSubfolder: event.target.checked });
      },
    }),
    plSubfolderName: el('strong', {}),
    plStart: el('button', { class: 'button primary large', onclick: startPlaylist }),
    plStatus: el('p', { class: 'notice', role: 'status', hidden: true }),
    finder: el('section', { class: 'card stack', hidden: true }),
    finderText: el('p', { class: 'muted' }),
    finderSpinner: el('span', { class: 'spinner', hidden: true, 'aria-hidden': 'true' }),
    finderCancel: el('button', { class: 'button small', hidden: true, onclick: () => { cancelSearch(); parts.finder.hidden = true; } }, t('Abbrechen')),
    finderList: el('ul', { class: 'found-list', hidden: true }),
    finderOpen: el('button', { class: 'button primary', onclick: openFinder }),
    finderClose: el('button', { class: 'button small', onclick: () => invoke('download:closeFinder') }, t('Fenster schließen')),
  };

  parts.finder.append(
    el('div', { class: 'section-head' }, el('h2', {}, t('Video auf der Seite suchen')), parts.finderClose),
    parts.finderText,
    parts.finderList,
    el('div', { class: 'marker-row' }, parts.finderSpinner, parts.finderOpen, parts.finderCancel),
  );

  parts.playlistNote.append(el('span', {}, t('Dieses Video gehört zu einer Playlist.')), parts.playlistButton);
  parts.playlistView.append(
    el('section', { class: 'card stack' },
      el('div', { class: 'section-head' },
        el('div', { class: 'video-text' }, parts.playlistTitle, parts.playlistMeta),
        el('button', { class: 'button small', onclick: closePlaylist }, t('Schließen'))),
      parts.playlistLinksNote,
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
  parts.languageField.append(el('span', { class: 'muted' }, t('Tonspur')), parts.audioLanguage);
  parts.extraLanguages.append(parts.extraSummary, parts.extraList, parts.extraHint);
  parts.sectionRow.append(parts.sectionToggle, el('span', { class: 'switch-track' }), t('Nur einen Abschnitt herunterladen'));

  editor = new SectionEditor({ video: parts.video, onMessage: setMessage, createRange: nextRange });

  parts.video.addEventListener('error', () => {
    if (!parts.video.getAttribute('src')) return;
    if (previewRetries < PREVIEW_RETRIES && state.info?.previewKind === 'file') {
      previewRetries += 1;
      const { info } = state;
      previewTimer = setTimeout(() => {
        previewTimer = null;
        if (state.info === info && previewStarted) parts.video.load();
      }, PREVIEW_RETRY_MS);
      return;
    }
    showNoPreview();
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
        parts.languageField,
      ),
      parts.extraLanguages,
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

  parts.urlCard.append(
    el('div', { class: 'url-row' }, parts.url, parts.load),
    el('p', { class: 'muted small-note' }, t('Mehrere Links? Füge sie alle auf einmal ein oder ziehe eine Textdatei mit Links hierher.')),
    // Bewusst nur eine ruhige Zeile: ein Hinweis, keine Hürde.
    el('p', { class: 'muted small-note' }, t('Lade nur Videos herunter, die du nutzen darfst, etwa eigene oder frei lizenzierte. Urheberrecht und die Regeln der jeweiligen Seite gelten weiter.')),
  );
  setupDrop(root);

  root.append(
    pageHeader('Download', t('Link einfügen, Qualität wählen, fertig.')),
    parts.urlCard,
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
  hint: t('Videos und Ton aus Links laden, auch ganze Playlists.'),
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
    // Wartet das Prüfen auf ein yt-dlp-Update, soll der Knopf nicht einfach stehen bleiben.
    window.vitool.on('ytdlp:status', (status) => {
      if (parts.load.disabled && status.state === 'updating') parts.load.textContent = t('Aktualisiert yt-dlp …');
    });
  },
  onShow(data) {
    if (data?.findOnPage) openPageFromQueue(data.findOnPage);
  },
  onHide() {
    parts.video.pause();
  },
};
