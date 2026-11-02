// Bereich Transkribieren: Zusatzpaket einrichten, Gesprochenes erkennen, Text prüfen und speichern.
import { el, pageHeader } from '../utils/dom.js';
import { formatTime } from '../utils/time.js';
import { createFileDrop } from '../components/file-drop.js';
import { MediaPlayer } from '../components/media-player.js';

const invoke = (...args) => window.vitool.invoke(...args);

const LANGUAGES = [
  ['', 'Automatisch erkennen'],
  ['de', 'Deutsch'],
  ['en', 'Englisch'],
  ['fr', 'Französisch'],
  ['es', 'Spanisch'],
  ['it', 'Italienisch'],
  ['nl', 'Niederländisch'],
  ['pl', 'Polnisch'],
  ['pt', 'Portugiesisch'],
  ['tr', 'Türkisch'],
  ['ru', 'Russisch'],
  ['uk', 'Ukrainisch'],
  ['ar', 'Arabisch'],
  ['ja', 'Japanisch'],
  ['zh', 'Chinesisch'],
];
const LANGUAGE_NAMES = Object.fromEntries(LANGUAGES.filter(([code]) => code));

const EXPORTS = [
  { format: 'srt', text: 'SRT', hint: 'Untertitel für Player und Schnittprogramme' },
  { format: 'vtt', text: 'VTT', hint: 'Untertitel fürs Web' },
  { format: 'txt', text: 'Text', hint: 'Fließtext in Absätzen' },
  { format: 'timed', text: 'Text mit Zeiten', hint: 'Jeder Satz mit Zeitangabe' },
  { format: 'json', text: 'JSON', hint: 'Mit Wortzeiten, zum Weiterverarbeiten' },
];

const state = {
  status: null,
  media: null,
  transcript: null,
  running: false,
  wasRunning: false,
};
let parts = {};
let player = null;
let stream = null;
let rows = [];

function setMessage(text) {
  parts.message.textContent = text;
  parts.message.hidden = !text;
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
    : el('button', { class: 'button small', onclick: () => act('transcribe:downloadModel', model.id) }, 'Herunterladen');

  return el('div', { class: `model-card ${selected ? 'active' : ''}` },
    el('strong', {}, model.label, model.recommended ? el('span', { class: 'model-tag' }, 'Empfohlen') : null),
    el('span', { class: 'muted' }, model.text),
    el('span', { class: 'muted' }, model.sizeMb >= 1000 ? `${(model.sizeMb / 1000).toFixed(1).replace('.', ',')} GB` : `${model.sizeMb} MB`),
    el('div', { class: 'marker-row' },
      model.downloaded ? el('button', {
        class: `flag ${selected ? 'active' : ''}`,
        onclick: () => act('transcribe:selectModel', model.id),
      }, selected ? 'Ausgewählt' : 'Auswählen') : null,
      action),
  );
}

function confirmRemoveModel(model) {
  if (window.confirm(`Modell ${model.label} wirklich entfernen?`)) act('transcribe:removeModel', model.id);
}

function confirmUninstall() {
  if (window.confirm('Die Transkription mit allen Sprachmodellen wirklich vollständig entfernen?')) act('transcribe:uninstall');
}

function installRequirements(status) {
  if (!status.checked) {
    return [
      el('p', { class: 'muted' }, 'Grafikkarte und Python werden geprüft …'),
      el('div', {}, el('button', { class: 'button primary', disabled: true }, 'Transkription installieren')),
    ];
  }
  return [
    el('p', { class: 'muted' }, status.gpu ? `Grafikkarte erkannt: ${status.gpu}` : 'Keine NVIDIA-Grafikkarte erkannt. Die Erkennung läuft dann über den Prozessor und dauert länger.'),
    status.python
      ? el('div', {}, el('button', { class: 'button primary', onclick: () => act('transcribe:install') }, 'Transkription installieren'))
      : el('p', { class: 'message' }, 'Dafür wird Python 3.10 oder neuer gebraucht. Installiere es mit: winget install Python.Python.3.12'),
  ];
}

function renderSetup() {
  const { status } = state;
  const ready = status.installed && status.models.some((model) => model.downloaded);
  // Bei einem Link gibt es während des Ladens noch keine Datei, die Arbeitsfläche ist trotzdem offen.
  const open = Boolean(state.media || state.link);

  parts.setup.hidden = open;
  parts.setup.replaceChildren(...[
    el('section', { class: 'card stack' },
      el('h2', {}, status.installed ? 'Transkription' : 'Freiwilliges Zusatzpaket'),
      el('p', { class: 'muted' }, 'Transkribieren nutzt Whisper von OpenAI in der schnellen Fassung faster-whisper. Alles läuft nur auf deinem Rechner, es wird nichts hochgeladen. Vitool funktioniert auch ohne dieses Paket vollständig.'),
      status.installed
        ? el('div', { class: 'marker-row' },
          el('span', { class: 'muted' }, status.usedGb === null ? 'Installiert · Speicherbedarf wird ermittelt …' : `Installiert · belegt ${status.usedGb} GB`),
          el('button', { class: 'button small', onclick: confirmUninstall }, 'Transkription vollständig entfernen'))
        : el('div', { class: 'stack' },
          el('p', {}, `Download etwa ${String(status.installSizeGb).replace('.', ',')} GB · frei auf dem Laufwerk: ${status.freeGb} GB`),
          ...installRequirements(status),
        ),
    ),
    status.installed ? el('section', { class: 'card stack' },
      el('h2', {}, 'Sprachmodell'),
      el('p', { class: 'muted' }, 'Du kannst ein oder mehrere Modelle laden. Größere verstehen undeutliche Sprache besser, brauchen aber länger.'),
      el('div', { class: 'model-grid' }, ...status.models.map(modelCard)),
    ) : null,
  ].filter(Boolean));
  parts.drop.hidden = !ready || open;
  parts.linkCard.hidden = parts.drop.hidden;
  renderModelSelect();
}

function renderModelSelect() {
  const downloaded = state.status.models.filter((model) => model.downloaded);
  parts.model.replaceChildren(...downloaded.map((model) => el('option', {
    value: model.id,
    selected: model.id === state.status.selected,
  }, model.label)));
}

async function refresh() {
  state.status = await invoke('transcribe:status');
  renderSetup();
}

async function openFile(filePath) {
  setMessage('');
  const response = await invoke('media:probe', filePath);
  if (!response.ok) {
    setMessage(response.error);
    return;
  }
  if (!response.media.hasAudio) {
    setMessage('Diese Datei hat keine Tonspur.');
    return;
  }
  showMedia(response.media);
}

function showWorkspace(name, info) {
  state.transcript = null;
  parts.name.textContent = name;
  parts.info.textContent = info;
  parts.start.disabled = !state.media;
  parts.drop.hidden = true;
  parts.linkCard.hidden = true;
  parts.setup.hidden = true;
  parts.workspace.hidden = false;
  renderResult();
}

function playLocal(media) {
  player.video.removeAttribute('poster');
  player.load(media);
  player.root.classList.toggle('audio-only', !media.hasVideo);
}

function showMedia(media) {
  state.link = null;
  state.media = media;
  playLocal(media);
  const details = media.hasVideo ? `${media.width} × ${media.height}` : 'nur Ton';
  showWorkspace(media.name, `${formatTime(media.duration)} · ${details}`);
}

function stopStream() {
  stream?.destroy();
  stream = null;
}

// Das Video läuft direkt von der Seite, wie im Download-Bereich. Geladen wird nur der Ton.
function startLinkPreview(info) {
  player.clear();
  player.root.classList.remove('audio-only');
  if (info.thumbnail) player.video.poster = info.thumbnail;
  state.previewing = Boolean(info.previewUrl);
  if (!info.previewUrl) return;
  if (info.previewKind !== 'hls') {
    player.video.src = info.previewUrl;
    return;
  }
  if (!window.Hls?.isSupported()) {
    state.previewing = false;
    return;
  }
  stream = new window.Hls({ enableWorker: false });
  stream.on(window.Hls.Events.ERROR, (_event, data) => {
    if (data.fatal) previewFailed();
  });
  stream.loadSource(info.previewUrl);
  stream.attachMedia(player.video);
}

// Lässt die Seite keine Vorschau zu, spielt der geladene Ton.
function previewFailed() {
  if (!state.previewing) return;
  state.previewing = false;
  stopStream();
  if (state.media) playLocal(state.media);
}

// Zeigt sofort Titel und Video, lädt den Ton und legt gleich mit dem Transkribieren los.
async function loadLink() {
  const url = parts.url.value.trim();
  if (!url) return;
  setMessage('');
  parts.loadLink.disabled = true;
  parts.loadLink.textContent = 'Prüft Link …';
  const infoResponse = await invoke('download:info', url);
  parts.loadLink.disabled = false;
  parts.loadLink.textContent = 'Laden und transkribieren';
  if (!infoResponse.ok) {
    setMessage(infoResponse.error);
    return;
  }
  const { info } = infoResponse;
  if (info.isLive) {
    setMessage('Livestreams können nicht transkribiert werden.');
    return;
  }

  parts.url.value = '';
  state.media = null;
  state.link = info;
  startLinkPreview(info);
  const length = info.duration ? `${formatTime(info.duration)} · ` : '';
  showWorkspace(info.title, `${length}aus Link · Ton wird geladen …`);

  const response = await invoke('transcribe:fromLink', info.url);
  if (state.link !== info) return;
  if (!response.ok) {
    parts.info.textContent = `${length}aus Link`;
    setMessage(response.error ?? 'Abgebrochen. Füge den Link erneut ein, um es noch einmal zu versuchen.');
    return;
  }
  state.media = response.media;
  parts.info.textContent = `${formatTime(state.media.duration)} · aus Link`;
  if (!state.previewing) playLocal(state.media);
  start();
}

function closeFile() {
  stopStream();
  player.clear();
  player.video.removeAttribute('poster');
  state.media = null;
  state.link = null;
  state.previewing = false;
  state.transcript = null;
  setMessage('');
  parts.workspace.hidden = true;
  refresh();
}

async function start() {
  setMessage('');
  state.running = true;
  parts.start.disabled = true;
  parts.start.textContent = 'Läuft …';
  const filePath = state.media.path;
  const response = await invoke('transcribe:start', { filePath, language: parts.language.value, model: parts.model.value });
  state.running = false;
  parts.start.disabled = false;
  parts.start.textContent = 'Transkribieren';
  if (state.media?.path !== filePath) return;
  if (!response.ok) {
    if (response.error) setMessage(response.error);
    return;
  }
  state.transcript = response.transcript;
  renderResult();
}

function summary(transcript) {
  const words = transcript.segments.reduce((sum, segment) => sum + segment.text.split(/\s+/).filter(Boolean).length, 0);
  const language = LANGUAGE_NAMES[transcript.language] ?? transcript.language;
  const device = transcript.device === 'cuda' ? 'Grafikkarte' : 'Prozessor';
  return `${transcript.segments.length} Abschnitte · ${words} Wörter · Sprache: ${language} · erkannt mit ${device}`;
}

function segmentRow(segment) {
  const text = el('div', {
    class: 'transcript-text',
    contentEditable: 'plaintext-only',
    spellcheck: false,
    'aria-label': `Text ab ${formatTime(segment.start)}`,
    oninput: () => {
      segment.text = text.textContent.replace(/\s+/g, ' ').trim();
      segment.edited = true;
    },
  }, segment.text);
  const time = el('button', {
    class: 'transcript-time',
    title: 'Im Video an diese Stelle springen',
    onclick: () => {
      player.video.currentTime = segment.start;
    },
  }, formatTime(segment.start));
  return el('div', { class: 'transcript-row' }, time, text);
}

function renderResult() {
  const { transcript } = state;
  parts.resultCards.forEach((card) => {
    card.hidden = !transcript;
  });
  parts.start.textContent = 'Transkribieren';
  if (!transcript) {
    rows = [];
    parts.list.replaceChildren();
    return;
  }
  parts.start.textContent = 'Neu transkribieren';
  parts.summary.textContent = summary(transcript);
  if (transcript.segments.length === 0) {
    rows = [];
    parts.list.replaceChildren(el('p', { class: 'muted' }, 'Es wurde keine Sprache erkannt.'));
    return;
  }
  rows = transcript.segments.map(segmentRow);
  parts.list.replaceChildren(...rows);
}

// Markiert den Satz, der gerade läuft, und hält ihn beim Abspielen im Blick.
function highlightCurrent() {
  if (!state.transcript || rows.length === 0) return;
  const time = player.video.currentTime;
  const index = state.transcript.segments.findIndex((segment) => time >= segment.start && time < segment.end);
  rows.forEach((row, rowIndex) => row.classList.toggle('active', rowIndex === index));
  const editing = parts.list.contains(document.activeElement) && document.activeElement.isContentEditable;
  if (index >= 0 && !player.video.paused && !editing) {
    const row = rows[index];
    const list = parts.list;
    if (row.offsetTop < list.scrollTop || row.offsetTop + row.offsetHeight > list.scrollTop + list.clientHeight) {
      list.scrollTo({ top: row.offsetTop - list.clientHeight / 3 });
    }
  }
}

async function save(format) {
  setMessage('');
  const response = await invoke('transcribe:export', {
    format,
    transcript: state.transcript,
    filePath: state.media.path,
    fromLink: Boolean(state.media.fromLink),
  });
  if (!response.ok) {
    setMessage(response.error);
    return;
  }
  if (!response.path) return;
  parts.saved.replaceChildren(
    el('span', { class: 'muted' }, `Gespeichert: ${response.path}`),
    el('button', { class: 'button small', onclick: () => invoke('shell:showFile', response.path) }, 'Im Ordner zeigen'),
  );
  parts.saved.hidden = false;
}

function buildPage(root) {
  player = new MediaPlayer();
  player.root.classList.add('transcript-player');

  parts = {
    message: el('p', { class: 'message', role: 'alert', hidden: true }),
    setup: el('div', { class: 'stack' }),
    drop: createFileDrop({
      onFile: openFile,
      title: 'Video oder Audio hierher ziehen',
      features: [
        { iconName: 'transcribe', title: 'Gesprochenes erkennen', text: 'Auch mit Satzzeichen und Wortzeiten' },
        { iconName: 'globe', title: 'Viele Sprachen', text: 'Die Sprache wird automatisch erkannt' },
        { iconName: 'file', title: 'Untertitel oder Text', text: 'SRT, VTT, Text oder JSON speichern' },
      ],
    }),
    url: el('input', {
      class: 'input grow',
      placeholder: 'Link einfügen, zum Beispiel von YouTube, Instagram oder TikTok',
      'aria-label': 'Link zum Video',
      spellcheck: false,
      onkeydown: (event) => {
        if (event.key === 'Enter') loadLink();
      },
    }),
    loadLink: el('button', { class: 'button primary', onclick: () => loadLink() }, 'Laden und transkribieren'),
    workspace: el('div', { class: 'stack', hidden: true }),
    name: el('h2', { class: 'file-name' }),
    info: el('p', { class: 'muted' }),
    language: el('select', { class: 'input', 'aria-label': 'Sprache' },
      ...LANGUAGES.map(([value, text]) => el('option', { value }, text))),
    model: el('select', { class: 'input', 'aria-label': 'Sprachmodell' }),
    start: el('button', { class: 'button primary', onclick: start }, 'Transkribieren'),
    summary: el('p', { class: 'muted' }),
    list: el('div', { class: 'transcript-list' }),
    saved: el('div', { class: 'marker-row', hidden: true }),
  };

  player.video.addEventListener('error', previewFailed);
  player.video.addEventListener('timeupdate', highlightCurrent);
  player.video.addEventListener('seeked', highlightCurrent);

  const settingsCard = el('section', { class: 'card stack' },
    el('h2', {}, 'Einstellungen'),
    el('label', { class: 'field' }, el('span', { class: 'muted' }, 'Sprache'), parts.language),
    el('label', { class: 'field' }, el('span', { class: 'muted' }, 'Modell'), parts.model),
    el('div', {}, parts.start),
  );
  const saveCard = el('section', { class: 'card stack', hidden: true },
    el('h2', {}, 'Speichern'),
    el('div', { class: 'export-grid' }, ...EXPORTS.map(({ format, text, hint }) => el('button', {
      class: 'export-choice',
      onclick: () => save(format),
    }, el('strong', {}, text), el('span', { class: 'muted' }, hint)))),
    parts.saved,
  );
  const textCard = el('section', { class: 'card stack transcript-card', hidden: true },
    el('h2', {}, 'Text'),
    parts.summary,
    el('p', { class: 'muted' }, 'Klick auf eine Zeit springt im Video dorthin. Den Text kannst du direkt verbessern, das wird beim Speichern übernommen.'),
    parts.list,
  );
  parts.resultCards = [saveCard, textCard];

  parts.workspace.append(
    el('section', { class: 'card file-card' },
      el('div', { class: 'video-text' }, parts.name, parts.info),
      el('button', { class: 'button small', onclick: closeFile }, 'Andere Datei'),
    ),
    // Der Text scrollt in sich, so bleiben Video und Text nebeneinander sichtbar.
    el('div', { class: 'ai-columns transcript-columns' },
      el('div', { class: 'stack ai-controls' }, el('section', { class: 'card stack' }, player.root), settingsCard, saveCard),
      el('div', { class: 'stack ai-controls' }, textCard),
    ),
  );

  parts.linkCard = el('section', { class: 'card stack', hidden: true },
    el('h2', {}, 'Per Link'),
    el('p', { class: 'muted' }, 'Es wird nur der Ton vorübergehend geladen, in deinen Downloads landet nichts.'),
    el('div', { class: 'url-row' }, parts.url, parts.loadLink),
  );

  root.classList.add('wide-page');
  root.append(
    pageHeader('Transkribieren', 'Gesprochenes erkennen und als Untertitel oder Text speichern.'),
    parts.message,
    // Ist alles eingerichtet, kommen Link und Datei zuerst, die Modellverwaltung darunter.
    parts.linkCard,
    parts.drop,
    parts.setup,
    parts.workspace,
  );
  parts.drop.hidden = true;

  window.vitool.on('transcribe:statusChanged', refresh);
  window.vitool.on('queue:update', (jobs) => {
    const running = jobs.some((job) => job.kind === 'transcribe' && (job.status === 'running' || job.status === 'queued'));
    if (!running && state.wasRunning) refresh();
    state.wasRunning = running;
  });
}

export default {
  id: 'transcribe',
  label: 'Transkribieren',
  mount: buildPage,
  onShow() {
    refresh();
  },
  onHide() {
    player.video.pause();
  },
};
