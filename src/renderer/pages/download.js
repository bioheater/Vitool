// Bereich Download: Link prüfen, Optionen und Abschnitte wählen, Aufgabe starten.
import { el, icon, pageHeader } from '../utils/dom.js';
import { ICONS } from '../utils/icons.js';
import { formatTime } from '../utils/time.js';
import { SectionEditor } from '../components/section-editor.js';

const invoke = (...args) => window.vitool.invoke(...args);

const state = {
  info: null,
  settings: null,
  mode: 'video',
  useSections: false,
};

let parts = {};
let editor = null;

function setMessage(text) {
  parts.message.textContent = text;
  parts.message.hidden = !text;
}

async function loadInfo() {
  const url = parts.url.value.trim();
  if (!url) return;

  parts.load.disabled = true;
  parts.load.textContent = 'Lädt …';
  parts.result.hidden = true;
  setMessage('');

  const response = await invoke('download:info', url);

  parts.load.disabled = false;
  parts.load.textContent = 'Prüfen';
  if (!response.ok) {
    setMessage(response.error);
    return;
  }
  showInfo(response.info);
}

function showInfo(info) {
  state.info = info;
  state.useSections = false;

  parts.thumb.src = info.thumbnail ?? '';
  parts.thumb.hidden = !info.thumbnail;
  parts.title.textContent = info.title;
  parts.meta.textContent = [info.uploader, info.duration ? formatTime(info.duration) : 'Live-Übertragung']
    .filter(Boolean).join(' · ');

  parts.quality.replaceChildren(
    el('option', { value: '' }, 'Beste Qualität'),
    ...info.heights.map((height) => el('option', { value: String(height) }, `${height}p`)),
  );

  parts.sectionToggle.checked = false;
  parts.sectionRow.hidden = !info.duration;
  parts.sections.hidden = true;
  parts.video.removeAttribute('src');
  parts.video.load();
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

function enableSections(enabled) {
  state.useSections = enabled;
  parts.sections.hidden = !enabled;
  if (!enabled) {
    parts.video.pause();
    return;
  }
  editor.ensureRange();
  const { previewUrl } = state.info;
  parts.preview.hidden = !previewUrl;
  parts.previewHint.hidden = Boolean(previewUrl);
  if (previewUrl && parts.video.getAttribute('src') !== previewUrl) parts.video.src = previewUrl;
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
  });
  if (!response.ok) setMessage(response.error);
  else setMessage('');
}

async function chooseFolder() {
  const folder = await invoke('dialog:pickFolder', state.settings.downloadDir);
  if (!folder) return;
  state.settings = await invoke('settings:set', { downloadDir: folder });
  parts.folder.textContent = folder;
  parts.folder.title = folder;
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
  const date = new Date(entry.date).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' });
  const count = entry.files.length > 1 ? ` · ${entry.files.length} Dateien` : '';
  return el('li', { class: 'history-row' },
    historyThumb(entry),
    el('div', { class: 'history-text' },
      el('span', { class: 'job-title', title: entry.title }, entry.title),
      el('span', { class: 'muted' }, `${date} · ${entry.mode === 'audio' ? 'MP3' : 'Video'}${count}`),
    ),
    el('button', { class: 'button small', onclick: () => invoke('shell:openFile', entry.files[0]) }, 'Öffnen'),
    el('button', { class: 'button small', onclick: () => invoke('shell:showFile', entry.files[0]) }, 'Im Ordner zeigen'),
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
      placeholder: 'Link zum Video einfügen',
      'aria-label': 'Link zum Video',
      spellcheck: false,
      onkeydown: (event) => {
        if (event.key === 'Enter') loadInfo();
      },
      onpaste: () => setTimeout(loadInfo),
    }),
    load: el('button', { class: 'button primary', onclick: loadInfo }, 'Prüfen'),
    message: el('p', { class: 'message', role: 'alert', hidden: true }),
    result: el('div', { class: 'stack', hidden: true }),
    thumb: el('img', { class: 'thumb', alt: '' }),
    title: el('h2', {}),
    meta: el('p', { class: 'muted' }),
    modeVideo: el('button', { class: 'segment', onclick: () => { state.mode = 'video'; renderOptions(); } }, 'Video'),
    modeAudio: el('button', { class: 'segment', onclick: () => { state.mode = 'audio'; renderOptions(); } }, 'Nur Audio (MP3)'),
    quality: el('select', { class: 'input', 'aria-label': 'Qualität' }),
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
    historyEmpty: el('p', { class: 'muted' }, 'Noch keine Downloads.'),
    historyClear: el('button', { class: 'button small', onclick: async () => renderHistory(await invoke('download:clearHistory')) }, 'Verlauf leeren'),
  };

  parts.previewHint.textContent = 'Für dieses Video ist keine Vorschau möglich. Lege die Zeiten über Griffe oder Eingabefelder fest.';
  parts.preview.append(parts.video);
  parts.qualityField.append(parts.quality);
  parts.sectionRow.append(parts.sectionToggle, el('span', { class: 'switch-track' }), 'Nur einen Abschnitt herunterladen');

  editor = new SectionEditor({ video: parts.video, onMessage: setMessage, createRange: nextRange });

  parts.video.addEventListener('error', () => {
    if (!parts.video.getAttribute('src')) return;
    parts.preview.hidden = true;
    parts.previewHint.hidden = false;
  });

  parts.sections.append(
    parts.preview,
    parts.previewHint,
    editor.root,
    el('label', { class: 'check' }, parts.exact,
      el('span', {}, 'Exakt schneiden', el('small', { class: 'muted' }, 'Genauer, aber langsamer, da neu kodiert wird. Ohne diese Option kann der Schnitt um einige Sekunden abweichen.'))),
  );

  parts.result.append(
    el('section', { class: 'card video-card' },
      parts.thumb,
      el('div', { class: 'video-text' }, parts.title, parts.meta),
    ),
    el('section', { class: 'card stack' },
      el('div', { class: 'option-row' },
        el('div', { class: 'segments', role: 'group', 'aria-label': 'Art des Downloads' }, parts.modeVideo, parts.modeAudio),
        parts.qualityField,
      ),
      parts.sectionRow,
      parts.sections,
    ),
    el('section', { class: 'card stack' },
      el('div', { class: 'folder-row' },
        el('span', { class: 'muted' }, 'Zielordner'),
        parts.folder,
        el('button', { class: 'button small', onclick: chooseFolder }, 'Ändern'),
      ),
      el('label', { class: 'check' }, parts.openInCut, el('span', {}, 'Nach dem Download im Bereich Schneiden öffnen')),
      el('div', {}, el('button', { class: 'button primary large', onclick: startDownload }, 'Herunterladen')),
    ),
  );

  root.append(
    pageHeader('Download', 'Link einfügen, Qualität wählen, fertig.'),
    el('section', { class: 'card' }, el('div', { class: 'url-row' }, parts.url, parts.load)),
    parts.message,
    parts.result,
    el('section', { class: 'card stack history' },
      el('div', { class: 'section-head' }, el('h2', {}, 'Verlauf'), parts.historyClear),
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
  },
  onHide() {
    parts.video.pause();
  },
};
