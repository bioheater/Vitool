// Bereich Konvertieren: Zielformat, Zielgröße, Auflösung und Hochformat wählen.
// Mehrere Dateien werden mit denselben Einstellungen nacheinander verarbeitet.
import { el, pageHeader } from '../utils/dom.js';
import { folderOf } from '../utils/path.js';
import { formatTime } from '../utils/time.js';
import { createFileDrop } from '../components/file-drop.js';
import { MediaPlayer } from '../components/media-player.js';
import { t, formatNumber } from '../utils/i18n.js';

const invoke = (...args) => window.vitool.invoke(...args);

const VIDEO_FORMATS = ['mp4', 'mkv', 'webm', 'mov'];
const AUDIO_FORMATS = ['mp3', 'm4a', 'wav', 'flac'];
const UNSIZABLE_FORMATS = ['wav', 'flac'];
const RESOLUTIONS = [2160, 1440, 1080, 720, 480, 360];
const SIZE_PRESETS = [10, 25, 50, 100];
const PREVIEW_HEIGHT = 340;

// folder ist null, solange jede Datei neben ihrem Original landen soll.
const state = { items: [], format: 'mp4', folder: null, cropPosition: 0.5, notice: '' };
let parts = {};
let player = null;
let planRequest = 0;

function setMessage(text) {
  parts.message.textContent = text;
  parts.message.hidden = !text;
}

function preview() {
  return state.items.find((item) => item.media.hasVideo)?.media ?? state.items[0]?.media ?? null;
}

function options(item) {
  const isVideo = VIDEO_FORMATS.includes(state.format);
  const sizable = !UNSIZABLE_FORMATS.includes(state.format);
  return {
    filePath: item.media.path,
    format: state.format,
    height: isVideo ? Number(parts.resolution.value) || null : null,
    portrait: isVideo && parts.portrait.checked,
    cropPosition: state.cropPosition,
    targetSizeMb: sizable && parts.sizeToggle.checked ? Number(parts.sizeInput.value) || 0 : null,
    folder: state.folder ?? folderOf(item.media.path),
  };
}

function mediaInfo(media) {
  return [
    formatTime(media.duration),
    media.height ? `${media.width} × ${media.height}` : t('Nur Audio'),
    `${formatNumber(media.size / 1024 / 1024)} MB`,
  ].join(' · ');
}

// Fragt für jede Datei, was passieren wird, damit Probleme schon vor dem Start sichtbar sind.
async function updatePlan() {
  if (state.items.length === 0) return;
  planRequest += 1;
  const request = planRequest;
  const responses = await Promise.all(state.items.map((item) => invoke('convert:plan', options(item))));
  if (request !== planRequest) return;

  state.items.forEach((item, index) => { item.plan = responses[index]; });
  const ready = state.items.filter((item) => item.plan.ok);
  const skipped = state.items.length - ready.length;

  if (state.items.length === 1) {
    const [{ plan }] = state.items;
    parts.summary.textContent = plan.ok ? plan.summary : '';
    setMessage(plan.ok ? state.notice : plan.error);
  } else {
    parts.summary.textContent = [
      t('{ready} von {total} Dateien werden konvertiert.', { ready: ready.length, total: state.items.length }),
      ready[0]?.plan.summary,
      skipped === 1 ? t('1 wird übersprungen, der Grund steht in der Liste.') : '',
      skipped > 1 ? t('{count} werden übersprungen, der Grund steht in der Liste.', { count: skipped }) : '',
    ].filter(Boolean).join(' ');
    setMessage(state.notice);
  }
  parts.summary.hidden = !parts.summary.textContent;
  parts.start.disabled = ready.length === 0;
  parts.start.textContent = ready.length > 1 ? t('{count} Dateien konvertieren', { count: ready.length }) : t('Konvertieren');
  renderFileList();
}

function renderFormats() {
  [...parts.videoFormats.children, ...parts.audioFormats.children].forEach((button) => {
    const active = button.dataset.format === state.format;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });

  const isVideo = VIDEO_FORMATS.includes(state.format);
  parts.videoCard.hidden = !isVideo || !preview()?.hasVideo;
  parts.sizeCard.hidden = UNSIZABLE_FORMATS.includes(state.format);
  if (!isVideo) player.video.pause();
  updatePlan();
}

function formatButton(format) {
  const button = el('button', {
    class: 'segment',
    onclick: () => {
      state.format = format;
      renderFormats();
    },
  }, format.toUpperCase());
  button.dataset.format = format;
  return button;
}

function renderCrop() {
  const media = preview();
  if (!media?.height) return;

  const showPicture = parts.portrait.checked;
  parts.cropArea.hidden = !showPicture;
  if (!showPicture) {
    player.video.pause();
    return;
  }

  if (player.media?.path !== media.path) player.load(media);
  parts.stage.style.width = `${(PREVIEW_HEIGHT * media.width) / media.height}px`;
  parts.stage.style.aspectRatio = `${media.width} / ${media.height}`;

  const frameWidth = Math.min(1, (media.height * 9) / 16 / media.width);
  const canMove = frameWidth < 1;
  parts.cropSlider.closest('label').hidden = !canMove;
  parts.cropInfo.hidden = canMove;
  parts.cropBatchHint.hidden = state.items.length < 2;
  parts.maskLeft.style.width = `${(1 - frameWidth) * state.cropPosition * 100}%`;
  parts.maskRight.style.width = `${(1 - frameWidth) * (1 - state.cropPosition) * 100}%`;
}

function renderHeader() {
  const single = state.items.length === 1;
  const [first] = state.items;
  parts.name.textContent = single ? first.media.name : t('{count} Dateien', { count: state.items.length });
  parts.name.title = single ? first.media.path : '';
  parts.info.textContent = single
    ? mediaInfo(first.media)
    : t('zusammen {size} MB', { size: formatNumber(state.items.reduce((sum, item) => sum + item.media.size, 0) / 1024 / 1024) });
  parts.fileList.hidden = single;
  parts.folder.textContent = state.folder ?? (single ? folderOf(first.media.path) : t('Jeweils neben der Originaldatei'));
  parts.folder.title = parts.folder.textContent;
  parts.resetFolder.hidden = state.folder === null;
}

function renderFileList() {
  parts.fileList.replaceChildren(...state.items.map((item) => el('li', { class: `batch-row ${item.plan && !item.plan.ok ? 'skip' : ''}` },
    el('div', { class: 'history-text' },
      el('span', { class: 'job-title', title: item.media.path }, item.media.name),
      el('span', { class: item.plan && !item.plan.ok ? 'batch-error' : 'muted' }, item.plan && !item.plan.ok ? t('Wird übersprungen: {reason}', { reason: item.plan.error }) : mediaInfo(item.media))),
    el('button', { class: 'button small', 'aria-label': t('{name} entfernen', { name: item.media.name }), onclick: () => removeItem(item) }, t('Entfernen')),
  )));
}

function resetOptions() {
  const maxHeight = Math.max(0, ...state.items.map((item) => item.media.height ?? 0));
  parts.resolution.replaceChildren(
    el('option', { value: '' }, t('Original')),
    ...RESOLUTIONS.filter((height) => height < maxHeight).map((height) => el('option', { value: String(height) }, `${height}p`)),
  );
  parts.videoFormats.hidden = !state.items.some((item) => item.media.hasVideo);
}

async function openFiles(paths) {
  setMessage('');
  const known = new Set(state.items.map((item) => item.media.path.toLowerCase()));
  const fresh = paths.filter((filePath) => !known.has(filePath.toLowerCase()));
  const responses = await Promise.all(fresh.map((filePath) => invoke('media:probe', filePath)));

  const failed = responses.filter((response) => !response.ok);
  const firstTime = state.items.length === 0;
  responses.filter((response) => response.ok).forEach((response) => state.items.push({ media: response.media, plan: null }));

  // Der Hinweis bleibt stehen, bis neue Dateien kommen, auch wenn sich die Einstellungen ändern.
  state.notice = '';
  if (failed.length) {
    state.notice = fresh.length === 1
      ? failed[0].error
      : failed.length === 1
        ? t('1 Datei ließ sich nicht lesen und wurde nicht übernommen.')
        : t('{count} Dateien ließen sich nicht lesen und wurden nicht übernommen.', { count: failed.length });
    setMessage(state.notice);
  }
  if (state.items.length === 0) return;

  if (firstTime) {
    state.cropPosition = 0.5;
    state.format = state.items.some((item) => item.media.hasVideo) ? 'mp4' : 'mp3';
    parts.portrait.checked = false;
    parts.cropSlider.value = '50';
    parts.sizeToggle.checked = false;
    parts.sizeFields.hidden = true;
    player.clear();
  }

  resetOptions();
  renderHeader();
  parts.drop.hidden = true;
  parts.workspace.hidden = false;
  renderCrop();
  renderFormats();
}

function removeItem(item) {
  state.items.splice(state.items.indexOf(item), 1);
  if (state.items.length === 0) {
    closeFiles();
    return;
  }
  resetOptions();
  renderHeader();
  renderCrop();
  renderFormats();
}

function closeFiles() {
  player.clear();
  state.items = [];
  state.folder = null;
  state.notice = '';
  setMessage('');
  parts.workspace.hidden = true;
  parts.drop.hidden = false;
}

async function pickFolderFiles() {
  const paths = await invoke('dialog:pickVideoFolder');
  if (paths.length === 0) return;
  openFiles(paths);
}

async function chooseFolder() {
  const folder = await invoke('dialog:pickFolder', state.folder ?? folderOf(state.items[0].media.path));
  if (!folder) return;
  state.folder = folder;
  renderHeader();
  updatePlan();
}

function resetFolder() {
  state.folder = null;
  renderHeader();
  updatePlan();
}

async function startConvert() {
  const ready = state.items.filter((item) => item.plan?.ok);
  const responses = await Promise.all(ready.map((item) => invoke('convert:start', options(item))));
  const failed = responses.filter((response) => !response.ok);
  if (failed.length === 0) {
    setMessage('');
  } else if (ready.length === 1) {
    setMessage(failed[0].error);
  } else {
    setMessage(t('{failed} von {total} Dateien konnten nicht gestartet werden: {reason}', { failed: failed.length, total: ready.length, reason: failed[0].error }));
  }
}

function buildPage(root) {
  player = new MediaPlayer();
  player.root.classList.add('crop-stage');

  parts = {
    message: el('p', { class: 'message', role: 'alert', hidden: true }),
    drop: el('div', { class: 'stack' },
      createFileDrop({
        onFiles: openFiles,
        hint: t('oder klicken, um eine oder mehrere Dateien auszuwählen'),
        features: [
          { iconName: 'convert', title: t('Jedes Format'), text: t('MP4, MKV, WebM, MP3, WAV und mehr') },
          { iconName: 'shrink', title: t('Zielgröße'), text: t('Zum Beispiel unter 25 MB zum Verschicken') },
          { iconName: 'layers', title: t('Viele auf einmal'), text: t('Mehrere Dateien oder einen ganzen Ordner') },
        ],
      }),
      el('div', {}, el('button', { class: 'button', onclick: pickFolderFiles }, t('Ganzen Ordner auswählen')))),
    workspace: el('div', { class: 'stack', hidden: true }),
    name: el('h2', { class: 'file-name' }),
    info: el('p', { class: 'muted' }),
    fileList: el('ul', { class: 'history-list batch-list', hidden: true }),
    videoFormats: el('div', { class: 'segments', role: 'group', 'aria-label': t('Videoformate') }, ...VIDEO_FORMATS.map(formatButton)),
    audioFormats: el('div', { class: 'segments', role: 'group', 'aria-label': t('Audioformate') }, ...AUDIO_FORMATS.map(formatButton)),
    videoCard: el('section', { class: 'card stack' }),
    resolution: el('select', { class: 'input', 'aria-label': t('Auflösung'), onchange: updatePlan }),
    portrait: el('input', {
      type: 'checkbox',
      onchange: () => {
        renderCrop();
        updatePlan();
      },
    }),
    cropArea: el('div', { class: 'stack', hidden: true }),
    stage: player.root,
    maskLeft: el('div', { class: 'crop-mask left' }),
    maskRight: el('div', { class: 'crop-mask right' }),
    cropSlider: el('input', {
      type: 'range',
      min: 0,
      max: 100,
      value: 50,
      'aria-label': t('Bildausschnitt'),
      oninput: (event) => {
        state.cropPosition = Number(event.target.value) / 100;
        renderCrop();
      },
    }),
    cropInfo: el('p', { class: 'muted' }, t('Dieses Video ist schon schmal genug, es wird nur oben und unten beschnitten.')),
    cropBatchHint: el('p', { class: 'muted', hidden: true }, t('Die Vorschau zeigt die erste Datei. Der Ausschnitt gilt für alle Dateien an derselben Stelle.')),
    sizeCard: el('section', { class: 'card stack' }),
    sizeToggle: el('input', {
      type: 'checkbox',
      onchange: (event) => {
        parts.sizeFields.hidden = !event.target.checked;
        updatePlan();
      },
    }),
    sizeFields: el('div', { class: 'size-row', hidden: true }),
    sizeInput: el('input', {
      class: 'input size',
      type: 'number',
      min: 1,
      value: 25,
      'aria-label': t('Zielgröße in MB'),
      oninput: updatePlan,
    }),
    summary: el('p', { class: 'muted' }),
    folder: el('span', { class: 'folder-path' }),
    resetFolder: el('button', { class: 'button small', hidden: true, onclick: resetFolder }, t('Wie Original')),
    start: el('button', { class: 'button primary large', onclick: startConvert }, t('Konvertieren')),
  };

  parts.stage.append(parts.maskLeft, parts.maskRight);
  parts.cropArea.append(
    parts.stage,
    el('label', { class: 'crop-control' }, el('span', { class: 'muted' }, t('Bildausschnitt')), parts.cropSlider),
    parts.cropInfo,
    parts.cropBatchHint,
  );

  parts.videoCard.append(
    el('h2', {}, t('Bild')),
    el('div', { class: 'option-row' }, el('span', { class: 'muted' }, t('Auflösung')), parts.resolution),
    el('label', { class: 'switch' }, parts.portrait, el('span', { class: 'switch-track' }), t('Hochformat 9:16 zuschneiden')),
    parts.cropArea,
  );

  parts.sizeFields.append(
    parts.sizeInput,
    el('span', { class: 'muted' }, 'MB'),
    ...SIZE_PRESETS.map((size) => el('button', {
      class: 'button small',
      onclick: () => {
        parts.sizeInput.value = size;
        updatePlan();
      },
    }, `${size} MB`)),
  );

  parts.sizeCard.append(
    el('h2', {}, t('Größe')),
    el('label', { class: 'switch' }, parts.sizeToggle, el('span', { class: 'switch-track' }), t('Auf Zielgröße komprimieren')),
    parts.sizeFields,
  );

  parts.workspace.append(
    el('section', { class: 'card stack' },
      el('div', { class: 'file-card' },
        el('div', { class: 'video-text' }, parts.name, parts.info),
        el('div', { class: 'marker-row' },
          el('button', { class: 'button small', onclick: () => parts.addFiles.click() }, t('Dateien hinzufügen')),
          el('button', { class: 'button small', onclick: closeFiles }, t('Alle entfernen')))),
      parts.fileList,
    ),
    el('section', { class: 'card stack' },
      el('h2', {}, t('Zielformat')),
      el('div', { class: 'option-row' }, parts.videoFormats, parts.audioFormats),
    ),
    parts.videoCard,
    parts.sizeCard,
    el('section', { class: 'card stack' },
      parts.summary,
      el('div', { class: 'folder-row' },
        el('span', { class: 'muted' }, t('Zielordner')),
        parts.folder,
        parts.resetFolder,
        el('button', { class: 'button small', onclick: chooseFolder }, t('Ändern')),
      ),
      el('div', {}, parts.start),
    ),
  );

  // Unsichtbare Ablage für "Dateien hinzufügen", damit Auswahlfenster und Hineinziehen gleich arbeiten.
  parts.addFiles = createFileDrop({ onFiles: openFiles, compact: true });
  parts.addFiles.hidden = true;
  parts.workspace.append(parts.addFiles);

  root.append(pageHeader(t('Konvertieren'), t('Format, Größe und Bild passend machen, auch für viele Dateien auf einmal.')), parts.message, parts.drop, parts.workspace);
}

export default {
  id: 'convert',
  label: t('Konvertieren'),
  mount: buildPage,
  onShow(data) {
    if (data?.filePath) openFiles([data.filePath]);
  },
  onHide() {
    player.video.pause();
  },
};
