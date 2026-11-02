// Bereich Transkribieren: Zusatzpaket einrichten, Gesprochenes erkennen, Text prüfen und speichern.
import { el, pageHeader } from '../utils/dom.js';
import { formatTime } from '../utils/time.js';
import { createFileDrop } from '../components/file-drop.js';
import { createSendTo } from '../components/send-to.js';
import { MediaPlayer } from '../components/media-player.js';
import { t, formatNumber, LANGUAGE } from '../utils/i18n.js';

const invoke = (...args) => window.vitool.invoke(...args);

const LANGUAGES = [
  ['', t('Automatisch erkennen')],
  ['de', t('Deutsch')],
  ['en', t('Englisch')],
  ['fr', t('Französisch')],
  ['es', t('Spanisch')],
  ['it', t('Italienisch')],
  ['nl', t('Niederländisch')],
  ['pl', t('Polnisch')],
  ['pt', t('Portugiesisch')],
  ['tr', t('Türkisch')],
  ['ru', t('Russisch')],
  ['uk', t('Ukrainisch')],
  ['ar', t('Arabisch')],
  ['ja', t('Japanisch')],
  ['zh', t('Chinesisch')],
];
const LANGUAGE_NAMES = Object.fromEntries(LANGUAGES.filter(([code]) => code));

const EXPORTS = [
  { format: 'srt', text: 'SRT', hint: t('Untertitel für Player und Schnittprogramme') },
  { format: 'vtt', text: 'VTT', hint: t('Untertitel fürs Web') },
  { format: 'txt', text: t('Text'), hint: t('Fließtext in Absätzen') },
  { format: 'timed', text: t('Text mit Zeiten'), hint: t('Jeder Satz mit Zeitangabe') },
  { format: 'json', text: 'JSON', hint: t('Mit Wortzeiten, zum Weiterverarbeiten') },
];

const STYLE_CHOICES = [
  { value: 'classic', text: t('Klassisch') },
  { value: 'box', text: 'Box' },
  { value: 'highlight', text: t('Wort für Wort') },
  { value: 'pop', text: 'Pop' },
];
const ACCENTS = [
  ['#FFD400', t('Gelb')],
  ['#3DDC97', t('Grün')],
  ['#2FC6E8', t('Türkis')],
  ['#FF4FA3', t('Pink')],
  ['#FF7A1A', t('Orange')],
];

const state = {
  status: null,
  media: null,
  transcript: null,
  running: false,
  wasRunning: false,
  burn: { style: 'highlight', position: 'bottom', size: 'medium', color: '#FFD400', preview: true },
};
let parts = {};
let player = null;
let stream = null;
let rows = [];
const search = { hits: [], position: -1 };
const overlay = { cues: null, look: null, video: null, cue: null, words: [], watching: false };

function setMessage(text) {
  parts.message.textContent = text;
  parts.message.hidden = !text;
  parts.notice.hidden = true;
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
    ? el('button', { class: 'button small', onclick: () => confirmRemoveModel(model) }, t('Entfernen'))
    : el('button', { class: 'button small', onclick: () => act('transcribe:downloadModel', model.id) }, t('Herunterladen'));

  return el('div', { class: `model-card ${selected ? 'active' : ''}` },
    el('strong', {}, model.label, model.recommended ? el('span', { class: 'model-tag' }, t('Empfohlen')) : null),
    el('span', { class: 'muted' }, model.text),
    el('span', { class: 'muted' }, model.sizeMb >= 1000 ? `${formatNumber(model.sizeMb / 1000)} GB` : `${model.sizeMb} MB`),
    el('div', { class: 'marker-row' },
      model.downloaded ? el('button', {
        class: `flag ${selected ? 'active' : ''}`,
        onclick: () => act('transcribe:selectModel', model.id),
      }, selected ? t('Ausgewählt') : t('Auswählen')) : null,
      action),
  );
}

function confirmRemoveModel(model) {
  if (window.confirm(t('Modell {name} wirklich entfernen?', { name: model.label }))) act('transcribe:removeModel', model.id);
}

function confirmUninstall() {
  if (window.confirm(t('Die Transkription mit allen Sprachmodellen wirklich vollständig entfernen?'))) act('transcribe:uninstall');
}

function installRequirements(status) {
  if (!status.checked) {
    return [
      el('p', { class: 'muted' }, t('Grafikkarte und Python werden geprüft …')),
      el('div', {}, el('button', { class: 'button primary', disabled: true }, t('Transkription installieren'))),
    ];
  }
  return [
    el('p', { class: 'muted' }, status.gpu ? t('Grafikkarte erkannt: {name}', { name: status.gpu }) : t('Keine NVIDIA-Grafikkarte erkannt. Die Erkennung läuft dann über den Prozessor und dauert länger.')),
    status.python
      ? el('div', {}, el('button', { class: 'button primary', onclick: () => act('transcribe:install') }, t('Transkription installieren')))
      : el('p', { class: 'message' }, t('Dafür wird Python 3.10 oder neuer gebraucht. Installiere es mit: winget install Python.Python.3.12')),
  ];
}

function renderSetup() {
  const { status } = state;
  const ready = status.installed && status.models.some((model) => model.downloaded);
  // Bei einem Link gibt es während des Ladens noch keine Datei, die Arbeitsfläche ist trotzdem offen.
  const open = Boolean(state.media || state.link || state.batch);

  parts.setup.hidden = open;
  parts.setup.replaceChildren(...[
    el('section', { class: 'card stack' },
      el('h2', {}, status.installed ? t('Transkription') : t('Freiwilliges Zusatzpaket')),
      el('p', { class: 'muted' }, t('Transkribieren nutzt Whisper von OpenAI in der schnellen Fassung faster-whisper. Alles läuft nur auf deinem Rechner, es wird nichts hochgeladen. Vitool funktioniert auch ohne dieses Paket vollständig.')),
      status.installed
        ? el('div', { class: 'marker-row' },
          el('span', { class: 'muted' }, status.usedGb === null ? t('Installiert · Speicherbedarf wird ermittelt …') : t('Installiert · belegt {size} GB', { size: formatNumber(status.usedGb) })),
          el('button', { class: 'button small', onclick: confirmUninstall }, t('Transkription vollständig entfernen')))
        : el('div', { class: 'stack' },
          el('p', {}, t('Download etwa {size} GB · frei auf dem Laufwerk: {free} GB', { size: formatNumber(status.installSizeGb), free: status.freeGb })),
          ...installRequirements(status),
        ),
    ),
    status.installed ? el('section', { class: 'card stack' },
      el('h2', {}, t('Sprachmodell')),
      el('p', { class: 'muted' }, t('Du kannst ein oder mehrere Modelle laden. Größere verstehen undeutliche Sprache besser, brauchen aber länger.')),
      el('div', { class: 'model-grid' }, ...status.models.map(modelCard)),
    ) : null,
  ].filter(Boolean));
  parts.drop.hidden = !ready || open;
  parts.linkCard.hidden = parts.drop.hidden;
  parts.folderRow.hidden = parts.drop.hidden;
  renderModelSelect();
}

function renderModelSelect() {
  const downloaded = state.status.models.filter((model) => model.downloaded);
  [parts.fields, parts.batchFields].forEach((fields) => {
    const current = fields.model.value;
    fields.model.replaceChildren(...downloaded.map((model) => el('option', {
      value: model.id,
      selected: current ? model.id === current : model.id === state.status.selected,
    }, model.label)));
    updateTranslateHint(fields);
  });
}

// Sprache, Modell und Ausgabe gibt es für eine Datei und für den Stapel.
function settingFields() {
  const fields = {
    language: el('select', { class: 'input', 'aria-label': t('Sprache') },
      ...LANGUAGES.map(([value, text]) => el('option', { value }, text))),
    model: el('select', { class: 'input', 'aria-label': t('Sprachmodell'), onchange: () => updateTranslateHint(fields) }),
    output: el('select', { class: 'input', 'aria-label': t('Sprache des Textes'), onchange: () => updateTranslateHint(fields) },
      el('option', { value: 'original' }, t('Gesprochener Sprache')),
      el('option', { value: 'en' }, t('Englisch (übersetzt)'))),
    translateHint: el('p', { class: 'muted', hidden: true }),
  };
  fields.rows = [
    el('label', { class: 'field' }, el('span', { class: 'muted' }, t('Sprache')), fields.language),
    el('label', { class: 'field' }, el('span', { class: 'muted' }, t('Modell')), fields.model),
    el('label', { class: 'field' }, el('span', { class: 'muted' }, t('Text in')), fields.output),
    fields.translateHint,
  ];
  return fields;
}

const optionsFrom = (fields) => ({
  language: fields.language.value,
  model: fields.model.value,
  translate: fields.output.value === 'en',
});

// Large Turbo wurde ohne Übersetzungen trainiert und gibt dann oft nur die Originalsprache aus.
function updateTranslateHint(fields) {
  const translating = fields.output.value === 'en';
  const downloaded = state.status?.models.filter((model) => model.downloaded) ?? [];
  const better = downloaded.filter((model) => ['medium', 'large'].includes(model.id)).map((model) => model.label);
  let text = '';
  if (translating && fields.model.value === 'turbo') {
    text = better.length
      ? t('Large Turbo übersetzt schlecht. Nimm dafür besser {models}.', { models: better.join(t(' oder ')) })
      : t('Large Turbo übersetzt schlecht. Lade dafür besser das Modell Medium oder Large.');
  } else if (translating) {
    text = t('Whisper übersetzt aus jeder Sprache ins Englische. Andere Zielsprachen kann es nicht.');
  }
  fields.translateHint.textContent = text;
  fields.translateHint.hidden = !text;
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
    setMessage(t('Diese Datei hat keine Tonspur.'));
    return;
  }
  showMedia(response.media);
}

function showWorkspace(name, info) {
  state.transcript = null;
  state.batch = null;
  parts.batch.hidden = true;
  parts.sendTo.hidden = Boolean(state.link);
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

function openFiles(paths) {
  if (paths.length === 1) openFile(paths[0]);
  else if (paths.length > 1) showBatch(paths);
}

async function pickFolder() {
  const paths = await invoke('dialog:pickVideoFolder');
  if (paths.length === 0) return;
  if (state.batch) addToBatch(paths);
  else showBatch(paths);
}

// Stapel: mehrere Dateien mit denselben Einstellungen, Ergebnisse ohne Nachfrage neben den Originalen.
function showBatch(paths) {
  setMessage('');
  state.batch = [];
  addToBatch(paths);
  parts.drop.hidden = true;
  parts.linkCard.hidden = true;
  parts.folderRow.hidden = true;
  parts.setup.hidden = true;
  parts.batch.hidden = false;
}

function addToBatch(paths) {
  const known = new Set(state.batch);
  state.batch.push(...paths.filter((filePath) => !known.has(filePath)));
  renderBatch();
}

function renderBatch() {
  const count = state.batch.length;
  parts.batchTitle.textContent = count === 1 ? t('Stapel: 1 Datei') : t('Stapel: {count} Dateien', { count });
  parts.batchList.replaceChildren(...state.batch.map((filePath) => el('li', { class: 'batch-item' },
    el('span', { class: 'batch-name', title: filePath }, filePath.split(/[\\/]/).pop()),
    el('button', {
      class: 'object-remove',
      title: t('Aus dem Stapel nehmen'),
      'aria-label': t('Aus dem Stapel nehmen'),
      onclick: () => {
        state.batch = state.batch.filter((entry) => entry !== filePath);
        if (state.batch.length === 0) closeBatch();
        else renderBatch();
      },
    }, '×'))));
  parts.batchStart.textContent = t('Alle transkribieren ({count})', { count });
  parts.batchStart.disabled = count === 0 || !parts.formatChecks.some((check) => check.checked);
}

function closeBatch() {
  state.batch = null;
  parts.batch.hidden = true;
  refresh();
}

async function startBatch() {
  setMessage('');
  const formats = parts.formatChecks.filter((check) => check.checked).map((check) => check.value);
  const response = await invoke('transcribe:batch', { files: state.batch, formats, ...optionsFrom(parts.batchFields) });
  if (!response.ok) {
    setMessage(response.error);
    return;
  }
  closeBatch();
  setMessage('');
  parts.notice.textContent = t('{count} Dateien sind in der Warteschlange und werden nacheinander transkribiert. Die Ergebnisse landen neben den Originaldateien.', { count: response.count });
  parts.notice.hidden = false;
}

function buildBatch() {
  parts.batchTitle = el('h2', {});
  parts.batchList = el('ul', { class: 'batch-list' });
  parts.batchStart = el('button', { class: 'button primary', onclick: startBatch });
  parts.formatChecks = EXPORTS.map(({ format }) => el('input', {
    type: 'checkbox',
    value: format,
    checked: ['srt', 'txt'].includes(format),
    onchange: renderBatch,
  }));
  parts.batch = el('div', { class: 'stack', hidden: true },
    el('section', { class: 'card stack' },
      el('div', { class: 'section-head' }, parts.batchTitle,
        el('button', { class: 'button small', onclick: closeBatch }, t('Abbrechen'))),
      parts.batchList,
      el('div', { class: 'marker-row' },
        el('button', { class: 'button small', onclick: async () => addToBatch(await invoke('dialog:pickVideos')) }, t('Dateien hinzufügen')),
        el('button', { class: 'button small', onclick: pickFolder }, t('Ordner hinzufügen'))),
    ),
    el('section', { class: 'card stack' },
      el('h2', {}, t('Einstellungen für alle')),
      ...parts.batchFields.rows,
      el('p', { class: 'muted' }, t('Speichern als')),
      el('div', { class: 'format-checks' }, ...EXPORTS.map(({ text }, index) => el('label', { class: 'check' }, parts.formatChecks[index], el('span', {}, text)))),
      el('p', { class: 'muted' }, t('Die Dateien landen neben den Originalen, vorhandene werden nicht überschrieben. Die Transkriptionen laufen nacheinander.')),
      el('div', {}, parts.batchStart),
    ),
  );
  return parts.batch;
}

function showMedia(media) {
  state.link = null;
  state.media = media;
  playLocal(media);
  const details = media.hasVideo ? `${media.width} × ${media.height}` : t('nur Ton');
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
  parts.loadLink.textContent = t('Prüft Link …');
  const infoResponse = await invoke('download:info', url);
  parts.loadLink.disabled = false;
  parts.loadLink.textContent = t('Laden und transkribieren');
  if (!infoResponse.ok) {
    setMessage(infoResponse.error);
    return;
  }
  const { info } = infoResponse;
  if (info.isLive) {
    setMessage(t('Livestreams können nicht transkribiert werden.'));
    return;
  }
  if (info.playlist === 'only' && !info.duration) {
    setMessage(t('Das ist eine Playlist. Füge bitte den Link zu einem einzelnen Video ein.'));
    return;
  }

  parts.url.value = '';
  state.media = null;
  state.link = info;
  startLinkPreview(info);
  const length = info.duration ? `${formatTime(info.duration)} · ` : '';
  showWorkspace(info.title, `${length}${t('aus Link · Ton wird geladen …')}`);

  const response = await invoke('transcribe:fromLink', info.url);
  if (state.link !== info) return;
  if (!response.ok) {
    parts.info.textContent = `${length}${t('aus Link')}`;
    setMessage(response.error ?? t('Abgebrochen. Füge den Link erneut ein, um es noch einmal zu versuchen.'));
    return;
  }
  state.media = response.media;
  parts.info.textContent = `${formatTime(state.media.duration)} · ${t('aus Link')}`;
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
  parts.start.textContent = t('Läuft …');
  const filePath = state.media.path;
  const response = await invoke('transcribe:start', { filePath, ...optionsFrom(parts.fields) });
  state.running = false;
  parts.start.disabled = false;
  parts.start.textContent = t('Transkribieren');
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
  const device = transcript.device === 'cuda' ? t('erkannt mit Grafikkarte') : t('erkannt mit Prozessor');
  const spoken = transcript.translated
    ? t('ins Englische übersetzt (gesprochen: {language})', { language })
    : t('Sprache: {language}', { language });
  const segments = transcript.segments.length === 1 ? t('1 Abschnitt') : t('{count} Abschnitte', { count: transcript.segments.length });
  const wordCount = words === 1 ? t('1 Wort') : t('{count} Wörter', { count: words });
  return `${segments} · ${wordCount} · ${spoken} · ${device}`;
}

function segmentRow(segment) {
  const text = el('div', {
    class: 'transcript-text',
    contentEditable: 'plaintext-only',
    spellcheck: false,
    'aria-label': t('Text ab {time}', { time: formatTime(segment.start) }),
    oninput: () => {
      segment.text = text.textContent.replace(/\s+/g, ' ').trim();
      segment.edited = true;
      onTextChanged();
    },
    // Ein Satz bleibt eine Zeile, sonst passen Untertitel und Suche nicht mehr.
    onkeydown: (event) => {
      if (event.key === 'Enter') event.preventDefault();
    },
  }, segment.text);
  const time = el('button', {
    class: 'transcript-time',
    title: t('Im Video an diese Stelle springen'),
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
  parts.start.textContent = transcript ? t('Neu transkribieren') : t('Transkribieren');
  rows = transcript?.segments.map(segmentRow) ?? [];
  if (transcript) parts.summary.textContent = summary(transcript);
  if (transcript?.segments.length === 0) {
    parts.list.replaceChildren(el('p', { class: 'muted' }, t('Es wurde keine Sprache erkannt.')));
  } else {
    parts.list.replaceChildren(...rows);
  }
  runSearch();
  renderBurn();
}

// Treffer werden über die Highlight-Schnittstelle markiert, der bearbeitbare Text bleibt unverändert.
function runSearch() {
  const query = parts.search.value.trim().toLocaleLowerCase('de');
  search.hits = [];
  search.position = -1;
  if (query) {
    rows.forEach((row, index) => {
      const field = row.querySelector('.transcript-text');
      field.normalize();
      const node = field.firstChild;
      const text = node?.textContent.toLocaleLowerCase('de') ?? '';
      for (let at = text.indexOf(query); at >= 0; at = text.indexOf(query, at + query.length)) {
        const range = new Range();
        range.setStart(node, at);
        range.setEnd(node, at + query.length);
        search.hits.push({ range, index });
      }
    });
  }
  CSS.highlights.set('transcript-search', new Highlight(...search.hits.map((hit) => hit.range)));
  CSS.highlights.delete('transcript-current');
  renderSearchCount();
}

function renderSearchCount() {
  const query = parts.search.value.trim();
  const count = search.hits.length;
  parts.searchCount.textContent = !query ? '' : count === 0 ? t('Keine Treffer') : t('{position} von {count}', { position: search.position + 1 || '–', count });
  parts.searchPrev.disabled = count === 0;
  parts.searchNext.disabled = count === 0;
}

function jumpToHit(direction) {
  const count = search.hits.length;
  if (count === 0) return;
  search.position = (search.position + direction + count) % count;
  const hit = search.hits[search.position];
  CSS.highlights.set('transcript-current', new Highlight(hit.range));
  const row = rows[hit.index];
  parts.list.scrollTo({ top: row.offsetTop - parts.list.clientHeight / 3 });
  player.video.currentTime = state.transcript.segments[hit.index].start;
  renderSearchCount();
}

let searchTimer = null;
function onTextChanged() {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    runSearch();
    requestCues();
  }, 250);
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
    el('span', { class: 'muted' }, t('Gespeichert: {path}', { path: response.path })),
    el('button', { class: 'button small', onclick: () => invoke('shell:showFile', response.path) }, t('Im Ordner zeigen')),
  );
  parts.saved.hidden = false;
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

function setBurn(patch) {
  Object.assign(state.burn, patch);
  renderBurn();
}

function renderBurn() {
  const ready = Boolean(state.transcript?.segments.length);
  const noPicture = Boolean(state.media && !state.media.fromLink && !state.media.hasVideo);
  parts.burnCard.hidden = !ready;
  parts.burnButton.disabled = !ready || noPicture;
  parts.burnHint.textContent = noPicture
    ? t('Diese Datei hat kein Bild. Einbrennen geht nur bei Videos.')
    : state.media?.fromLink
      ? t('Dafür wird das Video heruntergeladen (höchstens 1080p). Das fertige Video landet in deinem Download-Ordner.')
      : t('Das fertige Video landet neben dem Original.');
  parts.styleTiles.forEach((tile) => tile.classList.toggle('active', tile.dataset.style === state.burn.style));
  parts.swatches.forEach((swatch) => swatch.classList.toggle('active', swatch.dataset.color === state.burn.color));
  parts.colorRow.hidden = !['highlight', 'pop'].includes(state.burn.style);
  requestCues();
}

// Holt dieselben Untertitel, die auch eingebrannt würden, damit die Vorschau genau passt.
let cueTimer = null;
function requestCues() {
  clearTimeout(cueTimer);
  cueTimer = setTimeout(async () => {
    const video = { width: player.video.videoWidth, height: player.video.videoHeight };
    if (!state.transcript?.segments.length || !state.burn.preview || !video.width) {
      overlay.cues = null;
      renderOverlay();
      return;
    }
    const response = await invoke('transcribe:cues', { transcript: state.transcript, options: { ...state.burn }, video });
    if (!response.ok) return;
    overlay.cues = response.cues;
    overlay.look = response.look;
    overlay.video = video;
    overlay.cue = null;
    renderOverlay();
  }, 150);
}

// Legt die Vorschau genau über die sichtbare Bildfläche, ohne die schwarzen Ränder.
function placeOverlay() {
  const { video } = player;
  const box = video.getBoundingClientRect();
  const rootBox = player.root.getBoundingClientRect();
  const ratio = video.videoWidth / video.videoHeight;
  let width = box.width;
  let height = box.height;
  if (width / height > ratio) width = height * ratio;
  else height = width / ratio;
  const node = parts.subOverlay;
  node.style.left = `${box.left - rootBox.left + (box.width - width) / 2}px`;
  node.style.top = `${box.top - rootBox.top + (box.height - height) / 2}px`;
  node.style.width = `${width}px`;
  node.style.height = `${height}px`;
  return height / overlay.video.height;
}

function renderOverlay() {
  const node = parts.subOverlay;
  const time = player.video.currentTime;
  const cue = overlay.cues?.find((entry) => time >= entry.start && time < entry.end) ?? null;
  node.hidden = !cue;
  if (!cue) {
    overlay.cue = null;
    return;
  }

  const scale = placeOverlay();
  const { look } = overlay;
  if (cue !== overlay.cue) {
    overlay.cue = cue;
    overlay.words = cue.words.map((word) => el('span', { class: 'sub-word' }, word.text));
    // Die innere Zeile trägt bei "Box" den Kasten, so bekommt jede Zeile ihren eigenen wie im fertigen Video.
    const line = el('span', { class: 'sub-line' }, ...overlay.words.flatMap((word, index) => (index ? [' ', word] : [word])));
    const text = el('span', { class: 'sub-text' }, line);
    node.className = `sub-overlay pos-${state.burn.position} ${look.box ? 'sub-box' : 'sub-outline'} ${look.upper ? 'sub-upper' : ''} ${look.pop ? 'sub-pop' : ''}`;
    node.replaceChildren(text);
  }
  node.style.setProperty('--sub-font', `'${look.font}'`);
  node.style.setProperty('--sub-weight', look.bold ? '700' : '400');
  node.style.setProperty('--sub-size', `${look.fontSize * scale}px`);
  node.style.setProperty('--sub-outline', `${look.outlineSize * scale}px`);
  node.style.setProperty('--sub-shadow', `${look.shadowSize * scale}px`);
  node.style.setProperty('--sub-box', `${look.boxSize * scale}px`);
  node.style.setProperty('--sub-margin', `${look.margin * scale}px`);
  node.style.setProperty('--sub-accent', look.color);
  if (look.highlight) {
    const active = cue.words.findLastIndex((word) => word.start <= time);
    overlay.words.forEach((word, index) => word.classList.toggle('active', index === Math.max(0, active)));
  }
}

function watchOverlay() {
  if (overlay.watching) return;
  overlay.watching = true;
  const step = () => {
    renderOverlay();
    if (player.video.paused) {
      overlay.watching = false;
      return;
    }
    requestAnimationFrame(step);
  };
  step();
}

async function burn() {
  setMessage('');
  const name = state.link?.title ?? state.media.name.replace(/\.[^.]+$/, '');
  const response = await invoke('transcribe:burn', {
    ...state.burn,
    transcript: state.transcript,
    filePath: state.media.path,
    linkUrl: state.media.fromLink ?? null,
    name,
  });
  if (!response.ok) {
    setMessage(response.error);
    return;
  }
  parts.burnHint.textContent = t('Läuft in der Warteschlange. Dort findest du danach auch „Im Ordner zeigen“.');
}

function buildBurnCard() {
  parts.styleTiles = STYLE_CHOICES.map(({ value, text }) => el('button', {
    class: 'style-tile',
    'data-style': value,
    onclick: () => setBurn({ style: value }),
  }, el('span', { class: `style-sample sample-${value}` }, value === 'pop' ? t('Hallo').toLocaleUpperCase(LANGUAGE) : value === 'highlight' ? el('span', {}, el('em', {}, t('Hallo')), ` ${t('du')}`) : t('Hallo')), el('span', { class: 'muted' }, text)));
  parts.swatches = ACCENTS.map(([color, text]) => {
    const swatch = el('button', {
      class: 'swatch',
      'data-color': color,
      title: text,
      'aria-label': t('Farbe {name}', { name: text }),
      onclick: () => setBurn({ color }),
    });
    swatch.style.setProperty('--swatch', color);
    return swatch;
  });
  parts.colorRow = el('div', { class: 'marker-row' }, el('span', { class: 'muted slider-label' }, t('Farbe')), ...parts.swatches);
  parts.burnHint = el('p', { class: 'muted' });
  parts.burnButton = el('button', { class: 'button primary', onclick: burn }, t('Video mit Untertiteln erstellen'));
  const preview = el('input', {
    type: 'checkbox',
    checked: state.burn.preview,
    onchange: () => setBurn({ preview: preview.checked }),
  });

  parts.burnCard = el('section', { class: 'card stack', hidden: true },
    el('h2', {}, t('Untertitel einbrennen')),
    el('div', { class: 'style-grid' }, ...parts.styleTiles),
    el('div', { class: 'marker-row' }, el('span', { class: 'muted slider-label' }, t('Position')),
      choice(t('Position'), [{ value: 'bottom', text: t('Unten') }, { value: 'middle', text: t('Mitte') }, { value: 'top', text: t('Oben') }], state.burn.position, (position) => setBurn({ position }))),
    el('div', { class: 'marker-row' }, el('span', { class: 'muted slider-label' }, t('Größe')),
      choice(t('Größe'), [{ value: 'small', text: t('Klein') }, { value: 'medium', text: t('Mittel') }, { value: 'large', text: t('Groß') }], state.burn.size, (size) => setBurn({ size }))),
    parts.colorRow,
    el('label', { class: 'check' }, preview, el('span', {}, t('Vorschau im Video zeigen'))),
    parts.burnHint,
    el('div', {}, parts.burnButton),
  );
  return parts.burnCard;
}

function buildPage(root) {
  player = new MediaPlayer();
  player.root.classList.add('transcript-player');

  parts = {
    message: el('p', { class: 'message', role: 'alert', hidden: true }),
    notice: el('p', { class: 'notice', role: 'status', hidden: true }),
    setup: el('div', { class: 'stack' }),
    drop: createFileDrop({
      onFiles: openFiles,
      title: t('Video oder Audio hierher ziehen'),
      hint: t('oder klicken, um auszuwählen. Mehrere Dateien werden nacheinander transkribiert.'),
      features: [
        { iconName: 'transcribe', title: t('Gesprochenes erkennen'), text: t('Auch mit Satzzeichen und Wortzeiten') },
        { iconName: 'globe', title: t('Viele Sprachen'), text: t('Die Sprache wird automatisch erkannt') },
        { iconName: 'file', title: t('Untertitel oder Text'), text: t('SRT, VTT, Text oder JSON speichern') },
      ],
    }),
    url: el('input', {
      class: 'input grow',
      placeholder: t('Link einfügen, zum Beispiel von YouTube, Instagram oder TikTok'),
      'aria-label': t('Link zum Video'),
      spellcheck: false,
      onkeydown: (event) => {
        if (event.key === 'Enter') loadLink();
      },
    }),
    loadLink: el('button', { class: 'button primary', onclick: () => loadLink() }, t('Laden und transkribieren')),
    workspace: el('div', { class: 'stack', hidden: true }),
    name: el('h2', { class: 'file-name' }),
    info: el('p', { class: 'muted' }),
    fields: settingFields(),
    batchFields: settingFields(),
    start: el('button', { class: 'button primary', onclick: start }, t('Transkribieren')),
    summary: el('p', { class: 'muted' }),
    list: el('div', { class: 'transcript-list' }),
    search: el('input', {
      class: 'input grow',
      type: 'search',
      placeholder: t('Im Text suchen'),
      'aria-label': t('Im Text suchen'),
      spellcheck: false,
      oninput: runSearch,
      onkeydown: (event) => {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        jumpToHit(event.shiftKey ? -1 : 1);
      },
    }),
    searchCount: el('span', { class: 'muted search-count' }),
    searchPrev: el('button', { class: 'button small', title: t('Vorheriger Treffer (Umschalt+Enter)'), 'aria-label': t('Vorheriger Treffer'), onclick: () => jumpToHit(-1) }, '↑'),
    searchNext: el('button', { class: 'button small', title: t('Nächster Treffer (Enter)'), 'aria-label': t('Nächster Treffer'), onclick: () => jumpToHit(1) }, '↓'),
    saved: el('div', { class: 'marker-row', hidden: true }),
    subOverlay: el('div', { class: 'sub-overlay', hidden: true, 'aria-hidden': 'true' }),
    // Ton aus einem Link liegt nur vorübergehend im Temp-Ordner und wird nicht weitergegeben.
    sendTo: createSendTo({ getPath: () => (state.media && !state.media.fromLink ? state.media.path : null), exclude: 'transcribe' }),
  };

  player.root.append(parts.subOverlay);
  player.video.addEventListener('error', previewFailed);
  player.video.addEventListener('timeupdate', highlightCurrent);
  player.video.addEventListener('seeked', highlightCurrent);
  player.video.addEventListener('seeked', renderOverlay);
  player.video.addEventListener('timeupdate', renderOverlay);
  player.video.addEventListener('play', watchOverlay);
  player.video.addEventListener('loadedmetadata', requestCues);
  window.addEventListener('resize', renderOverlay);

  const settingsCard = el('section', { class: 'card stack' },
    el('h2', {}, t('Einstellungen')),
    ...parts.fields.rows,
    el('div', {}, parts.start),
  );
  const saveCard = el('section', { class: 'card stack', hidden: true },
    el('h2', {}, t('Speichern')),
    el('div', { class: 'export-grid' }, ...EXPORTS.map(({ format, text, hint }) => el('button', {
      class: 'export-choice',
      onclick: () => save(format),
    }, el('strong', {}, text), el('span', { class: 'muted' }, hint)))),
    parts.saved,
  );
  const textCard = el('section', { class: 'card stack transcript-card', hidden: true },
    el('h2', {}, t('Text')),
    parts.summary,
    el('p', { class: 'muted' }, t('Klick auf eine Zeit springt im Video dorthin. Den Text kannst du direkt verbessern, das wird beim Speichern übernommen.')),
    el('div', { class: 'search-row' }, parts.search, parts.searchCount, parts.searchPrev, parts.searchNext),
    parts.list,
  );
  parts.resultCards = [saveCard, textCard];

  parts.workspace.append(
    el('section', { class: 'card file-card' },
      el('div', { class: 'video-text' }, parts.name, parts.info),
      el('div', { class: 'file-actions' }, parts.sendTo,
        el('button', { class: 'button small', onclick: closeFile }, t('Andere Datei'))),
    ),
    // Der Text scrollt in sich, so bleiben Video und Text nebeneinander sichtbar.
    el('div', { class: 'ai-columns transcript-columns' },
      el('div', { class: 'stack ai-controls' }, el('section', { class: 'card stack' }, player.root), settingsCard, saveCard, buildBurnCard()),
      el('div', { class: 'stack ai-controls' }, textCard),
    ),
  );

  parts.linkCard = el('section', { class: 'card stack', hidden: true },
    el('h2', {}, t('Per Link')),
    el('p', { class: 'muted' }, t('Es wird nur der Ton vorübergehend geladen, in deinen Downloads landet nichts.')),
    el('div', { class: 'url-row' }, parts.url, parts.loadLink),
  );

  parts.folderRow = el('div', { class: 'marker-row', hidden: true },
    el('button', { class: 'button small', onclick: pickFolder }, t('Ganzen Ordner transkribieren')));

  root.classList.add('wide-page');
  root.append(
    pageHeader(t('Transkribieren'), t('Gesprochenes erkennen und als Untertitel oder Text speichern.')),
    parts.message,
    parts.notice,
    // Ist alles eingerichtet, kommen Link und Datei zuerst, die Modellverwaltung darunter.
    parts.linkCard,
    parts.drop,
    parts.folderRow,
    parts.setup,
    parts.workspace,
    buildBatch(),
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
  label: t('Transkribieren'),
  mount: buildPage,
  // Eine weitergegebene Datei öffnet sich nur, wenn Paket und Modell bereit sind.
  async onShow(data) {
    await refresh();
    if (!data?.filePath) return;
    const ready = state.status.installed && state.status.models.some((model) => model.downloaded);
    if (ready) openFile(data.filePath);
    else setMessage(t('Zum Transkribieren muss zuerst das Zusatzpaket mit einem Sprachmodell eingerichtet werden.'));
  },
  onHide() {
    player.video.pause();
  },
};
