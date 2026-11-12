// Tonspur angleichen: Wellenformen vergleichen und verschieben, Versatz und Tempo automatisch finden,
// Ausschnitt mit Bild probehören. Die Werte landen direkt in der Spur und gelten beim Speichern.
import { el } from '../utils/dom.js';
import { formatTime } from '../utils/time.js';
import { t, LANGUAGE } from '../utils/i18n.js';

const invoke = (...args) => window.vitool.invoke(...args);

const VIEWS = [5, 15, 60];
const PREVIEW_SECONDS = 20;
const NUMBER = new Intl.NumberFormat(LANGUAGE, { maximumFractionDigits: 3, useGrouping: false, signDisplay: 'exceptZero' });
const PERCENT = new Intl.NumberFormat(LANGUAGE, { maximumFractionDigits: 2 });

// Nummeriert wie die Liste darüber, auch bei Spuren aus hinzugefügten Dateien.
function trackLabel(track, tracks) {
  const language = track.language && track.language !== 'und' ? ` · ${track.language}` : '';
  const name = track.name ? ` · ${track.name}` : '';
  return `${t('Spur {number}', { number: tracks.indexOf(track) + 1 })}: ${track.codec.toUpperCase()}${language}${name}`;
}

function sameTrack(a, b) {
  return a && b && a.source === b.source && a.index === b.index;
}

function cssColor(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#888';
}

// Erklärt in Worten, warum eine Spur auseinanderläuft. kind kommt aus der Analyse.
function tempoText(kind, stretch) {
  if (kind === 'pal-fast') {
    return t('Die Spur läuft etwa 4 % zu schnell. Deshalb passt sie am Anfang und läuft dann immer weiter auseinander. Das ist typisch für Fassungen aus dem europäischen Fernsehen und von DVDs (PAL): Dort laufen Filme mit 25 statt 24 Bildern pro Sekunde, Bild und Ton werden dadurch schneller und die Stimmen etwas höher.');
  }
  if (kind === 'pal-slow') {
    return t('Die Spur läuft etwa 4 % zu langsam. Vermutlich stammt das Video aus einer PAL-Fassung mit 25 Bildern pro Sekunde und die Spur aus einer Kino- oder Blu-ray-Fassung mit 24 Bildern pro Sekunde.');
  }
  if (kind === 'ntsc-fast' || kind === 'ntsc-slow') {
    return t('Die Spur läuft um 0,1 % zu {direction}. Das entsteht zwischen 24 und 23,976 Bildern pro Sekunde (NTSC) und macht bei einem zweistündigen Film etwa 7 Sekunden aus.', {
      direction: kind === 'ntsc-fast' ? t('schnell') : t('langsam'),
    });
  }
  return t('Die Spur läuft um {percent} % zu {direction}. Eine typische Ursache ließ sich nicht zuordnen.', {
    percent: PERCENT.format(Math.abs(stretch - 1) * 100),
    direction: stretch > 1 ? t('schnell') : t('langsam'),
  });
}

export class SyncPanel {
  constructor({ getFiles, getTracks, onChange }) {
    this.getFiles = getFiles;
    this.getTracks = getTracks;
    this.onChange = onChange;
    this.track = null;
    this.reference = null;
    this.result = null;
    this.position = 0;
    this.view = 15;
    this.overlay = false;
    this.cache = { ref: null, dub: null };
    this.loading = { ref: false, dub: false };

    this.title = el('h2', {});
    this.referenceSelect = el('select', {
      class: 'input',
      'aria-label': t('Vergleichen mit'),
      onchange: () => {
        this.reference = this.audioTracks().find((track) => `${track.source}:${track.index}` === this.referenceSelect.value);
        this.cache.ref = null;
        this.result = null;
        this.renderResult();
        this.draw();
      },
    });
    this.autoButton = el('button', { class: 'button primary', onclick: () => this.analyze() }, t('Automatisch angleichen'));
    this.status = el('span', { class: 'muted' });
    this.resultText = el('p', { class: 'notice', hidden: true });
    this.tempoBox = el('div', { class: 'notice sync-tempo', hidden: true });
    this.canvas = el('canvas', { class: 'sync-canvas' });
    this.positionInput = el('input', {
      type: 'range',
      min: 0,
      step: 0.1,
      'aria-label': t('Stelle im Film'),
      oninput: () => this.setPosition(Number(this.positionInput.value)),
    });
    this.positionText = el('span', { class: 'muted sync-time' });
    this.viewButtons = VIEWS.map((seconds) => el('button', {
      class: 'segment',
      onclick: () => this.setView(seconds),
    }, `${seconds} s`));
    this.overlayInput = el('input', {
      type: 'checkbox',
      onchange: () => {
        this.overlay = this.overlayInput.checked;
        this.draw();
      },
    });
    this.offsetText = el('strong', { class: 'sync-offset' });
    this.previewButton = el('button', { class: 'button', onclick: () => this.preview() }, t('Ausschnitt testen'));
    this.video = el('video', { controls: true, hidden: true, class: 'sync-video' });

    const nudge = (seconds) => el('button', {
      class: 'button small',
      onclick: () => this.setOffset(this.track.offset + seconds),
    }, `${seconds > 0 ? '+' : '−'}${Math.abs(seconds * 1000)} ms`);

    this.root = el('section', { class: 'card stack sync-panel', hidden: true },
      el('div', { class: 'section-head' },
        this.title,
        el('button', { class: 'button small', onclick: () => this.close() }, t('Schließen'))),
      el('div', { class: 'folder-row' }, el('span', { class: 'muted' }, t('Vergleichen mit')), this.referenceSelect),
      el('div', { class: 'marker-row' }, this.autoButton, this.status),
      this.resultText,
      this.tempoBox,
      el('p', { class: 'muted' }, t('Oben die Vergleichsspur, unten die Spur, die du angleichst. Ziehe die Wellenform mit der Maus, bis die Ausschläge übereinanderliegen. Mit dem Mausrad wanderst du durch den Film.')),
      this.canvas,
      el('div', { class: 'sync-controls' },
        el('span', { class: 'muted' }, t('Stelle')),
        this.positionInput,
        this.positionText,
        el('div', { class: 'segments', role: 'group', 'aria-label': t('Ausschnitt') }, ...this.viewButtons),
        el('label', { class: 'check' }, this.overlayInput, el('span', {}, t('Übereinander')))),
      el('div', { class: 'marker-row' },
        el('span', { class: 'muted' }, t('Versatz')),
        this.offsetText,
        nudge(-0.1), nudge(-0.01), nudge(0.01), nudge(0.1),
        this.previewButton),
      this.video,
    );

    this.installCanvas();
    window.vitool.on('mkv:syncProgress', ({ part }) => {
      if (this.analyzing) this.status.textContent = t('Vergleicht die Spuren … {percent} %', { percent: Math.round(part * 100) });
    });
  }

  audioTracks() {
    return this.getTracks().filter((track) => track.type === 'audio');
  }

  isOpenFor(track) {
    return !this.root.hidden && sameTrack(this.track, track);
  }

  open(track) {
    this.track = track;
    this.result = null;
    this.cache = { ref: null, dub: null };
    this.video.hidden = true;
    this.video.removeAttribute('src');
    const others = this.audioTracks().filter((entry) => !sameTrack(entry, track));
    // Als Vergleich bietet sich die erste Tonspur der Hauptdatei an, das ist meist das Original.
    this.reference = others.find((entry) => entry.source === 0) ?? others[0];
    this.referenceSelect.replaceChildren(...others.map((entry) => el('option', {
      value: `${entry.source}:${entry.index}`,
      selected: sameTrack(entry, this.reference),
    }, trackLabel(entry, this.getTracks()))));
    this.title.textContent = t('Angleichen: {track}', { track: trackLabel(track, this.getTracks()) });
    this.status.textContent = '';
    this.root.hidden = false;
    this.setView(this.view);
    this.renderResult();
    this.root.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  close() {
    this.root.hidden = true;
    this.track = null;
    this.video.pause();
  }

  // Wird aufgerufen, wenn sich Spuren oder Versatz außerhalb des Bereichs geändert haben.
  refresh() {
    if (this.root.hidden) return;
    const tracks = this.getTracks();
    if (!tracks.some((entry) => sameTrack(entry, this.track)) || !tracks.some((entry) => sameTrack(entry, this.reference))) {
      this.close();
      return;
    }
    this.track = tracks.find((entry) => sameTrack(entry, this.track));
    this.reference = tracks.find((entry) => sameTrack(entry, this.reference));
    this.renderOffset();
    this.draw();
  }

  duration() {
    return Math.max(this.reference?.duration ?? 0, (this.track?.duration ?? 0) * (this.track?.stretch ?? 1)) || 60;
  }

  setView(seconds) {
    this.view = seconds;
    this.viewButtons.forEach((button, index) => {
      const active = VIEWS[index] === seconds;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    });
    this.cache = { ref: null, dub: null };
    this.setPosition(this.position);
  }

  setPosition(seconds) {
    const max = Math.max(0, this.duration() - this.view);
    this.position = Math.min(max, Math.max(0, seconds));
    this.positionInput.max = String(max);
    this.positionInput.value = String(this.position);
    this.positionText.textContent = `${formatTime(this.position)} / ${formatTime(this.duration())}`;
    this.draw();
  }

  setOffset(seconds) {
    this.track.offset = Math.round(Math.max(-3600, Math.min(3600, seconds)) * 1000) / 1000;
    this.renderOffset();
    this.draw();
    this.onChange();
  }

  renderOffset() {
    const stretch = this.track.stretch ?? 1;
    const percent = PERCENT.format(Math.abs(1 - 1 / stretch) * 100);
    let tempo = '';
    if (stretch > 1 + 1e-6) tempo = ` · ${t('Tempo um {percent} % verlangsamt', { percent })}`;
    else if (stretch < 1 - 1e-6) tempo = ` · ${t('Tempo um {percent} % beschleunigt', { percent })}`;
    this.offsetText.textContent = `${NUMBER.format(this.track.offset) || '0'} s${tempo}`;
  }

  // Ausgabezeit → Zeit in der Spur. Ausgabezeit = Spurzeit × Tempo + Versatz.
  trackTime(time) {
    return (time - this.track.offset) / (this.track.stretch ?? 1);
  }

  // Lädt die Lautstärke rund um den sichtbaren Ausschnitt, mit Reserve zum Verschieben.
  async ensure(lane, start, length) {
    const bin = this.view / 800;
    const cached = this.cache[lane];
    if (cached && cached.bin === bin && start >= cached.start && start + length <= cached.start + cached.length) return;
    // Läuft schon eine Anfrage, holt das anschließende Neuzeichnen den aktuellen Ausschnitt nach.
    if (this.loading[lane]) return;
    const source = lane === 'ref' ? this.reference : this.track;
    if (!source) return;
    this.loading[lane] = true;
    const from = start - length;
    const span = length * 3;
    const response = await invoke('mkv:waveform', {
      file: this.getFiles()[source.source],
      index: source.index,
      start: from,
      duration: span,
      bin,
    });
    this.loading[lane] = false;
    if (response.ok && this.view / 800 === bin) this.cache[lane] = { start: from, length: span, bin, values: response.values };
    this.draw();
  }

  sample(lane, time) {
    const cached = this.cache[lane];
    if (!cached) return 0;
    const index = Math.floor((time - cached.start) / cached.bin);
    return index >= 0 && index < cached.values.length ? cached.values[index] : 0;
  }

  draw() {
    if (this.root.hidden || !this.track) return;
    this.renderOffset();
    const stretch = this.track.stretch ?? 1;
    this.ensure('ref', this.position, this.view);
    this.ensure('dub', this.trackTime(this.position), this.view / stretch);

    const { canvas } = this;
    const ratio = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.round(canvas.clientWidth * ratio));
    const height = Math.max(1, Math.round(canvas.clientHeight * ratio));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    const context = canvas.getContext('2d');
    context.clearRect(0, 0, width, height);

    const refValues = new Float32Array(width);
    const dubValues = new Float32Array(width);
    let refMax = 1e-6;
    let dubMax = 1e-6;
    for (let x = 0; x < width; x += 1) {
      const time = this.position + (x / width) * this.view;
      refValues[x] = this.sample('ref', time);
      dubValues[x] = this.sample('dub', this.trackTime(time));
      refMax = Math.max(refMax, refValues[x]);
      dubMax = Math.max(dubMax, dubValues[x]);
    }

    const lane = (values, max, color, center, half, alpha) => {
      context.fillStyle = color;
      context.globalAlpha = alpha;
      for (let x = 0; x < width; x += 1) {
        const size = Math.sqrt(values[x] / max) * half * 0.92;
        context.fillRect(x, center - size, 1, Math.max(1, size * 2));
      }
      context.globalAlpha = 1;
    };
    const refColor = cssColor('--muted');
    const dubColor = cssColor('--accent');
    if (this.overlay) {
      lane(refValues, refMax, refColor, height / 2, height / 2, 0.7);
      lane(dubValues, dubMax, dubColor, height / 2, height / 2, 0.55);
    } else {
      lane(refValues, refMax, refColor, height / 4, height / 4, 0.9);
      lane(dubValues, dubMax, dubColor, (height * 3) / 4, height / 4, 0.9);
      context.fillStyle = cssColor('--border');
      context.fillRect(0, Math.round(height / 2), width, Math.max(1, ratio));
    }

    // Beschriftung der Bahnen unten links.
    context.font = `${11 * ratio}px sans-serif`;
    context.globalAlpha = 0.9;
    context.fillStyle = refColor;
    context.fillText(t('Vergleich'), 6 * ratio, this.overlay ? height - 22 * ratio : height / 2 - 6 * ratio);
    context.fillStyle = dubColor;
    context.fillText(t('Diese Spur'), 6 * ratio, height - 6 * ratio);
    context.globalAlpha = 1;

    // Sekundenmarken zur Orientierung.
    context.fillStyle = cssColor('--muted');
    context.font = `${11 * ratio}px sans-serif`;
    const step = this.view <= 5 ? 1 : this.view <= 15 ? 2 : 10;
    for (let second = Math.ceil(this.position / step) * step; second < this.position + this.view; second += step) {
      const x = ((second - this.position) / this.view) * width;
      context.globalAlpha = 0.35;
      context.fillRect(Math.round(x), 0, Math.max(1, ratio), height);
      context.globalAlpha = 0.9;
      context.fillText(formatTime(second), x + 4 * ratio, 12 * ratio);
    }
    context.globalAlpha = 1;
  }

  installCanvas() {
    let drag = null;
    this.canvas.addEventListener('pointerdown', (event) => {
      if (!this.track) return;
      drag = { x: event.clientX, offset: this.track.offset };
      this.canvas.setPointerCapture(event.pointerId);
      this.canvas.classList.add('dragging');
    });
    this.canvas.addEventListener('pointermove', (event) => {
      if (!drag) return;
      const seconds = ((event.clientX - drag.x) / this.canvas.clientWidth) * this.view;
      this.track.offset = Math.round((drag.offset + seconds) * 1000) / 1000;
      this.draw();
    });
    const end = () => {
      if (!drag) return;
      drag = null;
      this.canvas.classList.remove('dragging');
      this.setOffset(this.track.offset);
    };
    this.canvas.addEventListener('pointerup', end);
    this.canvas.addEventListener('pointercancel', end);
    this.canvas.addEventListener('wheel', (event) => {
      event.preventDefault();
      const delta = (event.deltaY || event.deltaX) > 0 ? 1 : -1;
      this.setPosition(this.position + delta * this.view * 0.2);
    }, { passive: false });
    new ResizeObserver(() => this.draw()).observe(this.canvas);
  }

  async analyze() {
    const files = this.getFiles();
    this.analyzing = true;
    this.autoButton.disabled = true;
    this.status.textContent = t('Vergleicht die Spuren …');
    const response = await invoke('mkv:analyzeSync', {
      reference: { file: files[this.reference.source], index: this.reference.index, duration: this.reference.duration },
      track: { file: files[this.track.source], index: this.track.index, duration: this.track.duration },
    });
    this.analyzing = false;
    this.autoButton.disabled = false;
    this.status.textContent = '';
    if (response.canceled) return;
    if (!response.ok) {
      this.result = { error: response.error };
    } else {
      this.result = response.result;
      if (this.result.found) {
        this.track.stretch = this.result.kind === 'same' ? 1 : this.result.stretch;
        this.track.offset = this.result.offset;
        this.cache.dub = null;
      }
    }
    this.renderResult();
    this.setOffset(this.track.offset);
  }

  renderResult() {
    const { result } = this;
    this.tempoBox.hidden = true;
    if (!result) {
      this.resultText.hidden = true;
      // Eine schon gesetzte Tempoänderung bleibt sichtbar und abschaltbar.
      if (Math.abs((this.track?.stretch ?? 1) - 1) > 1e-6) this.renderTempo(null, this.track.stretch);
      return;
    }
    this.resultText.hidden = false;
    if (result.error) {
      this.resultText.textContent = result.error;
      return;
    }
    if (!result.found) {
      this.resultText.textContent = t('Vitool konnte die Spuren nicht sicher vergleichen. Das passiert, wenn sie keine gemeinsame Musik und keine gemeinsamen Geräusche haben. Verschiebe die Wellenform dann von Hand.');
      return;
    }
    const parts = [t('Versatz gefunden: {offset} s. Geprüft an {checked} Stellen, {agreeing} davon passen zusammen.', {
      offset: NUMBER.format(result.offset) || '0',
      checked: result.checked,
      agreeing: result.agreeing,
    })];
    if (result.cutsDiffer) {
      const list = result.sections.map((section) => t('ab {time}: {offset} s', {
        time: formatTime(section.time),
        offset: NUMBER.format(section.offset) || '0',
      })).join(', ');
      parts.push(t('Nicht überall passt derselbe Versatz ({list}). Wahrscheinlich unterscheiden sich die Fassungen im Schnitt, etwa durch fehlende oder zusätzliche Szenen. Vitool nimmt den Versatz, der an den meisten Stellen passt.', { list }));
    }
    if (result.confidence === 'low') parts.push(t('Das Ergebnis ist unsicher. Prüfe es bitte an der Wellenform oder mit einem Ausschnitt.'));
    else parts.push(t('Prüfe es am besten noch mit einem Ausschnitt.'));
    this.resultText.textContent = parts.join(' ');
    if (result.kind !== 'same') this.renderTempo(result.kind, result.stretch);
  }

  // Erklärung und Schalter, wenn die Spur ein anderes Tempo hat als das Video.
  renderTempo(kind, stretch) {
    const input = el('input', {
      type: 'checkbox',
      checked: Math.abs((this.track.stretch ?? 1) - 1) > 1e-6,
      onchange: () => {
        this.track.stretch = input.checked ? stretch : 1;
        this.cache.dub = null;
        this.setOffset(this.track.offset);
      },
    });
    this.tempoBox.replaceChildren(
      kind ? el('p', {}, tempoText(kind, stretch)) : el('p', {}, t('Für diese Spur ist eine Tempoanpassung eingestellt.')),
      el('label', { class: 'check' }, input,
        el('span', {}, t('Tempo anpassen'),
          el('small', { class: 'muted' }, t('Die Spur wird dafür neu kodiert ({codec}). Länge und Tonhöhe passen danach zum Video.', { codec: this.track.retimeLabel ?? 'AAC' })))),
    );
    this.tempoBox.hidden = false;
  }

  async preview() {
    const files = this.getFiles();
    const video = this.getTracks().find((track) => track.type === 'video' && track.source === 0)
      ?? this.getTracks().find((track) => track.type === 'video');
    if (!video) {
      this.status.textContent = t('Für einen Ausschnitt braucht die Datei eine Videospur.');
      return;
    }
    this.previewButton.disabled = true;
    this.previewButton.textContent = t('Erstellt Ausschnitt …');
    const response = await invoke('mkv:syncPreview', {
      video: { file: files[video.source], index: video.index },
      track: {
        file: files[this.track.source],
        index: this.track.index,
        offset: this.track.offset,
        stretch: this.track.stretch ?? 1,
        sampleRate: this.track.sampleRate,
      },
      start: this.position,
      length: PREVIEW_SECONDS,
    });
    this.previewButton.disabled = false;
    this.previewButton.textContent = t('Ausschnitt testen');
    if (!response.ok) {
      this.status.textContent = response.error;
      return;
    }
    this.status.textContent = '';
    this.video.src = response.url;
    this.video.hidden = false;
    this.video.play().catch(() => {});
  }
}
