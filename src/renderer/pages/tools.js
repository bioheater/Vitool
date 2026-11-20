// Bereich Werkzeuge: GIF, Standbild, Untertitel einbrennen, Zensieren, Greenscreen und Anpassen.
import { el, pageHeader } from '../utils/dom.js';
import { folderOf } from '../utils/path.js';
import { formatTime } from '../utils/time.js';
import { CensorEditor } from '../components/censor-editor.js';
import { ChromaEditor } from '../components/chroma-editor.js';
import { AdjustEditor } from '../components/adjust-editor.js';
import { createFileDrop } from '../components/file-drop.js';
import { createSendTo, createContinue } from '../components/send-to.js';
import { draftBadge } from '../components/draft-badge.js';
import { MediaPlayer } from '../components/media-player.js';
import { SectionEditor } from '../components/section-editor.js';
import { frameButtons } from '../components/video-controls.js';
import { t } from '../utils/i18n.js';

const invoke = (...args) => window.vitool.invoke(...args);

const GIF_DEFAULT_SECONDS = 5;
const GIF_LONG_SECONDS = 15;

const TOOLS = [
  { id: 'gif', label: t('GIF erstellen'), action: t('GIF erstellen'), stillImage: true, needsVideo: true, icon: 'layers', text: t('Kurze Animation aus einem Ausschnitt') },
  { id: 'frame', label: t('Standbild'), action: t('Bild speichern'), stillImage: true, needsVideo: true, icon: 'image', text: t('Ein Einzelbild als PNG oder JPG') },
  { id: 'subtitle', label: t('Untertitel einbrennen'), action: t('Untertitel einbrennen'), needsVideo: true, icon: 'text', text: t('SRT, ASS oder VTT fest ins Bild') },
  { id: 'censor', label: t('Zensieren'), action: t('Zensiert exportieren'), needsVideo: true, icon: 'target', text: t('Stellen mit Keyframes verdecken') },
  { id: 'chroma', label: t('Greenscreen'), action: t('Hintergrund ersetzen'), needsVideo: true, icon: 'chroma', text: t('Grün oder Blau ausstanzen und den Hintergrund ersetzen') },
  { id: 'adjust', label: t('Anpassen'), action: t('Angepasst speichern'), needsVideo: true, icon: 'rotate', text: t('Drehen, spiegeln, Ränder entfernen, beruhigen, Tempo ändern') },
];

const state = {
  media: null,
  tool: 'gif',
  preferredTool: null,
  folder: null,
  frameFormat: 'png',
  subtitlePath: null,
};
let parts = {};
let player = null;
let editor = null;
let censor = null;
let chroma = null;
let adjust = null;

function setMessage(text) {
  parts.message.textContent = text;
  parts.message.hidden = !text;
}

function toolAvailable(tool, media) {
  return !tool.needsVideo || media.hasVideo;
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

  const showsPicture = id !== 'subtitle';
  parts.playerCard.hidden = !showsPicture;
  parts.columns.classList.toggle('single', !showsPicture);
  if (!showsPicture) player.video.pause();
  // Die Editoren stellen die Vorschaufläche um. Erst alle abschalten, dann den gewählten einschalten.
  censor.setActive(false);
  chroma.setActive(false);
  adjust.setActive(false);
  if (id === 'censor') censor.setActive(true);
  else if (id === 'chroma') chroma.setActive(true);
  else if (id === 'adjust') adjust.setActive(true);
  censor.timelineRoot.hidden = id !== 'censor';
  censor.timelineHint.hidden = id !== 'censor' || censor.fields.length === 0;
  editor.root.hidden = id !== 'gif';
  editor.loopEnabled = id === 'gif';
  parts.frameControls.hidden = id !== 'frame';
  parts.start.textContent = tool.action;
  // GIFs und Standbilder lassen sich nicht weiterbearbeiten.
  parts.continueButton.hidden = Boolean(tool.stillImage);

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
    || (state.tool === 'censor' && censor.fields.length === 0)
    || (state.tool === 'chroma' && !chroma.ready())
    || (state.tool === 'adjust' && !adjust.ready());
  parts.continueButton.disabled = parts.start.disabled;
}

async function openFile(filePath) {
  setMessage('');
  const response = await invoke('media:probe', filePath);
  if (!response.ok) {
    setMessage(response.error);
    return;
  }

  const { media } = response;
  // Alle Werkzeuge hier brauchen ein Bild. Für reine Tondateien gibt es den Bereich Ton.
  if (!media.hasVideo) {
    setMessage(t('Diese Datei enthält kein Video. Tondateien bearbeitest du im Bereich Ton.'));
    return;
  }
  state.media = media;
  state.folder = media.homeFolder ?? folderOf(media.path);
  state.subtitlePath = null;
  parts.badge.hidden = !media.draft;

  parts.name.textContent = media.name;
  parts.name.title = media.path;
  parts.info.textContent = [
    formatTime(media.duration),
    media.height ? `${media.width} × ${media.height}` : t('Nur Audio'),
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
  chroma.load(media);
  adjust.load(media);

  parts.drop.hidden = true;
  parts.workspace.hidden = false;
  const preferred = TOOLS.find((tool) => tool.id === state.preferredTool && toolAvailable(tool, media));
  state.preferredTool = null;
  selectTool((preferred ?? TOOLS.find((tool) => toolAvailable(tool, media))).id);
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

function toolOptions(draft = false) {
  const base = { tool: state.tool, filePath: state.media.path, folder: state.folder, draft };
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
    case 'frame': return { ...base, time: player.video.currentTime, format: state.frameFormat };
    case 'adjust': return { ...base, ...adjust.options() };
    default: return { ...base, subtitlePath: state.subtitlePath, fontSize: parts.subtitleSize.value };
  }
}

function startTool(draft = false) {
  if (state.tool === 'censor') return invoke('censor:start', { filePath: state.media.path, fields: censor.fields, folder: state.folder, draft });
  if (state.tool === 'chroma') return invoke('chroma:start', { filePath: state.media.path, folder: state.folder, draft, ...chroma.options() });
  return invoke('tools:start', toolOptions(draft));
}

async function runTool() {
  const response = await startTool();
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
  chroma = new ChromaEditor({ player, onChange: () => parts.start && updateStart() });
  adjust = new AdjustEditor({ player, onChange: () => parts.start && updateStart() });
  editor.root.addEventListener('input', updateGifHint);
  editor.root.addEventListener('pointerup', updateGifHint);
  editor.root.addEventListener('change', updateGifHint);

  parts = {
    message: el('p', { class: 'message', role: 'alert', hidden: true }),
    drop: createFileDrop({
      onFile: openFile,
      title: t('Video hierher ziehen oder ein Werkzeug wählen'),
      // Ein Klick auf ein Werkzeug fragt die Datei ab und öffnet sie gleich dort.
      features: TOOLS.map((tool) => ({
        iconName: tool.icon,
        title: tool.label,
        text: tool.text,
        onSelect: () => {
          state.preferredTool = tool.id;
        },
      })),
    }),
    workspace: el('div', { class: 'stack', hidden: true }),
    name: el('h2', { class: 'file-name' }),
    info: el('p', { class: 'muted' }),
    tabs: new Map(TOOLS.map((tool) => [tool.id, el('button', { class: 'segment', onclick: () => selectTool(tool.id) }, tool.label)])),
    playerCard: el('section', { class: 'card stack ai-video' }),
    columns: el('div', { class: 'ai-columns tool-columns' }),
    frameControls: el('div', { class: 'marker-row', hidden: true }),
    gifWidth: el('select', { class: 'input', 'aria-label': t('Breite') },
      el('option', { value: '320' }, t('320 Pixel')),
      el('option', { value: '480', selected: true }, t('480 Pixel')),
      el('option', { value: '640' }, t('640 Pixel')),
      el('option', { value: '' }, t('Original'))),
    gifFps: el('select', { class: 'input', 'aria-label': t('Bilder pro Sekunde') },
      el('option', { value: '10' }, '10'),
      el('option', { value: '15', selected: true }, '15'),
      el('option', { value: '24' }, '24')),
    gifHint: el('p', { class: 'muted', hidden: true }, t('Längere GIFs werden schnell sehr groß. Eine geringere Breite oder weniger Bilder pro Sekunde helfen.')),
    subtitleDrop: createFileDrop({
      onFile: (filePath) => {
        state.subtitlePath = filePath;
        setMessage('');
        renderSubtitle();
      },
      title: t('Untertitel-Datei hierher ziehen'),
      hint: t('oder klicken (SRT, ASS, VTT)'),
      dialog: 'dialog:pickSubtitle',
      compact: true,
    }),
    subtitleChosen: el('div', { class: 'folder-row', hidden: true }),
    subtitleName: el('span', { class: 'folder-path' }),
    subtitleSize: el('select', { class: 'input', 'aria-label': t('Schriftgröße') },
      el('option', { value: 'klein' }, t('Klein')),
      el('option', { value: 'mittel', selected: true }, t('Mittel')),
      el('option', { value: 'gross' }, t('Groß'))),
    folder: el('span', { class: 'folder-path' }),
    start: el('button', { class: 'button primary large', onclick: runTool }),
    badge: draftBadge(),
  };
  parts.continueButton = createContinue({ exclude: 'tools', start: () => startTool(true), onError: setMessage });

  parts.frameControls.append(
    ...frameButtons(player.video),
    choiceGroup(t('Bildformat'), [{ value: 'png', text: 'PNG' }, { value: 'jpg', text: 'JPG' }], state.frameFormat, (value) => {
      state.frameFormat = value;
    }),
  );
  parts.playerCard.append(player.root, editor.root, censor.timelineHint, censor.timelineRoot, chroma.controlsRow, adjust.controlsRow, parts.frameControls);

  parts.subtitleChosen.append(
    el('span', { class: 'muted' }, t('Untertitel')),
    parts.subtitleName,
    el('button', {
      class: 'button small',
      onclick: () => {
        state.subtitlePath = null;
        renderSubtitle();
      },
    }, t('Andere Datei')),
  );

  parts.panels = new Map([
    ['gif', el('section', { class: 'card stack' },
      el('div', { class: 'option-row' }, selectField(t('Breite'), parts.gifWidth), selectField(t('Bilder pro Sekunde'), parts.gifFps)),
      parts.gifHint)],
    ['censor', censor.root],
    ['chroma', chroma.root],
    ['adjust', adjust.root],
    ['frame', el('section', { class: 'card' },
      el('p', { class: 'muted' }, t('Gespeichert wird das Bild an der aktuellen Stelle des Players. Mit den Knöpfen gehst du bildgenau vor und zurück.')))],
    ['subtitle', el('section', { class: 'card stack' },
      parts.subtitleDrop,
      parts.subtitleChosen,
      selectField(t('Schriftgröße'), parts.subtitleSize),
      el('p', { class: 'muted' }, t('Die Untertitel werden fest ins Bild geschrieben. Das Video wird dafür neu kodiert und als MP4 gespeichert. Bei ASS-Dateien gilt deren eigener Stil.')))],
  ]);

  parts.workspace.append(
    el('section', { class: 'card file-card' },
      el('div', { class: 'video-text' }, parts.name, parts.info, parts.badge),
      el('div', { class: 'file-actions' },
        createSendTo({ getPath: () => state.media?.path, exclude: 'tools' }),
        el('button', { class: 'button small', onclick: closeFile }, t('Andere Datei'))),
    ),
    el('div', { class: 'tool-tabs segments', role: 'group', 'aria-label': t('Werkzeug') }, ...parts.tabs.values()),
    // Wie bei KI-Maske: Video links und beim Scrollen stehend, Einstellungen rechts daneben.
    parts.columns,
  );
  parts.columns.append(
    parts.playerCard,
    el('div', { class: 'stack ai-controls' },
      ...parts.panels.values(),
      el('section', { class: 'card stack' },
        el('div', { class: 'folder-row' },
          el('span', { class: 'muted' }, t('Zielordner')),
          parts.folder,
          el('button', { class: 'button small', onclick: chooseFolder }, t('Ändern')),
        ),
        el('div', { class: 'action-row' }, parts.start, parts.continueButton),
      ),
    ),
  );

  root.classList.add('wide-page');
  root.append(pageHeader(t('Werkzeuge'), t('Kleine Helfer für alles rund um deine Videos.')), parts.message, parts.drop, parts.workspace);
}

export default {
  id: 'tools',
  label: t('Werkzeuge'),
  hint: t('GIF, Standbild, Untertitel einbrennen, Zensieren, Greenscreen und Video anpassen.'),
  mount: buildPage,
  onShow(data) {
    if (data?.filePath) openFile(data.filePath);
  },
  onHide() {
    player.video.pause();
  },
};
