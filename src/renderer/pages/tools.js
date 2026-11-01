// Bereich Werkzeuge: GIF, Audio extrahieren, Standbild und Untertitel einbrennen.
import { el, pageHeader } from '../utils/dom.js';
import { folderOf } from '../utils/path.js';
import { formatTime } from '../utils/time.js';
import { CensorEditor } from '../components/censor-editor.js';
import { createFileDrop } from '../components/file-drop.js';
import { MediaPlayer } from '../components/media-player.js';
import { SectionEditor } from '../components/section-editor.js';
import { frameButtons } from '../components/video-controls.js';

const invoke = (...args) => window.vitool.invoke(...args);

const GIF_DEFAULT_SECONDS = 5;
const GIF_LONG_SECONDS = 15;

const TOOLS = [
  { id: 'gif', label: 'GIF erstellen', action: 'GIF erstellen', needsVideo: true },
  { id: 'audio', label: 'Audio extrahieren', action: 'Audio extrahieren', needsAudio: true },
  { id: 'frame', label: 'Standbild', action: 'Bild speichern', needsVideo: true },
  { id: 'subtitle', label: 'Untertitel einbrennen', action: 'Untertitel einbrennen', needsVideo: true },
  { id: 'censor', label: 'Zensieren', action: 'Zensiert exportieren', needsVideo: true },
];

const state = {
  media: null,
  tool: 'gif',
  folder: null,
  audioFormat: 'mp3',
  frameFormat: 'png',
  subtitlePath: null,
};
let parts = {};
let player = null;
let editor = null;
let censor = null;

function setMessage(text) {
  parts.message.textContent = text;
  parts.message.hidden = !text;
}

function toolAvailable(tool, media) {
  return (!tool.needsVideo || media.hasVideo) && (!tool.needsAudio || media.hasAudio);
}

function selectTool(id) {
  state.tool = id;
  setMessage('');
  const tool = TOOLS.find((entry) => entry.id === id);

  parts.tabs.forEach((tab, tabId) => {
    tab.classList.toggle('active', tabId === id);
    tab.setAttribute('aria-pressed', String(tabId === id));
  });
  parts.panels.forEach((panel, panelId) => {
    panel.hidden = panelId !== id;
  });

  const showsPicture = id === 'gif' || id === 'frame' || id === 'censor';
  parts.playerCard.hidden = !showsPicture;
  if (!showsPicture) player.video.pause();
  censor.setActive(id === 'censor');
  editor.root.hidden = id !== 'gif';
  editor.loopEnabled = id === 'gif';
  parts.frameControls.hidden = id !== 'frame';
  parts.start.textContent = tool.action;

  if (showsPicture && state.media && !player.video.getAttribute('src')) player.load(state.media);
  updateGifHint();
  renderSubtitle();
}

function updateGifHint() {
  const range = editor.ranges[0];
  const tooLong = state.tool === 'gif' && range && range.end - range.start > GIF_LONG_SECONDS;
  parts.gifHint.hidden = !tooLong;
}

function renderSubtitle() {
  const { subtitlePath } = state;
  parts.subtitleDrop.hidden = Boolean(subtitlePath);
  parts.subtitleChosen.hidden = !subtitlePath;
  parts.subtitleName.textContent = subtitlePath ? subtitlePath.slice(folderOf(subtitlePath).length + 1) : '';
  updateStart();
}

function updateStart() {
  parts.start.disabled = (state.tool === 'subtitle' && !state.subtitlePath)
    || (state.tool === 'censor' && censor.fields.length === 0);
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
  state.subtitlePath = null;

  parts.name.textContent = media.name;
  parts.name.title = media.path;
  parts.info.textContent = [
    formatTime(media.duration),
    media.height ? `${media.width} × ${media.height}` : 'Nur Audio',
  ].join(' · ');
  parts.folder.textContent = state.folder;
  parts.folder.title = state.folder;

  TOOLS.forEach((tool) => {
    parts.tabs.get(tool.id).hidden = !toolAvailable(tool, media);
  });
  parts.gifWidth.value = '480';

  player.clear();
  editor.load(media.duration);
  editor.ensureRange();
  editor.render();
  censor.load(media);

  parts.drop.hidden = true;
  parts.workspace.hidden = false;
  selectTool(TOOLS.find((tool) => toolAvailable(tool, media)).id);
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

function toolOptions() {
  const base = { tool: state.tool, filePath: state.media.path, folder: state.folder };
  switch (state.tool) {
    case 'gif': {
      const [{ start, end }] = editor.ranges;
      return {
        ...base,
        start,
        end,
        width: Number(parts.gifWidth.value) || null,
        fps: Number(parts.gifFps.value),
      };
    }
    case 'audio': return { ...base, format: state.audioFormat };
    case 'frame': return { ...base, time: player.video.currentTime, format: state.frameFormat };
    default: return { ...base, subtitlePath: state.subtitlePath, fontSize: parts.subtitleSize.value };
  }
}

async function runTool() {
  const response = state.tool === 'censor'
    ? await invoke('censor:start', { filePath: state.media.path, fields: censor.fields, folder: state.folder })
    : await invoke('tools:start', toolOptions());
  setMessage(response.ok ? '' : response.error);
}

function choiceGroup(label, choices, current, onSelect) {
  const buttons = choices.map(({ value, text }) => {
    const button = el('button', {
      class: `segment ${value === current ? 'active' : ''}`,
      'aria-pressed': String(value === current),
      onclick: () => {
        buttons.forEach((entry) => {
          const active = entry === button;
          entry.classList.toggle('active', active);
          entry.setAttribute('aria-pressed', String(active));
        });
        onSelect(value);
      },
    }, text);
    return button;
  });
  return el('div', { class: 'segments', role: 'group', 'aria-label': label }, ...buttons);
}

function selectField(label, select) {
  return el('label', { class: 'field' }, el('span', { class: 'muted' }, label), select);
}

function firstSeconds(duration) {
  return { start: 0, end: Math.min(duration, GIF_DEFAULT_SECONDS) };
}

function buildPage(root) {
  player = new MediaPlayer();
  editor = new SectionEditor({
    video: player.video,
    onMessage: setMessage,
    createRange: firstSeconds,
    single: true,
  });
  censor = new CensorEditor({ player, onChange: () => updateStart() });
  editor.root.addEventListener('input', updateGifHint);
  editor.root.addEventListener('pointerup', updateGifHint);
  editor.root.addEventListener('change', updateGifHint);

  parts = {
    message: el('p', { class: 'message', role: 'alert', hidden: true }),
    drop: createFileDrop({
      onFile: openFile,
      features: [
        { iconName: 'target', title: 'Zensieren', text: 'Stellen mit Keyframes verdecken' },
        { iconName: 'image', title: 'GIF und Standbild', text: 'Beste Momente als Bild oder Animation' },
        { iconName: 'music', title: 'Audio extrahieren', text: 'Tonspur als MP3, WAV oder im Original' },
      ],
    }),
    workspace: el('div', { class: 'stack', hidden: true }),
    name: el('h2', { class: 'file-name' }),
    info: el('p', { class: 'muted' }),
    tabs: new Map(TOOLS.map((tool) => [tool.id, el('button', { class: 'segment', onclick: () => selectTool(tool.id) }, tool.label)])),
    playerCard: el('section', { class: 'card stack' }),
    frameControls: el('div', { class: 'marker-row', hidden: true }),
    gifWidth: el('select', { class: 'input', 'aria-label': 'Breite' },
      el('option', { value: '320' }, '320 Pixel'),
      el('option', { value: '480', selected: true }, '480 Pixel'),
      el('option', { value: '640' }, '640 Pixel'),
      el('option', { value: '' }, 'Original')),
    gifFps: el('select', { class: 'input', 'aria-label': 'Bilder pro Sekunde' },
      el('option', { value: '10' }, '10'),
      el('option', { value: '15', selected: true }, '15'),
      el('option', { value: '24' }, '24')),
    gifHint: el('p', { class: 'muted', hidden: true }, 'Längere GIFs werden schnell sehr groß. Eine geringere Breite oder weniger Bilder pro Sekunde helfen.'),
    subtitleDrop: createFileDrop({
      onFile: (filePath) => {
        state.subtitlePath = filePath;
        setMessage('');
        renderSubtitle();
      },
      title: 'Untertitel-Datei hierher ziehen',
      hint: 'oder klicken (SRT, ASS, VTT)',
      dialog: 'dialog:pickSubtitle',
      compact: true,
    }),
    subtitleChosen: el('div', { class: 'folder-row', hidden: true }),
    subtitleName: el('span', { class: 'folder-path' }),
    subtitleSize: el('select', { class: 'input', 'aria-label': 'Schriftgröße' },
      el('option', { value: 'klein' }, 'Klein'),
      el('option', { value: 'mittel', selected: true }, 'Mittel'),
      el('option', { value: 'gross' }, 'Groß')),
    folder: el('span', { class: 'folder-path' }),
    start: el('button', { class: 'button primary large', onclick: runTool }),
  };

  parts.frameControls.append(
    ...frameButtons(player.video),
    choiceGroup('Bildformat', [{ value: 'png', text: 'PNG' }, { value: 'jpg', text: 'JPG' }], state.frameFormat, (value) => {
      state.frameFormat = value;
    }),
  );
  parts.playerCard.append(player.root, editor.root, parts.frameControls);

  parts.subtitleChosen.append(
    el('span', { class: 'muted' }, 'Untertitel'),
    parts.subtitleName,
    el('button', {
      class: 'button small',
      onclick: () => {
        state.subtitlePath = null;
        renderSubtitle();
      },
    }, 'Andere Datei'),
  );

  const audioChoices = [
    { value: 'mp3', text: 'MP3' },
    { value: 'm4a', text: 'M4A' },
    { value: 'wav', text: 'WAV' },
    { value: 'flac', text: 'FLAC' },
    { value: 'original', text: 'Original' },
  ];

  parts.panels = new Map([
    ['gif', el('section', { class: 'card stack' },
      el('div', { class: 'option-row' }, selectField('Breite', parts.gifWidth), selectField('Bilder pro Sekunde', parts.gifFps)),
      parts.gifHint)],
    ['audio', el('section', { class: 'card stack' },
      el('h2', {}, 'Format'),
      choiceGroup('Audioformat', audioChoices, state.audioFormat, (value) => {
        state.audioFormat = value;
      }),
      el('p', { class: 'muted' }, 'Original übernimmt die Tonspur unverändert und ohne Qualitätsverlust.'))],
    ['censor', censor.root],
    ['frame', el('section', { class: 'card' },
      el('p', { class: 'muted' }, 'Gespeichert wird das Bild an der aktuellen Stelle des Players. Mit den Knöpfen gehst du bildgenau vor und zurück.'))],
    ['subtitle', el('section', { class: 'card stack' },
      parts.subtitleDrop,
      parts.subtitleChosen,
      selectField('Schriftgröße', parts.subtitleSize),
      el('p', { class: 'muted' }, 'Die Untertitel werden fest ins Bild geschrieben. Das Video wird dafür neu kodiert und als MP4 gespeichert. Bei ASS-Dateien gilt deren eigener Stil.'))],
  ]);

  parts.workspace.append(
    el('section', { class: 'card file-card' },
      el('div', { class: 'video-text' }, parts.name, parts.info),
      el('button', { class: 'button small', onclick: closeFile }, 'Andere Datei'),
    ),
    el('div', { class: 'tool-tabs segments', role: 'group', 'aria-label': 'Werkzeug' }, ...parts.tabs.values()),
    parts.playerCard,
    ...parts.panels.values(),
    el('section', { class: 'card stack' },
      el('div', { class: 'folder-row' },
        el('span', { class: 'muted' }, 'Zielordner'),
        parts.folder,
        el('button', { class: 'button small', onclick: chooseFolder }, 'Ändern'),
      ),
      el('div', {}, parts.start),
    ),
  );

  root.append(pageHeader('Werkzeuge', 'Kleine Helfer für alles rund um deine Videos.'), parts.message, parts.drop, parts.workspace);
}

export default {
  id: 'tools',
  label: 'Werkzeuge',
  mount: buildPage,
  onHide() {
    player.video.pause();
  },
};
