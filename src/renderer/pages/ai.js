// Bereich KI-Maske: optionales Zusatzpaket einrichten, Objekt anklicken, verfolgen, exportieren.
import { el, pageHeader } from '../utils/dom.js';
import { folderOf } from '../utils/path.js';
import { formatTime } from '../utils/time.js';
import { EffectPreview } from '../components/effect-preview.js';
import { createFileDrop } from '../components/file-drop.js';
import { MediaPlayer } from '../components/media-player.js';
import { SectionEditor } from '../components/section-editor.js';

const invoke = (...args) => window.vitool.invoke(...args);

const DEFAULT_SECONDS = 10;
const LONG_SECONDS = 30;
const STAGE_HEIGHT = 400;
const CLICK_HINT = 'Linksklick: gehört dazu. Rechtsklick: gehört nicht dazu. Klick auf einen Punkt: entfernt ihn.';

const state = {
  status: null,
  media: null,
  folder: null,
  session: null,
  phase: 'range', // range, click oder result
  objects: [],
  activeObject: 0,
  nextObjectId: 1,
  clickMask: null,
  trackedBase: null,
  trackedVersion: 0,
  view: 'effect',
  target: 'object',
  effect: 'blur',
  matteWhite: 'object',
  matteFormat: 'mp4',
};
let parts = {};
let player = null;
let editor = null;
let effectPreview = null;
let busy = false;
let watching = false;

function setMessage(text) {
  parts.message.textContent = text;
  parts.message.hidden = !text;
}

function choice(label, choices, current, onSelect) {
  const buttons = choices.map(({ value, text }) => {
    const button = el('button', {
      class: `segment ${value === current ? 'active' : ''}`,
      'aria-pressed': String(value === current),
      onclick: () => {
        buttons.forEach((entry) => {
          entry.classList.toggle('active', entry === button);
          entry.setAttribute('aria-pressed', String(entry === button));
        });
        onSelect(value);
      },
    }, text);
    return button;
  });
  return el('div', { class: 'segments', role: 'group', 'aria-label': label }, ...buttons);
}

async function act(channel, ...args) {
  const response = await invoke(channel, ...args);
  if (!response.ok) setMessage(response.error);
  await refresh();
  return response;
}

function modelCard(model) {
  const selected = state.status.selected === model.id;
  const action = model.downloaded
    ? el('button', { class: 'button small', onclick: () => confirmRemoveModel(model) }, 'Entfernen')
    : el('button', { class: 'button small', onclick: () => act('ai:downloadModel', model.id) }, 'Herunterladen');

  return el('div', { class: `model-card ${selected ? 'active' : ''}` },
    el('strong', {}, model.label, model.recommended ? el('span', { class: 'model-tag' }, 'Empfohlen') : null),
    el('span', { class: 'muted' }, model.text),
    el('span', { class: 'muted' }, `${model.sizeMb} MB`),
    el('div', { class: 'marker-row' },
      model.downloaded ? el('button', {
        class: `flag ${selected ? 'active' : ''}`,
        onclick: () => act('ai:selectModel', model.id),
      }, selected ? 'Ausgewählt' : 'Auswählen') : null,
      action),
  );
}

function confirmRemoveModel(model) {
  if (window.confirm(`Modell ${model.label} wirklich entfernen?`)) act('ai:removeModel', model.id);
}

function confirmUninstall() {
  if (window.confirm('Das KI-Paket mit allen Modellen wirklich vollständig entfernen?')) act('ai:uninstall');
}

// Bis Python und Grafikkarte geprüft sind, ist der Knopf gesperrt und sagt das auch.
function installRequirements(status) {
  if (!status.checked) {
    return [
      el('p', { class: 'muted' }, 'Grafikkarte und Python werden geprüft …'),
      el('div', {}, el('button', { class: 'button primary', disabled: true }, 'KI-Paket installieren')),
    ];
  }
  return [
    el('p', { class: 'muted' }, status.gpu ? `Grafikkarte erkannt: ${status.gpu}` : 'Keine NVIDIA-Grafikkarte erkannt. Die KI läuft dann über den Prozessor und ist sehr langsam.'),
    status.python
      ? el('div', {}, el('button', { class: 'button primary', onclick: () => act('ai:install') }, 'KI-Paket installieren'))
      : el('p', { class: 'message' }, 'Dafür wird Python 3.10 oder neuer gebraucht. Installiere es mit: winget install Python.Python.3.12'),
  ];
}

function renderSetup() {
  const { status } = state;
  const hasModel = status.models.some((model) => model.downloaded);
  const ready = status.installed && hasModel;

  parts.setup.hidden = Boolean(state.media);
  parts.setup.replaceChildren(...[
    el('section', { class: 'card stack' },
      el('h2', {}, status.installed ? 'KI-Paket' : 'Freiwilliges Zusatzpaket'),
      el('p', { class: 'muted' }, 'KI-Maske nutzt SAM 2.1 von Meta: Du klickst ein Objekt an, die KI erkennt seine Form und verfolgt es durchs Video. Alles läuft nur auf deinem Rechner, es wird kein Video hochgeladen. Vitool funktioniert auch ohne dieses Paket vollständig.'),
      status.installed
        ? el('div', { class: 'marker-row' },
          el('span', { class: 'muted' }, status.usedGb === null ? 'Installiert · Speicherbedarf wird ermittelt …' : `Installiert · belegt ${status.usedGb} GB`),
          el('button', { class: 'button small', onclick: confirmUninstall }, 'KI-Paket vollständig entfernen'))
        : el('div', { class: 'stack' },
          el('p', {}, `Download etwa ${status.installSizeGb} GB · frei auf dem Laufwerk: ${status.freeGb} GB`),
          ...installRequirements(status),
        ),
    ),
    status.installed ? el('section', { class: 'card stack' },
      el('h2', {}, 'Modell'),
      el('p', { class: 'muted' }, 'Du kannst ein oder mehrere Modelle laden. Größere sind genauer, aber langsamer.'),
      el('div', { class: 'model-grid' }, ...status.models.map(modelCard)),
    ) : null,
  ].filter(Boolean));
  parts.drop.hidden = !ready || Boolean(state.media);
}

async function refresh() {
  if (busy) return;
  state.status = await invoke('ai:status');
  renderSetup();
}

function resetClicks() {
  state.objects = [{ id: 1, clicks: [] }];
  state.activeObject = 0;
  state.nextObjectId = 2;
  state.clickMask = null;
}

function resetSession() {
  state.session = null;
  state.phase = 'range';
  state.trackedBase = null;
  resetClicks();
  parts.mask.hidden = true;
  parts.effect.hidden = true;
  parts.dots.replaceChildren();
}

async function openFile(filePath) {
  setMessage('');
  const response = await invoke('media:probe', filePath);
  if (!response.ok) {
    setMessage(response.error);
    return;
  }
  if (!response.media.hasVideo) {
    setMessage('Diese Datei enthält kein Video.');
    return;
  }

  const { media } = response;
  state.media = media;
  state.folder = folderOf(media.path);
  resetSession();

  parts.name.textContent = media.name;
  parts.info.textContent = `${formatTime(media.duration)} · ${media.width} × ${media.height}`;
  parts.folder.textContent = state.folder;
  parts.stage.style.width = `${(STAGE_HEIGHT * media.width) / media.height}px`;
  parts.stage.style.aspectRatio = `${media.width} / ${media.height}`;
  parts.stage.style.setProperty('--stage-aspect', String(media.width / media.height));

  editor.load(media.duration);
  editor.ensureRange();
  editor.render();
  player.load(media);
  player.video.controls = false;

  parts.drop.hidden = true;
  parts.setup.hidden = true;
  parts.workspace.hidden = false;
  renderSteps();
}

function closeFile() {
  player.clear();
  state.media = null;
  resetSession();
  setMessage('');
  parts.workspace.hidden = true;
  refresh();
}

function renderObjects() {
  parts.objectList.replaceChildren(...state.objects.map((object, index) => {
    const name = `Objekt ${index + 1} (${object.clicks.length})`;
    const select = el('button', {
      class: `object-chip ${index === state.activeObject ? 'active' : ''}`,
      'aria-pressed': String(index === state.activeObject),
      onclick: () => selectObject(index),
    }, name);
    const remove = el('button', {
      class: 'object-remove',
      'aria-label': `${name} entfernen`,
      title: 'Objekt entfernen',
      onclick: () => removeObject(index),
    }, '×');
    return el('span', { class: 'object-item' }, select, state.objects.length > 1 ? remove : null);
  }));
}

function renderSteps() {
  const { phase } = state;
  parts.prepareCard.hidden = phase !== 'range';
  parts.clickCard.hidden = phase !== 'click';
  parts.exportCard.hidden = phase !== 'result';
  editor.root.classList.toggle('locked', phase !== 'range');
  parts.stage.classList.toggle('clickable', phase === 'click');
  renderObjects();
  updateTrackButton();
  updateLengthHint();
  updateOverlay();
}

function updateTrackButton() {
  parts.track.disabled = !state.objects.some((object) => object.clicks.length > 0);
}

function updateLengthHint() {
  const [range] = editor.ranges;
  parts.lengthHint.hidden = !range || range.end - range.start <= LONG_SECONDS;
}

function currentFrame() {
  const [{ start }] = editor.ranges;
  const frame = Math.round((player.video.currentTime - start) * state.session.fps);
  return Math.min(state.session.frames - 1, Math.max(0, frame));
}

function renderDots() {
  if (state.phase !== 'click') {
    parts.dots.replaceChildren();
    return;
  }
  const frame = currentFrame();
  parts.dots.replaceChildren(...state.objects.flatMap((object, objectIndex) => object.clicks
    .filter((click) => click.frame === frame)
    .map((click) => {
      const active = objectIndex === state.activeObject ? 'current' : '';
      const dot = el('button', {
        class: `ai-dot ${click.label ? 'add' : 'remove'} ${active}`,
        title: 'Punkt entfernen',
        'aria-label': 'Punkt entfernen',
        onclick: (event) => {
          event.stopPropagation();
          removeClick(object, click);
        },
      });
      dot.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        event.stopPropagation();
      });
      dot.style.left = `${click.x * 100}%`;
      dot.style.top = `${click.y * 100}%`;
      return dot;
    })));
}

function effectOptions() {
  return {
    effect: state.effect,
    target: state.effect === 'matte' ? state.matteWhite : state.target,
    matteFormat: state.matteFormat,
    strength: Number(parts.strength.value),
    expand: Number(parts.expand.value),
    feather: Number(parts.feather.value),
  };
}

// Zeigt je nach Schritt die Klick-Maske, die verfolgte Maske oder den fertigen Effekt.
function updateOverlay() {
  renderDots();
  if (!state.session) {
    parts.mask.hidden = true;
    parts.effect.hidden = true;
    return;
  }

  const frame = currentFrame();
  const showResult = state.phase === 'result';
  parts.effect.hidden = !showResult;
  if (showResult) {
    const options = effectOptions();
    if (state.view === 'mask') options.effect = 'overlay';
    parts.mask.hidden = true;
    effectPreview.draw(frame, options);
    effectPreview.preload(frame, state.session.frames);
    return;
  }

  let url = null;
  if (state.phase === 'click' && state.clickMask?.frame === frame) url = state.clickMask.url;
  else if (state.trackedBase) url = `${state.trackedBase}/${String(frame).padStart(5, '0')}.png?v=${state.trackedVersion}`;
  parts.mask.hidden = !url;
  if (url && parts.mask.getAttribute('src') !== url) parts.mask.src = url;
}

function watchPlayback() {
  if (watching) return;
  watching = true;
  const step = () => {
    if (player.video.paused) {
      watching = false;
      return;
    }
    updateOverlay();
    requestAnimationFrame(step);
  };
  step();
}

async function prepare() {
  const [{ start, end }] = editor.ranges;
  setMessage('');
  parts.prepare.disabled = true;
  const response = await invoke('ai:prepare', { filePath: state.media.path, start, end, model: state.status.selected });
  parts.prepare.disabled = false;
  if (!response.ok) {
    if (response.error) setMessage(response.error);
    return;
  }
  state.session = { frames: response.frames, fps: response.fps, device: response.device };
  state.phase = 'click';
  parts.deviceInfo.textContent = response.device === 'cuda' ? 'Läuft auf der Grafikkarte' : 'Läuft auf dem Prozessor, das dauert länger';
  player.video.pause();
  player.video.currentTime = start;
  renderSteps();
}

// Schickt alle Klicks des Objekts auf diesem Bild an die KI und zeigt die neue Maske.
async function sendClicks(object, frame) {
  const clicks = object.clicks.filter((click) => click.frame === frame);
  busy = true;
  parts.clickHint.textContent = 'KI rechnet …';
  const response = await invoke('ai:points', {
    frame,
    object: object.id,
    points: clicks.map((click) => [click.x, click.y]),
    labels: clicks.map((click) => click.label),
  });
  busy = false;
  parts.clickHint.textContent = CLICK_HINT;
  if (!response.ok) {
    setMessage(response.error);
    return;
  }
  state.clickMask = response.url ? { frame, url: response.url } : null;
  renderObjects();
  updateTrackButton();
  updateOverlay();
}

function addPoint(event, label) {
  if (state.phase !== 'click' || busy) return;
  event.preventDefault();
  player.video.pause();

  const box = parts.stage.getBoundingClientRect();
  const frame = currentFrame();
  const object = state.objects[state.activeObject];
  object.clicks.push({ frame, label, x: (event.clientX - box.left) / box.width, y: (event.clientY - box.top) / box.height });
  renderDots();
  sendClicks(object, frame);
}

function removeClick(object, click) {
  if (busy) return;
  object.clicks.splice(object.clicks.indexOf(click), 1);
  renderDots();
  sendClicks(object, click.frame);
}

function selectObject(index) {
  state.activeObject = index;
  renderObjects();
  renderDots();
}

function addObject() {
  state.objects.push({ id: state.nextObjectId, clicks: [] });
  state.nextObjectId += 1;
  selectObject(state.objects.length - 1);
}

async function removeObject(index) {
  if (busy) return;
  const [object] = state.objects.splice(index, 1);
  state.activeObject = Math.min(state.activeObject, state.objects.length - 1);
  busy = true;
  const response = await invoke('ai:removeObject', { object: object.id });
  busy = false;
  if (!response.ok) setMessage(response.error);

  // Die Maske auf diesem Bild zeigt noch das entfernte Objekt und wird neu berechnet.
  state.clickMask = null;
  const frame = currentFrame();
  const remaining = state.objects.find((entry) => entry.clicks.some((click) => click.frame === frame));
  renderSteps();
  if (remaining) sendClicks(remaining, frame);
}

async function resetPoints() {
  const response = await invoke('ai:reset');
  if (!response.ok) setMessage(response.error);
  resetClicks();
  state.trackedBase = null;
  renderSteps();
}

async function track() {
  setMessage('');
  parts.track.disabled = true;
  const response = await invoke('ai:track');
  updateTrackButton();
  if (!response.ok) {
    if (response.canceled) {
      changeRange();
      setMessage('Abgebrochen. Bereite den Abschnitt neu vor, um weiterzumachen.');
    } else {
      setMessage(response.error);
    }
    return;
  }
  state.trackedBase = response.previewBase;
  state.trackedVersion += 1;
  effectPreview.setMasks(state.trackedBase, state.trackedVersion);
  state.phase = 'result';
  renderSteps();
}

// Maske und Punkte bleiben stehen, damit an ihnen weitergearbeitet werden kann.
function redo() {
  state.phase = 'click';
  renderSteps();
}

function changeRange() {
  resetSession();
  renderSteps();
}

async function exportResult() {
  const response = await invoke('ai:export', { ...effectOptions(), folder: state.folder });
  setMessage(response.ok ? '' : response.error);
}

async function chooseFolder() {
  const folder = await invoke('dialog:pickFolder', state.folder);
  if (!folder) return;
  state.folder = folder;
  parts.folder.textContent = folder;
}

function firstSeconds(duration) {
  return { start: 0, end: Math.min(duration, DEFAULT_SECONDS) };
}

function updateSliderLabels() {
  const expand = Number(parts.expand.value);
  parts.expandValue.textContent = `${expand > 0 ? '+' : ''}${expand}`;
  parts.featherValue.textContent = parts.feather.value;
  updateOverlay();
}

function buildPage(root) {
  player = new MediaPlayer();
  player.root.classList.add('crop-stage', 'ai-stage');
  editor = new SectionEditor({ video: player.video, onMessage: setMessage, createRange: firstSeconds, single: true });
  editor.root.addEventListener('change', updateLengthHint);
  editor.root.addEventListener('pointerup', updateLengthHint);

  parts = {
    message: el('p', { class: 'message', role: 'alert', hidden: true }),
    setup: el('div', { class: 'stack' }),
    drop: createFileDrop({
      onFile: openFile,
      features: [
        { iconName: 'target', title: 'Anklicken genügt', text: 'Die KI erkennt die Form des Objekts' },
        { iconName: 'layers', title: 'Automatisch verfolgen', text: 'Die Maske folgt dem Objekt im Video' },
        { iconName: 'image', title: 'Blurren oder freistellen', text: 'Objekt oder Hintergrund bearbeiten' },
      ],
    }),
    workspace: el('div', { class: 'stack', hidden: true }),
    name: el('h2', { class: 'file-name' }),
    info: el('p', { class: 'muted' }),
    stage: player.root,
    mask: el('img', { class: 'ai-mask', alt: '', hidden: true }),
    effect: el('canvas', { class: 'ai-effect', hidden: true }),
    dots: el('div', { class: 'ai-dots' }),
    prepareCard: el('section', { class: 'card stack' }),
    prepare: el('button', { class: 'button primary', onclick: prepare }, 'Abschnitt vorbereiten'),
    lengthHint: el('p', { class: 'muted', hidden: true }, 'Längere Abschnitte brauchen deutlich mehr Zeit und Speicher.'),
    clickCard: el('section', { class: 'card stack', hidden: true }),
    clickHint: el('p', { class: 'muted' }, CLICK_HINT),
    objectList: el('div', { class: 'object-list' }),
    deviceInfo: el('span', { class: 'muted' }),
    track: el('button', { class: 'button primary', disabled: true, onclick: track }, 'Durchs Video verfolgen'),
    exportCard: el('section', { class: 'card stack', hidden: true }),
    strength: el('input', { type: 'range', min: 1, max: 100, value: 60, 'aria-label': 'Stärke', oninput: updateOverlay }),
    expand: el('input', { type: 'range', min: -30, max: 30, value: 2, 'aria-label': 'Maske erweitern', oninput: updateSliderLabels }),
    expandValue: el('span', { class: 'muted slider-value' }),
    feather: el('input', { type: 'range', min: 0, max: 40, value: 0, 'aria-label': 'Weiche Kante', oninput: updateSliderLabels }),
    featherValue: el('span', { class: 'muted slider-value' }),
    folder: el('span', { class: 'folder-path' }),
  };

  effectPreview = new EffectPreview(player.video, parts.effect);
  parts.stage.append(parts.effect, parts.mask, parts.dots);
  parts.stage.addEventListener('click', (event) => addPoint(event, 1));
  parts.stage.addEventListener('contextmenu', (event) => addPoint(event, 0));
  player.video.addEventListener('timeupdate', updateOverlay);
  player.video.addEventListener('seeked', updateOverlay);
  player.video.addEventListener('play', watchPlayback);
  updateSliderLabels();

  parts.prepareCard.append(
    el('h2', {}, '1. Abschnitt wählen'),
    el('p', { class: 'muted' }, 'Wähle mit den Griffen, in welchem Teil des Videos die KI arbeiten soll.'),
    parts.lengthHint,
    el('div', {}, parts.prepare),
  );

  parts.clickCard.append(
    el('h2', {}, '2. Objekt anklicken'),
    parts.clickHint,
    el('div', { class: 'marker-row' }, parts.objectList, el('button', { class: 'button small', onclick: addObject }, 'Weiteres Objekt')),
    el('div', { class: 'marker-row' },
      el('button', { class: 'button small', onclick: resetPoints }, 'Alle Klicks löschen'),
      el('button', { class: 'button small', onclick: changeRange }, 'Abschnitt ändern'),
      parts.deviceInfo,
    ),
    el('div', {}, parts.track),
  );

  const strengthField = el('label', { class: 'crop-control' }, el('span', { class: 'muted' }, 'Stärke'), parts.strength);
  const targetField = choice('Anwenden auf', [{ value: 'object', text: 'Objekt' }, { value: 'background', text: 'Hintergrund' }], state.target, (value) => {
    state.target = value;
    updateOverlay();
  });
  const matteHint = el('p', { class: 'muted', hidden: true }, 'Die Alpha-Maske enthält genau den gewählten Abschnitt und hat keinen Ton. Lege sie im Schnittprogramm passend zu diesem Abschnitt über das Video.');
  const matteFields = el('div', { class: 'option-row', hidden: true },
    choice('Weißer Bereich', [{ value: 'object', text: 'Objekt weiß' }, { value: 'background', text: 'Hintergrund weiß' }], state.matteWhite, (value) => {
      state.matteWhite = value;
      updateOverlay();
    }),
    choice('Dateiformat', [{ value: 'mp4', text: 'MP4' }, { value: 'prores', text: 'ProRes (MOV)' }], state.matteFormat, (value) => {
      state.matteFormat = value;
    }),
  );
  const sectionHint = el('p', { class: 'muted' }, 'Freistellen speichert nur den Abschnitt als transparente WebM-Datei, die anderen Effekte das ganze Video.');
  parts.exportCard.append(
    el('h2', {}, '3. Ergebnis'),
    el('div', { class: 'marker-row' },
      el('span', { class: 'muted' }, 'Ansicht'),
      choice('Ansicht', [{ value: 'effect', text: 'Effekt' }, { value: 'mask', text: 'Maske' }], state.view, (value) => {
        state.view = value;
        updateOverlay();
      }),
    ),
    el('div', { class: 'option-row' },
      targetField,
      choice('Effekt', [
        { value: 'blur', text: 'Blur' },
        { value: 'pixel', text: 'Verpixeln' },
        { value: 'black', text: 'Schwarz' },
        { value: 'transparent', text: 'Freistellen' },
        { value: 'matte', text: 'Alpha-Maske' },
      ], state.effect, (value) => {
        state.effect = value;
        const matte = value === 'matte';
        strengthField.hidden = ['black', 'transparent', 'matte'].includes(value);
        targetField.hidden = value === 'transparent' || matte;
        matteFields.hidden = !matte;
        matteHint.hidden = !matte;
        sectionHint.hidden = matte;
        updateOverlay();
      }),
    ),
    matteFields,
    strengthField,
    el('label', { class: 'crop-control' }, el('span', { class: 'muted slider-label' }, 'Maske erweitern'), parts.expand, parts.expandValue),
    el('label', { class: 'crop-control' }, el('span', { class: 'muted slider-label' }, 'Weiche Kante'), parts.feather, parts.featherValue),
    sectionHint,
    matteHint,
    el('div', { class: 'folder-row' },
      el('span', { class: 'muted' }, 'Zielordner'),
      parts.folder,
      el('button', { class: 'button small', onclick: chooseFolder }, 'Ändern'),
    ),
    el('div', { class: 'marker-row' },
      el('button', { class: 'button primary', onclick: exportResult }, 'Exportieren'),
      el('button', { class: 'button small', onclick: redo }, 'Nachbessern'),
    ),
  );

  parts.workspace.append(
    el('section', { class: 'card file-card' },
      el('div', { class: 'video-text' }, parts.name, parts.info),
      el('button', { class: 'button small', onclick: closeFile }, 'Andere Datei'),
    ),
    // Das Video bleibt beim Scrollen stehen, damit die Regler sichtbar wirken.
    el('div', { class: 'ai-columns' },
      el('section', { class: 'card stack ai-video' }, player.root, editor.root),
      el('div', { class: 'stack ai-controls' }, parts.prepareCard, parts.clickCard, parts.exportCard),
    ),
  );

  root.classList.add('wide-page');
  root.append(
    pageHeader('KI-Maske', 'Objekte anklicken, automatisch verfolgen und bearbeiten.'),
    parts.message,
    parts.setup,
    parts.drop,
    parts.workspace,
  );
  parts.drop.hidden = true;

  window.vitool.on('ai:statusChanged', refresh);
  window.vitool.on('queue:update', (jobs) => {
    const running = jobs.some((job) => job.kind === 'ai' && (job.status === 'running' || job.status === 'queued'));
    if (!running && state.wasRunning) refresh();
    state.wasRunning = running;
  });
}

export default {
  id: 'ai',
  label: 'KI-Maske',
  mount: buildPage,
  onShow() {
    refresh();
  },
  onHide() {
    player.video.pause();
  },
};
