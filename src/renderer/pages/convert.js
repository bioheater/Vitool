// Bereich Konvertieren: Zielformat, Zielgröße, Auflösung und Hochformat wählen.
import { el, pageHeader } from '../utils/dom.js';
import { folderOf } from '../utils/path.js';
import { formatTime } from '../utils/time.js';
import { createFileDrop } from '../components/file-drop.js';
import { MediaPlayer } from '../components/media-player.js';

const invoke = (...args) => window.vitool.invoke(...args);

const VIDEO_FORMATS = ['mp4', 'mkv', 'webm', 'mov'];
const AUDIO_FORMATS = ['mp3', 'm4a', 'wav', 'flac'];
const UNSIZABLE_FORMATS = ['wav', 'flac'];
const RESOLUTIONS = [2160, 1440, 1080, 720, 480, 360];
const SIZE_PRESETS = [10, 25, 50, 100];
const PREVIEW_HEIGHT = 340;

const state = { media: null, format: 'mp4', folder: null, cropPosition: 0.5 };
let parts = {};
let player = null;
let planRequest = 0;

function setMessage(text) {
  parts.message.textContent = text;
  parts.message.hidden = !text;
}

function currentOptions() {
  const isVideo = VIDEO_FORMATS.includes(state.format);
  const sizable = !UNSIZABLE_FORMATS.includes(state.format);
  return {
    filePath: state.media.path,
    format: state.format,
    height: isVideo ? Number(parts.resolution.value) || null : null,
    portrait: isVideo && parts.portrait.checked,
    cropPosition: state.cropPosition,
    targetSizeMb: sizable && parts.sizeToggle.checked ? Number(parts.sizeInput.value) || 0 : null,
    folder: state.folder,
  };
}

// Fragt den Hintergrund, was passieren wird, damit Probleme schon vor dem Start sichtbar sind.
async function updatePlan() {
  if (!state.media) return;
  planRequest += 1;
  const request = planRequest;
  const response = await invoke('convert:plan', currentOptions());
  if (request !== planRequest) return;

  parts.summary.textContent = response.ok ? response.summary : '';
  parts.summary.hidden = !response.ok;
  parts.start.disabled = !response.ok;
  setMessage(response.ok ? '' : response.error);
}

function renderFormats() {
  [...parts.videoFormats.children, ...parts.audioFormats.children].forEach((button) => {
    const active = button.dataset.format === state.format;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });

  const isVideo = VIDEO_FORMATS.includes(state.format);
  parts.videoCard.hidden = !isVideo || !state.media?.hasVideo;
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
  const { media } = state;
  if (!media?.height) return;

  const showPicture = parts.portrait.checked;
  parts.cropArea.hidden = !showPicture;
  if (!showPicture) {
    player.video.pause();
    return;
  }

  if (!player.video.getAttribute('src')) player.load(media);
  parts.stage.style.width = `${(PREVIEW_HEIGHT * media.width) / media.height}px`;
  parts.stage.style.aspectRatio = `${media.width} / ${media.height}`;

  const frameWidth = Math.min(1, (media.height * 9) / 16 / media.width);
  const canMove = frameWidth < 1;
  parts.cropSlider.closest('label').hidden = !canMove;
  parts.cropInfo.hidden = canMove;
  parts.maskLeft.style.width = `${(1 - frameWidth) * state.cropPosition * 100}%`;
  parts.maskRight.style.width = `${(1 - frameWidth) * (1 - state.cropPosition) * 100}%`;
}

async function openFile(filePath) {
  setMessage('');
  const response = await invoke('media:probe', filePath);
  if (!response.ok) {
    setMessage(response.error);
    return;
  }

  const { media } = response;
  state.media = media;
  state.folder = folderOf(media.path);
  state.cropPosition = 0.5;
  state.format = media.hasVideo ? 'mp4' : 'mp3';

  parts.name.textContent = media.name;
  parts.name.title = media.path;
  parts.info.textContent = [
    formatTime(media.duration),
    media.height ? `${media.width} × ${media.height}` : 'Nur Audio',
    `${(media.size / 1024 / 1024).toFixed(1)} MB`,
  ].join(' · ');
  parts.folder.textContent = state.folder;
  parts.folder.title = state.folder;

  parts.resolution.replaceChildren(
    el('option', { value: '' }, 'Original'),
    ...RESOLUTIONS.filter((height) => height < media.height).map((height) => el('option', { value: String(height) }, `${height}p`)),
  );
  parts.portrait.checked = false;
  parts.cropSlider.value = '50';
  parts.sizeToggle.checked = false;
  parts.sizeFields.hidden = true;
  parts.videoFormats.hidden = !media.hasVideo;

  player.clear();
  parts.drop.hidden = true;
  parts.workspace.hidden = false;
  renderCrop();
  renderFormats();
}

function closeFile() {
  player.clear();
  state.media = null;
  setMessage('');
  parts.workspace.hidden = true;
  parts.drop.hidden = false;
}

async function chooseFolder() {
  const folder = await invoke('dialog:pickFolder', state.folder);
  if (!folder) return;
  state.folder = folder;
  parts.folder.textContent = folder;
  parts.folder.title = folder;
}

async function startConvert() {
  const response = await invoke('convert:start', currentOptions());
  setMessage(response.ok ? '' : response.error);
}

function buildPage(root) {
  player = new MediaPlayer();
  player.root.classList.add('crop-stage');

  parts = {
    message: el('p', { class: 'message', role: 'alert', hidden: true }),
    drop: createFileDrop({
      onFile: openFile,
      features: [
        { iconName: 'convert', title: 'Jedes Format', text: 'MP4, MKV, WebM, MP3, WAV und mehr' },
        { iconName: 'shrink', title: 'Zielgröße', text: 'Zum Beispiel unter 25 MB zum Verschicken' },
        { iconName: 'phone', title: 'Hochformat', text: 'Auf 9:16 zuschneiden für Reels und Shorts' },
      ],
    }),
    workspace: el('div', { class: 'stack', hidden: true }),
    name: el('h2', { class: 'file-name' }),
    info: el('p', { class: 'muted' }),
    videoFormats: el('div', { class: 'segments', role: 'group', 'aria-label': 'Videoformate' }, ...VIDEO_FORMATS.map(formatButton)),
    audioFormats: el('div', { class: 'segments', role: 'group', 'aria-label': 'Audioformate' }, ...AUDIO_FORMATS.map(formatButton)),
    videoCard: el('section', { class: 'card stack' }),
    resolution: el('select', { class: 'input', 'aria-label': 'Auflösung', onchange: updatePlan }),
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
      'aria-label': 'Bildausschnitt',
      oninput: (event) => {
        state.cropPosition = Number(event.target.value) / 100;
        renderCrop();
      },
    }),
    cropInfo: el('p', { class: 'muted' }, 'Dieses Video ist schon schmal genug, es wird nur oben und unten beschnitten.'),
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
      'aria-label': 'Zielgröße in MB',
      oninput: updatePlan,
    }),
    summary: el('p', { class: 'muted' }),
    folder: el('span', { class: 'folder-path' }),
    start: el('button', { class: 'button primary large', onclick: startConvert }, 'Konvertieren'),
  };

  parts.stage.append(parts.maskLeft, parts.maskRight);
  parts.cropArea.append(
    parts.stage,
    el('label', { class: 'crop-control' }, el('span', { class: 'muted' }, 'Bildausschnitt'), parts.cropSlider),
    parts.cropInfo,
  );

  parts.videoCard.append(
    el('h2', {}, 'Bild'),
    el('div', { class: 'option-row' }, el('span', { class: 'muted' }, 'Auflösung'), parts.resolution),
    el('label', { class: 'switch' }, parts.portrait, el('span', { class: 'switch-track' }), 'Hochformat 9:16 zuschneiden'),
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
    el('h2', {}, 'Größe'),
    el('label', { class: 'switch' }, parts.sizeToggle, el('span', { class: 'switch-track' }), 'Auf Zielgröße komprimieren'),
    parts.sizeFields,
  );

  parts.workspace.append(
    el('section', { class: 'card file-card' },
      el('div', { class: 'video-text' }, parts.name, parts.info),
      el('button', { class: 'button small', onclick: closeFile }, 'Andere Datei'),
    ),
    el('section', { class: 'card stack' },
      el('h2', {}, 'Zielformat'),
      el('div', { class: 'option-row' }, parts.videoFormats, parts.audioFormats),
    ),
    parts.videoCard,
    parts.sizeCard,
    el('section', { class: 'card stack' },
      parts.summary,
      el('div', { class: 'folder-row' },
        el('span', { class: 'muted' }, 'Zielordner'),
        parts.folder,
        el('button', { class: 'button small', onclick: chooseFolder }, 'Ändern'),
      ),
      el('div', {}, parts.start),
    ),
  );

  root.append(pageHeader('Konvertieren', 'Format, Größe und Bild passend machen.'), parts.message, parts.drop, parts.workspace);
}

export default {
  id: 'convert',
  label: 'Konvertieren',
  mount: buildPage,
  onShow(data) {
    if (data?.filePath) openFile(data.filePath);
  },
  onHide() {
    player.video.pause();
  },
};
