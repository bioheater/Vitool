// Bereich Zusammenfassen: Text eines Videos holen und von einem Sprachmodell zusammenfassen lassen,
// lokal über Ollama oder über einen Online-Dienst mit eigenem API-Schlüssel.
import { el, icon, pageHeader } from '../utils/dom.js';
import { ICONS } from '../utils/icons.js';
import { createFileDrop } from '../components/file-drop.js';
import { openPage } from '../utils/navigation.js';
import { t, LANGUAGE } from '../utils/i18n.js';

const invoke = (...args) => window.vitool.invoke(...args);

const PARTS = [
  { id: 'short', label: t('Kurzfassung') },
  { id: 'points', label: t('Wichtigste Punkte') },
  { id: 'chapters', label: t('Kapitel mit Zeitmarken') },
];
const LANGUAGES = [
  { value: 'de', text: t('Deutsch') },
  { value: 'en', text: t('Englisch') },
  { value: 'video', text: t('Wie das Video') },
];
const SOURCE_LABELS = {
  subtitles: t('Untertitel des Videos'),
  auto: t('Automatische Untertitel des Videos'),
  file: t('Text aus der Datei'),
  sidecar: t('Untertitel-Datei neben dem Video'),
  embedded: t('Untertitel aus dem Video'),
  transcript: t('Transkript aus Transkribieren'),
  whisper: t('Mit Whisper erkannt'),
};
const NUMBER = new Intl.NumberFormat(LANGUAGE);

const state = {
  status: null,
  online: null,
  engine: 'ollama',
  whisper: null,
  source: null,
  loaded: null,
  recognizing: false,
  parts: new Set(['short', 'points', 'chapters']),
  language: LANGUAGE === 'de' ? 'de' : 'en',
  running: false,
  text: '',
};
let parts = {};

function setMessage(text) {
  parts.message.textContent = text;
  parts.message.hidden = !text;
}

function segmented(label, choices, current, onSelect) {
  const buttons = choices.map(({ value, text }) => el('button', {
    class: `segment ${value === current() ? 'active' : ''}`,
    onclick: () => {
      onSelect(value);
      buttons.forEach((button, index) => button.classList.toggle('active', choices[index].value === current()));
    },
  }, text));
  const root = el('div', { class: 'segments', role: 'group', 'aria-label': label }, ...buttons);
  return { root, refresh: () => buttons.forEach((button, index) => button.classList.toggle('active', choices[index].value === current())) };
}

// ---------------------------------------------------------------- Sprachmodell

async function checkModels() {
  parts.statusText.textContent = t('Sucht Ollama …');
  const [status, online, settings] = await Promise.all([invoke('summary:status'), invoke('summary:onlineConfig'), invoke('settings:get')]);
  state.status = status;
  state.online = online;
  if (settings.summaryEngine === 'online' || settings.summaryEngine === 'ollama') state.engine = settings.summaryEngine;
  const { running, models } = status;
  parts.model.replaceChildren(...models.map((model) =>
    el('option', { value: model.name }, [model.name, model.parameters].filter(Boolean).join(' · '))));
  const remembered = models.find((model) => model.name === settings.summaryModel);
  if (remembered) parts.model.value = remembered.name;
  parts.statusText.textContent = running ? t('Ollama läuft, {count} Modelle', { count: models.length }) : '';
  renderOnlineSetup(false);
  renderEngine();
}

function ollamaReady() {
  return Boolean(state.status?.running && state.status.models.length);
}

function onlineProvider() {
  return state.online?.providers.find((provider) => provider.id === state.online.provider) ?? null;
}

function onlineReady() {
  return Boolean(onlineProvider()?.hasKey && state.online.model);
}

function renderEngine() {
  const local = state.engine === 'ollama';
  parts.engineButtons.refresh();
  parts.localRow.hidden = !local;
  parts.onlineRow.hidden = local;
  parts.onlineNote.hidden = local;
  const provider = onlineProvider();
  parts.onlineSummary.textContent = onlineReady() ? `${provider.label} · ${state.online.model}` : t('Noch nicht eingerichtet');
  renderNote();
  // Fehlt Ollama, steht oben die Einrichtung, mit dem Online-Dienst als Alternative.
  parts.setup.hidden = !local || ollamaReady() || !state.status;
  parts.setupNoOllama.hidden = Boolean(state.status?.running);
  parts.setupNoModel.hidden = !state.status?.running || state.status.models.length > 0;
  if (!local && !onlineReady()) renderOnlineSetup(true);
  renderStart();
}

// Der Hinweis nennt den Dienst, der gerade gewählt ist, auch während der Einrichtung.
function renderNote() {
  const id = !parts.onlineSetup.hidden && parts.provider.value ? parts.provider.value : state.online?.provider;
  const provider = state.online?.providers.find((entry) => entry.id === id);
  parts.onlineNote.textContent = t('Mit einem Online-Dienst schickt Vitool den Text des Videos an {name}: Untertitel oder Transkript, Titel und Beschreibung. Das Video und der Ton bleiben auf deinem PC. Es gelten die Preise und Datenschutzregeln des Anbieters.', { name: provider?.label ?? t('den Anbieter') });
}

// Einrichtung des Online-Dienstes: Anbieter, Schlüssel, bei Bedarf Adresse, dann das Modell.
function renderOnlineSetup(open) {
  if (!state.online) return;
  parts.onlineSetup.hidden = !open;
  if (!open) {
    renderNote();
    return;
  }
  const selected = parts.provider.value || state.online.provider;
  parts.provider.replaceChildren(...state.online.providers.map((provider) => el('option', { value: provider.id }, provider.label)));
  parts.provider.value = selected;
  renderProviderFields();
}

function renderProviderFields() {
  const provider = state.online.providers.find((entry) => entry.id === parts.provider.value);
  parts.key.value = '';
  parts.key.placeholder = provider.hasKey ? t('Gespeichert, zum Ändern neu eingeben') : t('API-Schlüssel einfügen');
  parts.keyPage.hidden = !provider.keyPage;
  parts.forget.hidden = !provider.hasKey;
  parts.baseRow.hidden = !provider.custom;
  parts.base.value = parts.provider.value === state.online.provider ? state.online.base ?? '' : '';
  const model = parts.provider.value === state.online.provider ? state.online.model : '';
  parts.onlineModel.replaceChildren(...(model ? [el('option', { value: model }, model)] : []));
  parts.onlineModel.value = model;
  parts.onlineHint.textContent = provider.hasKey || model ? '' : t('Gib den Schlüssel ein und lade dann die Modelle des Dienstes.');
  parts.onlineHint.hidden = !parts.onlineHint.textContent;
  renderNote();
}

async function loadOnlineModels() {
  parts.loadModels.disabled = true;
  parts.onlineHint.textContent = t('Fragt die Modelle ab …');
  parts.onlineHint.hidden = false;
  const response = await invoke('summary:onlineModels', { provider: parts.provider.value, base: parts.base.value.trim(), key: parts.key.value.trim() });
  parts.loadModels.disabled = false;
  if (!response.ok) {
    parts.onlineHint.textContent = response.error;
    return;
  }
  const current = parts.onlineModel.value;
  parts.onlineModel.replaceChildren(...response.models.map((model) => el('option', { value: model }, model)));
  if (response.models.includes(current)) parts.onlineModel.value = current;
  parts.onlineHint.textContent = t('{count} Modelle gefunden. Wähle eines und speichere.', { count: response.models.length });
}

async function saveOnline() {
  const response = await invoke('summary:onlineSave', {
    provider: parts.provider.value,
    model: parts.onlineModel.value,
    base: parts.base.value.trim(),
    key: parts.key.value.trim(),
  });
  if (!response.ok) {
    parts.onlineHint.textContent = response.error;
    parts.onlineHint.hidden = false;
    return;
  }
  state.online = response.config;
  renderOnlineSetup(!onlineReady());
  if (!onlineReady()) {
    parts.onlineHint.textContent = t('Es fehlt noch der Schlüssel oder ein Modell.');
    parts.onlineHint.hidden = false;
  }
  renderEngine();
}

async function forgetKey() {
  state.online = await invoke('summary:onlineForget', parts.provider.value);
  renderProviderFields();
  renderEngine();
}

// ---------------------------------------------------------------- Quelle

function resetSource(title) {
  state.loaded = null;
  state.text = '';
  parts.noText.hidden = true;
  parts.sourceCard.hidden = false;
  parts.resultCard.hidden = true;
  parts.sourceTitle.textContent = title;
  parts.transcript.hidden = true;
  setMessage('');
}

async function loadSource(source) {
  if (!source || state.recognizing) return;
  state.source = source;
  resetSource(/^https?:/i.test(source) ? source : source.split(/[\\/]/).pop());
  parts.sourceInfo.textContent = t('Holt den Text …');
  renderStart();
  const response = await invoke('summary:load', source);
  if (state.source !== source) return;
  if (!response.ok) {
    if (response.canceled) return;
    parts.sourceInfo.textContent = '';
    if (response.needsTranscript) await showNoText(response.error);
    else setMessage(response.error);
    return;
  }
  showLoaded(response);
}

async function loadTranscript(transcript) {
  state.source = null;
  resetSource(transcript.title ?? '');
  const response = await invoke('summary:fromTranscript', transcript);
  if (!response.ok) {
    setMessage(response.error);
    return;
  }
  showLoaded(response);
}

function showLoaded(response) {
  state.loaded = response;
  const { meta } = response;
  parts.noText.hidden = true;
  parts.sourceTitle.textContent = meta.title;
  parts.sourceInfo.textContent = [
    SOURCE_LABELS[meta.source],
    meta.language ? languageName(meta.language) : null,
    t('{count} Wörter', { count: NUMBER.format(response.words) }),
  ].filter(Boolean).join(' · ');
  parts.transcriptText.textContent = response.blocks
    .map((block) => (block.start === null ? block.text : `${clock(block.start)}  ${block.text}`)).join('\n');
  parts.transcript.hidden = false;
  renderStart();
}

// Ohne Untertitel kann Whisper die Sprache erkennen. Ist Transkribieren noch nicht eingerichtet, steht hier wie.
async function showNoText(reason) {
  state.whisper = await invoke('transcribe:status');
  const ready = state.whisper.installed && state.whisper.models.some((model) => model.downloaded);
  parts.noTextReason.textContent = reason;
  parts.whisperReady.hidden = !ready;
  parts.whisperMissing.hidden = ready;
  parts.whisperProgress.hidden = true;
  parts.recognize.disabled = false;
  parts.noText.hidden = false;
}

async function recognize() {
  const source = state.source;
  if (!source || state.recognizing) return;
  state.recognizing = true;
  parts.recognize.disabled = true;
  parts.whisperProgress.hidden = false;
  parts.whisperProgress.textContent = t('Startet …');
  try {
    let filePath = source;
    let title = source.split(/[\\/]/).pop().replace(/\.[^.]+$/, '');
    if (/^https?:/i.test(source)) {
      const link = await invoke('transcribe:fromLink', source);
      if (!link.ok) throw new Error(link.error);
      filePath = link.media.path;
      title = link.media.name.replace(/\.[^.]+$/, '');
    }
    const response = await invoke('transcribe:start', { filePath, model: state.whisper.selected, language: '', translate: false, speakers: false });
    if (!response.ok) throw new Error(response.error ?? t('Die Erkennung wurde abgebrochen.'));
    const loaded = await invoke('summary:fromTranscript', { ...response.transcript, title });
    if (!loaded.ok) throw new Error(loaded.error);
    loaded.meta.source = 'whisper';
    if (state.source === source) showLoaded(loaded);
  } catch (error) {
    if (state.source === source) {
      parts.whisperProgress.hidden = true;
      parts.recognize.disabled = false;
      setMessage(error.message);
    }
  } finally {
    state.recognizing = false;
  }
}

// Den Fortschritt der Erkennung zeigt die Warteschlange, hier steht er zusätzlich direkt beim Video.
function onQueue(jobs) {
  if (!state.recognizing) return;
  const job = jobs.find((entry) => entry.kind === 'transcribe' && entry.status === 'running');
  if (!job) return;
  const percent = Number.isFinite(job.progress) ? ` · ${Math.round(job.progress)} %` : '';
  parts.whisperProgress.textContent = `${job.detail ?? t('Erkennt Sprache')}${percent}`;
}

function languageName(code) {
  try {
    const name = new Intl.DisplayNames([LANGUAGE], { type: 'language' }).of(code);
    return name ? name[0].toUpperCase() + name.slice(1) : code;
  } catch {
    return code;
  }
}

function clock(seconds) {
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = String(Math.floor(total / 60) % 60).padStart(2, '0');
  const rest = String(total % 60).padStart(2, '0');
  return hours ? `${hours}:${minutes}:${rest}` : `${minutes}:${rest}`;
}

// ---------------------------------------------------------------- Zusammenfassen

function renderStart() {
  const engineReady = state.engine === 'online' ? onlineReady() : Boolean(state.status?.running && parts.model.value);
  parts.start.hidden = state.running;
  parts.cancel.hidden = !state.running;
  parts.start.disabled = !(state.loaded && engineReady && state.parts.size > 0);
  parts.optionsCard.hidden = !state.loaded;
}

async function startSummary() {
  if (!state.loaded) return;
  setMessage('');
  state.running = true;
  state.text = '';
  parts.resultCard.hidden = false;
  parts.resultActions.hidden = true;
  parts.resultTitle.textContent = state.loaded.meta.title;
  parts.progress.textContent = state.engine === 'online' ? t('Fragt {name} …', { name: onlineProvider()?.label ?? '' }) : t('Das Modell wird geladen …');
  parts.progress.hidden = false;
  renderResult();
  renderStart();
  const response = await invoke('summary:start', {
    engine: state.engine,
    model: parts.model.value,
    parts: PARTS.map((part) => part.id).filter((id) => state.parts.has(id)),
    language: state.language,
    meta: state.loaded.meta,
    blocks: state.loaded.blocks,
  });
  state.running = false;
  parts.progress.hidden = true;
  if (response.ok) {
    state.text = response.text;
    parts.resultActions.hidden = false;
  } else if (!response.canceled) {
    setMessage(response.error);
    if (!state.text) parts.resultCard.hidden = true;
  }
  renderResult();
  renderStart();
}

function onProgress({ phase, part, total, text }) {
  if (!state.running) return;
  if (phase === 'notes') {
    parts.progress.textContent = t('Liest das Video in Teilen, Teil {part} von {total} …', { part, total });
    return;
  }
  parts.progress.textContent = t('Schreibt die Zusammenfassung …');
  if (text) {
    state.text += text;
    renderResult();
  }
}

// Einfaches Markdown: Überschriften, Aufzählungen und Fettes. Alles andere bleibt Text.
function inline(text) {
  const nodes = [];
  let last = 0;
  for (const match of text.matchAll(/\*\*(.+?)\*\*/g)) {
    if (match.index > last) nodes.push(text.slice(last, match.index));
    nodes.push(el('strong', {}, match[1]));
    last = match.index + match[0].length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

function renderMarkdown(text) {
  const nodes = [];
  let list = null;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    const bullet = /^[-*•]\s+(.*)$/.exec(line) ?? /^\d+[.)]\s+(.*)$/.exec(line);
    if (bullet) {
      if (!list) {
        list = el('ul', { class: 'summary-list' });
        nodes.push(list);
      }
      list.append(el('li', {}, ...inline(bullet[1])));
      continue;
    }
    list = null;
    if (!line) continue;
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (heading) nodes.push(el('h3', {}, ...inline(heading[1].replace(/\*\*/g, ''))));
    else nodes.push(el('p', {}, ...inline(line)));
  }
  return nodes;
}

function renderResult() {
  parts.result.replaceChildren(...renderMarkdown(state.text));
}

async function copyResult() {
  await navigator.clipboard.writeText(state.text);
  parts.copy.textContent = t('Kopiert');
  setTimeout(() => { parts.copy.textContent = t('Kopieren'); }, 1500);
}

async function saveResult() {
  const response = await invoke('summary:save', { text: state.text, name: `${state.loaded?.meta.title ?? 'Video'} (${t('Zusammenfassung')})` });
  if (response.ok) setMessage('');
}

// ---------------------------------------------------------------- Seite

function buildSetup() {
  const command = 'ollama pull gemma3:4b';
  parts.setupNoOllama = el('div', { class: 'stack' },
    el('p', {}, t('Zum Zusammenfassen nutzt Vitool Ollama, ein kostenloses Programm, das Sprachmodelle auf deinem PC ausführt. Video und Text bleiben dabei auf deinem PC.')),
    el('div', { class: 'action-row' },
      el('button', { class: 'button primary', onclick: () => invoke('summary:openOllama') }, t('Ollama herunterladen')),
      el('button', { class: 'button', onclick: checkModels }, t('Erneut prüfen'))));
  parts.setupNoModel = el('div', { class: 'stack' },
    el('p', {}, t('Ollama läuft, hat aber noch kein Modell. Lade eins in der Eingabeaufforderung, zum Beispiel:')),
    el('div', { class: 'folder-row' },
      el('code', { class: 'summary-command' }, command),
      el('button', { class: 'button small', onclick: () => navigator.clipboard.writeText(command) }, t('Kopieren')),
      el('button', { class: 'button small', onclick: checkModels }, t('Erneut prüfen'))),
    el('p', { class: 'muted' }, t('Größere Modelle fassen genauer zusammen, brauchen aber mehr Grafikspeicher.')));
  parts.setup = el('section', { class: 'card stack', hidden: true },
    el('div', { class: 'audio-option-head' },
      el('span', { class: 'feature-icon' }, icon(ICONS.summary)),
      el('span', { class: 'audio-option-text' }, el('strong', {}, t('Ollama einrichten')))),
    parts.setupNoOllama,
    parts.setupNoModel,
    el('div', { class: 'folder-row' },
      el('span', { class: 'muted' }, t('Oder nutze einen Online-Dienst mit eigenem API-Schlüssel.')),
      el('button', {
        class: 'button small',
        onclick: () => {
          state.engine = 'online';
          renderEngine();
        },
      }, t('Online-Dienst nutzen'))));
}

function buildOnlineSetup() {
  parts.provider = el('select', { class: 'input', 'aria-label': t('Dienst'), onchange: renderProviderFields });
  parts.key = el('input', { class: 'input grow', type: 'password', autocomplete: 'off', spellcheck: false, 'aria-label': t('API-Schlüssel') });
  parts.keyPage = el('button', { class: 'button small', onclick: () => invoke('summary:openKeyPage', parts.provider.value) }, t('Schlüssel holen'));
  parts.forget = el('button', { class: 'button small', onclick: forgetKey }, t('Schlüssel entfernen'));
  parts.base = el('input', { class: 'input grow', placeholder: 'https://…/v1', 'aria-label': t('Adresse') });
  parts.baseRow = el('label', { class: 'folder-row', hidden: true }, el('span', { class: 'muted' }, t('Adresse')), parts.base);
  parts.onlineModel = el('select', { class: 'input grow', 'aria-label': t('Modell') });
  parts.loadModels = el('button', { class: 'button small', onclick: loadOnlineModels }, t('Modelle laden'));
  parts.onlineHint = el('p', { class: 'muted', hidden: true });
  parts.onlineSetup = el('div', { class: 'stack summary-online', hidden: true },
    el('label', { class: 'folder-row' }, el('span', { class: 'muted' }, t('Dienst')), parts.provider),
    el('div', { class: 'folder-row' }, el('span', { class: 'muted' }, t('Schlüssel')), parts.key, parts.keyPage, parts.forget),
    parts.baseRow,
    el('div', { class: 'folder-row' }, el('span', { class: 'muted' }, t('Modell')), parts.onlineModel, parts.loadModels),
    parts.onlineHint,
    el('p', { class: 'muted' }, t('Der Schlüssel wird mit deiner Windows-Anmeldung verschlüsselt auf diesem PC gespeichert und nur an den gewählten Dienst geschickt.')),
    el('div', { class: 'action-row' },
      el('button', { class: 'button primary', onclick: saveOnline }, t('Speichern')),
      el('button', { class: 'button', onclick: () => renderOnlineSetup(false) }, t('Abbrechen'))));
}

function buildNoText() {
  parts.noTextReason = el('p', {});
  parts.recognize = el('button', { class: 'button primary', onclick: recognize }, t('Sprache mit Whisper erkennen'));
  parts.whisperProgress = el('p', { class: 'muted', hidden: true });
  parts.whisperReady = el('div', { class: 'stack' },
    el('p', { class: 'muted' }, t('Vitool kann die Sprache mit Whisper erkennen, wie im Bereich Transkribieren. Bei einem Link lädt es dafür nur den Ton. Je nach Länge und Grafikkarte dauert das einige Sekunden bis Minuten.')),
    el('div', { class: 'action-row' }, parts.recognize),
    parts.whisperProgress);
  parts.whisperMissing = el('div', { class: 'stack' },
    el('p', { class: 'muted' }, t('Für Videos ohne Untertitel erkennt Vitool die Sprache mit Whisper. Dafür wird einmalig das Zusatzpaket im Bereich Transkribieren eingerichtet. Danach geht es hier mit einem Klick.')),
    el('div', { class: 'action-row' }, el('button', { class: 'button primary', onclick: () => openPage('transcribe') }, t('Transkribieren einrichten'))));
  parts.noText = el('div', { class: 'stack summary-notext', hidden: true }, parts.noTextReason, parts.whisperReady, parts.whisperMissing);
}

function buildPage(root) {
  parts = {
    message: el('p', { class: 'message', role: 'alert', hidden: true }),
    statusText: el('span', { class: 'muted' }),
    url: el('input', {
      class: 'input grow',
      placeholder: t('Link zu einem Video, etwa von YouTube'),
      'aria-label': t('Link'),
      onkeydown: (event) => {
        if (event.key === 'Enter') loadSource(parts.url.value.trim());
      },
    }),
    model: el('select', { class: 'input', 'aria-label': t('Modell'), onchange: renderStart }),
    start: el('button', { class: 'button primary large', onclick: startSummary }, t('Zusammenfassen')),
    cancel: el('button', { class: 'button large', hidden: true, onclick: () => invoke('summary:cancel') }, t('Abbrechen')),
    progress: el('p', { class: 'muted', hidden: true }),
    result: el('div', { class: 'summary-result' }),
    resultTitle: el('h2', {}),
    sourceTitle: el('h2', { class: 'file-name' }),
    sourceInfo: el('p', { class: 'muted' }),
    transcriptText: el('pre', { class: 'summary-transcript' }),
    copy: el('button', { class: 'button small', onclick: copyResult }, t('Kopieren')),
    onlineSummary: el('span', {}),
    onlineNote: el('p', { class: 'notice', hidden: true }),
  };
  buildSetup();
  buildOnlineSetup();
  buildNoText();
  parts.transcript = el('details', { class: 'summary-details', hidden: true }, el('summary', {}, t('Text ansehen')), parts.transcriptText);
  parts.resultActions = el('div', { class: 'action-row', hidden: true },
    parts.copy,
    el('button', { class: 'button small', onclick: saveResult }, t('Speichern …')),
    el('button', { class: 'button small', onclick: startSummary }, t('Neu erstellen')));

  const drop = createFileDrop({
    onFile: (filePath) => loadSource(filePath),
    title: t('Video, Untertitel oder Transkript hierher ziehen'),
    hint: t('oder klicken (Video, SRT, VTT, TXT oder JSON aus Transkribieren)'),
    dialog: 'dialog:pickSummarySource',
    compact: true,
    allowAudio: true,
  });
  parts.sourceCard = el('section', { class: 'card stack', hidden: true },
    el('div', { class: 'video-text' }, parts.sourceTitle, parts.sourceInfo),
    parts.noText,
    parts.transcript);

  // Optionen: Sprachmodell, Inhalt, Sprache
  const partBoxes = PARTS.map((part) => {
    const box = el('input', {
      type: 'checkbox',
      checked: state.parts.has(part.id),
      onchange: () => {
        if (box.checked) state.parts.add(part.id);
        else state.parts.delete(part.id);
        renderStart();
      },
    });
    return el('label', { class: 'check' }, box, el('span', {}, part.label));
  });
  parts.engineButtons = segmented(t('Sprachmodell'), [
    { value: 'ollama', text: t('Auf diesem PC (Ollama)') },
    { value: 'online', text: t('Online-Dienst') },
  ], () => state.engine, (value) => {
    state.engine = value;
    renderEngine();
  });
  const languageButtons = segmented(t('Sprache'), LANGUAGES, () => state.language, (value) => {
    state.language = value;
  });
  parts.localRow = el('label', { class: 'folder-row' }, el('span', { class: 'muted' }, t('Modell')), parts.model, el('span', { class: 'spacer' }), parts.statusText);
  parts.onlineRow = el('div', { class: 'folder-row', hidden: true },
    el('span', { class: 'muted' }, t('Dienst')), parts.onlineSummary, el('span', { class: 'spacer' }),
    el('button', { class: 'button small', onclick: () => renderOnlineSetup(parts.onlineSetup.hidden) }, t('Einrichten')));
  parts.optionsCard = el('section', { class: 'card stack', hidden: true },
    el('div', { class: 'folder-row' }, el('span', { class: 'muted' }, t('Sprachmodell')), parts.engineButtons.root),
    parts.localRow,
    parts.onlineRow,
    parts.onlineSetup,
    parts.onlineNote,
    el('div', { class: 'summary-parts' }, ...partBoxes),
    el('div', { class: 'folder-row' }, el('span', { class: 'muted' }, t('Sprache')), languageButtons.root),
    el('div', { class: 'action-row' }, parts.start, parts.cancel));

  parts.resultCard = el('section', { class: 'card stack', hidden: true },
    parts.resultTitle,
    parts.progress,
    parts.result,
    parts.resultActions);

  root.append(
    pageHeader(t('Zusammenfassen'), t('Worum es in einem Video geht, in wenigen Absätzen, Stichpunkten und Kapiteln.')),
    parts.message,
    parts.setup,
    el('section', { class: 'card stack' },
      el('div', { class: 'url-row' }, parts.url, el('button', { class: 'button primary', onclick: () => loadSource(parts.url.value.trim()) }, t('Text holen'))),
      drop),
    parts.sourceCard,
    parts.optionsCard,
    parts.resultCard,
  );
  window.vitool.on('summary:progress', onProgress);
  window.vitool.on('queue:update', onQueue);
}

export default {
  id: 'summary',
  label: t('Zusammenfassen'),
  hint: t('Videos von einem Sprachmodell zusammenfassen lassen, auf deinem PC oder online.'),
  mount: buildPage,
  async onShow(data) {
    if (!state.status) await checkModels();
    if (data?.transcript) loadTranscript(data.transcript);
    else if (data?.filePath) loadSource(data.filePath);
  },
};
