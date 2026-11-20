// Bereich Ton: Pausen entfernen, Rauschen mindern, die Lautstärke angleichen und den Ton herausholen.
// Die Pausen berechnet die Oberfläche aus den Pegeln. So sieht man jede Änderung an den Reglern sofort.
import { el, icon, pageHeader } from '../utils/dom.js';
import { ICONS } from '../utils/icons.js';
import { folderOf } from '../utils/path.js';
import { formatTime } from '../utils/time.js';
import { createFileDrop } from '../components/file-drop.js';
import { quietSeek } from '../components/video-controls.js';
import { createSendTo, createContinue } from '../components/send-to.js';
import { MediaPlayer } from '../components/media-player.js';
import { sendTo } from '../utils/navigation.js';
import { draftBadge } from '../components/draft-badge.js';
import { volumeControl, registerMedia } from '../utils/volume.js';
import { t, LANGUAGE } from '../utils/i18n.js';

const invoke = (...args) => window.vitool.invoke(...args);

const FLOOR_DB = -70;
const SILENT_DB = -100;
const NOISE_SECONDS = 1;
const SECONDS = new Intl.NumberFormat(LANGUAGE, { minimumFractionDigits: 1, maximumFractionDigits: 2 });

const state = {
  media: null,
  levels: null,
  measuring: false,
  folder: null,
  visible: false,
  silence: { on: true, threshold: null, auto: null, minPause: 0.7, pad: 0.2, skip: true },
  denoise: { on: false, strength: 'medium', rumble: false },
  loudness: { on: false, target: -14 },
  // keep: wie die Datei, sonst nur der Ton im gewählten Format. original übernimmt die Tonspur unverändert.
  format: 'keep',
  preset: null,
  pauses: [],
  noise: null,
  probe: null,
  probing: false,
  keep: [],
};
let parts = {};
let player = null;
let skipFrame = null;

function setMessage(text) {
  parts.message.textContent = text;
  parts.message.hidden = !text;
}

// Grundrauschen und laute Stellen aus den Pegeln schätzen. Die Schwelle liegt etwa bei einem Drittel dazwischen.
function autoThreshold(values) {
  const heard = values.filter((value) => value > SILENT_DB).sort((a, b) => a - b);
  if (heard.length < 20) return -45;
  const floor = heard[Math.floor(heard.length * 0.1)];
  const loud = heard[Math.floor(heard.length * 0.95)];
  return Math.max(-65, Math.min(-20, Math.round(floor + (loud - floor) * 0.35)));
}

function findPauses({ step, values }, duration, { threshold, minPause, pad }) {
  const pauses = [];
  let runStart = null;
  for (let index = 0; index <= values.length; index += 1) {
    const quiet = index < values.length && values[index] < threshold;
    if (quiet && runStart === null) runStart = index;
    if (quiet || runStart === null) continue;
    const start = runStart * step;
    const end = Math.min(duration, index * step);
    if (end - start >= minPause) {
      // Am Anfang und am Ende darf die Stille ganz weg, dazwischen bleibt ein kleiner Rand.
      const from = runStart === 0 ? 0 : start + pad;
      const to = index >= values.length ? duration : end - pad;
      if (to - from >= 0.1) pauses.push({ start: from, end: to });
    }
    runStart = null;
  }
  return pauses;
}

function keepSections(pauses, duration) {
  const keep = [];
  let position = 0;
  for (const pause of pauses) {
    if (pause.start > position) keep.push({ start: position, end: pause.start });
    position = pause.end;
  }
  if (duration > position) keep.push({ start: position, end: duration });
  return keep.filter(({ start, end }) => end - start >= 0.05);
}

// Die ruhigste Sekunde der Datei, an der nur das Grundrauschen zu hören ist. Aus ihr lernt der
// Rauschfilter, was er entfernen soll. Digitale Stille zählt nicht, darin ist kein Rauschen.
function quietWindow({ step, values }) {
  const size = Math.round(NOISE_SECONDS / step);
  if (values.length < size) return null;
  let best = null;
  let sum = 0;
  let silent = 0;
  for (let index = 0; index < values.length; index += 1) {
    sum += values[index];
    if (values[index] <= SILENT_DB + 10) silent += 1;
    if (index >= size) {
      sum -= values[index - size];
      if (values[index - size] <= SILENT_DB + 10) silent -= 1;
    }
    if (index < size - 1 || silent > 0) continue;
    const level = sum / size;
    if (!best || level < best.level) best = { start: (index - size + 1) * step, end: (index + 1) * step, level };
  }
  return best;
}

function threshold() {
  return state.silence.threshold ?? state.silence.auto ?? -45;
}

function recompute() {
  const { media, levels } = state;
  if (!media || !levels) {
    state.pauses = [];
    state.keep = [];
  } else {
    state.pauses = findPauses(levels, media.duration, { ...state.silence, threshold: threshold() });
    state.keep = keepSections(state.pauses, media.duration);
  }
  renderSilence();
  drawWave();
}

function renderSilence() {
  const { silence, media } = state;
  parts.thresholdInput.value = String(threshold());
  parts.thresholdValue.textContent = `${threshold()} dB`;
  parts.thresholdAuto.hidden = silence.threshold === null;
  parts.minPauseValue.textContent = `${SECONDS.format(silence.minPause)} s`;
  parts.padValue.textContent = `${SECONDS.format(silence.pad)} s`;
  parts.silenceBody.hidden = !silence.on;

  if (!media) return;
  if (state.measuring) {
    parts.silenceSummary.textContent = t('Misst den Pegel …');
  } else if (!state.levels) {
    parts.silenceSummary.textContent = '';
  } else if (state.pauses.length === 0) {
    parts.silenceSummary.textContent = t('Keine Pausen gefunden. Stell die Schwelle höher oder die Mindestlänge kürzer.');
  } else {
    const removed = state.pauses.reduce((sum, { start, end }) => sum + end - start, 0);
    parts.silenceSummary.textContent = t('{count} Pausen, {removed} kürzer. Neue Länge {length}.', {
      count: state.pauses.length,
      removed: formatTime(removed),
      length: formatTime(media.duration - removed),
    });
  }
  parts.openInCut.disabled = !state.levels || state.pauses.length === 0;
  updateStart();
}

// Pegel als Balken, entfernte Pausen schraffiert und die Schwelle als Linie.
function drawWave() {
  const canvas = parts.wave;
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (!width || !height) return;
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);
  const context = canvas.getContext('2d');
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, width, height);
  const { media, levels } = state;
  if (!media || !levels) return;

  const styles = getComputedStyle(canvas);
  const toY = (db) => height - ((Math.max(FLOOR_DB, db) - FLOOR_DB) / -FLOOR_DB) * height;
  const perPixel = levels.values.length / width;

  if (state.silence.on) {
    context.fillStyle = styles.getPropertyValue('--wave-cut').trim() || 'rgba(255, 90, 90, 0.18)';
    for (const pause of state.pauses) {
      const x = (pause.start / media.duration) * width;
      context.fillRect(x, 0, Math.max(1, ((pause.end - pause.start) / media.duration) * width), height);
    }
  }

  context.fillStyle = styles.getPropertyValue('--accent').trim() || '#3ddc97';
  for (let x = 0; x < width; x += 1) {
    const from = Math.floor(x * perPixel);
    const to = Math.max(from + 1, Math.floor((x + 1) * perPixel));
    let peak = SILENT_DB;
    for (let index = from; index < to && index < levels.values.length; index += 1) peak = Math.max(peak, levels.values[index]);
    const y = toY(peak);
    context.fillRect(x, y, 1, height - y);
  }

  if (state.silence.on) {
    const y = Math.round(toY(threshold())) + 0.5;
    context.strokeStyle = styles.getPropertyValue('--text').trim() || '#fff';
    context.globalAlpha = 0.6;
    context.setLineDash([4, 4]);
    context.beginPath();
    context.moveTo(0, y);
    context.lineTo(width, y);
    context.stroke();
    context.setLineDash([]);
    context.globalAlpha = 1;
  }
}

function movePlayhead() {
  if (!state.media) return;
  parts.playhead.style.left = `${(player.video.currentTime / state.media.duration) * 100}%`;
}

// Beim Abspielen springt der Player über die Pausen. So hört man das Ergebnis vorher.
// Nach einem Sprung meldet der Player oft eine Zeit knapp vor dem Ziel, etwa das letzte ganze Bild.
// Der Rand verhindert, dass er deshalb immer wieder an dieselbe Stelle springt und stehen bleibt.
const SKIP_TOLERANCE = 0.1;

function pauseAt(time) {
  let low = 0;
  let high = state.pauses.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const pause = state.pauses[middle];
    if (time < pause.start) high = middle - 1;
    else if (time >= pause.end - SKIP_TOLERANCE) low = middle + 1;
    else return pause;
  }
  return null;
}

function skipLoop() {
  skipFrame = null;
  const { video } = player;
  if (video.paused || !state.visible) return;
  if (state.silence.on && state.silence.skip && !video.seeking) {
    const pause = pauseAt(video.currentTime);
    if (pause) quietSeek(video, Math.min(pause.end, state.media.duration));
  }
  movePlayhead();
  skipFrame = requestAnimationFrame(skipLoop);
}

async function measure(media) {
  state.levels = null;
  state.measuring = true;
  parts.measureFill.style.width = '0%';
  parts.measure.hidden = false;
  renderSilence();
  drawWave();
  const response = await invoke('audio:levels', media.path);
  if (state.media?.path !== media.path) return;
  state.measuring = false;
  parts.measure.hidden = true;
  if (!response.ok) {
    if (!response.canceled) setMessage(response.error);
    renderSilence();
    return;
  }
  state.levels = { step: response.step, values: response.values };
  state.silence.auto = autoThreshold(response.values);
  state.noise = quietWindow(state.levels);
  recompute();
  renderProbe();
}

async function openFile(filePath) {
  setMessage('');
  const response = await invoke('media:probe', filePath);
  if (!response.ok) {
    setMessage(response.error);
    return;
  }
  const { media } = response;
  if (!media.hasAudio) {
    setMessage(t('Diese Datei enthält keine Tonspur.'));
    return;
  }

  state.media = media;
  state.folder = media.homeFolder ?? folderOf(media.path);
  state.silence.threshold = null;
  state.noise = null;
  resetProbe();
  parts.name.textContent = media.name;
  parts.name.title = media.path;
  parts.info.textContent = [
    formatTime(media.duration),
    media.height ? `${media.width} × ${media.height}` : t('Nur Audio'),
  ].join(' · ');
  parts.badge.hidden = !media.draft;
  parts.folder.textContent = state.folder;
  parts.folder.title = state.folder;
  applyPreset();
  renderFormat();

  player.load(media);
  parts.drop.hidden = true;
  parts.workspace.hidden = false;
  movePlayhead();
  requestAnimationFrame(drawWave);
  measure(media);
}

function setOption(toggle, on) {
  toggle.checked = on;
  toggle.dispatchEvent(new Event('change'));
}

function applyPreset() {
  const { preset } = state;
  state.preset = null;
  if (!preset) return;
  setOption(parts.silenceToggle, preset === 'silence');
  setOption(parts.denoiseToggle, preset === 'denoise');
  setOption(parts.loudnessToggle, preset === 'loudness');
  state.format = preset === 'extract' ? 'mp3' : 'keep';
}

function renderFormat() {
  const video = Boolean(state.media?.hasVideo);
  if (state.media && !video && state.format === 'original') state.format = 'keep';
  const select = parts.formatSelect;
  select.querySelector('[value="keep"]').textContent = video ? t('Video') : t('Wie die Datei');
  // Bei reinen Tondateien ist das Original die Datei selbst.
  select.querySelector('[value="original"]').hidden = !video;
  select.value = state.format;
  parts.videoHint.hidden = !video || state.format !== 'keep';
  parts.formatHint.textContent = state.format === 'original'
    ? t('Original übernimmt die Tonspur unverändert und ohne Qualitätsverlust.')
    : video && state.format !== 'keep' ? t('Gespeichert wird nur der Ton, ohne Bild.') : '';
  parts.formatHint.hidden = !parts.formatHint.textContent;
  updateStart();
}

function closeFile() {
  resetProbe();
  player.clear();
  state.media = null;
  state.levels = null;
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

function anyChosen() {
  return state.silence.on || state.denoise.on || state.loudness.on;
}

function updateStart() {
  if (!parts.formatSelect) return;
  const audioOnly = state.format !== 'keep';
  const original = state.format === 'original';
  // Auch der Rauschfilter wartet auf die Pegel, weil er daraus die ruhige Stelle nimmt.
  const waiting = !original && (state.silence.on || state.denoise.on) && !state.levels;
  const pausesFound = state.silence.on && (!state.levels || state.pauses.length > 0);
  const empty = state.silence.on && state.levels && state.pauses.length === 0 && !state.denoise.on && !state.loudness.on && !audioOnly;
  // Die Original-Tonspur wird nur kopiert, Bearbeitungen gehen dabei nicht.
  const conflict = original && (pausesFound || state.denoise.on || state.loudness.on);
  const ready = Boolean(state.media) && (anyChosen() || audioOnly) && !waiting && !empty && !conflict;
  parts.start.disabled = !ready;
  parts.continueButton.disabled = !ready;
  parts.startHint.textContent = conflict
    ? t('Die Original-Tonspur lässt sich nur ohne Bearbeitung übernehmen. Schalte oben alles aus oder wähle ein anderes Format.')
    : !anyChosen() && !audioOnly ? t('Wähle oben eine Bearbeitung oder bei „Speichern als“ ein Tonformat.')
      : waiting ? t('Wartet auf die Pegelmessung …') : '';
  parts.startHint.hidden = !parts.startHint.textContent;
  renderProbe();
}

function audioOptions(draft = false) {
  const usePauses = state.silence.on && state.pauses.length > 0;
  return {
    filePath: state.media.path,
    folder: state.folder,
    draft,
    format: state.format,
    sections: usePauses ? state.keep : null,
    denoise: state.denoise.on ? state.denoise.strength : null,
    rumble: state.denoise.on && state.denoise.rumble,
    loudness: state.loudness.on ? state.loudness.target : null,
    noise: state.denoise.on ? state.noise : null,
  };
}

// Hörprobe: zwei kurze Stücke, die gleichzeitig laufen. Umgeschaltet wird nur, welches zu hören ist.
function probeKey() {
  const { denoise, rumble, loudness, noise } = audioOptions();
  return JSON.stringify([state.media?.path, denoise, rumble, loudness, noise]);
}

function probeAudios() {
  return [parts.probeOriginal, parts.probeProcessed];
}

function stopProbe() {
  probeAudios().forEach((audio) => audio.pause());
  renderProbe();
}

function resetProbe() {
  if (state.probing) invoke('audio:cancelPreview');
  state.probe = null;
  state.probing = false;
  probeAudios().forEach((audio) => {
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
  });
  renderProbe();
}

function renderProbe() {
  if (!parts.probeButton) return;
  const usable = state.denoise.on || state.loudness.on;
  const fresh = state.probe && state.probe.key === probeKey();
  const playing = !parts.probeProcessed.paused;
  parts.probeButton.disabled = !usable || state.probing || !state.media || (state.denoise.on && !state.levels);
  parts.probeButton.textContent = state.probe && !fresh ? t('Neue Hörprobe ab hier') : t('Hörprobe ab hier');
  parts.probeControls.hidden = !fresh;
  parts.probeHint.textContent = !usable
    ? t('Für Rauschen und Lautstärke. Pausen hörst du schon beim normalen Abspielen.')
    : state.probe && !fresh ? t('Die Einstellungen haben sich geändert.') : '';
  parts.probeHint.hidden = !parts.probeHint.textContent;
  parts.probePlay.textContent = playing ? t('Pause') : t('Abspielen');
  parts.probeOriginalButton.classList.toggle('active', state.probe?.listen === 'original');
  parts.probeProcessedButton.classList.toggle('active', state.probe?.listen !== 'original');
}

function listenTo(which) {
  if (!state.probe) return;
  state.probe.listen = which;
  parts.probeOriginal.muted = which !== 'original';
  parts.probeProcessed.muted = which === 'original';
  renderProbe();
}

async function makeProbe() {
  player.video.pause();
  stopProbe();
  state.probing = true;
  parts.probeStatus.textContent = t('Erstellt die Hörprobe …');
  parts.probeStatus.hidden = false;
  renderProbe();
  const key = probeKey();
  const response = await invoke('audio:preview', { ...audioOptions(), sections: null, start: player.video.currentTime });
  state.probing = false;
  parts.probeStatus.hidden = true;
  if (!response.ok) {
    if (!response.canceled) setMessage(response.error);
    renderProbe();
    return;
  }
  state.probe = { key, start: response.start, length: response.length, listen: 'processed' };
  parts.probeOriginal.src = response.original;
  parts.probeProcessed.src = response.processed;
  listenTo('processed');
  await Promise.all(probeAudios().map((audio) => new Promise((resolve) => {
    audio.addEventListener('canplaythrough', resolve, { once: true });
  })));
  toggleProbe();
}

function toggleProbe() {
  const [original, processed] = probeAudios();
  if (!processed.paused) {
    stopProbe();
    return;
  }
  player.video.pause();
  if (processed.ended || processed.currentTime >= processed.duration - 0.05) processed.currentTime = 0;
  original.currentTime = processed.currentTime;
  original.play();
  processed.play();
  renderProbe();
}

function moveProbeTime() {
  if (!state.probe) return;
  const time = parts.probeProcessed.currentTime;
  parts.probeTime.textContent = `${formatTime(state.probe.start + time)} · ${formatTime(time)} / ${formatTime(state.probe.length)}`;
}

async function startAudio() {
  const response = await invoke('audio:start', audioOptions());
  setMessage(response.ok ? '' : response.error);
}

function segmented(label, choices, current, onSelect) {
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

function slider(label, input, value) {
  return el('label', { class: 'crop-control' }, el('span', { class: 'muted slider-label' }, label), input, value);
}

// Karte mit Schalter im Kopf. Ausgeschaltet bleibt nur die kurze Beschreibung sichtbar.
function optionCard(iconName, title, text, toggle, body) {
  return el('section', { class: 'card stack audio-option' },
    el('label', { class: 'audio-option-head' },
      el('span', { class: 'feature-icon' }, icon(ICONS[iconName])),
      el('span', { class: 'audio-option-text' }, el('strong', {}, title), el('span', { class: 'muted' }, text)),
      el('span', { class: 'switch' }, toggle, el('span', { class: 'switch-track' }))),
    body);
}

function buildPage(root) {
  player = new MediaPlayer();
  player.video.addEventListener('play', () => {
    if (parts.probeProcessed && !parts.probeProcessed.paused) stopProbe();
    if (!skipFrame) skipFrame = requestAnimationFrame(skipLoop);
  });
  player.video.addEventListener('timeupdate', movePlayhead);
  player.video.addEventListener('seeked', movePlayhead);

  parts = {
    message: el('p', { class: 'message', role: 'alert', hidden: true }),
    drop: createFileDrop({
      onFile: openFile,
      title: t('Video oder Audio hierher ziehen'),
      allowAudio: true,
      // Ein Klick auf eine Karte fragt die Datei ab und schaltet genau diese Bearbeitung ein.
      features: [
        { iconName: 'cut', title: t('Pausen entfernen'), text: t('Stille Stellen automatisch herausschneiden'), onSelect: () => { state.preset = 'silence'; } },
        { iconName: 'wave', title: t('Rauschen entfernen'), text: t('Rauschen, Brummen und Lüfter leiser machen'), onSelect: () => { state.preset = 'denoise'; } },
        { iconName: 'audio', title: t('Lautstärke angleichen'), text: t('Gleich laut wie bei YouTube, Podcasts oder im Fernsehen'), onSelect: () => { state.preset = 'loudness'; } },
        { iconName: 'music', title: t('Audio extrahieren'), text: t('Tonspur als MP3, WAV oder im Original'), onSelect: () => { state.preset = 'extract'; } },
      ],
    }),
    workspace: el('div', { class: 'stack', hidden: true }),
    name: el('h2', { class: 'file-name' }),
    info: el('p', { class: 'muted' }),
    badge: draftBadge(),
    wave: el('canvas', { class: 'audio-wave' }),
    playhead: el('span', { class: 'audio-playhead' }),
    measure: el('div', { class: 'progress audio-measure', hidden: true }),
    measureFill: el('div', { class: 'progress-fill' }),
    folder: el('span', { class: 'folder-path' }),
    start: el('button', { class: 'button primary large', onclick: startAudio }, t('Exportieren')),
    startHint: el('p', { class: 'muted', hidden: true }),
    videoHint: el('p', { class: 'muted' }, t('Beim Entfernen von Pausen wird das Bild neu kodiert. Weitere Tonspuren und Untertitel werden nicht übernommen.')),
    silenceSummary: el('p', { class: 'notice audio-summary' }),
    formatHint: el('p', { class: 'muted', hidden: true }),
    formatSelect: el('select', {
      class: 'input',
      'aria-label': t('Speichern als'),
      onchange: () => {
        state.format = parts.formatSelect.value;
        renderFormat();
      },
    },
    ...[['keep', t('Video')], ['mp3', 'MP3'], ['m4a', 'M4A'], ['wav', 'WAV'], ['flac', 'FLAC'], ['original', t('Original-Tonspur')]]
      .map(([value, text]) => el('option', { value }, text))),
  };
  parts.measure.append(parts.measureFill);

  // Hörprobe
  parts.probeOriginal = el('audio', { preload: 'auto' });
  parts.probeProcessed = el('audio', { preload: 'auto' });
  parts.probeProcessed.addEventListener('timeupdate', moveProbeTime);
  parts.probeProcessed.addEventListener('ended', () => {
    parts.probeOriginal.pause();
    renderProbe();
  });
  parts.probeButton = el('button', { class: 'button', onclick: makeProbe }, t('Hörprobe ab hier'));
  parts.probeOriginalButton = el('button', { class: 'segment', onclick: () => listenTo('original') }, t('Original'));
  parts.probeProcessedButton = el('button', { class: 'segment', onclick: () => listenTo('processed') }, t('Bearbeitet'));
  parts.probePlay = el('button', { class: 'button small', onclick: toggleProbe });
  parts.probeTime = el('span', { class: 'muted sync-time' });
  parts.probeControls = el('div', { class: 'action-row', hidden: true },
    el('div', { class: 'segments', role: 'group', 'aria-label': t('Hörprobe') }, parts.probeOriginalButton, parts.probeProcessedButton),
    parts.probePlay,
    parts.probeTime,
    volumeControl());
  // Die Hörprobe hängt nicht im Dokument, sie bekommt die Lautstärke direkt.
  registerMedia(parts.probeOriginal);
  registerMedia(parts.probeProcessed);
  parts.probeStatus = el('p', { class: 'muted', hidden: true });
  parts.probeHint = el('p', { class: 'muted', hidden: true });
  parts.continueButton = createContinue({
    exclude: 'audio',
    start: () => invoke('audio:start', audioOptions(true)),
    onError: setMessage,
  });

  // Pausen
  parts.silenceToggle = el('input', {
    type: 'checkbox',
    checked: state.silence.on,
    onchange: () => {
      state.silence.on = parts.silenceToggle.checked;
      recompute();
    },
  });
  parts.thresholdInput = el('input', {
    type: 'range', min: -70, max: -15, step: 1, 'aria-label': t('Schwelle'),
    oninput: () => {
      state.silence.threshold = Number(parts.thresholdInput.value);
      recompute();
    },
  });
  parts.thresholdValue = el('span', { class: 'muted slider-value' });
  parts.thresholdAuto = el('button', {
    class: 'button small',
    onclick: () => {
      state.silence.threshold = null;
      recompute();
    },
  }, t('Automatisch'));
  parts.minPauseInput = el('input', {
    type: 'range', min: 0.3, max: 3, step: 0.1, value: state.silence.minPause, 'aria-label': t('Pausen ab'),
    oninput: () => {
      state.silence.minPause = Number(parts.minPauseInput.value);
      recompute();
    },
  });
  parts.minPauseValue = el('span', { class: 'muted slider-value' });
  parts.padInput = el('input', {
    type: 'range', min: 0, max: 0.5, step: 0.05, value: state.silence.pad, 'aria-label': t('Rand behalten'),
    oninput: () => {
      state.silence.pad = Number(parts.padInput.value);
      recompute();
    },
  });
  parts.padValue = el('span', { class: 'muted slider-value' });
  parts.skipToggle = el('input', {
    type: 'checkbox',
    checked: state.silence.skip,
    onchange: () => {
      state.silence.skip = parts.skipToggle.checked;
    },
  });
  parts.openInCut = el('button', {
    class: 'button small',
    onclick: () => sendTo('cut', state.media.path, { sections: state.keep }),
  }, t('In Schneiden ansehen'));
  parts.silenceBody = el('div', { class: 'stack' },
    slider(t('Schwelle'), parts.thresholdInput, parts.thresholdValue),
    el('div', { class: 'audio-auto' }, el('span', { class: 'muted' }, t('Leiser als die gestrichelte Linie gilt als Pause.')), parts.thresholdAuto),
    slider(t('Pausen ab'), parts.minPauseInput, parts.minPauseValue),
    slider(t('Rand behalten'), parts.padInput, parts.padValue),
    parts.silenceSummary,
    el('div', { class: 'marker-row' },
      el('label', { class: 'check' }, parts.skipToggle, el('span', {}, t('Beim Abspielen Pausen überspringen'))),
      el('span', { class: 'spacer' }),
      parts.openInCut),
  );

  // Rauschen
  parts.denoiseToggle = el('input', {
    type: 'checkbox',
    onchange: () => {
      state.denoise.on = parts.denoiseToggle.checked;
      parts.denoiseBody.hidden = !state.denoise.on;
      updateStart();
    },
  });
  parts.rumbleToggle = el('input', {
    type: 'checkbox',
    onchange: () => {
      state.denoise.rumble = parts.rumbleToggle.checked;
      renderProbe();
    },
  });
  parts.denoiseBody = el('div', { class: 'stack', hidden: true },
    segmented(t('Stärke'), [
      { value: 'light', text: t('Leicht') },
      { value: 'medium', text: t('Mittel') },
      { value: 'strong', text: t('Stark') },
    ], state.denoise.strength, (value) => {
      state.denoise.strength = value;
      renderProbe();
    }),
    el('label', { class: 'check' }, parts.rumbleToggle, el('span', {}, t('Tiefes Brummen und Trittschall entfernen (unter 80 Hz)'))),
    el('p', { class: 'muted' }, t('Vitool lernt das Rauschen an der ruhigsten Stelle der Datei. Stark kann Stimmen etwas dumpf machen, am besten mit der Hörprobe vergleichen.')),
  );

  // Lautstärke
  parts.loudnessToggle = el('input', {
    type: 'checkbox',
    onchange: () => {
      state.loudness.on = parts.loudnessToggle.checked;
      parts.loudnessBody.hidden = !state.loudness.on;
      updateStart();
    },
  });
  parts.loudnessBody = el('div', { class: 'stack', hidden: true },
    segmented(t('Ziel'), [
      { value: -14, text: t('Online-Video') },
      { value: -16, text: t('Podcast') },
      { value: -23, text: t('Fernsehen') },
    ], state.loudness.target, (value) => {
      state.loudness.target = value;
      renderProbe();
    }),
    el('p', { class: 'muted' }, t('Misst die ganze Datei und stellt sie auf die übliche Lautheit ein: −14 LUFS für YouTube und Co., −16 für Podcasts, −23 für Fernsehen. Spitzen bleiben unter −1,5 dB.')),
  );

  const waveBox = el('div', {
    class: 'audio-wave-box',
    onclick: (event) => {
      if (!state.media) return;
      const box = waveBox.getBoundingClientRect();
      player.video.currentTime = ((event.clientX - box.left) / box.width) * state.media.duration;
      movePlayhead();
    },
  }, parts.wave, parts.playhead);

  parts.workspace.append(
    el('section', { class: 'card file-card' },
      el('div', { class: 'video-text' }, parts.name, parts.info, parts.badge),
      el('div', { class: 'file-actions' },
        createSendTo({ getPath: () => state.media?.path, exclude: 'audio' }),
        el('button', { class: 'button small', onclick: closeFile }, t('Andere Datei'))),
    ),
    el('div', { class: 'ai-columns tool-columns' },
      el('section', { class: 'card stack ai-video' },
        player.root,
        waveBox,
        parts.measure,
        el('p', { class: 'muted timeline-hint' }, t('Klick in den Pegel springt an diese Stelle. Rot markierte Pausen fallen weg.')),
        el('div', { class: 'stack audio-probe' },
          el('div', { class: 'action-row' }, parts.probeButton, parts.probeControls),
          parts.probeStatus,
          parts.probeHint,
          el('p', { class: 'muted' }, t('Berechnet {seconds} Sekunden ab der aktuellen Stelle mit Rauschfilter und Lautstärke. Zum Vergleichen zwischen Original und Bearbeitet umschalten.', { seconds: 15 })))),
      el('div', { class: 'stack ai-controls' },
        optionCard('cut', t('Pausen entfernen'), t('Schneidet stille Stellen heraus'), parts.silenceToggle, parts.silenceBody),
        optionCard('wave', t('Rauschen entfernen'), t('Mindert gleichmäßiges Rauschen und Brummen'), parts.denoiseToggle, parts.denoiseBody),
        optionCard('audio', t('Lautstärke angleichen'), t('Bringt alles auf eine übliche Lautheit'), parts.loudnessToggle, parts.loudnessBody),
        el('section', { class: 'card stack' },
          el('div', { class: 'folder-row' },
            el('span', { class: 'muted' }, t('Zielordner')),
            parts.folder,
            el('button', { class: 'button small', onclick: chooseFolder }, t('Ändern')),
          ),
          el('label', { class: 'folder-row' }, el('span', { class: 'muted' }, t('Speichern als')), parts.formatSelect),
          parts.formatHint,
          parts.videoHint,
          el('div', { class: 'action-row' }, parts.start, parts.continueButton),
          parts.startHint,
        ),
      ),
    ),
  );

  root.classList.add('wide-page');
  root.append(pageHeader(t('Ton'), t('Pausen entfernen, Rauschen mindern, die Lautstärke angleichen und den Ton herausholen.')), parts.message, parts.drop, parts.workspace);

  window.vitool.on('audio:previewProgress', ({ phase, part }) => {
    if (!state.probing) return;
    const percent = Math.round(part * 100);
    parts.probeStatus.textContent = phase === 'measure'
      ? t('Misst die Lautstärke der ganzen Datei … {percent} %', { percent })
      : t('Erstellt die Hörprobe … {percent} %', { percent });
  });
  window.vitool.on('audio:levelsProgress', ({ filePath, part }) => {
    if (state.media?.path === filePath) parts.measureFill.style.width = `${Math.round(part * 100)}%`;
  });
  new ResizeObserver(() => drawWave()).observe(parts.wave);
  renderSilence();
  renderFormat();
}

export default {
  id: 'audio',
  label: t('Ton'),
  hint: t('Pausen entfernen, Rauschen mindern, Lautstärke angleichen und Audio extrahieren.'),
  mount: buildPage,
  onShow(data) {
    state.visible = true;
    if (data?.filePath) openFile(data.filePath);
    requestAnimationFrame(drawWave);
  },
  onHide() {
    state.visible = false;
    player.video.pause();
    stopProbe();
  },
};
